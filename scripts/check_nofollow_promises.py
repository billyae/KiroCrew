#!/usr/bin/env python3
"""check_nofollow_promises.py -- no raw ``O_NOFOLLOW`` that no-ops on Windows.

## The failure class

``getattr(os, "O_NOFOLLOW", 0)`` evaluates to ``0`` on Windows, because the OS
has no ``O_NOFOLLOW``. A read helper written as

    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))

therefore refuses a symlink on POSIX and **silently follows a reparse point on
Windows**, while its docstring promises the refusal on both. The defect is
invisible on Linux CI, so a new helper of this shape merges green and only
misbehaves on Windows -- which is why counting the sites by hand fixes today and
regresses next quarter (#9731). PR #9677 established the chokepoint:
``platform_compat.open_file_no_reparse`` reaches ``CreateFileW`` with
``FILE_FLAG_OPEN_REPARSE_POINT`` and fails closed at the final component on
either platform. This gate keeps the raw-flag class from growing back, the same
way ``check_subprocess_encoding.py`` (#5249) keeps the locale-decode class from
growing back.

## What counts as a violation

A ``getattr(os, "O_NOFOLLOW", 0)`` expression: a call to ``getattr`` whose first
argument is the name ``os`` (or an attribute ending ``.os``), whose second is the
string literal ``"O_NOFOLLOW"``, and whose third -- the default -- is the literal
``0``. That default is the whole hazard: it turns the flag into a no-op on any
platform that lacks it, so the promise the surrounding code makes about link
refusal is silently void there.

Matching is BY SHAPE on the AST, deliberately. The platform-correct primitive is
``platform_compat.open_file_no_reparse``; a new reader must borrow it rather than
re-spell the raw flag. The three sites in ``platform_compat.py`` that implement
the primitive and its directory/write kin ARE the Windows-correct wrappers (they
pair the POSIX flag with the ``CreateFileW`` path), so they carry the opt-out
marker rather than calling themselves.

The check is AST-based so a call formatted across multiple lines is judged as one
expression, which a regex cannot do reliably, and so the literal spelling inside
a docstring or a comment is not mistaken for a call. A file that does not parse
is a hard ERROR, never "clean": under a shrink-only ratchet a parse failure that
reads as zero violations would invite a prune that deletes the file's real entry
(the same fail-loud rule the black gate pins for "black exited 1 with no
findings").

## The opt-out marker

A site that genuinely must spell the raw flag -- the primitive's own POSIX
implementation, a test that plants the raw shape on purpose -- opts out with an
inline COMMENT on any line of the expression:

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)  # nofollow-raw: primitive

Only a real comment token counts -- the phrase inside a string literal on those
lines does not exempt it. The marker is an audit trail, not an escape hatch: it
asserts the author chose the raw flag on purpose and that the enclosing code
handles the Windows no-op itself.

## The ratchet

The repository predates this gate, so existing occurrences are recorded in
``.github/nofollow-promises-baseline.txt`` as ``<count> <path>`` lines. The rules
mirror ``check_subprocess_encoding.py`` and ``check_black_formatting.py`` (same
problem: a large pre-existing violation set that must only shrink):

* a file NOT in the baseline must be clean;
* a baselined file may not grow its count;
* in a file this change touches, a violation sitting on an ADDED line is a new
  offender even when the count is level -- otherwise fixing one old call while
  adding one new one would slip through the count unchanged;
* a baselined file whose count has shrunk (or that is clean or gone) must be
  pruned so the list only shrinks -- run ``--update-baseline``, which only ever
  lowers counts and deletes lines, never adds or raises one.

Like the sibling gates, the "new offender" verdict covers only the files this
change touches (CI evaluates a merge ref, so an unscoped gate would redden a PR
for files the base branch merged after the baseline was recorded). The
count-shrink prune demand is likewise scoped to this change's files: a stale
count caused by someone else's merged cleanup is their prune to record, and
reddening an unrelated PR for it would make this gate's colour depend on other
people's hygiene.
"""

from __future__ import annotations

import argparse
import ast
import importlib.util
import io
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASELINE = ROOT / ".github" / "nofollow-promises-baseline.txt"
# docs/ (prose snippets, not shipped code) and semgrep-tests/ (deliberately
# defective probe sources) are excluded on purpose, matching the sibling gates.
DEFAULT_TARGETS = (
    "src",
    "scripts",
    "test",
    "packages",
    "docker",
    "packaging",
    "conftest.py",
    "xdist_budget.py",
    "setup.py",
)

