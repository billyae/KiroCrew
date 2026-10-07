"""Tests for the default-workspace gateway DATA root resolver.

``workspaces.<default>.data_root`` relocates where the gateway reads and writes
the default workspace's data (the markdown memory tree). The contract these
tests pin:

* UNSET / empty / whitespace / unloadable / degraded config -> ``config_dir()/"workspace"``
  BYTE-IDENTICALLY (an install that never sets the key is unchanged).
* An ABSOLUTE, non-sensitive path UNDER the data home, when the built-in memory
  tree is empty -> that path.
* A relative, non-string, sensitive, data-home-ancestor, or OUTSIDE-the-data-home
  value -> ``WorkspaceDataRootError``, raised loudly rather than silently
  resolved. Outside the data home is refused because the backup/snapshot
  archivers only cover the data home.
* A relocation while the built-in memory tree still holds data -> refused, so
  boot never imports from the old path and marks memory migrated with nothing
  imported.
* The value is resolved ONCE per process (cached), so the gateway and the MCP
  subprocess cannot drift onto different directories.
* The key lives in ``config.json``, which is on the agent file-edit write-deny
  floor, so an agent cannot relocate its own data root.
"""

from __future__ import annotations

import json

import pytest

import kiro_crew.config.loader as loader
import kiro_crew.memory as memory
from kiro_crew.config.loader import (
    WorkspaceDataRootError,
    _reset_default_workspace_data_root_cache,
    default_workspace_data_root,
)


@pytest.fixture()
def cfg_env(tmp_path, monkeypatch):
    """A clean config dir; the config.json is rewritten per test via ``write``."""
    cfg_dir = tmp_path / ".kirocrew"
    cfg_dir.mkdir()
    cfg_file = cfg_dir / "config.json"

    def write(doc: dict) -> None:
        cfg_file.write_text(json.dumps(doc))
        # The resolver caches once per process; drop it so each test's config
        # is actually read.
        _reset_default_workspace_data_root_cache()

    write({"workspaces": {"default": {"dir": "workspace"}}})
    monkeypatch.setattr(loader, "config_path", lambda: cfg_file)
    monkeypatch.setattr(loader, "config_dir", lambda: cfg_dir)
    # Clear once more after the monkeypatches land so the first real read sees
    # the patched config_dir.
    _reset_default_workspace_data_root_cache()
    yield cfg_dir, write
    _reset_default_workspace_data_root_cache()


def test_unset_is_byte_identical_to_builtin(cfg_env):
    cfg_dir, write = cfg_env
    write({"workspaces": {"default": {"dir": "workspace"}}})
    assert default_workspace_data_root() == cfg_dir / "workspace"


def test_no_workspaces_section_is_byte_identical(cfg_env):
    cfg_dir, write = cfg_env
    write({})
    assert default_workspace_data_root() == cfg_dir / "workspace"


def test_empty_data_root_is_byte_identical(cfg_env):
    cfg_dir, write = cfg_env
    write({"workspaces": {"default": {"dir": "workspace", "data_root": ""}}})
    assert default_workspace_data_root() == cfg_dir / "workspace"


def test_whitespace_data_root_is_byte_identical(cfg_env):
    cfg_dir, write = cfg_env
    write({"workspaces": {"default": {"dir": "workspace", "data_root": "   "}}})
    assert default_workspace_data_root() == cfg_dir / "workspace"


def test_absolute_path_is_honored(cfg_env):
    cfg_dir, write = cfg_env
    # Under the data home (siblings of the built-in "workspace"), so the backup
    # archivers still cover it.
    target = cfg_dir / "relocated-data"
    target.mkdir()
    write({"workspaces": {"default": {"data_root": str(target)}}})
    assert default_workspace_data_root() == target


def test_relative_data_root_is_rejected(cfg_env):
    _cfg_dir, write = cfg_env
    write({"workspaces": {"default": {"data_root": "projects/default"}}})
    with pytest.raises(WorkspaceDataRootError, match="ABSOLUTE"):
        default_workspace_data_root()


def test_tilde_data_root_is_rejected(cfg_env):
    """``~/x`` is lexically non-absolute; the absolute-only contract refuses it
    rather than silently expanding it (and avoids expanduser's RuntimeError on
    an unknown ``~user``)."""
    _cfg_dir, write = cfg_env
    write({"workspaces": {"default": {"data_root": "~/memory"}}})
    with pytest.raises(WorkspaceDataRootError, match="ABSOLUTE"):
        default_workspace_data_root()


