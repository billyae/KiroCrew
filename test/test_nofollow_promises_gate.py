"""The nofollow-promises gate must be real, wired into CI, and ratchet-only.

``getattr(os, "O_NOFOLLOW", 0)`` is ``0`` on Windows, so a read helper built on
the raw flag follows a reparse point there while documenting refusal (#9731).
The lint gate in ``scripts/check_nofollow_promises.py`` keeps that class from
growing back. These tests pin the halves that must stay true together: CI
actually runs the gate (a gate that exists only on disk is not a gate), the AST
rules flag what they claim to flag, and the baseline can only shrink -- no
operation may add a path or raise a count.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_nofollow_promises.py"
BASELINE = ROOT / ".github" / "nofollow-promises-baseline.txt"
CI = ROOT / ".github" / "workflows" / "ci.yml"

SPEC = importlib.util.spec_from_file_location("check_nofollow_promises", SCRIPT)
assert SPEC and SPEC.loader
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


def _lint_steps() -> list[dict]:
    workflow = yaml.safe_load(CI.read_text(encoding="utf-8"))
    for job in workflow["jobs"].values():
        steps = job.get("steps") or []
        if any("isort --check-only" in str(step.get("run", "")) for step in steps):
            return steps
    raise AssertionError("ci.yml has no job running isort --check-only")


class TestCiWiring:
    def test_ci_actually_runs_the_gate(self) -> None:
        runs = [str(step.get("run", "")) for step in _lint_steps()]
        assert any(
            "scripts/check_nofollow_promises.py" in run for run in runs
        ), "ci.yml's lint job no longer runs the nofollow-promises gate"

    def test_ci_runs_the_self_test_first(self) -> None:
        # The self-test plants one probe per rule family, so a typo that
        # silently disables a rule fails in CI instead of shipping green.
        for run in (str(step.get("run", "")) for step in _lint_steps()):
            if "check_nofollow_promises.py" not in run:
                continue
            assert "--test" in run, "the gate step must run the --test self-test"
            return
        raise AssertionError("gate step not found")

    def test_prepare_pr_floor_mirrors_the_gate(self) -> None:
        # The frozen floor mirrors ci.yml by hand; a blocking CI scan absent
        # from it is a gate installed copies can never learn about.
        profile = (
            ROOT
            / "src/kiro_crew/builtin_skills/kirocrew-dev/kirocrew-prepare-pr/profiles/kirocrew.json"
        )
        floor = profile.read_text(encoding="utf-8")
        assert "scripts/check_nofollow_promises.py" in floor

    def test_scope_resolver_coupling_is_alive(self) -> None:
        # The gate loads scripts/ratchet_scope.py, which OWNS both answers. A
        # rename there must fail HERE, not as an AttributeError inside a CI run.
        scope = gate._load_scope()
        assert callable(scope.changed_paths)
        assert callable(scope.added_lines)


class TestRuleFamilies:
    """One probe per rule family, through the real detector."""

    def _lines(self, source: str) -> list[int]:
        return gate._violations_in_source(source)

    def test_flags_plain_default_zero(self) -> None:
        source = 'import os\nfd = os.open(p, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))\n'
        assert self._lines(source) == [2]

    def test_flags_multiline_calls(self) -> None:
        # The reason the check is AST-based: a getattr whose arguments span
        # several lines is one expression a regex cannot pair reliably.
        source = (
            "import os\n"
            "fd = os.open(\n"
            "    p,\n"
            '    os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),\n'
            ")\n"
        )
        assert self._lines(source) == [4]

    def test_flags_attribute_os_handle(self) -> None:
        source = 'import mod\nfd = mod.os.open(p, getattr(mod.os, "O_NOFOLLOW", 0))\n'
        assert self._lines(source) == [2]

    def test_non_zero_default_is_not_the_hazard(self) -> None:
        # The silent-0 fallback is the whole defect; a real default is fine.
        source = 'import os\nflags = getattr(os, "O_NOFOLLOW", os.O_RDONLY)\n'
        assert self._lines(source) == []

    def test_different_flag_name_is_clean(self) -> None:
        assert self._lines('import os\ng = getattr(os, "O_NONBLOCK", 0)\n') == []

    def test_non_os_target_is_clean(self) -> None:
        assert self._lines('class C: ...\ng = getattr(C, "O_NOFOLLOW", 0)\n') == []

    def test_literal_in_a_docstring_does_not_flag(self) -> None:
        # The spelling as prose is not a call; only a real getattr expression is.
        source = '"""getattr(os, \'O_NOFOLLOW\', 0) is 0 on Windows."""\n'
        assert self._lines(source) == []

    def test_marker_inside_a_string_literal_does_not_exempt(self) -> None:
        # The marker must be a COMMENT token; the phrase as call data is not
        # an author's opt-out decision.
        source = (
            "import os\n"
            'note = "# nofollow-raw: x"\n'
            'fd = os.open(p, getattr(os, "O_NOFOLLOW", 0))\n'
        )
        assert self._lines(source) == [3]

    def test_marker_opts_out_on_any_expression_line(self) -> None:
        source = (
            "import os\n"
            "flags = (\n"
            '    getattr(os, "O_NOFOLLOW", 0)  # nofollow-raw: primitive\n'
            ")\n"
        )
        assert self._lines(source) == []

    def test_marker_on_an_unrelated_line_does_not_leak(self) -> None:
        source = (
            "import os\n"
            'a = getattr(os, "O_NOFOLLOW", 0)  # nofollow-raw: primitive\n'
            'b = getattr(os, "O_NOFOLLOW", 0)\n'
        )
        assert self._lines(source) == [3]

    def test_unparseable_source_raises_instead_of_reading_clean(self) -> None:
        # A parse failure reading as "zero violations" would invite a baseline
        # prune that deletes the file's real entry.
        with pytest.raises(SyntaxError):
            self._lines("def broken(:\n")

    def test_self_test_passes(self) -> None:
        assert gate._self_test() == 0


class TestVerdicts:
    """The ratchet's verdict logic, on synthetic inputs."""

    def test_unbaselined_file_in_scope_is_a_new_offender(self) -> None:
        new, grown, on_added, shrunk = gate._verdicts({"src/x.py": [10]}, {}, {"src/x.py"}, None)
        assert new == ["src/x.py"]
        assert not grown and not on_added and not shrunk

    def test_out_of_scope_files_are_not_judged(self) -> None:
        # CI evaluates a merge ref: someone else's file must not colour this PR.
        new, grown, on_added, shrunk = gate._verdicts(
            {"src/x.py": [10], "src/y.py": [5, 6]},
            {"src/y.py": 1},
            {"src/other.py"},
            None,
        )
        assert not new and not grown and not on_added and not shrunk

    def test_grown_count_fails(self) -> None:
        new, grown, on_added, shrunk = gate._verdicts(
            {"src/x.py": [1, 2, 3]}, {"src/x.py": 2}, {"src/x.py"}, None
        )
        assert grown == ["src/x.py"]

    def test_swapping_one_violation_for_another_is_caught_by_added_lines(self) -> None:
        # Convert one old site, add one new one: the count is level, but the
        # new site sits on an added line and must still fail.
        new, grown, on_added, shrunk = gate._verdicts(
            {"src/x.py": [10, 30]},
            {"src/x.py": 2},
            {"src/x.py"},
            {"src/x.py": {30}},
        )
        assert on_added == {"src/x.py": [30]}
        assert not new and not grown

    def test_shrunk_count_demands_a_prune(self) -> None:
        new, grown, on_added, shrunk = gate._verdicts(
            {"src/x.py": [10]}, {"src/x.py": 3}, {"src/x.py"}, None
        )
        assert shrunk == ["src/x.py"]

    def test_undeterminable_scope_judges_the_whole_tree(self) -> None:
        new, _, _, _ = gate._verdicts({"src/x.py": [10]}, {}, None, None)
        assert new == ["src/x.py"]


class TestBaselineRatchet:
    def test_committed_baseline_parses_and_files_exist(self) -> None:
        entries = gate._read_baseline(BASELINE)
        assert entries, "committed baseline is empty -- was it regenerated?"
        for rel, count in entries.items():
            assert count > 0, f"baseline lists {rel} with a zero count"
            assert not Path(rel).is_absolute(), f"absolute path in baseline: {rel}"
            assert (ROOT / rel).is_file(), f"baseline lists a deleted file: {rel}"

    def test_missing_baseline_refuses_rather_than_absorbs(self, tmp_path: Path) -> None:
        with pytest.raises(SystemExit, match="restore it from git"):
            gate._read_baseline(tmp_path / "absent.txt")

    def test_malformed_baseline_line_is_rejected(self, tmp_path: Path) -> None:
        bad = tmp_path / "baseline.txt"
        bad.write_text("notanumber src/x.py\n", encoding="utf-8")
        with pytest.raises(SystemExit, match="malformed"):
            gate._read_baseline(bad)

    def test_duplicate_baseline_entry_is_rejected(self, tmp_path: Path) -> None:
        # A later duplicate would silently override the recorded ceiling.
        bad = tmp_path / "baseline.txt"
        bad.write_text("1 src/x.py\n9 src/x.py\n", encoding="utf-8")
        with pytest.raises(SystemExit, match="duplicate"):
            gate._read_baseline(bad)

    def test_refresh_never_adds_a_path(self) -> None:
        survivors = gate._shrunken_baseline({"src/a.py": 2}, {"src/new.py": 5})
        assert "src/new.py" not in survivors

    def test_refresh_never_raises_a_count(self) -> None:
        survivors = gate._shrunken_baseline({"src/a.py": 2}, {"src/a.py": 7})
        assert survivors == {"src/a.py": 2}

    def test_refresh_lowers_and_prunes(self) -> None:
        survivors = gate._shrunken_baseline(
            {"src/a.py": 5, "src/clean.py": 3, "gone.py": 1},
            {"src/a.py": 2},
        )
        assert survivors == {"src/a.py": 2}

    def test_primitive_module_is_grandfathered_and_docstring_mention_ignored(self) -> None:
        """platform_compat.py IS the Windows-correct chokepoint: its raw-flag
        sites are the primitive's own POSIX implementation, grandfathered in the
        baseline (shrink-only, so they can never grow). Its count also proves
        the AST ignores the literal spelling inside the docstring -- the module
        has six textual `O_NOFOLLOW` hits but only the five real `getattr`
        expressions are counted."""
        rel = "src/kiro_crew/platform_compat.py"
        baseline = gate._read_baseline(BASELINE)
        assert baseline.get(rel) == 5, (
            "platform_compat.py should carry exactly its five real getattr sites; "
            "a sixth would mean the docstring mention was miscounted as a call"
        )
        violations = gate._violations_in_source((ROOT / rel).read_text(encoding="utf-8"))
        assert len(violations) == 5

    def test_write_read_roundtrip(self, tmp_path: Path) -> None:
        path = tmp_path / "baseline.txt"
        entries = {"src/b.py": 2, "src/a.py": 7}
        gate._write_baseline(path, entries)
        assert gate._read_baseline(path) == entries
        # Header survives as comments and the body is sorted.
        body = [
            line
            for line in path.read_text(encoding="utf-8").splitlines()
            if line and not line.startswith("#")
        ]
        assert body == ["7 src/a.py", "2 src/b.py"]
