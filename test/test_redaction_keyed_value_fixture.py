"""The keyed-value fixture is the one oracle every copy of the value scanner answers to.

``test/redaction_keyed_value_fixture.py`` generates it from the canonical redactor;
this file pins (1) that the committed JSON equals a fresh generation, so the file
cannot drift from the code, (2) that every row holds on the redactor, on the stream
at six chunk sizes, on the hard URL floor and on the packaging scan's vendored
scanner, and (3) that the scanner is linear in its input by construction. The
chat mirror reads the same file in
``website/src/test/sanitizeCredentials.fixture.test.ts``.
"""

from __future__ import annotations

import json
import time

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from redaction_keyed_value_fixture import FIXTURE_PATH, TAG, VALUE, build_rows, render

ROWS = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
_IDS = [f"{row['key']}-{row['shape']}" for row in ROWS]
_SIZES = (1, 3, 7, 50, 200, 513)


def test_the_committed_fixture_is_a_fresh_generation() -> None:
    """Regenerate with ``PYTHONPATH=src python test/redaction_keyed_value_fixture.py``."""
    assert FIXTURE_PATH.read_text(encoding="utf-8") == render()
    assert len(build_rows()) == len(ROWS) > 150


@pytest.mark.parametrize("row", ROWS, ids=_IDS)
def test_the_redactor_answers_the_row(row: dict) -> None:
    from kiro_crew.security import credential_matches, redact_credentials

    once, warnings = redact_credentials(row["text"])
    assert once == row["expected"], row["shape"]
    assert len(warnings) == row["warnings"], row["shape"]
    assert redact_credentials(once) == (once, []), row["shape"]
    assert (next(credential_matches(row["text"]), None) is not None) is row["live"], row["shape"]


@pytest.mark.parametrize("row", ROWS, ids=_IDS)
def test_the_stream_equals_the_batch_pass_at_every_chunk_size(row: dict) -> None:
    from kiro_crew.security import StreamRedactor

    text, expected = row["text"], row["expected"]
    for size in _SIZES:
        redactor = StreamRedactor()
        out = "".join(redactor.feed(text[i : i + size]) for i in range(0, len(text), size))
        assert out + redactor.flush() == expected, (row["shape"], size)


@pytest.mark.parametrize("row", ROWS, ids=_IDS)
def test_the_hard_floor_reads_the_row_as_the_redactor_does(row: dict) -> None:
    from kiro_crew.security import hard_credential_hit

    assert hard_credential_hit(row["text"]) is row["live"], row["shape"]
    assert hard_credential_hit(row["expected"]) is False, row["shape"]


