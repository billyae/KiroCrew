"""The sound-settings backup refuses custom sounds the dashboard would refuse."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from kiro_crew import notification_sound_prefs as nsp
from kiro_crew import ui_prefs
from kiro_crew.ui_prefs import UiPrefsError, load_ui_prefs, merge_ui_prefs, parse_imported_ui_prefs

KEY = nsp.SOUND_SETTINGS_KEY
GOOD = [
    {"freq": 523, "start": 0, "dur": 0.2, "gain": 1},
    {"freq": 784, "start": 0.2, "dur": 0.3, "gain": 0.9},
]


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch):
    monkeypatch.setattr(ui_prefs, "config_dir", lambda: tmp_path)


def _blob(custom_tones) -> str:
    return json.dumps(
        {
            "enabled": True,
            "volume": 0.5,
            "perCategory": {"all": "custom:myAlert"},
            "customTones": custom_tones,
        }
    )


def test_valid_custom_sound_is_stored():
    merge_ui_prefs({KEY: _blob({"myAlert": GOOD})})
    assert json.loads(load_ui_prefs()[KEY])["customTones"] == {"myAlert": GOOD}


def test_blob_without_custom_sounds_is_untouched():
    merge_ui_prefs({KEY: json.dumps({"enabled": False, "volume": 9})})
    merge_ui_prefs({KEY: "not json"})
    assert load_ui_prefs()[KEY] == "not json"


def _step(**over):
    return [{**GOOD[0], **over}]


@pytest.mark.parametrize(
    "custom",
    [
        {"": GOOD},
        {"bad<name>": GOOD},
        {" padded": GOOD},
        {"x" * (nsp.MAX_NAME_LENGTH + 1): GOOD},
        {"Chime": GOOD},
        {"mine": GOOD, "MINE": GOOD},
        {"ok": []},
        {"ok": [GOOD[0]] * (nsp.MAX_TONES + 1)},
        {"ok": "not a list"},
        {"ok": ["not an object"]},
        {"ok": _step(freq=nsp.MIN_FREQ - 1)},
        {"ok": _step(freq=nsp.MAX_FREQ + 1)},
        {"ok": _step(freq="523")},
        {"ok": _step(freq=True)},
        {"ok": _step(dur=nsp.MIN_DUR / 2)},
        {"ok": _step(dur=nsp.MAX_DUR + 1)},
        {"ok": _step(gain=0)},
        {"ok": _step(gain=1.5)},
        {"ok": _step(start=-1)},
        {"ok": _step(start=nsp.MAX_LENGTH)},
        {f"s{i}": GOOD for i in range(nsp.MAX_SOUNDS + 1)},
        ["not", "an", "object"],
    ],
)
def test_out_of_bounds_custom_sound_is_refused_and_nothing_is_written(custom):
    with pytest.raises(UiPrefsError, match=KEY):
        merge_ui_prefs({KEY: _blob(custom), "mc-diff-split": "1"})
    assert load_ui_prefs() == {}


def test_restored_archive_drops_an_out_of_bounds_sound_blob(tmp_path):
    archive = tmp_path / "archive-ui-prefs.json"
    loud = _blob({"loud": _step(gain=9)})
    archive.write_text(json.dumps({"prefs": {KEY: loud, "mc-diff-split": "1"}}), encoding="utf-8")
    patch, dropped = parse_imported_ui_prefs(archive)
    assert patch == {"mc-diff-split": "1"}
    assert dropped == 1


def test_limits_match_the_dashboard():
    source = (
        Path(__file__).resolve().parents[1]
        / "website"
        / "src"
        / "hooks"
        / "useNotificationSound.ts"
    ).read_text(encoding="utf-8")
    block = re.search(r"CUSTOM_TONE_LIMITS = \{(.*?)\} as const", source, re.S)
    assert block is not None
    limits = {k: float(v) for k, v in re.findall(r"(\w+): ([\d.]+),", block.group(1))}
    assert limits == {
        "maxSounds": nsp.MAX_SOUNDS,
        "maxNameLength": nsp.MAX_NAME_LENGTH,
        "maxTones": nsp.MAX_TONES,
        "minFreq": nsp.MIN_FREQ,
        "maxFreq": nsp.MAX_FREQ,
        "minDur": nsp.MIN_DUR,
        "maxDur": nsp.MAX_DUR,
        "maxLength": nsp.MAX_LENGTH,
    }
