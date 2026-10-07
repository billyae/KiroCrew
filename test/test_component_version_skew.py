"""Tests for the selected-versus-running component version-skew section of
``kirocrew status``.

The signal compares the version the running gateway reports (``/api/status``'s
``version``) against the version Kiro Crew has *selected*. Selection lives in the
live-target pointer, NOT in whichever checkout the ``status`` CLI happens to run
from — so these tests pin ``live_target.read_target`` to drive the three states
the reviewer asked for: a foreign CLI checkout must not fabricate skew, a real
selected-versus-running mismatch must be reported, and a true match must read as
aligned.
"""

from __future__ import annotations

from kiro_crew import cli_server
from kiro_crew.service import live_target


def _make_checkout(root, version: str):
    """Write a minimal checkout tree whose ``__init__`` pins ``version``."""
    init_py = root / "src" / "kiro_crew" / "__init__.py"
    init_py.parent.mkdir(parents=True, exist_ok=True)
    init_py.write_text(f'__version__ = "{version}"\n', encoding="utf-8")
    return root


# ---------------------------------------------------------------------------
# Selected version is read from the live-target pointer, not this CLI
# ---------------------------------------------------------------------------


def test_foreign_cli_checkout_does_not_fabricate_skew(monkeypatch, tmp_path, capsys):
    # The live target (the selected package) and the running gateway are BOTH
    # 0.9.0. This status CLI is pretended to be a different checkout at 0.8.0.
    # Reading "selected" from this CLI's own __version__ (the old bug) would
    # report false skew; reading it from the pointer must report aligned.
    monkeypatch.setattr(cli_server, "__version__", "0.8.0")
    checkout = _make_checkout(tmp_path / "selected", "0.9.0")
    monkeypatch.setattr(live_target, "read_target", lambda: checkout)

    cli_server._print_component_identity({"version": "0.9.0"})

    out = capsys.readouterr().out
    assert "aligned" in out
    assert "version_skew" not in out


def test_real_skew_is_detected_against_the_pointer(monkeypatch, tmp_path, capsys):
    # The selected package (pinned checkout) is 0.9.0 but the gateway still runs
    # 0.8.0 — the half-applied-update state the issue is about.
    checkout = _make_checkout(tmp_path / "selected", "0.9.0")
    monkeypatch.setattr(live_target, "read_target", lambda: checkout)

    cli_server._print_component_identity({"version": "0.8.0"})

    out = capsys.readouterr().out
    assert "version_skew" in out
    assert "0.9.0" in out and "0.8.0" in out
    assert "skewed" in out


def test_no_skew_when_pointer_and_gateway_match(monkeypatch, tmp_path, capsys):
    checkout = _make_checkout(tmp_path / "selected", "0.9.0")
    monkeypatch.setattr(live_target, "read_target", lambda: checkout)

    cli_server._print_component_identity({"version": "0.9.0"})

    out = capsys.readouterr().out
    assert "aligned" in out
    assert "version_skew" not in out


# ---------------------------------------------------------------------------
# Unpinned: selection falls back to the installed build this CLI runs
# ---------------------------------------------------------------------------


def test_unpinned_falls_back_to_installed_build_aligned(monkeypatch, capsys):
    monkeypatch.setattr(cli_server, "__version__", "0.9.0")
    monkeypatch.setattr(live_target, "read_target", lambda: None)

    cli_server._print_component_identity({"version": "0.9.0"})

    assert "aligned" in capsys.readouterr().out


def test_unpinned_installed_build_skew_against_gateway(monkeypatch, capsys):
    # Nothing pinned, so the installed build (this CLI's __version__) is the
    # selected package; a gateway on an older version is genuine skew.
    monkeypatch.setattr(cli_server, "__version__", "0.9.0")
    monkeypatch.setattr(live_target, "read_target", lambda: None)

    cli_server._print_component_identity({"version": "0.8.0"})

    assert "version_skew" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# Unknown, not fabricated
# ---------------------------------------------------------------------------


def test_missing_gateway_version_is_unknown_not_aligned(monkeypatch, capsys):
    monkeypatch.setattr(live_target, "read_target", lambda: None)
    monkeypatch.setattr(cli_server, "__version__", "0.9.0")

    cli_server._print_component_identity({})

    out = capsys.readouterr().out
    assert "unknown" in out
    assert "aligned" not in out


def test_unreadable_pinned_checkout_is_unknown(monkeypatch, tmp_path, capsys):
    # A pinned checkout with no readable __init__ cannot yield a selected
    # version — report unknown rather than a fabricated match.
    empty = tmp_path / "selected"
    empty.mkdir()
    monkeypatch.setattr(live_target, "read_target", lambda: empty)

    cli_server._print_component_identity({"version": "0.9.0"})

    out = capsys.readouterr().out
    assert "unknown" in out
    assert "aligned" not in out


def test_distinct_builds_clamping_to_same_release_still_skew(monkeypatch, tmp_path, capsys):
    # Two nightlies clamp to the same public release but are different builds;
    # the equality test is on the full version, so this is skew.
    checkout = _make_checkout(tmp_path / "selected", "0.9.0.1")
    monkeypatch.setattr(live_target, "read_target", lambda: checkout)

    cli_server._print_component_identity({"version": "0.9.0.2"})

    out = capsys.readouterr().out
    assert "version_skew" in out
