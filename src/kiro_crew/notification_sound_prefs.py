"""Bounds for the user-defined notification sounds in the dashboard's sound settings.

The dashboard keeps its sound settings as one JSON blob under the browser key
``mc-notification-sound`` and backs it up to the host through ``/api/ui-prefs``
(:mod:`kiro_crew.ui_prefs`). Every other value that store holds is opaque. This
one is checked, because its ``customTones`` member is played on the user's
speakers as written: a tone the client would refuse must not be landable on the
host by a PUT or a restored archive, and then come back into every browser
profile on its next load.

The limits mirror ``CUSTOM_TONE_LIMITS`` in
``website/src/hooks/useNotificationSound.ts``; ``test_notification_sound_prefs``
pins the two together. Only ``customTones`` is checked: the rest of the blob
(enabled, volume, per-category choices) is clamped by the client on load, and a
stored value from a build without custom sounds simply has no such member.
"""

from __future__ import annotations

import json
import math
from typing import Any, TypeGuard

#: The browser key whose value is the sound-settings blob.
SOUND_SETTINGS_KEY = "mc-notification-sound"

MAX_SOUNDS = 20
MAX_NAME_LENGTH = 32
MAX_TONES = 16
MIN_FREQ = 20
MAX_FREQ = 20000
MIN_DUR = 0.02
MAX_DUR = 2
MAX_LENGTH = 5

_RESERVED_NAMES = frozenset({"none", "default", "chime", "ding", "blip", "pop", "pulse"})
_NAME_PUNCTUATION = frozenset(" _-")


def _is_number(value: Any) -> TypeGuard[float]:
    # bool is an int subclass; a JSON true is not a frequency.
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _name_problem(name: str, seen: set[str]) -> str | None:
    if (
        not name
        or name != name.strip()
        or len(name) > MAX_NAME_LENGTH
        or not all(ch.isalnum() or ch in _NAME_PUNCTUATION for ch in name)
    ):
        return "invalid name"
    folded = name.lower()
    if folded in _RESERVED_NAMES or folded in seen:
        return "name already used"
    return None


def _tones_problem(tones: Any) -> str | None:
    if not isinstance(tones, list) or not 1 <= len(tones) <= MAX_TONES:
        return f"must be a list of 1 to {MAX_TONES} tones"
    for step in tones:
        if not isinstance(step, dict):
            return "each tone must be an object"
        freq, start, dur, gain = (step.get(k) for k in ("freq", "start", "dur", "gain"))
        if not _is_number(freq) or not MIN_FREQ <= freq <= MAX_FREQ:
            return f"freq must be {MIN_FREQ} to {MAX_FREQ} Hz"
        if not _is_number(dur) or not MIN_DUR <= dur <= MAX_DUR:
            return f"dur must be {MIN_DUR} to {MAX_DUR} seconds"
        if not _is_number(gain) or not 0 < gain <= 1:
            return "gain must be above 0 and at most 1"
        if not _is_number(start) or start < 0 or start + dur > MAX_LENGTH:
            return f"each tone must start at 0 or later and end within {MAX_LENGTH} seconds"
    return None


def custom_tones_problem(value: str) -> str | None:
    """Why *value* (the stored sound-settings blob) is not storable, or ``None``.

    A value that is not a JSON object is left alone: the client already treats an
    unreadable blob as "use the defaults", and refusing it here would only stop
    the rest of a settings patch from being backed up.
    """
    try:
        doc = json.loads(value)
    except (ValueError, RecursionError):
        return None
    if not isinstance(doc, dict) or "customTones" not in doc:
        return None
    custom = doc["customTones"]
    if not isinstance(custom, dict):
        return "customTones must be an object"
    if len(custom) > MAX_SOUNDS:
        return f"at most {MAX_SOUNDS} custom sounds"
    seen: set[str] = set()
    for name, tones in custom.items():
        problem = _name_problem(name, seen)
        if problem is None:
            problem = _tones_problem(tones)
        if problem is not None:
            return f"custom sound {name[:MAX_NAME_LENGTH]!r}: {problem}"
        seen.add(name.lower())
    return None
