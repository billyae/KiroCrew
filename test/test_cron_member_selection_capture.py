"""Every cron-create path captures a MEMBER selection for a member-named agent.

``--agent`` / the ``agent`` field is the one slot every create surface offers for
naming either a provider template or a crew member. The dashboard UI resolves a
member pick client-side and sends a separate ``member_id``, but the CLI, the MCP
``cron_add`` tool and a scripted dashboard POST send the member NAME in ``agent``.
Without resolution the schedule captures ``selection_kind='template'`` with the
member name mistaken for a provider template, so the next reply in the cron chat
resolves that name as a template, finds none, and fails to bind the agent.

All three create paths share one resolver, ``split_cron_agent_member``: when a
member name is given in ``agent`` (and no explicit ``member_id``), it is recorded
as a member selection (``member_id`` set, ``agent_id`` cleared). A real provider
template name, and the record-level ``add_job(agent_id=...)`` field, both stay
templates -- that contract is pinned by
``test_member_memory_runtime.test_v1_provider_template_does_not_become_a_member``.
"""

from __future__ import annotations

import argparse
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from kiro_crew.cli_commands import _cron
from kiro_crew.config.loader import (
    KiroCrewAgentConfig,
    KiroCrewConfig,
    config_dir,
    resolve_agent_bindings,
)
from kiro_crew.cron import CronService
from kiro_crew.cron_service.identity import split_cron_agent_member
from kiro_crew.dashboard.handlers.cron import api_crons_create
from kiro_crew.execution_context import (
    bind_session_execution,
    execution_from_record,
    read_session_execution,
)
from kiro_crew.memory_stores import provision_member_memory
from kiro_crew.session_agent_selection import resolve_session_agent_bindings


def _ns(**overrides) -> argparse.Namespace:
    base = dict(
        cron_action="add",
        name="daily",
        message="task",
        every=60,
        cron_expr=None,
        at=None,
        timezone="",
        channel=None,
        agent="",
        script="",
        shell_command="",
        timeout=None,
        timeout_secs=None,
        model="",
        persistent_session=True,
        minimal_context=False,
        hide_in_chat=False,
        silent=False,
        folder="",
        approval_mode="",
    )
    base.update(overrides)
    return argparse.Namespace(**base)


@pytest.fixture
def member_with_distinct_template(tmp_path, monkeypatch):
    """A crew member whose display name differs from its kiro template.

    Lives under a real config home so the CLI's ``config_dir()``-rooted
    ``CronService`` and ``KiroCrewConfig.load()`` see the same member.
    """
    monkeypatch.setenv("KIROCREW_HOME", str(tmp_path / "home"))
    (config_dir() / "crons").mkdir(parents=True)
    cfg = KiroCrewConfig.load()
    cfg.agents["SampleMemberAgent"] = KiroCrewAgentConfig(
        kiro_agent="sample-template-agent", triggers="sample"
    )
    store = provision_member_memory(cfg, "SampleMemberAgent")
    cfg.save()
    return store


def _only_job() -> object:
    return CronService(base_dir=config_dir()).list_jobs(include_disabled=True)[0]


def _capture(job):
    return execution_from_record({"execution_context": job.execution_context})


def test_cli_agent_naming_a_member_captures_a_member_selection(member_with_distinct_template):
    _cron(_ns(agent="SampleMemberAgent"))

    job = _only_job()
    assert job.member_id == "samplememberagent"
    # The record keeps ``agent_id`` a pure template field: the member is carried
    # in ``member_id``, not conflated into ``agent_id``.
    assert job.agent_id == ""
    capture = _capture(job)
    assert capture.selection_kind == "member"
    assert capture.member_id == KiroCrewConfig.load().agents["SampleMemberAgent"].member_id


