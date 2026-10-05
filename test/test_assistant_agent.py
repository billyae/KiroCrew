"""The managed ``kirocrew-captain`` template.

Pins the narrowed default toolset plus the assistant's guide mount and two
ceiling-filtered read grants, a model that mirrors ``agent.model`` (never a literal), a skill
mapping that reaches the packaged skills, and a
prompt that teaches the assistant role without naming tools this build does not
ship. Every test writes to a private agents dir under the isolated data home;
nothing here touches a live ``~/.kiro/agents``.
"""

from __future__ import annotations

import dataclasses
import json
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from kiro_crew import agent, agent_state
from kiro_crew.agent_files import (
    AGENT_FILENAME,
    ASSISTANT_AGENT_FILENAME,
    OWNED_KIRO_AGENT_FILES,
    is_assistant_member,
)
from kiro_crew.kiro_cli import SPEC_PERMISSIONS_MIN_VERSION

GUIDE_SERVER = "kirocrew-guide"
GUIDE_REF = f"@{GUIDE_SERVER}"
#: Discovery, status, the inert offer (``guide_start`` shows a card the user
#: must press Start on) and cancel (removes this conversation's pointer only).
GUIDE_READ_REFS = {
    f"{GUIDE_REF}/guide_list_actions",
    f"{GUIDE_REF}/guide_start",
    f"{GUIDE_REF}/guide_status",
    f"{GUIDE_REF}/guide_cancel",
}
#: Change-card tools: a proposal changes nothing until the owner confirms it.
CARD_REFS = {
    f"{GUIDE_REF}/list_change_kinds",
    f"{GUIDE_REF}/find_setting",
    f"{GUIDE_REF}/get_member_capabilities",
    f"{GUIDE_REF}/diagnose_settings",
    f"{GUIDE_REF}/propose_change",
    f"{GUIDE_REF}/get_change_status",
}
CREW_LOG_SERVER = "kirocrew-crew-log"
CREW_LOG_REF = f"@{CREW_LOG_SERVER}"
#: The read-only crew log: the server has no write tool at all.
CREW_LOG_REFS = {
    f"{CREW_LOG_REF}/crew_log_list",
    f"{CREW_LOG_REF}/crew_log_read",
    f"{CREW_LOG_REF}/crew_log_projection",
}
#: Captain's Global-memory read and preference line; the gateway admits Captain only.
MEMORY_REFS = {
    f"{GUIDE_REF}/global_memory_recall",
    f"{GUIDE_REF}/global_preference_add",
}
#: The packaged-docs search and location index: read files shipped with Kiro Crew, no user state.
DOCS_REFS = {f"{GUIDE_REF}/search_docs", f"{GUIDE_REF}/find_ui"}
GRANTED_REFS = GUIDE_READ_REFS | CARD_REFS | MEMORY_REFS | DOCS_REFS | CREW_LOG_REFS


@pytest.fixture()
def agents_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    directory = tmp_path / "agents"
    directory.mkdir()
    monkeypatch.setattr(agent, "kiro_agents_dir_path", lambda: directory)
    monkeypatch.setattr(agent, "KIRO_AGENTS_DIR", directory)
    monkeypatch.setattr(
        "kiro_crew.kiro_cli.installed_kiro_cli_version", lambda: SPEC_PERMISSIONS_MIN_VERSION
    )
    return directory


def _install(agents_dir: Path) -> dict[str, Any]:
    agent._install_assistant_agent()
    return json.loads((agents_dir / ASSISTANT_AGENT_FILENAME).read_text(encoding="utf-8"))


def _refs(value: object) -> list[str]:
    return [ref for ref in value if isinstance(ref, str)] if isinstance(value, list) else []


def test_the_assistant_is_a_managed_file() -> None:
    assert ASSISTANT_AGENT_FILENAME == "kirocrew-captain.json"
    assert ASSISTANT_AGENT_FILENAME in OWNED_KIRO_AGENT_FILES


def test_the_spec_is_the_template_or_narrower(agents_dir: Path) -> None:
    spec = _install(agents_dir)
    template = agent.build_agent_config()
    assert spec["name"] == "kirocrew-captain"
    # The ONE explicit widening is the gated guide mount; everything else is the
    # template or narrower.
    tools = set(_refs(spec["tools"])) - {GUIDE_REF, CREW_LOG_REF}
    servers = set(spec["mcpServers"]) - {GUIDE_SERVER, CREW_LOG_SERVER}
    assert tools <= set(_refs(template["tools"]))
    assert set(_refs(spec["allowedTools"])) - GRANTED_REFS <= set(_refs(template["allowedTools"]))
    assert "*" not in spec["tools"] and "*" not in spec["allowedTools"]
    assert servers <= set(template["mcpServers"])
    for name in servers:
        entry = spec["mcpServers"][name]
        theirs = template["mcpServers"][name].get("autoApprove") or []
        assert set(entry.get("autoApprove") or []) <= set(theirs), name
    # Governance travels unchanged: bundled hooks and the subagent allowlist.
    assert spec["hooks"] == template["hooks"]
    assert spec.get("toolsSettings") == template.get("toolsSettings")
    assert spec["includeMcpJson"] is False
    # The KAS block is derived from the final grant list, never widened.
    from kiro_crew.agent_sdk.drivers.acp import derived_agent_permissions

    assert spec["permissions"] == derived_agent_permissions(
        spec["allowedTools"], ASSISTANT_AGENT_FILENAME
    )


def test_a_narrowed_default_narrows_the_assistant(agents_dir: Path) -> None:
    template = agent.build_agent_config()
    granted = _refs(template["allowedTools"])
    assert len(granted) >= 2, "the template grants something to narrow"
    keep = granted[-1]
    (agents_dir / AGENT_FILENAME).write_text(
        json.dumps(
            {
                "name": "kirocrew",
                "tools": ["fs_read", "grep", "@kirocrew-core", "@user-only"],
                "allowedTools": [keep, "@user-only"],
            }
        ),
        encoding="utf-8",
    )
    spec = _install(agents_dir)
    # Narrowing runs BEFORE the explicit guide grant, so a default that never
    # names the opt-in set cannot narrow it back out.
    assert spec["tools"] == ["fs_read", "grep", "@kirocrew-core", GUIDE_REF, CREW_LOG_REF]
    assert set(spec["allowedTools"]) == {keep} | GRANTED_REFS
    # A server no remaining ref names is not mounted.
    assert set(spec["mcpServers"]) == {"kirocrew-core", GUIDE_SERVER, CREW_LOG_SERVER}
    # A default-only entry never arrives: the intersection only removes.
    assert "@user-only" not in spec["tools"] + spec["allowedTools"]