def test_non_string_data_root_is_rejected(cfg_env):
    _cfg_dir, write = cfg_env
    write({"workspaces": {"default": {"data_root": 123}}})
    with pytest.raises(WorkspaceDataRootError, match="must be a string"):
        default_workspace_data_root()


def test_sensitive_data_root_is_rejected(cfg_env, monkeypatch):
    cfg_dir, write = cfg_env
    # Force the sensitivity check to fire regardless of host layout. Build the
    # path from the fixture (under the data home, absolute on every OS) so it
    # reaches the sensitivity check rather than the absolute/outside-home gates.
    target = cfg_dir / "sensitive-target"
    monkeypatch.setattr("kiro_crew.security.is_sensitive_path", lambda p: True)
    write({"workspaces": {"default": {"data_root": str(target)}}})
    with pytest.raises(WorkspaceDataRootError, match="sensitive path"):
        default_workspace_data_root()


def test_data_home_ancestor_is_rejected(cfg_env):
    """The data home itself and any ancestor of it are refused, so the memory
    tree cannot interleave with config.json / session dirs."""
    cfg_dir, write = cfg_env
    write({"workspaces": {"default": {"data_root": str(cfg_dir)}}})
    with pytest.raises(WorkspaceDataRootError, match="data home or an ancestor"):
        default_workspace_data_root()
    write({"workspaces": {"default": {"data_root": str(cfg_dir.parent)}}})
    with pytest.raises(WorkspaceDataRootError, match="data home or an ancestor"):
        default_workspace_data_root()


def test_symlink_into_sensitive_dir_is_rejected(cfg_env, tmp_path, monkeypatch):
    """A symlink whose target is sensitive is caught: realpath runs before the
    sensitivity check, so the symlink cannot hide the real destination. Uses a
    real symlink and a real (monkeypatched) classifier target, not a blanket
    True."""
    _cfg_dir, write = cfg_env
    secret = tmp_path / "secret-real"
    secret.mkdir()
    link = tmp_path / "innocent-looking"
    link.symlink_to(secret, target_is_directory=True)
    # Classify only the resolved real target as sensitive; if realpath did not
    # run first the link path would be checked and slip through.
    monkeypatch.setattr(
        "kiro_crew.security.is_sensitive_path",
        lambda p: str(p) == str(secret.resolve()),
    )
    write({"workspaces": {"default": {"data_root": str(link)}}})
    with pytest.raises(WorkspaceDataRootError, match="sensitive path"):
        default_workspace_data_root()