def test_cli_member_reply_resolves_without_unknown_store(member_with_distinct_template):
    """The reply path on the cron session resolves the member, never raises."""
    _cron(_ns(agent="SampleMemberAgent"))
    job = _only_job()

    # A run publishes the captured execution under the stable cron session key.
    session_key = f"cron:{job.id}"
    bind_session_execution(session_key, _capture(job))

    cfg = KiroCrewConfig.load()
    # This is what the reply path does on every turn of the cron chat; on the
    # bug it raised UnknownMemoryStore resolving the member name as a template.
    bindings = resolve_session_agent_bindings(resolve_agent_bindings, cfg, session_key, None)
    assert bindings.selection_kind == "member"
    assert bindings.kiro_agent == "sample-template-agent"
    assert read_session_execution  # import check


def test_cli_member_capture_matches_the_plain_resolver(member_with_distinct_template):
    """The cron capture agrees with the ordinary member resolution path."""
    _cron(_ns(agent="SampleMemberAgent"))
    job = _only_job()

    cfg = KiroCrewConfig.load()
    plain = resolve_agent_bindings(cfg, "SampleMemberAgent", validate_memory_files=False)
    capture = _capture(job)
    assert capture.selection_kind == plain.selection_kind == "member"
    assert capture.store.store_id == plain.memory_store_name


# ── Shared resolver (used by all three create paths) ─────────────────────────


def test_split_promotes_a_member_name_and_leaves_a_template_alone(member_with_distinct_template):
    cfg = KiroCrewConfig.load()
    cfg.agents["plain-template"] = KiroCrewAgentConfig(kiro_agent="kirocrew")
    cfg.save()

    # A member name with no explicit member_id -> promoted to a member selection.
    assert split_cron_agent_member("SampleMemberAgent", "") == ("", "SampleMemberAgent")
    # A name that is NOT a member stays a template.
    assert split_cron_agent_member("plain-template", "") == ("plain-template", "")
    # An explicit member_id is authoritative and untouched.
    assert split_cron_agent_member("some-template", "writer") == ("some-template", "writer")
    # A blank agent is a no-op.
    assert split_cron_agent_member("", "") == ("", "")


# ── MCP cron_add tool path ───────────────────────────────────────────────────


def test_mcp_cron_add_naming_a_member_captures_a_member_selection(
    member_with_distinct_template,
):
    from unittest.mock import patch

    from kiro_crew.mcp_cron import _call_tool_locally

    # The tool refuses an unidentified caller; a dashboard/agent caller has a
    # verified session key, so supply one for the test.
    with patch("kiro_crew.mcp_cron._authz_session_key", return_value="dashboard:tester"):
        result = _call_tool_locally(
            "cron_add",
            {"name": "daily", "message": "task", "every": 60, "agent": "SampleMemberAgent"},
        )
    assert "Error" not in result

    job = _only_job()
    assert job.member_id == "samplememberagent"
    assert job.agent_id == ""
    capture = _capture(job)
    assert capture.selection_kind == "member"
    assert capture.member_id == KiroCrewConfig.load().agents["SampleMemberAgent"].member_id


# ── Dashboard POST /api/crons path ───────────────────────────────────────────


def _dashboard_app(add_job_async) -> web.Application:
    app = web.Application()
    app["state"] = SimpleNamespace(
        crons=SimpleNamespace(add_job_async=add_job_async),
        push_refresh=MagicMock(),
    )
    app.router.add_route("*", "/api/crons", api_crons_create)
    return app


@pytest.mark.asyncio
async def test_dashboard_create_naming_a_member_captures_a_member_selection(
    member_with_distinct_template,
):
    """A scripted POST sending a member NAME in ``agent`` records a member run."""
    svc = CronService(base_dir=config_dir())
    app = _dashboard_app(svc.add_job_async)

    async with TestClient(TestServer(app)) as client:
        resp = await client.post(
            "/api/crons",
            json={"name": "daily", "message": "task", "every": 60, "agent": "SampleMemberAgent"},
        )
    assert resp.status == 200

    job = _only_job()
    # The handler resolved the member name before the store call: member in,
    # agent_id cleared.
    assert job.member_id == "samplememberagent"
    assert job.agent_id == ""
    capture = _capture(job)
    assert capture.selection_kind == "member"
    assert capture.member_id == KiroCrewConfig.load().agents["SampleMemberAgent"].member_id