def test_a_wildcard_default_imposes_no_narrowing(agents_dir: Path) -> None:
    (agents_dir / AGENT_FILENAME).write_text(
        json.dumps({"name": "kirocrew", "tools": ["*"], "allowedTools": ["*"]}), encoding="utf-8"
    )
    spec = _install(agents_dir)
    template = agent.build_agent_config()
    assert spec["tools"] == template["tools"] + [GUIDE_REF, CREW_LOG_REF]
    assert set(spec["allowedTools"]) == set(template["allowedTools"]) | GRANTED_REFS


def test_only_guide_reads_and_card_tools_are_auto_approved_on_the_assistant(
    agents_dir: Path,
) -> None:
    spec = _install(agents_dir)
    assert GUIDE_REF in spec["tools"]
    entry = spec["mcpServers"][GUIDE_SERVER]
    assert entry["args"][-1] == "mcp-guide"
    assert "autoApprove" not in entry
    guide_grants = {
        ref
        for ref in _refs(spec["allowedTools"])
        if ref == GUIDE_REF or ref.startswith(f"{GUIDE_REF}/")
    }
    assert guide_grants == GUIDE_READ_REFS | CARD_REFS | MEMORY_REFS | DOCS_REFS
    assert f"{GUIDE_REF}/guide_start" in guide_grants
    assert f"{GUIDE_REF}/guide_cancel" in guide_grants
    matches = {
        match
        for rule in spec["permissions"]["rules"]
        if rule["capability"] == "mcp" and rule["effect"] == "allow"
        for match in rule.get("match", [])
        if match.startswith(f"{GUIDE_SERVER}/")
    }
    assert matches == {
        ref.removeprefix("@") for ref in GUIDE_READ_REFS | CARD_REFS | MEMORY_REFS | DOCS_REFS
    }
    assert "autoApprove" not in agent._MANAGED_MCP_SERVERS[GUIDE_SERVER]
    template = agent.build_agent_config()
    assert GUIDE_SERVER not in template["mcpServers"]
    assert GUIDE_REF not in _refs(template["tools"])


def test_the_read_only_crew_log_is_mounted_and_its_reads_pre_approved(agents_dir: Path) -> None:
    from kiro_crew import mcp_crew_log

    spec = _install(agents_dir)
    assert CREW_LOG_REF in spec["tools"]
    entry = spec["mcpServers"][CREW_LOG_SERVER]
    assert entry["args"][-1] == "mcp-crew-log"
    assert "autoApprove" not in entry
    granted = {r for r in _refs(spec["allowedTools"]) if r.startswith(f"{CREW_LOG_REF}/")}
    assert granted == CREW_LOG_REFS
    # Every grant names a tool the server actually ships, and it ships no others.
    assert {r.rsplit("/", 1)[1] for r in granted} == set(mcp_crew_log.TOOLS)
    matches = {
        match
        for rule in spec["permissions"]["rules"]
        if rule["capability"] == "mcp" and rule["effect"] == "allow"
        for match in rule.get("match", [])
        if match.startswith(f"{CREW_LOG_SERVER}/")
    }
    assert matches == {ref.removeprefix("@") for ref in CREW_LOG_REFS}
    template = agent.build_agent_config()
    assert CREW_LOG_SERVER not in template["mcpServers"]
    assert CREW_LOG_REF not in _refs(template["tools"])