def test_transient_load_failure_is_not_cached(cfg_env, monkeypatch):
    """A transient config-load failure returns the base but must NOT freeze it:
    a later call, once the configured root is readable, honours it."""
    cfg_dir, write = cfg_env
    target = cfg_dir / "relocated-data"
    target.mkdir()
    write({"workspaces": {"default": {"data_root": str(target)}}})

    import kiro_crew.config.loader as _loader

    real_load = _loader.KiroCrewConfig.load
    calls = {"n": 0}

    def flaky_load(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("config.json mid-write")
        return real_load(*a, **k)

    monkeypatch.setattr(_loader.KiroCrewConfig, "load", staticmethod(flaky_load))
    # First call: load raises -> base, not cached.
    assert default_workspace_data_root() == _loader.config_dir() / "workspace"
    # Second call: load succeeds -> the configured root wins (fallback was not
    # frozen).
    assert default_workspace_data_root() == target


def test_result_is_cached_once_per_process(cfg_env):
    cfg_dir, write = cfg_env
    write({"workspaces": {"default": {"dir": "workspace"}}})
    first = default_workspace_data_root()
    assert first == cfg_dir / "workspace"
    # Rewrite the file WITHOUT clearing the cache: the frozen value must win,
    # so the gateway and MCP subprocess cannot drift onto different dirs.
    target = cfg_dir / "relocated-data"
    target.mkdir()
    cfg_file = cfg_dir / "config.json"
    cfg_file.write_text(json.dumps({"workspaces": {"default": {"data_root": str(target)}}}))
    assert default_workspace_data_root() == first  # still the cached value


def test_memory_workspace_dir_routes_through_resolver(cfg_env):
    cfg_dir, write = cfg_env
    target = cfg_dir / "relocated-data"
    target.mkdir()
    write({"workspaces": {"default": {"data_root": str(target)}}})
    assert memory.workspace_dir() == target
    assert memory.memory_dir() == target / memory.MEMORY_DIR_NAME


def test_config_sources_are_on_the_write_deny_floor():
    """The key is only operator-safe because the files that can set it cannot be
    agent-edited. ``KiroCrewConfig.load()`` reads ``config.json`` and the
    ``config.local.json`` overlay (which deep-merges over it); BOTH are on
    ``_WRITE_PROTECTED_HOME_PATHS``. If either ever left the floor an agent could
    relocate its own data root; this pins that dependency.
    """
    from kiro_crew.config.loader import config_local_path, config_path
    from kiro_crew.security import is_sensitive_write_path

    assert is_sensitive_write_path(str(config_path()))
    assert is_sensitive_write_path(str(config_local_path()))


def test_outside_data_home_is_rejected(cfg_env, tmp_path):
    """A root outside the data home is refused: the backup/snapshot archivers
    only cover the data home, so an outside root would be silently omitted from
    every backup."""
    cfg_dir, write = cfg_env
    outside = tmp_path / "elsewhere"  # sibling of cfg_dir, not under it
    outside.mkdir()
    write({"workspaces": {"default": {"data_root": str(outside)}}})
    with pytest.raises(WorkspaceDataRootError, match="outside the data home"):
        default_workspace_data_root()


def test_relocation_refused_while_old_tree_has_data(cfg_env):
    """Setting data_root while the built-in memory tree still holds markdown is
    refused, so boot never imports from the old path and flips migrated with
    nothing imported."""
    cfg_dir, write = cfg_env
    old_memory = cfg_dir / "workspace" / "memory"
    old_memory.mkdir(parents=True)
    (old_memory / "preferences.md").write_text("- a real preference\n")
    target = cfg_dir / "relocated-data"
    target.mkdir()
    write({"workspaces": {"default": {"data_root": str(target)}}})
    with pytest.raises(WorkspaceDataRootError, match="holds data"):
        default_workspace_data_root()


def test_relocation_allowed_once_old_tree_cleared(cfg_env):
    """With the built-in tree empty (operator moved it), the same relocation is
    honoured."""
    cfg_dir, write = cfg_env
    target = cfg_dir / "relocated-data"
    target.mkdir()
    write({"workspaces": {"default": {"data_root": str(target)}}})
    assert default_workspace_data_root() == target


def test_degraded_config_falls_back_without_caching(cfg_env, monkeypatch):
    """A torn read (degraded defaults, no raise) must fall back to the built-in
    base WITHOUT caching, so a later clean load honours the configured root."""
    cfg_dir, write = cfg_env
    target = cfg_dir / "relocated-data"
    target.mkdir()
    write({"workspaces": {"default": {"data_root": str(target)}}})

    import kiro_crew.config.loader as _loader
    from kiro_crew.config.resolution import DEGRADED_WHOLE_CONFIG

    real_load = _loader.KiroCrewConfig.load
    calls = {"n": 0}

    def degraded_once(*a, **k):
        calls["n"] += 1
        cfg = real_load(*a, **k)
        if calls["n"] == 1:
            object.__setattr__(cfg, "_degraded_sections", frozenset({DEGRADED_WHOLE_CONFIG}))
        return cfg

    monkeypatch.setattr(_loader.KiroCrewConfig, "load", staticmethod(degraded_once))
    # First (degraded) call: base, not cached.
    assert default_workspace_data_root() == cfg_dir / "workspace"
    # Second (clean) call: configured root wins.
    assert default_workspace_data_root() == target


def test_split_scenario_blocks_migration_detection(cfg_env):
    """The data-loss path is: boot detects legacy content, migrates from the OLD
    path, imports nothing, and flips migrated=True. The resolver refusal closes
    it at the source — in the split state ``legacy_memory_present()`` (which
    boot calls BEFORE migrating) raises, so boot's migration aborts and never
    reaches ``_set_memory_migrated(True)``."""
    cfg_dir, write = cfg_env
    old_memory = cfg_dir / "workspace" / "memory"
    old_memory.mkdir(parents=True)
    (old_memory / "projects.md").write_text("- a real project\n")
    target = cfg_dir / "relocated-data"
    target.mkdir()
    write({"workspaces": {"default": {"data_root": str(target)}}})
    with pytest.raises(WorkspaceDataRootError):
        memory.legacy_memory_present()