@pytest.mark.parametrize("row", ROWS, ids=_IDS)
def test_the_packaging_scans_vendored_scanner_reads_the_row_as_the_redactor_does(
    row: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kiro_crew.apps.builtins.aws_control.crew.packaging.pipeline import scan as pkg_scan

    # The labelled matcher alone (the canonical detector and redactor masked off),
    # line by line as the scan runs it; access-key-id spellings have no labelled
    # entry in the packaging scan, which reads secrets and session tokens.
    if "access_key_id" in row["key"].lower() or row["key"] == "AccessKeyId":
        pytest.skip("the packaging scan's labelled entry covers secrets and session tokens")
    matcher = dict(pkg_scan._HARD_PATTERNS)["aws-secret-labelled"]
    found = any(matcher.search(line) is not None for line in row["text"].splitlines())
    if row["shape"] == "empty-value":
        # The redactor's anchor runs `\s*` across the line break after `key=`
        # and claims the next line's first word (the base-era rule, an
        # over-redaction and never a leak); the packaging scan reads one line
        # at a time, where `key=` alone is a key with no value.
        assert found is False, row["shape"]
    else:
        assert found is row["live"], row["shape"]
    assert all(matcher.search(line) is None for line in row["expected"].splitlines()), row["shape"]
    # And the vendored claim is byte-identical to the canonical one on every line.
    from kiro_crew.security import scan_keyed_value

    for line in row["text"].splitlines():
        for anchor in pkg_scan._LABEL_RE.finditer(line):
            vendored = pkg_scan._scan_value(line, anchor.end())
            canonical = scan_keyed_value(line, anchor.end())
            assert vendored == (
                canonical.start,
                canonical.end,
                canonical.closes,
                canonical.opener,
            ), (
                row["shape"],
                line,
            )


def test_the_scanner_is_linear_in_its_input() -> None:
    """One token per step: the time to scan grows with the text, not with its square.

    Adversarial shapes for a backtracking grammar -- a run of backslashes, a run of
    doubled quotes, a run of escaped-whitespace heads, an unterminated quote over a
    long line -- cost the same per byte as prose. Measured at two sizes a factor of
    eight apart; a quadratic scanner would show ~64x, a linear one ~8x (the bound
    below leaves room for timer noise, as ``test_security_regex_linearity.py`` does).
    """
    from kiro_crew.security import scan_keyed_value

    def shapes(n: int) -> list[str]:
        return [
            "k=" + "\\\\" * n,
            'k="' + '""' * n + "x",
            'k="' + "\\t" * n + VALUE + '"',
            'k="' + "a" * n,
            'k=\\"' + "\\\\" * n + '\\"',
            "k=" + (TAG * (n // len(TAG) + 1)),
            # A run of apostrophe candidates before a far close, and before none:
            # an other-kind quote is a byte of the value, read once.
            'k="' + "' " * n + VALUE + '"',
            'k="' + "' " * n + VALUE,
        ]

    def cost(n: int) -> float:
        best = float("inf")
        for _ in range(3):
            t0 = time.perf_counter()
            for text in shapes(n):
                scan_keyed_value(text, 2)
            best = min(best, time.perf_counter() - t0)
        return best

    small, large = cost(2_000), cost(16_000)
    assert large < small * 24, (small, large)


def test_the_look_back_is_linear_in_the_line() -> None:
    """The look-back along the line runs once per traversal, not once per anchor:
    a line of many key-anchored pairs after a long prefix of quotes and escapes
    costs the redactor work proportional to the line, measured as executed lines
    of ``redaction`` (``conftest.assert_linear_work``), not as time."""
    from conftest import assert_linear_work
    from kiro_crew import security as _security
    from kiro_crew.security import redact_credentials

    def text(n: int) -> str:
        prefix = "'a' \"b\" \\\" 'c''d' " * (n // 20)
        pairs = "".join(f"aws_secret_access_key={VALUE}{i} " for i in range(n // 40))
        return prefix + '{"template":"' + pairs + '","keep":1}\n'

    assert_linear_work(_security.redaction, text, redact_credentials, sizes=(2_000, 4_000, 8_000))


# ─────────────────────────────────────────────────────────────────────────────
# the document property: a redacted JSON document is still that document
# ─────────────────────────────────────────────────────────────────────────────

_CREDENTIAL_KEY_WORDS = ("secretaccesskey", "sessiontoken", "accesskeyid", "bearer")


def _mentions_a_credential_key(text: str) -> bool:
    lowered = text.lower().replace("_", "")
    return any(word in lowered for word in _CREDENTIAL_KEY_WORDS)


def _shape(doc: object) -> object:
    """The document with every string leaf replaced by ``"s"``: its structure."""
    if isinstance(doc, dict):
        return {key: _shape(value) for key, value in doc.items()}
    if isinstance(doc, list):
        return [_shape(item) for item in doc]
    return "s" if isinstance(doc, str) else doc


def _leaves(doc: object, under_credential_key: bool = False) -> list[tuple[str, bool]]:
    """Every string leaf with whether a credential key names it or an ancestor."""
    if isinstance(doc, dict):
        found: list[tuple[str, bool]] = []
        for key, value in doc.items():
            found.extend(_leaves(value, under_credential_key or _mentions_a_credential_key(key)))
        return found
    if isinstance(doc, list):
        return [leaf for item in doc for leaf in _leaves(item, under_credential_key)]
    return [(doc, under_credential_key)] if isinstance(doc, str) else []


def _assert_still_the_document(text: str, out: str) -> None:
    """*out* parses as JSON, has *text*'s structure, and differs from it only in
    leaves that carry a credential key or sit under one."""
    before, after = json.loads(text), json.loads(out)
    assert _shape(before) == _shape(after)
    for (was, under), (now, _) in zip(_leaves(before), _leaves(after), strict=True):
        if not under and not _mentions_a_credential_key(was):
            assert now == was


def _wrappers(text: str) -> list[str]:
    """*text* as the string value of generated JSON documents: compact, indented,
    non-ASCII escaped and not, nested in an object and in an array."""
    return [
        json.dumps({"template": text, "keep": 1}, separators=(",", ":")),
        json.dumps({"template": text, "keep": 1}, indent=2),
        json.dumps({"template": text, "keep": 1}, ensure_ascii=False),
        json.dumps({"outer": {"template": text}, "keep": [1, text]}),
        json.dumps([text, {"keep": 1}]),
    ]


def _is_json(text: str) -> bool:
    try:
        json.loads(text)
    except ValueError:
        return False
    return True


_JSON_ROWS = [row for row in ROWS if _is_json(row["text"])]


@pytest.mark.parametrize("row", _JSON_ROWS, ids=[f"{r['key']}-{r['shape']}" for r in _JSON_ROWS])
def test_every_json_document_in_the_fixture_stays_a_document(row: dict) -> None:
    """A row that IS a JSON document redacts to a JSON document of the same
    structure, every leaf that names no credential key byte-identical. The
    scanner's rules are all stopping rules, so an unknown spelling costs an
    over-redaction inside a value and never a byte of the document around it.
    The one way that promise breaks is the scanner mistaking an enclosing
    literal's boundary for the value's (a bare opener inside a JSON string, an
    interior apostrophe, an empty assignment before the enclosing close), and
    the look-back along the line is what ends the class."""
    from kiro_crew.security import redact_credentials

    _assert_still_the_document(row["text"], row["expected"])
    assert redact_credentials(row["expected"]) == (row["expected"], [])


_ALREADY_ESCAPED = ("embedded", "escaped-json", "wrapped-json", "tag-filled-embedded")


def _one_level_deep(row: dict) -> bool:
    """Whether wrapping the row in a quoted literal escapes it ONCE. The shapes
    written in the escaped encoding already are one level deep, and the scanner
    reads one level: a doubly escaped quote is not an opener to it."""
    return not row["shape"].startswith(_ALREADY_ESCAPED)


@pytest.mark.parametrize("row", ROWS, ids=_IDS)
def test_every_row_wrapped_as_a_json_string_stays_a_document(row: dict) -> None:
    """Every row's text as the string value of a JSON document -- the pair in the
    escaped encoding inside a literal the look-back finds -- redacts to a parsing
    document with the sibling field intact and no secret byte left, through the
    redactor and the stream alike."""
    from kiro_crew.security import StreamRedactor, redact_credentials

    if not _one_level_deep(row):
        pytest.skip("already in the escaped encoding; wrapped it would be two levels deep")
    for text in _wrappers(row["text"]):
        out, _warnings = redact_credentials(text)
        _assert_still_the_document(text, out)
        if not row["shape"].startswith("empty-"):
            assert VALUE not in out, row["shape"]
        assert redact_credentials(out) == (out, []), row["shape"]
        redactor = StreamRedactor()
        streamed = "".join(redactor.feed(text[i : i + 7]) for i in range(0, len(text), 7))
        assert streamed + redactor.flush() == out, row["shape"]


@pytest.mark.parametrize("row", ROWS, ids=_IDS)
def test_every_row_wrapped_in_a_yaml_scalar_keeps_its_sibling_key(row: dict) -> None:
    """The YAML wrappers: the row as a block scalar (every row), and as a
    double-quoted and a single-quoted scalar (the rows not already in the escaped
    encoding), each with a sibling key after it. The redacted document still
    loads, the sibling key is untouched, and the scalar holds no secret byte."""
    import yaml

    from kiro_crew.security import redact_credentials

    body = row["text"].rstrip("\n")
    wrappers = ["text: |\n" + "".join(f"  {line}\n" for line in body.split("\n")) + "keep: 1\n"]
    if "\n" not in body and _one_level_deep(row):
        wrappers.append(yaml.safe_dump({"text": body, "keep": 1}, default_style='"'))
        wrappers.append(yaml.safe_dump({"text": body, "keep": 1}, default_style="'"))
    for text in wrappers:
        out, _warnings = redact_credentials(text)
        loaded = yaml.safe_load(out)
        assert isinstance(loaded, dict) and loaded["keep"] == 1, (row["shape"], out)
        if not row["shape"].startswith("empty-"):
            assert VALUE not in str(loaded["text"]), (row["shape"], out)


@settings(max_examples=400, deadline=None)
@given(
    documents=st.recursive(
        st.dictionaries(
            st.sampled_from(
                ["template", "note", "SecretAccessKey", "aws_session_token", "AccessKeyId"]
            ),
            st.lists(
                st.sampled_from(
                    list("ab=:,'\" \\/{}[]\n\t") + [VALUE, TAG, "aws_secret_access_key=", "Bearer "]
                ),
                max_size=8,
            ).map("".join),
            max_size=4,
        ),
        lambda inner: st.dictionaries(
            st.sampled_from(["outer", "items"]),
            st.one_of(inner, st.lists(inner, max_size=2)),
            max_size=2,
        ),
        max_leaves=6,
    ),
    indent=st.sampled_from([None, 2]),
    ensure_ascii=st.booleans(),
)
def test_any_json_document_redacts_to_a_json_document(
    documents: dict, indent: int | None, ensure_ascii: bool
) -> None:
    """The property behind the fixture's documents, over GENERATED ones: keys
    plain and credential, values made of quotes, apostrophes, backslashes,
    separators, line breaks, the synthetic secret, a redaction tag and a bare
    pair, serialized compact and indented. The output parses, keeps the
    structure, changes only leaves that carry a credential key or sit under one,
    and is a fixed point."""
    from kiro_crew.security import redact_credentials

    text = json.dumps(documents, indent=indent, ensure_ascii=ensure_ascii)
    out, _warnings = redact_credentials(text)
    _assert_still_the_document(text, out)
    assert redact_credentials(out) == (out, [])
