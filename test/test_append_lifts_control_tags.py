"""Ingestion-point control-tag lift in ``_ChatSlot.append``.

``append`` is the single chokepoint every persisted assistant row passes
through. For an assistant row carrying a trailing control-tag block it must
lift ``keep-visible`` / ``plan_task_id`` into ``meta`` and store content
WITHOUT the tag block (a ``deliver`` tail is stripped but not lifted -- it has
no persisted reader), so downstream projections are correct by default rather
than each re-running ``strip_control_comments``. Non-assistant rows, and rows
with no trailing tag, pass through unchanged.
"""

from kiro_crew.dashboard.state import _ChatSlot


class TestAppendLiftsControlTags:
    def test_assistant_keep_visible_lifted_and_stripped(self) -> None:
        slot = _ChatSlot("s1")
        msg = slot.append("assistant", "Report body\n\n<!-- keep-visible -->", broadcast=False)
        assert msg["meta"]["keep_visible"] is True
        assert "keep-visible" not in msg["content"]
        assert msg["content"].rstrip().endswith("Report body")

    def test_assistant_plan_task_id_lifted(self) -> None:
        slot = _ChatSlot("s1")
        msg = slot.append("assistant", "Done\n<!-- plan_task_id:abc-123 -->", broadcast=False)
        assert msg["meta"]["plan_task_id"] == "abc-123"
        assert "plan_task_id" not in msg["content"]

    def test_assistant_deliver_stripped_not_lifted(self) -> None:
        # deliver is a HEARTBEAT.md file-format tag with no persisted reader:
        # stripped from stored content, but never written to meta.
        slot = _ChatSlot("s1")
        msg = slot.append("assistant", "Routed\n<!-- deliver:dashboard -->", broadcast=False)
        assert "deliver" not in msg["content"]
        assert msg["content"].rstrip().endswith("Routed")
        assert "deliver" not in (msg.get("meta") or {})

    def test_assistant_no_tag_unchanged(self) -> None:
        slot = _ChatSlot("s1")
        text = "Just a reply, no control tags."
        msg = slot.append("assistant", text, broadcast=False)
        assert msg["content"] == text
        # No lift means no keep_visible/plan_task_id/deliver added. (A mid row
        # still gets its delivery-identity meta, so meta may exist — assert only
        # that the lift keys are absent.)
        meta = msg.get("meta") or {}
        assert "keep_visible" not in meta
        assert "plan_task_id" not in meta
        assert "deliver" not in meta

    def test_user_row_not_lifted(self) -> None:
        # Only assistant rows carry these tags; a user row that happens to end
        # in a tag-like line is left exactly as typed.
        slot = _ChatSlot("s1")
        text = "please keep\n<!-- keep-visible -->"
        msg = slot.append("user", text, broadcast=False)
        assert msg["content"] == text
        assert "keep_visible" not in (msg.get("meta") or {})

    def test_tag_in_unterminated_fence_not_lifted(self) -> None:
        # Fence-parity guard: a tail inside an open fence is literal code.
        slot = _ChatSlot("s1")
        text = "```\n<!-- keep-visible -->"
        msg = slot.append("assistant", text, broadcast=False)
        assert msg["content"] == text
        assert "keep_visible" not in (msg.get("meta") or {})

    def test_caller_meta_preserved_and_merged(self) -> None:
        slot = _ChatSlot("s1")
        msg = slot.append(
            "assistant",
            "Body\n<!-- keep-visible -->",
            meta={"crew_reply": True},
            broadcast=False,
        )
        assert msg["meta"]["crew_reply"] is True
        assert msg["meta"]["keep_visible"] is True