def test_crew_log_grants_respect_the_ceiling(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    denied = {f"{CREW_LOG_REF}/crew_log_read", f"{GUIDE_REF}/diagnose_settings"}
    monkeypatch.setattr(agent, "_may_auto_approve", lambda ref: ref not in denied)
    spec = _install(agents_dir)
    assert CREW_LOG_SERVER in spec["mcpServers"]
    assert not denied.intersection(spec["allowedTools"])
    assert (CREW_LOG_REFS - denied) <= set(spec["allowedTools"])


@pytest.mark.parametrize(
    "denied",
    [GUIDE_READ_REFS, {f"{GUIDE_REF}/guide_status"}, {f"{GUIDE_REF}/guide_start"}],
)
def test_guide_read_grants_respect_the_ceiling(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch, denied: set[str]
) -> None:
    monkeypatch.setattr(agent, "_may_auto_approve", lambda ref: ref not in denied)
    spec = _install(agents_dir)
    assert GUIDE_REF in spec["tools"]
    assert GUIDE_SERVER in spec["mcpServers"]
    assert GUIDE_READ_REFS.intersection(spec["allowedTools"]) == GUIDE_READ_REFS - denied
    matches = {
        match
        for rule in spec["permissions"]["rules"]
        if rule["capability"] == "mcp" and rule["effect"] == "allow"
        for match in rule.get("match", [])
    }
    assert not {ref.removeprefix("@") for ref in denied}.intersection(matches)


@pytest.mark.parametrize("denied", [{f"{GUIDE_REF}/find_ui"}, DOCS_REFS])
def test_the_find_ui_grant_respects_the_ceiling(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch, denied: set[str]
) -> None:
    """find_ui is an exact grant subject to the shared ceiling: a denial removes it
    from allowedTools AND from the generated permission rules, while the server
    stays mounted (the user is asked instead)."""
    monkeypatch.setattr(agent, "_may_auto_approve", lambda ref: ref not in denied)
    spec = _install(agents_dir)
    assert GUIDE_SERVER in spec["mcpServers"]
    assert not denied.intersection(spec["allowedTools"])
    assert (DOCS_REFS - denied) <= set(spec["allowedTools"])
    matches = {
        match
        for rule in spec["permissions"]["rules"]
        if rule["capability"] == "mcp" and rule["effect"] == "allow"
        for match in rule.get("match", [])
    }
    assert not {ref.removeprefix("@") for ref in denied}.intersection(matches)
    assert f"{GUIDE_SERVER}/find_ui" not in matches


def test_the_ceiling_withholds_on_the_assistant_too(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(agent, "_may_auto_approve", lambda ref: ref != "@kirocrew-core")
    spec = _install(agents_dir)
    assert "@kirocrew-core" not in spec["allowedTools"]
    assert "@kirocrew-core" in spec["tools"]


def _set_default_model(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, model: object) -> None:
    """Write config.json ``agent.model`` in the isolated data home."""
    from kiro_crew.config.loader import update_config_locked

    update_config_locked(mutate=lambda data: {**data, "agent": {"model": model}})


def _set_overlay_model(model: object) -> None:
    """Write ``agent.model`` into the config.local.json overlay only."""
    from kiro_crew.config.loader import config_local_path, update_config_locked

    update_config_locked(
        config_local_path(),
        mutate=lambda data: {**data, "agent": {"model": model}},
        stamp_meta=False,
    )


def test_the_overlay_default_outranks_the_base_default(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Captain mirrors the EFFECTIVE ``agent.model`` -- base with the
    config.local.json overlay merged over it -- the value every other session
    resolves, not the base file alone."""
    _set_default_model(monkeypatch, tmp_path, "base-default")
    assert _install(agents_dir)["model"] == "base-default"
    _set_overlay_model("overlay-default")
    assert _install(agents_dir)["model"] == "overlay-default"


def test_an_overlay_only_default_reaches_captain(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """An ``agent.model`` set only in the overlay (no base value) is mirrored."""
    from kiro_crew.config.loader import config_path

    _set_overlay_model("overlay-only")
    base = json.loads(config_path().read_text(encoding="utf-8")) if config_path().exists() else {}
    assert "model" not in (base.get("agent") or {})
    assert _install(agents_dir)["model"] == "overlay-only"


def test_an_explicit_captain_pin_outranks_an_overlay_default(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = agents_dir / ASSISTANT_AGENT_FILENAME
    spec = _install(agents_dir)
    spec["model"] = "picked"
    path.write_text(json.dumps(spec), encoding="utf-8")
    agent_state.set_model_managed("kirocrew-captain", False)
    _set_default_model(monkeypatch, tmp_path, "base-default")
    _set_overlay_model("overlay-default")
    assert _install(agents_dir)["model"] == "picked"


@pytest.mark.parametrize("configured", [None, "auto", " auto ", 7])
def test_an_unset_or_auto_default_leaves_the_inherit_sentinel(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, configured: object
) -> None:
    from kiro_crew.config.sections import DEFAULT_MODEL

    _set_default_model(monkeypatch, tmp_path, configured)
    assert _install(agents_dir)["model"] == DEFAULT_MODEL


def test_an_explicit_default_is_mirrored_into_the_spec(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The default agent's propagation: an explicit ``agent.model`` lands in the spec."""
    _set_default_model(monkeypatch, tmp_path, "first-default")
    assert _install(agents_dir)["model"] == "first-default"


def _captain_resolutions(agents_dir: Path, monkeypatch: pytest.MonkeyPatch, model: str) -> dict:
    """What every session-start resolver picks for Captain under ``agent.model``."""
    from kiro_crew import session
    from kiro_crew.config.loader import AgentConfig, KiroCrewConfig, resolve_effective_model

    monkeypatch.setattr("kiro_crew.config.loader.kiro_agents_dir", lambda: agents_dir)
    # The chip reads the process-wide materialized-agent snapshot; an earlier
    # test in the same worker can leave it built from another agents dir.
    from kiro_crew.config import loader

    for name in (
        "_MATERIALIZED_AGENTS",
        "_MATERIALIZED_AGENTS_READY",
        "_MATERIALIZED_AGENTS_GENERATION",
        "_MATERIALIZED_REFRESH_ISSUED",
        "_MATERIALIZED_REFRESH_APPLIED",
    ):
        monkeypatch.setattr(loader, name, getattr(loader, name))
    loader.refresh_materialized_agents()
    cfg = KiroCrewConfig(agent=AgentConfig(model=model))
    return {
        # The session layer's pick; None defers to the factory because the
        # template itself pins.
        "session": session._session_model(cfg, "kirocrew-captain", crew_agent=""),
        # The factory's own pick when the caller supplied no model.
        "factory": cfg.acp_effective_model("kirocrew-captain", None),
        # The chip.
        "chip": resolve_effective_model(cfg, "kirocrew-captain", selection_kind="template"),
    }


def test_a_default_model_change_reaches_captain_through_the_rebuild(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Each Settings change reruns the install (the ``agent.model`` applier's
    ``rebuild_agent_config``); the next Captain session then runs the new default."""
    for default in ("first-default", "second-default"):
        _set_default_model(monkeypatch, tmp_path, default)
        assert _install(agents_dir)["model"] == default
        picks = _captain_resolutions(agents_dir, monkeypatch, default)
        assert picks == {"session": None, "factory": default, "chip": default}


def test_the_default_model_rebuild_moves_captain_with_the_default_agent(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """``rebuild_agent_config`` -- what the ``agent.model`` config applier runs --
    rewrites Captain's model alongside ``kirocrew.json``'s, so no separate watcher
    is needed for a Settings change to reach Captain."""
    from kiro_crew.config.loader import update_config_locked

    bindir = tmp_path / "bin"
    bindir.mkdir()
    launcher = bindir / "kirocrew"
    launcher.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    launcher.chmod(0o755)
    monkeypatch.setattr(agent, "_KIROCREW_BIN", str(launcher))
    monkeypatch.setattr(agent, "_KIRO_MCP_JSON", tmp_path / "kiro-global-mcp.json")
    monkeypatch.setattr(agent, "_DEFAULT_KIRO_HOOKS_DIR", tmp_path / "hooks")
    monkeypatch.setattr(
        "kiro_crew.apps.bridges._mcp_json_path", lambda: agents_dir / AGENT_FILENAME
    )

    def models() -> tuple[str, str]:
        return tuple(  # type: ignore[return-value]
            json.loads((agents_dir / name).read_text(encoding="utf-8"))["model"]
            for name in (AGENT_FILENAME, ASSISTANT_AGENT_FILENAME)
        )

    # The default agent propagates on its refresh path, i.e. once a spec exists:
    # the first boot writes the template, every later rebuild refreshes it.
    agent.rebuild_agent_config()
    for default in ("first-default", "second-default"):
        update_config_locked(mutate=lambda data, d=default: {**data, "agent": {"model": d}})
        agent.rebuild_agent_config()
        assert models() == (default, default)


def test_an_explicit_captain_pin_outranks_a_changed_default(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = agents_dir / ASSISTANT_AGENT_FILENAME
    spec = _install(agents_dir)
    spec["model"] = "picked"
    path.write_text(json.dumps(spec), encoding="utf-8")
    agent_state.set_model_managed("kirocrew-captain", False)
    _set_default_model(monkeypatch, tmp_path, "some-default")
    assert _install(agents_dir)["model"] == "picked"
    picks = _captain_resolutions(agents_dir, monkeypatch, "some-default")
    assert picks == {"session": None, "factory": "picked", "chip": "picked"}


@pytest.mark.parametrize(
    ("spec_model", "expected"),
    [
        # A per-agent pin outranks the global default.
        ("own-pin", {"session": None, "factory": "own-pin"}),
        # A spec saying "auto" still shadows the global at the session layer
        # (kiro resolves it natively) and pins nothing at the factory.
        ("auto", {"session": None, "factory": ""}),
        # No model field: the global applies.
        (None, {"session": "the-default", "factory": "the-default"}),
    ],
)
def test_ordinary_named_agent_precedence_is_unchanged(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch, spec_model: object, expected: dict
) -> None:
    """Captain's propagation lives in its installer; the resolvers keep HEAD's
    precedence for every other named agent."""
    from kiro_crew import session
    from kiro_crew.config.loader import AgentConfig, KiroCrewConfig

    spec: dict[str, Any] = {"name": "b1-ordinary"}
    if spec_model is not None:
        spec["model"] = spec_model
    from kiro_crew.agent_discovery import clear_list_agents_cache

    (agents_dir / "b1-ordinary.json").write_text(json.dumps(spec), encoding="utf-8")
    # A direct write, so drop the parsed-spec snapshot the way the agent write
    # paths do.
    clear_list_agents_cache()
    monkeypatch.setattr("kiro_crew.config.loader.kiro_agents_dir", lambda: agents_dir)
    cfg = KiroCrewConfig(agent=AgentConfig(model="the-default"))
    assert {
        "session": session._session_model(cfg, "b1-ordinary", crew_agent=""),
        "factory": cfg.acp_effective_model("b1-ordinary", None),
    } == expected


def test_the_installer_names_no_model_literal() -> None:
    """The model line is the configured default, the sentinel or the user's pin."""
    from kiro_crew.agent_materialization import assistant_agent

    source = Path(assistant_agent.__file__).read_text(encoding="utf-8")
    assert not re.search(r"""["'](?:claude|opus|sonnet|haiku|gpt|fable)[-\w.]*["']""", source)
    assert re.search(r'config\["model"\] = default_model or DEFAULT_MODEL\b', source)


def test_an_explicit_model_pick_survives_a_rebuild(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = agents_dir / ASSISTANT_AGENT_FILENAME
    spec = _install(agents_dir)
    spec["model"] = "picked"
    path.write_text(json.dumps(spec), encoding="utf-8")
    assert _install(agents_dir)["model"] == "auto"  # no pin recorded: propagation
    spec["model"] = "picked"
    path.write_text(json.dumps(spec), encoding="utf-8")
    agent_state.set_model_managed("kirocrew-captain", False)
    assert _install(agents_dir)["model"] == "picked"


def test_a_foreign_file_at_the_path_is_left_alone(agents_dir: Path) -> None:
    foreign = {"name": "kirocrew-captain", "prompt": "my own persona", "tools": ["*"]}
    path = agents_dir / ASSISTANT_AGENT_FILENAME
    path.write_text(json.dumps(foreign), encoding="utf-8")
    agent._install_assistant_agent()
    assert json.loads(path.read_text(encoding="utf-8")) == foreign


def test_refresh_outcomes_separate_preserved_from_stale(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only a spec left STALE is a refresh failure; a written spec, a pinned
    model and a foreign template are not."""
    from kiro_crew.agent_materialization import assistant_agent

    path = agents_dir / ASSISTANT_AGENT_FILENAME
    # An older verdict on this thread is superseded by the next install's.
    assistant_agent._record_refresh_failure("left by an earlier install")
    # Written.
    assert agent._install_assistant_agent() is True
    assert assistant_agent.take_refresh_failure() is None
    # A dashboard pin is carried into the rewrite.
    agent_state.set_model_managed("kirocrew-captain", False)
    assert agent._install_assistant_agent() is True
    assert assistant_agent.take_refresh_failure() is None
    # Overrides unreadable: the spec is kept as it was -- stale.
    with monkeypatch.context() as m:
        m.setattr(
            agent_state, "get_member_overrides", lambda _name: (_ for _ in ()).throw(OSError("x"))
        )
        assert agent._install_assistant_agent() is False
        assert assistant_agent.take_refresh_failure() == "Captain capability overrides unreadable"
    # Unreadable spec: refused, stale.
    path.write_text("{broken", encoding="utf-8")
    assert agent._install_assistant_agent() is False
    assert "unreadable" in (assistant_agent.take_refresh_failure() or "")
    # Foreign template: the operator's file, deliberately kept -- not a failure.
    path.write_text(json.dumps({"name": "kirocrew-captain", "prompt": "mine"}), encoding="utf-8")
    assert agent._install_assistant_agent() is False
    assert assistant_agent.take_refresh_failure() is None


def test_a_raising_captain_install_is_recorded_by_the_rebuild(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """``rebuild_agent_config`` keeps booting past a Captain install that raised,
    but records it for the ``agent.model`` applier instead of only logging."""
    from kiro_crew.agent_materialization import assistant_agent

    bindir = tmp_path / "bin"
    bindir.mkdir()
    launcher = bindir / "kirocrew"
    launcher.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    launcher.chmod(0o755)
    monkeypatch.setattr(agent, "_KIROCREW_BIN", str(launcher))
    monkeypatch.setattr(agent, "_KIRO_MCP_JSON", tmp_path / "kiro-global-mcp.json")
    monkeypatch.setattr(agent, "_DEFAULT_KIRO_HOOKS_DIR", tmp_path / "hooks")
    monkeypatch.setattr(
        "kiro_crew.apps.bridges._mcp_json_path", lambda: agents_dir / AGENT_FILENAME
    )

    def _boom() -> bool:
        raise OSError("disk full")

    assistant_agent.take_refresh_failure()
    _path, wrote = agent.rebuild_agent_config_reporting()
    assert wrote and assistant_agent.take_refresh_failure() is None
    monkeypatch.setattr(assistant_agent, "_install_assistant_agent", _boom)
    _path, wrote = agent.rebuild_agent_config_reporting()
    assert wrote
    assert assistant_agent.take_refresh_failure() == "Captain template install raised"


def test_a_spec_left_under_the_old_template_name_is_an_ordinary_template(agents_dir: Path) -> None:
    """``kirocrew-assistant.json`` from before the rename is left byte-for-byte.

    It is not an owned file, its name is not Captain's template and its old
    ``# Kiro Crew Assistant`` mark is not the installer's, so nothing treats it as
    Captain: it lists as an ordinary user template.
    """
    stale = agents_dir / "kirocrew-assistant.json"
    old = {"name": "kirocrew-assistant", "prompt": "# Kiro Crew Assistant\n\nold role"}
    stale.write_bytes(json.dumps(old).encode("utf-8"))
    before = stale.read_bytes()
    spec = _install(agents_dir)
    assert stale.read_bytes() == before
    assert spec["name"] == "kirocrew-captain"
    assert spec["prompt"].startswith("# Kiro Crew Captain")
    assert "kirocrew-assistant.json" not in OWNED_KIRO_AGENT_FILES
    assert not agent._is_installed_assistant_spec(old)
    assert not is_assistant_member("kirocrew-captain", {"kiro_agent": "kirocrew-assistant"})


def test_reinstall_is_stable(agents_dir: Path) -> None:
    first = _install(agents_dir)
    assert _install(agents_dir) == first


def test_the_skill_mapping_reaches_the_packaged_skills(agents_dir: Path) -> None:
    from kiro_crew.agent_discovery import agent_skill_globs
    from kiro_crew.config import config_dir

    spec = _install(agents_dir)
    skills = [r for r in spec["resources"] if r.startswith("skill://")]
    home_glob = f"{(config_dir() / 'skills').as_posix()}/*/SKILL.md"
    assert f"skill://{home_glob}" in skills
    # The template's steering glob is kept, not replaced.
    assert set(agent.build_agent_config().get("resources") or []) <= set(spec["resources"])
    globs = agent_skill_globs("kirocrew-captain", agents_dir=agents_dir)
    assert globs, "a custom agent without a mapping receives no skill directory"
    import fnmatch

    builtin = (config_dir() / "skills" / "kirocrew-commands" / "SKILL.md").as_posix()
    assert any(fnmatch.fnmatch(builtin, g.replace("\\", "/")) for g in globs)


def _role_section(prompt: str, title: str) -> str:
    """The text under one ``### <title>`` heading of the role, up to the next heading."""
    return prompt.split(f"\n### {title}\n", 1)[1].split("\n### ", 1)[0]


def test_the_prompt_teaches_the_assistant_role(agents_dir: Path) -> None:
    # Structure only: the wording is the prompt's to change, and its effect is
    # judged by running scenarios, not by matching phrases here.
    prompt = _install(agents_dir)["prompt"]
    assert prompt.startswith(agent._ASSISTANT_PROMPT_HEADER)
    assert "{docs_index}" not in prompt
    docs_index = Path(agent.__file__).resolve().parent / "docs" / "README.md"
    assert docs_index.as_posix() in prompt and docs_index.is_file()
    for title in (
        "First greeting and names",
        "Replies and ordinary work",
        "Locations and documentation",
        "Questions and troubleshooting",
        "Memory and personalization",
        "Teaching and recommendations",
        "Changing Kiro Crew",
        "Answers and guides",
    ):
        assert _role_section(prompt, title).strip(), title
    # Safety boundaries the role must keep: changes only through a proposal,
    # secrets only through a secure field, trust-root files never.
    changes = _role_section(prompt, "Changing Kiro Crew")
    assert "`propose_change`" in changes and "`secret.save`" in changes
    assert "never ask for passwords" in changes
    assert "Never touch trust-root files" in changes
    # Not the managed stub: it is this template's own persona.
    assert not agent.is_managed_prompt(prompt)


def test_every_tool_the_prompt_names_is_shipped(agents_dir: Path) -> None:
    """The prompt must not imply a tool (or an operation server) this build lacks."""
    spec = _install(agents_dir)
    titles = json.loads(
        (Path(agent.__file__).resolve().parent / "data" / "mcp_tool_titles.json").read_text(
            encoding="utf-8"
        )
    )
    shipped = {name for tools in titles.values() for name in tools} | set(_refs(spec["tools"]))
    from kiro_crew import mcp_crew_log, mcp_guide

    shipped |= {tool["name"] for tool in mcp_guide._list_tools()}
    shipped |= set(mcp_crew_log.TOOLS)
    # The role section is the assistant's own text; the inherited contract is
    # checked where it ships, for every agent.
    role = agent._ASSISTANT_SYSTEM_PROMPT
    assert role.strip() in spec["prompt"].replace(_docs_index(), "{docs_index}")
    named = set(re.findall(r"`([a-z]+(?:_[a-z]+)+)`", role))
    assert named, "the prompt names its tools in backticks"
    assert named <= shipped, named - shipped
    # No MCP server reference beyond what the spec mounts.
    servers = set(re.findall(r"@([a-z][a-z0-9-]+)", role))
    assert servers <= set(spec["mcpServers"])


def test_captain_confirms_a_guide_is_live_before_pointing_at_it() -> None:
    # A live eval had Captain twice telling the user a guide was waiting with a
    # Start button when the gateway held only a cancelled one.
    role = " ".join(agent._ASSISTANT_SYSTEM_PROMPT.split())
    assert "Before saying a guide is waiting for the user, confirm it with `guide_status`" in role
    assert "offer a new one instead of pointing at a card that is gone" in role


def test_captain_answers_with_lookups_and_offers_to_dig_deeper() -> None:
    # A question must never wait on an approval prompt nobody sees: Captain
    # answers from lookups, then OFFERS a slower dig and runs commands only
    # after the user agrees, under the user's own approval settings. Pinned because a live eval showed
    # turns hanging ten minutes on an unanswered shell approval.
    role = " ".join(agent._ASSISTANT_SYSTEM_PROMPT.split())
    assert "Answer questions from lookups first" in role
    assert "not machine commands or file reads without the user's agreement" in role
    assert "offer deeper machine investigation, saying it takes a little time" in role
    assert "under the user's own approval settings" in role
    # No per-command permission promise: commands follow the trust level.
    assert "permission for each command" not in role
    assert "never stop at “I don't know.”" in role
    assert "Only after agreement run commands" in role
    # Machine investigation is the LAST troubleshooting step, under that consent.
    steps = [
        role.index("- `diagnose_settings` with a fitting `topic`"),
        role.index("- For a particular run/session: `crew_log_list`"),
        role.index("- Packaged docs/skills for intended behavior."),
        role.index("- Machine investigation under the consent rule above."),
    ]
    assert steps == sorted(steps)
    # First-time setup is answered with the checklist even on a configured install.
    assert "give getting-started steps even on a configured install" in role
    assert "not just “you're already set up.”" in role


ASSISTANT_ROW = {
    "kiro_agent": "kirocrew-captain",
    "workspace": "default",
    "memory_store": "default",
    "member_id": "",
    "source": "builtin",
    "display_name": "",
}


def _saved() -> dict:
    from kiro_crew.config.loader import config_path

    return json.loads(config_path().read_text(encoding="utf-8"))


def _assert_private_captain(saved: dict) -> None:
    """Captain's row as created: the fixed fields, plus its own private V2 store."""
    row = dict(saved["agents"]["kirocrew-captain"])
    store, member_id = row.pop("memory_store"), row.pop("member_id")
    expected = {k: v for k, v in ASSISTANT_ROW.items() if k not in ("memory_store", "member_id")}
    assert row == expected
    assert member_id == "kirocrew-captain"
    assert store.startswith("member-kirocrew-captain-")
    declared = saved["memory_stores"][store]
    assert declared["memory_version"] == 2
    assert declared["owner_member_id"] == member_id


def test_rebuild_installs_and_creates_assistant_member_without_touching_default(
    agents_dir: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from kiro_crew.config.loader import update_config_locked

    bindir = tmp_path / "bin"
    bindir.mkdir()
    launcher = bindir / "kirocrew"
    launcher.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    launcher.chmod(0o755)
    monkeypatch.setattr(agent, "_KIROCREW_BIN", str(launcher))
    monkeypatch.setattr(agent, "_KIRO_MCP_JSON", tmp_path / "kiro-global-mcp.json")
    monkeypatch.setattr(agent, "_DEFAULT_KIRO_HOOKS_DIR", tmp_path / "hooks")
    monkeypatch.setattr(
        "kiro_crew.apps.bridges._mcp_json_path", lambda: agents_dir / AGENT_FILENAME
    )
    default_row = {"kiro_agent": "kirocrew", "workspace": "default", "memory_store": "default"}
    update_config_locked(mutate=lambda _: {"agents": {"default": dict(default_row)}})
    agent.rebuild_agent_config()
    assert (agents_dir / ASSISTANT_AGENT_FILENAME).is_file()
    default = json.loads((agents_dir / AGENT_FILENAME).read_text(encoding="utf-8"))
    assert default["name"] == "kirocrew"
    after = _saved()
    assert after["agents"]["default"] == default_row
    _assert_private_captain(after)
    assert after.get("agent", {}).get("default_agent", "kirocrew") == "kirocrew"


@pytest.mark.parametrize(
    "default_row",
    [
        {"kiro_agent": "kirocrew", "display_name": "Mochi", "workspace": "work"},
        {"kiro_agent": "custom-template"},
        {"kiro_agent": "kirocrew", "member_id": "v2-identity", "memory_store": "private"},
        {"kiro_agent": "kirocrew-captain"},
    ],
)
def test_creation_never_changes_the_default_member(agents_dir, default_row):
    from kiro_crew.config.loader import update_config_locked

    original = {
        "agents": {"default": dict(default_row)},
        "agent": {"default_agent": "kirocrew"},
        "default_agent": "default",
        "dashboard": {"user_role": "designer"},
    }
    update_config_locked(mutate=lambda _: json.loads(json.dumps(original)))
    agent._create_assistant_member_once(True)
    saved = _saved()
    assert saved["agents"]["default"] == default_row
    _assert_private_captain(saved)
    assert saved["agent"] == original["agent"]
    assert saved["default_agent"] == "default"
    assert saved["dashboard"] == original["dashboard"]


def test_a_deleted_assistant_member_is_not_recreated(agents_dir):
    from kiro_crew.config.loader import config_path, update_config_locked

    update_config_locked(mutate=lambda _: {"agents": {"default": {"kiro_agent": "kirocrew"}}})
    agent._create_assistant_member_once(True)
    saved = _saved()
    del saved["agents"]["kirocrew-captain"]
    update_config_locked(mutate=lambda _: saved)
    before = config_path().read_bytes()
    agent._create_assistant_member_once(True)
    assert config_path().read_bytes() == before


def test_an_existing_assistant_key_is_left_alone(agents_dir):
    from kiro_crew.config.loader import config_path, update_config_locked

    mine = {"kiro_agent": "my-template", "memory_store": "default"}
    update_config_locked(
        mutate=lambda _: {
            "agents": {"default": {"kiro_agent": "kirocrew"}, "kirocrew-captain": mine}
        }
    )
    before = config_path().read_bytes()
    agent._create_assistant_member_once(True)
    assert config_path().read_bytes() == before


def test_a_user_member_named_assistant_is_ordinary(agents_dir):
    """A member keyed ``assistant`` predates Captain's key: it is kept as-is and
    Captain is still created under its own key."""
    from kiro_crew.agent_files import is_assistant_member
    from kiro_crew.config.loader import update_config_locked

    mine = {"kiro_agent": "kirocrew-captain", "memory_store": "default", "display_name": ""}
    update_config_locked(
        mutate=lambda _: {"agents": {"default": {"kiro_agent": "kirocrew"}, "assistant": mine}}
    )
    agent._create_assistant_member_once(True)
    saved = _saved()
    assert saved["agents"]["assistant"] == mine
    assert not is_assistant_member("assistant", saved["agents"]["assistant"])
    _assert_private_captain(saved)


def test_an_overlay_assistant_key_is_left_alone(agents_dir):
    from kiro_crew.config.loader import config_local_path, config_path, update_config_locked

    update_config_locked(mutate=lambda _: {"agents": {"default": {"kiro_agent": "kirocrew"}}})
    update_config_locked(
        config_local_path(),
        mutate=lambda _: {"agents": {"kirocrew-captain": {"kiro_agent": "my-template"}}},
        stamp_meta=False,
    )
    before = config_path().read_bytes()
    agent._create_assistant_member_once(True)
    assert config_path().read_bytes() == before


def test_an_overlay_only_roster_gets_no_base_row(agents_dir):
    from kiro_crew.config.loader import config_local_path, config_path, update_config_locked

    update_config_locked(mutate=lambda _: {"dashboard": {"user_role": "designer"}})
    update_config_locked(
        config_local_path(),
        mutate=lambda _: {"agents": {"mine": {"kiro_agent": "my-template"}}},
        stamp_meta=False,
    )
    before = config_path().read_bytes()
    agent._create_assistant_member_once(True)
    assert config_path().read_bytes() == before


def test_an_empty_roster_keeps_the_implicit_default_member(agents_dir):
    from kiro_crew.config.loader import KiroCrewConfig, update_config_locked

    update_config_locked(mutate=lambda _: {"agent": {"default_agent": "my-template"}})
    agent._create_assistant_member_once(True)
    saved = _saved()
    assert saved["agents"]["default"] == {
        "kiro_agent": "my-template",
        "workspace": "default",
        "memory_store": "default",
    }
    _assert_private_captain(saved)
    cfg = KiroCrewConfig.load()
    assert cfg.default_agent == "default"
    assert set(cfg.agents) >= {"default", "kirocrew-captain"}


def test_a_template_that_did_not_install_creates_no_member(agents_dir):
    from kiro_crew.config.loader import config_path, update_config_locked

    update_config_locked(mutate=lambda _: {"agents": {"default": {"kiro_agent": "kirocrew"}}})
    before = config_path().read_bytes()
    agent._create_assistant_member_once(False)
    agent._create_assistant_member_once(True)
    assert config_path().read_bytes() == before


def test_the_assistant_member_resolves_to_its_own_private_store(agents_dir):
    from kiro_crew.config.loader import KiroCrewConfig, update_config_locked
    from kiro_crew.execution_context import resolve_member_execution
    from kiro_crew.memory_stores import DEFAULT_MEMORY_STORE, require_member_memory_store

    update_config_locked(mutate=lambda _: {"agents": {"default": {"kiro_agent": "kirocrew"}}})
    agent._create_assistant_member_once(True)
    cfg = KiroCrewConfig.load()
    store = require_member_memory_store(cfg, "kirocrew-captain")
    assert store != DEFAULT_MEMORY_STORE
    execution = resolve_member_execution(cfg, "kirocrew-captain", validate_memory_files=True)
    assert (execution.member_id, execution.store.store_id) == ("kirocrew-captain", store)


def _isolation_config():
    captain = dict(ASSISTANT_ROW, member_id="kirocrew-captain", memory_store="captain-v2")
    return SimpleNamespace(
        agents={
            "default": SimpleNamespace(kiro_agent="kirocrew", member_id="", memory_store="default"),
            "kirocrew-captain": SimpleNamespace(**captain),
            "crew": SimpleNamespace(
                kiro_agent="kirocrew-captain", member_id="m-crew", memory_store="crew-v2"
            ),
            "stray": SimpleNamespace(
                kiro_agent="kirocrew-captain", member_id="m-stray", memory_store="default"
            ),
        },
        memory_stores={
            "captain-v2": SimpleNamespace(
                memory_version=2, owner_member_id="kirocrew-captain", owner_member=""
            ),
            "crew-v2": SimpleNamespace(
                memory_version=2, owner_member_id="m-crew", owner_member="crew"
            ),
        },
    )


def test_assistant_member_execution_is_private_and_only_captain_is_captain():
    from kiro_crew.execution_context import (
        MemoryStoreRef,
        is_assistant_execution,
        resolve_member_execution,
    )
    from kiro_crew.memory_stores import UnknownMemoryStore, require_member_memory_store

    cfg = _isolation_config()
    assistant = resolve_member_execution(cfg, "kirocrew-captain")
    assert (assistant.member_id, assistant.store.store_id) == ("kirocrew-captain", "captain-v2")
    assert assistant.template_id == "kirocrew-captain"
    assert is_assistant_execution(cfg, assistant)
    # A private V2 crewmate on the SAME template resolves only to its own store,
    # and is not Captain: the key decides, not the template.
    assert require_member_memory_store(cfg, "crew", require_directory=False) == "crew-v2"
    crew = resolve_member_execution(cfg, "crew")
    assert crew.store.store_id == "crew-v2" and crew.member_id == "m-crew"
    assert not is_assistant_execution(cfg, crew)
    # Captain's store run under another template (a delegate) is not Captain.
    assert not is_assistant_execution(cfg, assistant.with_template("kirocrew", "kirocrew"))
    # A record whose store differs from Captain's binding is not Captain.
    moved = dataclasses.replace(assistant, store=MemoryStoreRef("crew-v2", "kirocrew-captain"))
    assert not is_assistant_execution(cfg, moved)
    # A member carrying a V2 identity can never be pointed at Global memory.
    with pytest.raises(UnknownMemoryStore):
        require_member_memory_store(cfg, "stray", require_directory=False)


def test_unreadable_assistant_template_is_preserved(agents_dir):
    target = agents_dir / ASSISTANT_AGENT_FILENAME
    target.write_text("{broken", encoding="utf-8")
    assert agent._install_assistant_agent() is False
    assert target.read_text(encoding="utf-8") == "{broken"


def _docs_index() -> str:
    return (Path(agent.__file__).resolve().parent / "docs" / "README.md").as_posix()


def test_the_template_file_holds_only_the_mark_and_the_role(agents_dir: Path) -> None:
    prompt = _install(agents_dir)["prompt"]
    role = agent._ASSISTANT_SYSTEM_PROMPT.replace("{docs_index}", _docs_index()).strip()
    assert prompt == f"{agent._ASSISTANT_PROMPT_HEADER}\n\n{role}\n"
    assert agent._is_installed_assistant_spec({"name": "kirocrew-captain", "prompt": prompt})
    contract = agent._prompt_path().read_text(encoding="utf-8")
    assert "{bot_name}" in contract or "{{WIDGET_BLOCK}}" in contract
    for placeholder in ("{bot_name}", "{{WIDGET_BLOCK}}", "{{MAX_SUBAGENTS}}", "{docs_index}"):
        assert placeholder not in prompt


def _context_builder(tmp_path: Path) -> Any:
    from kiro_crew.context import ContextBuilder
    from kiro_crew.learn import LessonStore
    from kiro_crew.memory import MemoryStore
    from kiro_crew.skills import SkillsLoader

    return ContextBuilder(
        memory=MemoryStore(workspace=tmp_path / "ws"),
        skills=SkillsLoader(skills_path=tmp_path / "skills", install_builtins=False),
        lessons=LessonStore(base_dir=tmp_path),
    )


def _injected(builder: Any, agent_name: str, *, mode: str = "") -> str:
    return builder._resolve_agent_prompt(
        agent_name,
        project=None,
        mode=mode,
        session_key="chat-test",
        is_cc=False,
        private_owner=False,
        session_start=True,
    )


@pytest.mark.parametrize("mode", ["", "orchestrator"])
def test_the_injected_block_is_the_ordinary_contract_then_the_role(
    agents_dir: Path, tmp_path: Path, mode: str
) -> None:
    _install(agents_dir)
    builder = _context_builder(tmp_path)
    ordinary = _injected(builder, "kirocrew", mode=mode)
    injected = _injected(builder, "kirocrew-captain", mode=mode)
    role = agent._ASSISTANT_SYSTEM_PROMPT.replace("{docs_index}", _docs_index()).strip()
    assert ordinary
    assert injected == f"{ordinary.strip()}\n\n{role}"
    # The contract reaches the model exactly once, its placeholders filled.
    assert injected.count(ordinary.strip()) == 1
    assert injected.count("## Output Format") == ordinary.count("## Output Format") == 1
    for placeholder in ("{bot_name}", "{{WIDGET_BLOCK}}", "{{MAX_SUBAGENTS}}", "{docs_index}"):
        assert placeholder not in injected


def test_the_injected_contract_is_the_users_own_prompt(
    agents_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    own = tmp_path / "prompt.md"
    own.write_text("# My operating contract\n\nAlways answer in haiku.\n", encoding="utf-8")
    monkeypatch.setattr(agent, "_user_prompt_path", lambda: own)
    prompt = _install(agents_dir)["prompt"]
    assert "Always answer in haiku." not in prompt
    injected = _injected(_context_builder(tmp_path), "kirocrew-captain")
    assert injected.startswith("# My operating contract\n\nAlways answer in haiku.")
    role = agent._ASSISTANT_SYSTEM_PROMPT.replace("{docs_index}", _docs_index()).strip()
    assert injected.endswith(f"\n\n{role}")


def test_a_hand_authored_assistant_file_keeps_its_own_prompt(
    agents_dir: Path, tmp_path: Path
) -> None:
    (agents_dir / ASSISTANT_AGENT_FILENAME).write_text(
        json.dumps({"name": "kirocrew-captain", "prompt": "My own assistant."}),
        encoding="utf-8",
    )
    assert _injected(_context_builder(tmp_path), "kirocrew-captain") == "My own assistant."


def test_offer_results_tell_the_model_how_to_reply(monkeypatch: pytest.MonkeyPatch) -> None:
    # The result of an offer carries the reply instruction at the moment the
    # model writes, and it follows the offer's real state.
    from kiro_crew import mcp_guide

    reply: dict[str, Any] = {}
    monkeypatch.setattr(mcp_guide, "_strict_session_key", lambda: ("dashboard:c", ""))
    monkeypatch.setattr(mcp_guide, "_post", lambda *a, **k: dict(reply))

    def next_for(name: str, args: dict[str, Any], **state: Any) -> str:
        reply.clear()
        reply.update({"id": "c1", **state})
        out = json.loads(mcp_guide._call_tool_inner(name, args))
        assert out["id"] == "c1"
        return out["next"]

    change = ("propose_change", {"kind": "setting.change", "params": {}})
    guide = ("guide_start", {"actions": [{"action_id": "settings.show"}]})
    for name, args in (change, guide):
        # No open tab: the offer is queued, so it is never described as shown.
        assert "Queued" in next_for(name, args, delivered_clients=0)
        assert "Shown above" in next_for(name, args, delivered_clients=1)
    # A widening change cannot be applied before its acknowledgement box.
    assert "box ticked" in next_for(*change, delivered_clients=1, risk="widen")
    assert "box ticked" not in next_for(*change, delivered_clients=1, risk="normal")


def test_an_undelivered_guide_is_never_described_as_on_screen(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # delivered_clients=0 means no tab took the frame: the hint must forbid
    # claiming a card the user can see, not merely say it is queued.
    from kiro_crew import mcp_guide

    monkeypatch.setattr(mcp_guide, "_strict_session_key", lambda: ("dashboard:c", ""))
    monkeypatch.setattr(
        mcp_guide, "_post", lambda *a, **k: {"guide_id": "g1", "delivered_clients": 0}
    )
    out = json.loads(
        mcp_guide._call_tool_inner("guide_start", {"actions": [{"action_id": "settings.show"}]})
    )
    assert "Never say you placed or showed it" in out["next"]


def test_a_refused_guide_start_says_no_card_was_shown(monkeypatch: pytest.MonkeyPatch) -> None:
    # A refusal says plainly that no card was shown, so Captain never claims
    # "I put a guide card here" with nothing in the chat.
    from kiro_crew import mcp_guide

    monkeypatch.setattr(mcp_guide, "_strict_session_key", lambda: ("dashboard:c", ""))
    monkeypatch.setattr(mcp_guide, "_post", lambda *a, **k: {"error": "no such action"})
    out = mcp_guide._call_tool_inner("guide_start", {"actions": [{"action_id": "nope"}]})
    assert out.startswith("Error: no such action")
    assert mcp_guide.GUIDE_NOT_SHOWN_NOTE in out


def test_find_ui_tells_the_model_to_offer_a_guide_ref_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Reproduced on a fresh pod: the result carried a guide_ref plus a blocker,
    # and Captain answered in prose ("click Show sessions sidebar") without
    # calling guide_start. The result now says what to do next.
    from kiro_crew import mcp_guide

    hit = {
        "status": "ok",
        "results": [
            {
                "id": "chat.older-sessions",
                "guide_ref": {
                    "action_id": "ui.show",
                    "params": {"location_id": "chat.older-sessions"},
                },
                "blocker": {"kind": "hidden_in_scope", "scopes": ["chat.sidebar"]},
            }
        ],
    }
    monkeypatch.setattr("kiro_crew.ui_index.find_ui", lambda *a, **k: json.loads(json.dumps(hit)))
    monkeypatch.setattr(mcp_guide, "_with_live", lambda d: d)
    monkeypatch.setattr(mcp_guide, "_dashboard_ui_lang", lambda: "en")
    out = json.loads(mcp_guide._call_tool_inner("find_ui", {"query": "会话历史在哪里"}))
    assert "chat.older-sessions has a guide_ref" in out["next"]
    assert "guide_start" in out["next"]
    # No guide_ref, or an ambiguous search: no instruction to start one.
    hit["results"][0].pop("guide_ref")
    assert "next" not in json.loads(mcp_guide._call_tool_inner("find_ui", {"query": "x"}))
    hit["results"][0]["guide_ref"] = {"action_id": "ui.show", "params": {}}
    hit["ambiguous"] = True
    assert "next" not in json.loads(mcp_guide._call_tool_inner("find_ui", {"query": "x"}))
