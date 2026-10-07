"""Tests for :func:`kiro_crew.constants.lift_control_tags_to_meta`.

The ingestion-point counterpart to ``strip_control_comments``: the trailing
control-tag block is LIFTED into message metadata once at persistence, so
plain-text projections are correct by default instead of each re-running the
strip. The two must agree on WHAT the tag block is -- the lift reuses the exact
tail-anchored, fence-guarded grammar -- so a ``content_without_tags`` returned
here is byte-identical to ``strip_control_comments(text)`` on every input.
"""

from kiro_crew.constants import lift_control_tags_to_meta, strip_control_comments


class TestLiftExtractsMeta:
    def test_keep_visible(self) -> None:
        content, meta = lift_control_tags_to_meta("Report body\n\n<!-- keep-visible -->")
        assert meta == {"keep_visible": True}
        assert content.rstrip().endswith("Report body")

    def test_plan_task_id(self) -> None:
        content, meta = lift_control_tags_to_meta("Done\n<!-- plan_task_id:abc-123 -->")
        assert meta == {"plan_task_id": "abc-123"}
        assert content.rstrip().endswith("Done")

    def test_deliver_stripped_but_not_lifted(self) -> None:
        # A deliver tail is a HEARTBEAT.md file-format suffix with no persisted
        # reader: the grammar still strips it from content, but it is not
        # lifted into meta (no reader would consult meta["deliver"]).
        content, meta = lift_control_tags_to_meta("x\n<!-- deliver:dashboard -->")
        assert meta == {}
        assert content.rstrip().endswith("x")
        assert "deliver" not in content

    def test_stacked_siblings(self) -> None:
        content, meta = lift_control_tags_to_meta(
            "Body\n<!-- keep-visible -->\n<!-- plan_task_id:t-9 -->"
        )
        assert meta == {"keep_visible": True, "plan_task_id": "t-9"}
        assert content.rstrip().endswith("Body")

    def test_case_insensitive(self) -> None:
        # Mirrors the strip grammar's /i: an uppercase marker must still lift.
        _content, meta = lift_control_tags_to_meta("done\n<!-- KEEP-VISIBLE -->")
        assert meta == {"keep_visible": True}

    def test_last_value_wins(self) -> None:
        # A reader scanning the content tail sees the final tag of a family;
        # the lift agrees.
        _content, meta = lift_control_tags_to_meta(
            "x\n<!-- plan_task_id:first -->\n<!-- plan_task_id:second -->"
        )
        assert meta == {"plan_task_id": "second"}


class TestLiftLeavesNonTagsAlone:
    def test_no_trailing_tag(self) -> None:
        text = "Just a message, no control tags."
        content, meta = lift_control_tags_to_meta(text)
        assert content == text
        assert meta == {}

    def test_tag_in_unterminated_fence_is_visible_code(self) -> None:
        # Fence-parity guard: a tail inside an open fence is literal code, not a
        # control tag — nothing is lifted and content is unchanged.
        text = "```\n<!-- keep-visible -->"
        content, meta = lift_control_tags_to_meta(text)
        assert content == text
        assert meta == {}

    def test_inline_quoted_tag_is_visible(self) -> None:
        text = "see `<!-- keep-visible -->` inline"
        content, meta = lift_control_tags_to_meta(text)
        assert content == text
        assert meta == {}


class TestLiftContentMatchesStrip:
    """content_without_tags is byte-identical to strip_control_comments."""

    def test_parity_on_corpus_shapes(self) -> None:
        samples = [
            "Report body\n\n<!-- keep-visible -->",
            "Done\n<!-- plan_task_id:abc-123 -->",
            "x\n<!-- deliver:dashboard -->",
            "Body\n<!-- keep-visible -->\n<!-- plan_task_id:t-9 -->",
            "Just a message, no control tags.",
            "```\n<!-- keep-visible -->",
            "see `<!-- keep-visible -->` inline",
            "closed fence\n```\ncode\n```\ndone\n<!-- keep-visible -->",
        ]
        for text in samples:
            content, _meta = lift_control_tags_to_meta(text)
            assert content == strip_control_comments(text), text
