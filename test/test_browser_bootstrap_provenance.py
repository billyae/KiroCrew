"""Where the browser install's npm/Node live, and how ``kirocrew doctor`` reports it.

The install bootstrap resolves npm and Node from the gateway PATH and the
version-manager directories. Nothing refuses on the answer; these tests pin that
the answer comes from the same writability predicate the CLI resolver refuses
on, and that it is reported at the right volume: a toolchain under ``$HOME`` is
information, one the user can write elsewhere is a warning.
"""

from __future__ import annotations

import os
import stat
from collections.abc import Iterator
from pathlib import Path

import pytest

from kiro_crew import env as env_mod
from kiro_crew.browser_cli import install as mod
from kiro_crew.doctor_checks import install as doctor_install

pytestmark = pytest.mark.skipif(
    os.name == "nt" or os.geteuid() == 0,
    reason="writability is reported as unchecked on Windows and for root",
)


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Scope the hierarchy walk to *tmp_path*.

    The real walk starts at ``/`` and the pytest base dir sits under a
    world-writable ``/tmp``, which would make every fixture writable at ``/tmp``
    and hide what each case is about. The predicate itself is untouched.
    """
    walk = mod.platform_compat.traversed_components

    def scoped(path: str | os.PathLike[str]) -> list[Path] | None:
        found = walk(path)
        if found is None:
            return None
        return [c for c in found if c == tmp_path or tmp_path in c.parents]

    monkeypatch.setattr(mod.platform_compat, "traversed_components", scoped)
    tmp_path.chmod(0o755)
    return tmp_path


@pytest.fixture
def home(root: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """A writable home inside a root this user cannot write, like ``/home/<user>``."""
    home = root / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    _seal(root)
    yield home
    _unseal(root)


def _exe(directory: Path, name: str = "node") -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    tool = directory / name
    tool.write_text("#!/bin/sh\n")
    tool.chmod(0o755)
    return tool


def _seal(*paths: Path) -> None:
    for path in paths:
        path.chmod(stat.S_IRUSR | stat.S_IXUSR)


def _unseal(*paths: Path) -> None:
    for path in paths:
        path.chmod(0o755)


def test_a_version_manager_node_under_home_is_writable_under_home(home: Path) -> None:
    real = _exe(home / ".volta" / "tools" / "image" / "node" / "24.1.0" / "bin")
    shim_dir = home / ".volta" / "bin"
    shim_dir.mkdir(parents=True)
    (shim_dir / "node").symlink_to(real)

    info = mod.bootstrap_tool_provenance(str(shim_dir / "node"))

    assert info["real_path"] == os.path.realpath(real)
    assert info["writable_at"] == str(home)
    assert info["under_home"] is True


def test_a_writable_dir_outside_home_is_not_under_home(home: Path, root: Path) -> None:
    _unseal(root)
    shared = root / "shared-bin"
    tool = _exe(shared)
    _seal(root)
    info = mod.bootstrap_tool_provenance(str(tool))

    assert info["writable_at"] == str(shared)
    assert info["under_home"] is False


def test_a_fully_sealed_hierarchy_has_no_writable_component(root: Path) -> None:
    directory = root / "sealed"
    tool = _exe(directory)
    _seal(tool, directory, root)
    try:
        info = mod.bootstrap_tool_provenance(str(tool))
    finally:
        _unseal(root, directory)

    assert info["writable_at"] == ""
    assert info["under_home"] is False


def test_a_writable_parent_above_a_sealed_bin_dir_still_counts(root: Path) -> None:
    """The whole walk is asked, not just the binary's own directory."""
    opt = root / "opt"
    bin_dir = opt / "node" / "bin"
    tool = _exe(bin_dir)
    _seal(tool, bin_dir, opt / "node", root)
    try:
        info = mod.bootstrap_tool_provenance(str(tool))
    finally:
        _unseal(root, opt / "node", bin_dir)

    assert info["writable_at"] == str(opt)


def test_a_group_writable_dir_counts_even_when_this_user_cannot_write_it(root: Path) -> None:
    directory = root / "shared"
    tool = _exe(directory)
    _seal(tool, root)
    directory.chmod(stat.S_IRUSR | stat.S_IXUSR | stat.S_IWGRP | stat.S_IRGRP | stat.S_IXGRP)
    try:
        info = mod.bootstrap_tool_provenance(str(tool))
    finally:
        _unseal(root, directory)

    assert info["writable_at"] == str(directory)


def test_a_symlink_into_a_writable_target_counts_as_writable(root: Path) -> None:
    """A sealed-looking name is only as safe as what it points at."""
    target_dir = root / "writable-target"
    target = _exe(target_dir)
    sealed = root / "sealed"
    sealed.mkdir()
    (sealed / "node").symlink_to(target)
    _seal(sealed, root)
    try:
        info = mod.bootstrap_tool_provenance(str(sealed / "node"))
    finally:
        _unseal(root, sealed)

    assert info["writable_at"] == str(target_dir)


def _doctor_rows(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tools: dict[str, str],
    provenance: dict[str, tuple[str, bool]] | None = None,
) -> str:
    monkeypatch.setattr(env_mod, "find_node_tool", lambda name, base_path=None: tools.get(name))
    if provenance is not None:
        monkeypatch.setattr(
            mod,
            "bootstrap_tool_provenance",
            lambda path: {
                "path": path,
                "real_path": path,
                "writable_at": provenance[path][0],
                "under_home": provenance[path][1],
            },
        )
    doctor_install._doctor_browser_bootstrap()
    return capsys.readouterr().out


def test_doctor_reads_a_home_toolchain_as_information(
    home: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    bin_dir = home / ".nvm" / "versions" / "node" / "v24.1.0" / "bin"
    tools = {"npm": str(_exe(bin_dir, "npm")), "node": str(_exe(bin_dir))}

    out = _doctor_rows(monkeypatch, capsys, tools)

    assert f"browser npm: ℹ️  {tools['npm']} (user-owned toolchain" in out
    assert f"browser node: ℹ️  {tools['node']} (user-owned toolchain" in out
    assert "⚠️" not in out


def test_doctor_warns_on_a_toolchain_writable_outside_home(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    tools = {"npm": "/opt/n/bin/npm", "node": "/opt/n/bin/node"}
    prov = {p: ("/opt/n", False) for p in tools.values()}

    out = _doctor_rows(monkeypatch, capsys, tools, prov)

    assert "browser node: ⚠️  /opt/n/bin/node is replaceable by this user outside its home" in out
    assert "/opt/n is writable by this user" in out


def test_doctor_says_its_rows_come_from_its_own_path(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Doctor's PATH is not the gateway's; the row must not claim otherwise."""
    tools = {"npm": "/usr/bin/npm", "node": "/usr/bin/node"}
    prov = {p: ("", False) for p in tools.values()}

    out = _doctor_rows(monkeypatch, capsys, tools, prov)

    assert "browser node: ✅ /usr/bin/node" in out
    assert "resolve from this shell's PATH" in out
    assert "the gateway logs the npm and" in out


def test_doctor_reports_a_missing_toolchain_without_failing(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    out = _doctor_rows(monkeypatch, capsys, {})

    assert "browser npm: ⏹ not found" in out
    assert "browser node: ⏹ not found" in out
