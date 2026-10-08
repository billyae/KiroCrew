"""The Slack approval window follows ``agent.tool_approval_timeout_secs``.

Slack used a flat 120 s window no matter what the config said. These tests pin
that the configured value is read, clamped to the config's own bounds, and
that the decider actually waits for the resolved value.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from kiro_crew.config.loader import TOOL_APPROVAL_TIMEOUT_MAX, TOOL_APPROVAL_TIMEOUT_MIN
from kiro_crew.slack import handler
from kiro_crew.slack import renderer as slack_renderer


def _config_double(monkeypatch, value):
    """Make ``KiroCrewConfig.load()`` behave like a config holding *value*.

    ``None`` stands for "config cannot be read": the real loader raises then.
    """

    def _load(*_args, **_kwargs):
        if value is None:
            raise OSError("config unavailable")
        return SimpleNamespace(agent=SimpleNamespace(tool_approval_timeout_secs=value))

    monkeypatch.setattr(handler.KiroCrewConfig, "load", _load)


class TestResolvedWindow:
    def test_unreadable_config_falls_back_to_120(self, monkeypatch):
        _config_double(monkeypatch, None)
        assert handler._approval_timeout() == 120.0

    def test_non_positive_value_falls_back_to_120(self, monkeypatch):
        _config_double(monkeypatch, 0)
        assert handler._approval_timeout() == 120.0

    def test_configured_value_is_used(self, monkeypatch):
        _config_double(monkeypatch, 600)
        assert handler._approval_timeout() == 600.0

    def test_below_floor_is_raised_to_floor(self, monkeypatch):
        _config_double(monkeypatch, 5)
        assert handler._approval_timeout() == float(TOOL_APPROVAL_TIMEOUT_MIN)

    def test_above_ceiling_is_capped(self, monkeypatch):
        _config_double(monkeypatch, TOOL_APPROVAL_TIMEOUT_MAX + 1000)
        assert handler._approval_timeout() == float(TOOL_APPROVAL_TIMEOUT_MAX)

    def test_ceiling_is_the_dashboard_window(self):
        from kiro_crew.dashboard.state import DashboardState

        assert TOOL_APPROVAL_TIMEOUT_MAX == DashboardState._APPROVAL_TIMEOUT

    def test_override_pins_the_window(self, monkeypatch):
        _config_double(monkeypatch, 600)
        assert handler._approval_timeout(0.25) == 0.25


class TestDeciderWaitsForResolvedWindow:
    @pytest.mark.asyncio
    async def test_decider_passes_configured_window_to_wait(self, monkeypatch):
        _config_double(monkeypatch, 900)
        monkeypatch.setattr(slack_renderer, "_APPROVAL_TIMEOUT", None)
        seen: list[float] = []

        async def _wait_for(fut, timeout):
            # Honour the wait_for contract for an unanswered prompt: record the
            # window, then expire it without sleeping.
            seen.append(timeout)
            fut.cancel()
            raise asyncio.TimeoutError

        monkeypatch.setattr(slack_renderer.asyncio, "wait_for", _wait_for)
        decider = slack_renderer.SlackApprovalDecider(session_key="slack:C1:t1")
        event = SimpleNamespace(request_id="r1", title="bash", options=[])
        assert await decider(event) is False
        assert seen == [900.0]
