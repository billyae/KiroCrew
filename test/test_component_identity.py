"""Tests for selected-versus-running component version skew.

Drives the real :mod:`kiro_crew.component_identity` code -- the version
comparison, the mismatch-age clock, and the export shape -- so drift in any of
them fails here. Covers aligned, transient skew, persistent skew, an unreadable
gateway version, the age clock clearing on realignment, and the no-leak export
contract.
"""

from __future__ import annotations

import json

import pytest

from kiro_crew import component_identity as ci


@pytest.fixture(autouse=True)
def _isolate(tmp_path, _floor_monkeypatch):
    """Isolate the skew marker and pin the version helpers so tests are hermetic."""
    _floor_monkeypatch.setattr(ci, "_skew_marker_path", lambda: tmp_path / "skew.json")
    _floor_monkeypatch.setattr(ci.beacon, "release", lambda v: v)
    yield


# ---------------------------------------------------------------------------
# Aligned
# ---------------------------------------------------------------------------


def test_gateway_matching_selected_is_aligned():
    report = ci.compare_gateway("0.9.0", _selected="0.9.0")
    assert report.result == ci.RESULT_ALIGNED
    assert report.mismatch_age_seconds == 0.0
    relations = [r.relation for r in report.rows]
    assert relations == [ci.REL_SELECTED, ci.REL_ALIGNED]


# ---------------------------------------------------------------------------
# Skew with age (the half-applied-update state)
# ---------------------------------------------------------------------------


def test_gateway_on_older_version_surfaces_skew():
    report = ci.compare_gateway("0.8.0", now=100.0, _selected="0.9.0")
    assert report.result == ci.RESULT_SKEW
    gw = next(r for r in report.rows if r.role == ci.GATEWAY_ROLE)
    assert gw.relation == ci.REL_SKEWED
    assert gw.build_identity == "0.8.0"
    selected_row = next(r for r in report.rows if r.relation == ci.REL_SELECTED)
    assert selected_row.build_identity == "0.9.0"


def test_transient_then_persistent_skew_age_grows_across_calls():
    first = ci.compare_gateway("0.8.0", now=1000.0, _selected="0.9.0")
    assert first.result == ci.RESULT_SKEW
    assert first.mismatch_age_seconds == 0.0
    later = ci.compare_gateway("0.8.0", now=1300.0, _selected="0.9.0")
    assert later.result == ci.RESULT_SKEW
    assert later.mismatch_age_seconds == pytest.approx(300.0)


def test_aligned_clears_the_skew_clock():
    ci.compare_gateway("0.8.0", now=1000.0, _selected="0.9.0")
    # Realignment clears the marker.
    ci.compare_gateway("0.9.0", now=1300.0, _selected="0.9.0")
    # A fresh skew therefore starts a new clock at zero, not at 500s.
    again = ci.compare_gateway("0.8.0", now=1500.0, _selected="0.9.0")
    assert again.mismatch_age_seconds == 0.0


def test_distinct_builds_clamping_to_same_release_still_skew(_floor_monkeypatch):
    # Two nightlies clamp to the same public release but are different builds.
    # The equality test must use the FULL version, so this is skew, not aligned,
    # while the displayed product_version is the clamped release.
    _floor_monkeypatch.setattr(ci.beacon, "release", lambda v: "0.9.0")
    report = ci.compare_gateway("0.9.0-nightly.2", now=1.0, _selected="0.9.0-nightly.1")
    assert report.result == ci.RESULT_SKEW
    gw = next(r for r in report.rows if r.role == ci.GATEWAY_ROLE)
    assert gw.build_identity == "0.9.0-nightly.2"  # full version drives the compare
    assert gw.product_version == "0.9.0"  # clamped form is display-only


# ---------------------------------------------------------------------------
# Unreadable gateway version
# ---------------------------------------------------------------------------


def test_missing_gateway_version_is_unknown_not_aligned():
    report = ci.compare_gateway(None, _selected="0.9.0")
    assert report.result == ci.REL_UNKNOWN
    gw = next(r for r in report.rows if r.role == ci.GATEWAY_ROLE)
    assert gw.relation == ci.REL_UNKNOWN


def test_empty_gateway_version_is_unknown_and_does_not_touch_the_clock():
    # Seed a skew clock, then an unknown read must not clear it.
    ci.compare_gateway("0.8.0", now=1000.0, _selected="0.9.0")
    unknown = ci.compare_gateway("", now=1200.0, _selected="0.9.0")
    assert unknown.result == ci.REL_UNKNOWN
    assert unknown.mismatch_age_seconds == 0.0
    # The original skew clock survived the unknown read.
    again = ci.compare_gateway("0.8.0", now=1400.0, _selected="0.9.0")
    assert again.mismatch_age_seconds == pytest.approx(400.0)


# ---------------------------------------------------------------------------
# No-leak export
# ---------------------------------------------------------------------------


def test_exported_rows_carry_only_bounded_fields():
    report = ci.compare_gateway("0.9.0", _selected="0.9.0")
    allowed = {"role", "product_version", "build_identity", "relation"}
    for row in report.rows:
        assert set(row.as_dict().keys()) == allowed
    top = report.as_dict()
    assert set(top.keys()) == {"result", "reason", "mismatch_age_seconds", "components"}


def test_export_is_json_serializable_and_leaks_nothing_sensitive():
    report = ci.compare_gateway("0.8.0", now=1.0, _selected="0.9.0")
    blob = json.dumps(report.as_dict())
    for forbidden in ("/home/", "/local/home", "pid", "hostname", "cmdline", "username"):
        assert forbidden not in blob.lower()


# ---------------------------------------------------------------------------
# Marker write is symlink-safe
# ---------------------------------------------------------------------------


def test_marker_write_replaces_a_planted_symlink_not_its_target(tmp_path, _floor_monkeypatch):
    # A planted symlink at the marker path must not be followed to clobber the
    # file it points at (e.g. a governance policy): atomic_write replaces the
    # link itself via temp-file + rename.
    victim = tmp_path / "security_policy.json"
    victim.write_text('{"ceiling": "do-not-overwrite"}', encoding="utf-8")
    marker = tmp_path / "skew.json"
    marker.symlink_to(victim)
    _floor_monkeypatch.setattr(ci, "_skew_marker_path", lambda: marker)

    # Writing a skew marker during version skew.
    ci.compare_gateway("0.8.0", now=1.0, _selected="0.9.0")

    # The victim is untouched; the marker is now a regular file, not the link.
    assert victim.read_text(encoding="utf-8") == '{"ceiling": "do-not-overwrite"}'
    assert not marker.is_symlink()
    assert json.loads(marker.read_text(encoding="utf-8"))["first_seen"] == 1.0
