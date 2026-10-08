"""The gateway surfaces a consolidation span abandoned at its attempt cap.

The consolidator marks such a span consolidated so it stops re-billing a turn,
which also removes it from every "pending" listing. The bell note is the only
user-visible record that its history, preferences and lessons were dropped.
"""

from __future__ import annotations

from unittest.mock import MagicMock


def _make_gw(state: object) -> object:
    from kiro_crew.slack.gateway import GatewayOrchestrator

    gw = GatewayOrchestrator.__new__(GatewayOrchestrator)
    gw.dashboard_state = state  # type: ignore[attr-defined]
    return gw


def test_an_abandoned_span_posts_a_bell_note():
    state = MagicMock()
    gw = _make_gw(state)

    gw._notify_consolidation_abandoned("dashboard:chat-1", 3100, "empty LLM result")

    state.notify.assert_called_once()
    args, kwargs = state.notify.call_args
    kind, title, body = args
    assert kind == "agent"
    assert "gave up" in title
    # A whole-message abandon is a whole session span, not "part of a session".
    assert title == "Memory consolidation gave up on a session"
    assert "3100 messages" in body
    assert "dashboard:chat-1" in body
    assert "empty LLM result" in body
    assert kwargs["meta"] == {
        "session_key": "dashboard:chat-1",
        "kind": "consolidation-abandoned",
    }


def test_a_non_final_slice_abandon_promises_the_next_slice():
    state = MagicMock()
    gw = _make_gw(state)

    gw._notify_consolidation_abandoned(
        "dashboard:chat-1", 0, "empty LLM result", char_count=4096, last_slice=False
    )

    args, _ = state.notify.call_args
    _, title, body = args
    assert title == "Memory consolidation gave up on part of a session"
    assert "4096-character slice" in body
    assert "continues from the next slice" in body
    assert "fully consolidated" not in body


def test_a_final_slice_abandon_does_not_promise_a_next_slice():
    state = MagicMock()
    gw = _make_gw(state)

    gw._notify_consolidation_abandoned(
        "dashboard:chat-1", 1, "empty LLM result", char_count=4096, last_slice=True
    )

    args, _ = state.notify.call_args
    _, title, body = args
    assert title == "Memory consolidation gave up on part of a session"
    assert "4096-character slice" in body
    # No next slice: the marker has moved past the whole message.
    assert "next slice" not in body
    assert "fully consolidated" in body


def test_no_dashboard_means_no_note_and_no_error():
    gw = _make_gw(None)

    gw._notify_consolidation_abandoned("dashboard:chat-1", 10, "exception after the LLM call")