FLAG_NAME = "O_NOFOLLOW"
MARKER = "nofollow-raw:"

HEADER = """\
# `getattr(os, "O_NOFOLLOW", 0)` sites, as `<count> <path>`. The getattr default
# of 0 makes the flag a no-op on Windows, so a reader built on it follows a
# reparse point there while documenting refusal (#9731).
#
# The gate requires every OTHER file to be clean and none of these counts to
# grow, so this list can only shrink.
#
# Do NOT add or raise a line to make a red gate green: a new reader borrows
# `platform_compat.open_file_no_reparse` (which fails closed on both platforms),
# or carries the `# nofollow-raw: <why>` marker if the raw flag is deliberate
# and the enclosing code handles the Windows no-op itself.
# The refresh command below only lowers counts and deletes lines.
#
# Refresh (after converting something listed here):
#   python3 scripts/check_nofollow_promises.py --update-baseline
"""


def _load_scope():
    """The shared diff-scope helpers (see scripts/ratchet_scope.py).

    Loaded by path, not imported: ``scripts/`` is not a package, so a plain
    import would resolve only by accident of ``sys.path[0]`` -- and not at all
    when a test loads this gate by path. The pair lives there because several
    merge-ref ratchets need the identical answers; a private copy per gate is how
    they would come to disagree about the same added line.
    """
    script = ROOT / "scripts" / "ratchet_scope.py"
    spec = importlib.util.spec_from_file_location("ratchet_scope", script)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {script}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _is_os_ref(node: ast.expr) -> bool:
    """True for the ``os`` module reference getattr's first argument should be.

    A bare ``os`` (``import os``) or an attribute ending ``.os`` (``from . import
    os as _os`` is rare, but ``something.os`` covers a re-exported handle). A
    non-``os`` first argument is a different getattr and not this hazard.
    """
    if isinstance(node, ast.Name):
        return node.id == "os"
    if isinstance(node, ast.Attribute):
        return node.attr == "os"
    return False


def _is_nofollow_getattr(node: ast.Call) -> bool:
    """True for ``getattr(os, "O_NOFOLLOW", 0)`` -- the no-op-on-Windows shape.

    All three parts are required: the ``os`` target, the ``O_NOFOLLOW`` name,
    and the literal ``0`` default. A getattr with a non-zero default (or none)
    is not this class -- the hazard is specifically the silent-0 fallback.
    """
    fn = node.func
    is_getattr = (isinstance(fn, ast.Name) and fn.id == "getattr") or (
        isinstance(fn, ast.Attribute) and fn.attr == "getattr"
    )
    if not is_getattr or len(node.args) != 3 or node.keywords:
        return False
    target, name, default = node.args
    if not _is_os_ref(target):
        return False
    if not (isinstance(name, ast.Constant) and name.value == FLAG_NAME):
        return False
    return isinstance(default, ast.Constant) and default.value == 0 and default.value is not False


def _marker_lines(source: str) -> set[int]:
    """Line numbers whose COMMENT token carries the opt-out marker.

    tokenize (not a substring scan) so the marker phrase inside a string
    literal cannot exempt an expression.
    """
    lines: set[int] = set()
    try:
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type == tokenize.COMMENT and MARKER in tok.string:
                lines.add(tok.start[0])
    except tokenize.TokenizeError:
        pass  # the AST parse of the same source decides parseability
    return lines


def _violations_in_source(source: str) -> list[int]:
    """Line numbers of raw ``O_NOFOLLOW``-getattr expressions in one file.

    Raises SyntaxError for an unparseable file: the caller turns that into a
    hard error because "could not parse" must never read as "clean".
    """
    tree = ast.parse(source)
    markers = _marker_lines(source)
    found: list[int] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not _is_nofollow_getattr(node):
            continue
        end = node.end_lineno or node.lineno
        if markers & set(range(node.lineno, end + 1)):
            continue
        found.append(node.lineno)
    return sorted(found)


def _scan(targets: tuple[str, ...]) -> dict[str, list[int]]:
    """Map of repo-relative path -> violation line numbers, files with any."""
    results: dict[str, list[int]] = {}
    for name in targets:
        target = ROOT / name
        if target.is_file():
            files = [target]
        elif target.is_dir():
            files = sorted(target.rglob("*.py"))
        else:
            continue
        for path in files:
            if path.suffix != ".py":
                continue
            if "_vendor" in path.relative_to(ROOT).parts:
                continue  # bundled third-party code is not ours to convert
            rel = path.relative_to(ROOT).as_posix()
            source = path.read_text(encoding="utf-8", errors="replace")
            try:
                lines = _violations_in_source(source)
            except SyntaxError as exc:
                raise SystemExit(
                    f"{rel} does not parse ({exc.msg}, line {exc.lineno}); refusing "
                    "to read a parse failure as zero violations -- under a "
                    "shrink-only ratchet that would invite a prune that deletes "
                    "the file's real baseline entry"
                )
            if lines:
                results[rel] = lines
    return results


