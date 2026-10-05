"""``ui.show`` and ``find_ui`` over the build-time auto tier's guide policy.

An auto location is guidable only when the generator gave it
``guide_policy: point`` (one render site, drawn by an audited shared button)
and a single-step plan, AND the shipped auto tier names the committed index it
hangs off by both its ``input_digest`` and its ``build_digest``. The record
then carries the plan and the auto tier's own digest; everything else is
``unknown_location``, and a search-only entry never gets a ``guide_ref``.
Synthetic file pairs only: no test here reads a built dashboard bundle.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from kiro_crew import guide_catalog, ui_index
from kiro_crew.dashboard.guide_runs import GuideStore
from kiro_crew.guide_catalog import GuideCatalogError, validate_actions

_BASE_BUILD = "sha256:" + "b" * 64
_AUTO_BUILD = "sha256:" + "a" * 64
_POINT = "auto:page.knowledge:k.reindex"
_SITE = "auto:page.knowledge:KnowledgePage:k.reindex"
_SEARCH_ONLY = "auto:page.knowledge:k.export"
_DENIED = "auto:page.knowledge:k.wipe"


def _placement(parents: list[str], entry: str = "content") -> dict[str, Any]:
    return {
        "surface_id": "knowledge",
        "route": "/knowledge",
        "parent_ids": parents,
        "entry_kind": entry,
        "requires": [],
    }


def _plan(lid: str, site: str) -> dict[str, Any]:
    key = lid.rsplit(":", 1)[1]
    return {
        "version": 2,
        "label_key": key,
        "placements": [
            {
                "id": "any",
                "route": "/knowledge",
                "steps": [{"id": f"any:{lid}", "location": site, "label_key": key}],
            }
        ],
    }


def _auto(lid: str, policy: str, plan: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "id": lid,
        "kind": "button",
        "tier": "auto",
        "conditions_unknown": True,
        "label_key": lid.rsplit(":", 1)[1],
        "placements": [_placement(["page.knowledge"])],
        "guide_policy": policy,
        **({"guide_plan": plan} if plan else {}),
    }


def _write(tmp_path: Path, **artifact: Any) -> tuple[Path, Path]:
    committed = {
        "schema_version": 1,
        "input_digest": "sha256:committed",
        "build_digest": _BASE_BUILD,
        "coverage": {"scope": "test scope"},
        "locales": ["en"],
        "surfaces": ["knowledge"],
        "reveal_scopes": {},
        "locations": [
            {
                "id": "page.knowledge",
                "kind": "page",
                "tier": "generated",
                "label_key": "k.page",
                "placements": [_placement([], "rail")],
            }
        ],
        "labels": {"en": {"k.page": "Knowledge"}},
    }
    auto = {
        "schema_version": 1,
        "artifact": "auto",
        "base_input_digest": "sha256:committed",
        "input_digest": "sha256:auto",
        "base_build_digest": _BASE_BUILD,
        "build_digest": _AUTO_BUILD,
        "coverage": {"scope": "auto test controls", "auto_controls": 3},
        "locales": ["en"],
        "locations": [
            _auto(_POINT, "point", _plan(_POINT, _SITE)),
            _auto(_SEARCH_ONLY, "search-only"),
            _auto(_DENIED, "deny"),
        ],
        "labels": {
            "en": {
                "k.reindex": "Reindex sources",
                "k.export": "Export knowledge graph",
                "k.wipe": "Wipe knowledge graph",
            }
        },
        **artifact,
    }
    p, a = tmp_path / "ui-index.json", tmp_path / "ui-index.auto.json"
    p.write_text(json.dumps(committed), encoding="utf-8")
    a.write_text(json.dumps(auto), encoding="utf-8")
    return p, a


@pytest.fixture
def files(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    def make(**artifact: Any) -> tuple[Path, Path]:
        p, a = _write(tmp_path, **artifact)
        monkeypatch.setattr(guide_catalog, "_UI_INDEX_PATH", p)
        monkeypatch.setattr(guide_catalog, "_UI_AUTO_INDEX_PATH", a)
        for fn in (
            guide_catalog.ui_show_plans,
            guide_catalog.ui_build_manifest,
            guide_catalog.ui_auto_tier,
        ):
            fn.cache_clear()
        ui_index._cache.update(key=None, index=None)
        return p, a

    yield make
    for fn in (
        guide_catalog.ui_show_plans,
        guide_catalog.ui_build_manifest,
        guide_catalog.ui_auto_tier,
    ):
        fn.cache_clear()
    ui_index._cache.update(key=None, index=None)


def _show(lid: str) -> dict[str, Any]:
    return validate_actions([{"id": "ui.show", "params": {"location_id": lid}}])[0]


def test_a_point_auto_location_is_accepted_with_its_plan_and_the_auto_digest(files) -> None:
    files()
    rec = _show(_POINT)
    assert rec["build_digest"] == _AUTO_BUILD
    assert rec["auto_plan"] == _plan(_POINT, _SITE)
    assert rec["placements"] == {"any": [f"any:{_POINT}"]}
    # The plan a tab walks is a copy: mutating the record never edits the cache.
    rec["auto_plan"]["placements"][0]["steps"][0]["location"] = "x"
    assert _show(_POINT)["auto_plan"]["placements"][0]["steps"][0]["location"] == _SITE


@pytest.mark.parametrize("lid", [_SEARCH_ONLY, _DENIED, "auto:page.knowledge:k.nothing"])
def test_a_non_point_or_unknown_auto_location_is_refused(files, lid: str) -> None:
    files()
    with pytest.raises(GuideCatalogError) as exc:
        _show(lid)
    assert exc.value.code == "unknown_location"


@pytest.mark.parametrize(
    "artifact",
    [
        {"base_build_digest": "sha256:" + "c" * 64},  # built against another bundle digest
        {"base_input_digest": "sha256:other"},  # built against another committed index
        {"build_digest": "not-a-digest"},
        {"artifact": "full"},
    ],
)
def test_an_auto_tier_of_another_build_makes_every_auto_id_unknown(files, artifact) -> None:
    files(**artifact)
    with pytest.raises(GuideCatalogError) as exc:
        _show(_POINT)
    assert exc.value.code == "unknown_location"
    assert guide_catalog.ui_build_manifest().auto_sites == {}


def test_no_auto_tier_file_is_unknown_location(files, monkeypatch, tmp_path: Path) -> None:
    files()
    monkeypatch.setattr(guide_catalog, "_UI_AUTO_INDEX_PATH", tmp_path / "missing.json")
    guide_catalog.ui_auto_tier.cache_clear()
    with pytest.raises(GuideCatalogError) as exc:
        _show(_POINT)
    assert exc.value.code == "unknown_location"


def test_a_plan_on_a_search_only_entry_is_never_kept(files) -> None:
    p, a = files()
    raw = json.loads(a.read_text())
    raw["locations"][1]["guide_plan"] = _plan(_SEARCH_ONLY, "auto:page.knowledge:K:k.export")
    a.write_text(json.dumps(raw))
    guide_catalog.ui_auto_tier.cache_clear()
    assert set(guide_catalog.ui_auto_tier().plans) == {_POINT}
    # find_ui refuses the whole artifact: a plan on a search-only entry is broken.
    d = ui_index.find_ui("reindex sources", "en", path=p, auto_path=a)
    assert d["auto_tier"] == "unavailable"


def test_a_multi_step_or_non_site_auto_plan_is_left_out(files) -> None:
    _, a = files()
    raw = json.loads(a.read_text())
    plan = raw["locations"][0]["guide_plan"]
    plan["placements"][0]["steps"][0]["location"] = "page.knowledge"  # not a site id
    a.write_text(json.dumps(raw))
    guide_catalog.ui_auto_tier.cache_clear()
    assert guide_catalog.ui_auto_tier().plans == {}


def test_the_manifest_maps_point_auto_locations_to_their_site(files) -> None:
    files()
    m = guide_catalog.ui_build_manifest()
    assert m.auto_sites == {_POINT: _SITE}
    assert _POINT not in m.observable


def test_find_ui_gives_a_guide_ref_only_to_a_point_auto_result(files) -> None:
    p, a = files()
    d = ui_index.find_ui("reindex sources", "en", path=p, auto_path=a)
    top = d["results"][0]
    assert top["id"] == _POINT and top["tier"] == "auto"
    assert top["guide_ref"] == {"action_id": "ui.show", "params": {"location_id": _POINT}}
    for q, lid in (("export knowledge graph", _SEARCH_ONLY), ("wipe knowledge graph", _DENIED)):
        r = ui_index.find_ui(q, "en", path=p, auto_path=a)["results"][0]
        assert r["id"] == lid and r["tier"] == "auto"
        assert "guide_ref" not in r


def test_an_unknown_guide_policy_refuses_the_auto_tier(files) -> None:
    p, a = files()
    raw = json.loads(a.read_text())
    raw["locations"][1]["guide_policy"] = "maybe"
    a.write_text(json.dumps(raw))
    d = ui_index.find_ui("reindex sources", "en", path=p, auto_path=a)
    assert d["auto_tier"] == "unavailable"


def test_an_auto_guide_starts_and_carries_the_plan_to_the_tab(files) -> None:
    files()
    store = GuideStore(clock=lambda: 1000.0)
    g = store.start(
        slot_key="chat-x",
        session_key="dashboard:chat-x",
        actions=[{"id": "ui.show", "params": {"location_id": _POINT}}],
    )
    action = g["actions"][0]
    assert action["build_digest"] == _AUTO_BUILD
    assert action["auto_plan"]["placements"][0]["steps"][0]["location"] == _SITE


def test_observe_accepts_a_point_auto_location_and_refuses_the_rest(files) -> None:
    from kiro_crew.dashboard.guide_runs import GuideError
    from kiro_crew.dashboard.handlers.guide import _observe_ids

    files()
    targets, _, _ = _observe_ids({"targets": [_POINT]})
    assert targets == (_POINT,)
    for bad in (_SEARCH_ONLY, _DENIED, _SITE):
        with pytest.raises(GuideError) as exc:
            _observe_ids({"targets": [bad]})
        assert exc.value.code == "unknown_target"