def _read_baseline(path: Path) -> dict[str, int]:
    if not path.is_file():
        raise SystemExit(
            f"baseline {path} is missing; restore it from git rather than "
            "regenerating it, since a regenerated baseline would silently absorb "
            "every occurrence added since it was recorded"
        )
    entries: dict[str, int] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        count_str, _, rel = line.partition(" ")
        if not count_str.isdigit() or not rel:
            raise SystemExit(f"malformed baseline line: {line!r}")
        if rel in entries:
            raise SystemExit(
                f"duplicate baseline entry for {rel}; a later duplicate would "
                "silently override the recorded ceiling"
            )
        entries[rel] = int(count_str)
    return entries


def _write_baseline(path: Path, entries: dict[str, int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "".join(f"{count} {rel}\n" for rel, count in sorted(entries.items()))
    path.write_text(HEADER + body, encoding="utf-8")


def _shrunken_baseline(baseline: dict[str, int], current: dict[str, int]) -> dict[str, int]:
    """The refresh result: counts only ever lowered, clean/gone entries dropped."""
    survivors: dict[str, int] = {}
    for rel, recorded in baseline.items():
        now = current.get(rel, 0)
        if now > 0:
            survivors[rel] = min(recorded, now)
    return survivors


def _verdicts(
    violations: dict[str, list[int]],
    baseline: dict[str, int],
    changed: set[str] | None,
    added: dict[str, set[int]] | None,
) -> tuple[list[str], list[str], dict[str, list[int]], list[str]]:
    """(new_offenders, grown, added_line_offenders, shrunk) under the ratchet.

    ``changed`` None means scope was undeterminable: judge the whole tree.
    ``added`` None means added-line info was unavailable: skip only that rule.
    """
    current = {rel: len(lines) for rel, lines in violations.items()}

    def in_scope(rel: str) -> bool:
        return changed is None or rel in changed

    new_offenders: list[str] = []
    grown: list[str] = []
    added_line_offenders: dict[str, list[int]] = {}
    shrunk: list[str] = []
    for rel, count in sorted(current.items()):
        recorded = baseline.get(rel)
        if recorded is None:
            if in_scope(rel):
                new_offenders.append(rel)
        elif in_scope(rel):
            if count > recorded:
                grown.append(rel)
            elif added is not None:
                on_added = sorted(set(violations[rel]) & added.get(rel, set()))
                if on_added:
                    added_line_offenders[rel] = on_added
    for rel, recorded in sorted(baseline.items()):
        if current.get(rel, 0) < recorded and in_scope(rel):
            shrunk.append(rel)
    return new_offenders, grown, added_line_offenders, shrunk


def _fix_hint(path: str) -> str:
    return (
        f'::error file={path}::raw `getattr(os, "{FLAG_NAME}", 0)` -- a no-op '
        "on Windows, so this follows a reparse point there while documenting "
        "refusal. Borrow platform_compat.open_file_no_reparse (fails closed on "
        f"both platforms), or mark a deliberate raw use with `# {MARKER} <why>`."
    )


def run_gate(baseline_path: Path, update: bool) -> int:
    violations = _scan(DEFAULT_TARGETS)
    current = {rel: len(lines) for rel, lines in violations.items()}
    baseline = _read_baseline(baseline_path)

    if update:
        survivors = _shrunken_baseline(baseline, current)
        pruned = len(baseline) - len(survivors)
        lowered = sum(1 for rel in survivors if survivors[rel] < baseline[rel])
        _write_baseline(baseline_path, survivors)
        print(f"pruned {pruned} entr(y/ies), lowered {lowered}; {len(survivors)} remain")
        return 0

    scope = _load_scope()
    changed, scope_label = scope.changed_paths()
    print(f"nofollow-promises gate scope: {scope_label}", end="")
    print("" if changed is None else f" ({len(changed)} changed file(s))")
    added = scope.added_lines(scope_label) if changed is not None else None

    new_offenders, grown, added_line_offenders, shrunk = _verdicts(
        violations, baseline, changed, added
    )

    for rel in new_offenders:
        print(_fix_hint(rel))
        for line in violations[rel]:
            print(f"  {rel}:{line}")
    for rel in grown:
        print(
            f"::error file={rel}::raw O_NOFOLLOW-getattr sites grew from "
            f"{baseline[rel]} to {current[rel]}. New readers must borrow "
            f"platform_compat.open_file_no_reparse or carry `# {MARKER} <why>`."
        )
        for line in violations[rel]:
            print(f"  {rel}:{line}")
    for rel, lines in added_line_offenders.items():
        print(
            f"::error file={rel}::this change ADDS raw O_NOFOLLOW-getattr "
            "site(s) (the baseline grandfathers only pre-existing lines). "
            "Borrow platform_compat.open_file_no_reparse or carry "
            f"`# {MARKER} <why>`."
        )
        for line in lines:
            print(f"  {rel}:{line}")
    if shrunk:
        print(
            f"::error::{len(shrunk)} baselined file(s) now have fewer raw "
            "O_NOFOLLOW sites. Record the progress so the baseline keeps "
            "shrinking: python3 scripts/check_nofollow_promises.py --update-baseline"
        )
        for rel in shrunk:
            print(f"  {rel}: {baseline[rel]} -> {current.get(rel, 0)}")

    if new_offenders or grown or added_line_offenders or shrunk:
        print(
            f"\nnofollow-promises gate FAILED: {len(new_offenders)} new "
            f"offender(s), {len(grown)} grown count(s), "
            f"{len(added_line_offenders)} file(s) with new sites on added lines, "
            f"{len(shrunk)} entr(y/ies) to prune."
        )
        return 1

    total = sum(baseline.values())
    print(
        "nofollow-promises gate passed: nothing in scope spells the raw "
        f"O_NOFOLLOW no-op outside the baseline ({total} known site(s) in "
        f"{len(baseline)} file(s) still listed)."
    )
    return 0


def _self_test() -> int:
    """Plant one probe per rule family; a broken rule fails here, not in prod."""
    flagged_probes = {
        "plain getattr default 0": (
            'import os\nfd = os.open(p, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))\n'
        ),
        "multi-line call": (
            "import os\n"
            "fd = os.open(\n"
            "    p,\n"
            '    os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),\n'
            ")\n"
        ),
        "attribute os handle": (
            "import mod\n" 'fd = mod.os.open(p, getattr(mod.os, "O_NOFOLLOW", 0))\n'
        ),
        "marker inside a string is not a comment": (
            "import os\n"
            'note = "# nofollow-raw: x"\n'
            'fd = os.open(p, getattr(os, "O_NOFOLLOW", 0))\n'
        ),
    }
    clean_probes = {
        "non-zero default is not the hazard": (
            'import os\nflags = getattr(os, "O_NOFOLLOW", os.O_RDONLY)\n'
        ),
        "different flag name": 'import os\ng = getattr(os, "O_NONBLOCK", 0)\n',
        "non-os target": 'class C: ...\ng = getattr(C, "O_NOFOLLOW", 0)\n',
        "literal spelling in a docstring": (
            '"""getattr(os, \'O_NOFOLLOW\', 0) is 0 on Windows."""\n'
        ),
        "opt-out marker on the line": (
            'import os\nflags = getattr(os, "O_NOFOLLOW", 0)  # nofollow-raw: primitive\n'
        ),
        "marker on a multi-line expression": (
            "import os\n"
            "flags = (\n"
            '    getattr(os, "O_NOFOLLOW", 0)  # nofollow-raw: primitive\n'
            ")\n"
        ),
        "the primitive borrow is compliant": (
            "import platform_compat\nfd = platform_compat.open_file_no_reparse(p)\n"
        ),
    }
    failures: list[str] = []
    for label, source in flagged_probes.items():
        if not _violations_in_source(source):
            failures.append(f"NOT flagged but should be: {label}")
    for label, source in clean_probes.items():
        if _violations_in_source(source):
            failures.append(f"flagged but should be clean: {label}")
    for failure in failures:
        print(f"::error::self-test: {failure}")
    if failures:
        return 1
    print(
        f"self-test passed: {len(flagged_probes)} flagged probes, "
        f"{len(clean_probes)} clean probes."
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="lower counts / prune entries that improved; never adds or raises",
    )
    parser.add_argument(
        "--test",
        action="store_true",
        help="run the rule-family self-test instead of the gate",
    )
    args = parser.parse_args(argv)
    if args.test:
        return _self_test()
    return run_gate(args.baseline, args.update_baseline)


if __name__ == "__main__":
    raise SystemExit(main())
