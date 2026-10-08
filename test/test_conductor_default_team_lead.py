"""The team-lead practices, pinned in the two texts that carry them.

The goal conductor's operating procedure lives in two markdown-shaped strings --
``agent._CONDUCTOR_SYSTEM_PROMPT`` (shipped as the agent's charter) and the
``goal-conductor`` skill body -- and until this file existed, a clause in either
could be dropped by a well-meaning rewrite with nothing anywhere going red. The
nine practices asserted here were each learned by running fleets and losing a
round to its absence, so each one is a rule rather than advice, and each reuses a
mechanism that already exists in this repo rather than introducing one.

The dividing line, stated so a later edit has a rule to follow and not a taste to
guess at: **assert a phrase when it states a RULE** -- an obligation, a
prohibition, or the NAME of the mechanism the rule delegates to -- and do NOT
assert one that only explains why the rule exists. Rationale is what a rewrite is
entitled to reword, and pinning it produces a typo detector that every legitimate
edit has to fight, which is how a text test earns its deletion.

Two negative assertions carry as much weight as the positive ones. Capacity must
stay a question for ``resource_status`` and the server's own slot ceilings, so
neither text may hard-code a session or headcount number; and the depth cap must
stay where it is, so this change may not raise ``MAX_DEPTH`` while describing
what it costs.
"""

from __future__ import annotations

import inspect
import re
from pathlib import Path

import pytest

# The work-ledger route harness, for the one assertion here that must be driven
# through the real read rather than inferred from the handler's source. Imported
# for their names: pytest binds the autouse fixtures by presence in this module.
from test_work_ledger_tools import (  # noqa: F401
    _clean_slots,
    _isolated_home,
    _open_route,
)

from kiro_crew import agent, work_ledger

REPO_ROOT = Path(__file__).resolve().parents[1]
SKILL_MD = REPO_ROOT / "src" / "kiro_crew" / "builtin_skills" / "goal-conductor" / "SKILL.md"


def _flat(text: str) -> str:
    """Collapse whitespace and lowercase, so a phrase assertion survives a rewrap.

    Both texts are re-flowed every time a sentence in them is edited, so a check
    that breaks on a line break is testing the paragraph filler rather than the
    contract.
    """
    return " ".join(text.split()).lower()


CHARTER = _flat(agent._CONDUCTOR_SYSTEM_PROMPT)
SKILL = _flat(SKILL_MD.read_text(encoding="utf-8"))
BOTH = {"charter": CHARTER, "skill": SKILL}


@pytest.fixture(params=sorted(BOTH))
def text(request: pytest.FixtureRequest) -> str:
    """Each practice is asserted against BOTH texts.

    A conductor reads its charter always and the skill only once it loads it, so a
    practice present in one and absent from the other is a practice that applies
    on some runs and not others -- which is the shape of the bug, not a saving.
    """
    return BOTH[request.param]


# -- 1. an item of unknown size goes to a conductor --------------------------


class TestUnknownSizeDispatchesAConductor:
    """The default flips: a worker is the choice you justify, not the fallback."""

    def test_the_conductor_is_the_default_for_an_item_of_unknown_size(self, text: str) -> None:
        assert "cannot yet tell how big it is" in text

    def test_a_worker_is_named_only_for_a_single_assertable_leaf(self, text: str) -> None:
        assert "clearly one leaf" in text
        assert "single assertable acceptance condition" in text

    def test_the_decision_reads_the_conductors_own_depth(self, text: str) -> None:
        """``work_ledger_read`` already returns it on the conductor record, compact
        read included, so the rule delegates rather than guessing.

        Pinned on ``"compact read"``, which occurs exactly once in each text. The
        three words this rule is built from -- ``work_ledger_read``, ``depth`` and
        ``compact`` -- occur 4 to 18 times apiece, so asserting those would pass on
        a text that had lost the sentence entirely.
        """
        assert "compact read" in text

    def test_the_cap_refuses_every_item_not_only_a_conductor_child(self, text: str) -> None:
        """The measured breakage: at the cap ``create_item`` refuses worker items
        too, so flattening is not an escape and the item belongs one level up."""
        assert "worker ones included" in text

    def test_a_session_at_the_cap_reports_blocked_instead_of_dispatching(self, text: str) -> None:
        assert "`status: blocked`" in text

    def test_a_depth_exceeded_is_never_retried_or_re_spelled(self, text: str) -> None:
        assert "`depth_exceeded`" in text
        assert "never retry" in text or "never retried" in text


@pytest.mark.asyncio
async def test_a_compact_read_really_carries_the_conductors_own_depth(monkeypatch) -> None:
    """Driven through the read route, because the whole dispatch rule rests on it.

    Both texts tell a conductor to read its own ``depth`` off the ``conductor``
    record on the cheap patrol read. ``_COMPACT_ROW_FIELDS`` deliberately has no
    ``depth`` -- it is a property of the BOARD, not of an item -- so a reader who
    looked only at the row list would conclude the compact read cannot answer the
    question, and would either take the expensive read every cycle or drop the
    rule. This asserts both halves: on the record yes, on a row no.
    """
    from test_work_ledger_tools import CONDUCTOR_A, _read, _read_with, _three_dated_items

    await _three_dated_items(monkeypatch)
    _, compact = await _read_with(CONDUCTOR_A, "compact=true")
    _, full = await _read(CONDUCTOR_A)

    assert compact["compact"] is True
    assert "depth" in compact["conductor"]
    assert compact["conductor"]["depth"] == full["conductor"]["depth"]
    assert "depth" not in compact["items"][0]


def test_the_which_agent_table_exists_in_both_texts_and_both_carry_the_default() -> None:
    """The dispatch table is DUPLICATED, and that is the trap this test closes.

    A conductor boots on the charter and reads the skill only once it loads it, so a
    rule added to the skill alone leaves the booting conductor still sending unsized
    items to a worker. The parametrized assertions above already run against both
    copies; this one additionally pins that there ARE two copies, so a future edit
    cannot satisfy the suite by deleting one of them.
    """
    for name, text in BOTH.items():
        assert "### which agent" in text, f"{name} lost the dispatch table"
        assert "cannot yet tell how big it is" in text, f"{name}'s table lost the default"
        assert "`kirocrew-conductor`" in text, name
        assert "`kirocrew-worker`" in text, name


def test_the_cap_itself_is_unchanged() -> None:
    """This change describes what the cap costs; it does not raise it.

    Pinned against the module rather than against the prose, because the prose is
    what a later edit would update to MATCH a raise, so prose alone cannot catch
    one.
    """
    assert work_ledger.MAX_DEPTH == 2


#: The three guards the texts now quote, each as the source expression the text
#: reproduces and the function that holds it. The TEXTS state the comparison
#: operators, so the operators are part of the contract: two ``>`` guards admit a
#: session at the cap and one ``>=`` refuses every item it writes, which is the
#: whole asymmetry both texts exist to warn a conductor about. An edit that
#: changed any operator would silently make the quoted comparison a lie.
_DEPTH_GUARDS: tuple[tuple[str, str], ...] = (
    ("child_depth", "depth + 1 > MAX_DEPTH"),
    ("ensure_conductor", "checked_depth > MAX_DEPTH"),
    ("_create_item", "record.depth >= MAX_DEPTH"),
)


@pytest.mark.parametrize(("function", "comparison"), _DEPTH_GUARDS)
def test_each_guard_the_texts_quote_holds_the_comparison_they_quote(
    function: str, comparison: str
) -> None:
    """Read off the enclosing function's own source, so a guard that moved to
    another function fails here rather than passing on a file-wide grep."""
    import ast
    import inspect
    import textwrap

    source = inspect.getsource(getattr(work_ledger, function))
    tree = ast.parse(textwrap.dedent(source))
    comparisons = {
        ast.unparse(node.test)
        for node in ast.walk(tree)
        if isinstance(node, ast.If) and isinstance(node.test, ast.Compare)
    }
    assert comparison in comparisons, f"{function} no longer guards on {comparison}"


@pytest.mark.parametrize("name", [f for f, _ in _DEPTH_GUARDS])
def test_every_quoted_guard_is_named_in_the_text_that_quotes_it(name: str) -> None:
    """Both texts describe the same three guards, so neither may name only some.

    The charter states the two comparisons that matter for a dispatch decision and
    the skill tabulates all three; what this pins is that a guard the prose leans
    on is named somewhere in the text leaning on it, rather than being described
    as an unattributed "the cap".
    """
    assert name in SKILL, f"the skill describes a guard it does not name: {name}"


def _guard_table_symbols() -> list[str]:
    """Every symbol named in the first column of the skill's guard table.

    Scoped to that table rather than to the whole passage on purpose. The passage
    also backticks tool verbs, config keys and action names, none of which are
    ``work_ledger`` attributes, so a passage-wide scan would need an allowlist of
    exceptions -- and an allowlist is the thing that would quietly absorb a wrong
    name. The table's first column holds nothing but guard functions, so every
    token in it must resolve, with no exceptions to maintain.
    """
    import re

    rows = [
        line
        for line in SKILL_MD.read_text(encoding="utf-8").splitlines()
        if line.startswith("| `") and "MAX_DEPTH`" in line
    ]
    return [match for line in rows for match in re.findall(r"^\| `([^`]+)`", line)]


def test_every_guard_the_table_names_actually_exists() -> None:
    """A dangling symbol in shipped prose is worse than vague prose.

    The prose is read by an agent that cannot check it, so a plausible-looking name
    that does not exist sends it hunting for a guard that is not there. This table
    attracts the mistake: a reviewer relaying a measurement naturally paraphrases a
    function name, and the ledger-opening guard sounds like it would be called
    ``create_ledger`` when the function is ``ensure_conductor``.
    """
    named = _guard_table_symbols()
    assert len(named) == len(_DEPTH_GUARDS), f"the guard table lost a row: {named}"
    missing = sorted(name for name in named if not hasattr(work_ledger, name))
    assert not missing, f"the guard table names symbols that do not exist: {missing}"
    assert named == [function for function, _ in _DEPTH_GUARDS]


def test_the_symbol_scan_can_fail() -> None:
    """The control: the scan rejects the name the conductor actually handed over."""
    assert not hasattr(work_ledger, "create_ledger")
    assert hasattr(work_ledger, "ensure_conductor")


def test_the_child_depth_boundary_is_where_the_texts_say_it_is() -> None:
    """The pure half of the asymmetry: a parent at 1 is ADMITTED, so nothing
    refuses the dispatch that produces a dead depth-2 conductor.

    The behavioural ``>=`` half -- that a conductor AT the cap creates nothing --
    is already pinned by the store's own suite and is not duplicated here:
    ``test_work_ledger.py`` holds ``test_create_is_refused_when_the_conductor_is_
    at_the_depth_cap`` (which also asserts ``list_work_items`` stays empty),
    ``test_a_conductor_one_below_the_cap_may_still_dispatch``, and
    ``test_ensure_conductor_refuses_a_depth_past_the_cap``.
    """
    assert work_ledger.child_depth(0) == 1
    assert work_ledger.child_depth(1) == work_ledger.MAX_DEPTH
    with pytest.raises(work_ledger.WorkLedgerError) as caught:
        work_ledger.child_depth(work_ledger.MAX_DEPTH)
    assert caught.value.code == work_ledger.CODE_DEPTH_EXCEEDED


# -- 2. the seed stands alone ------------------------------------------------


class TestTheSeedStandsAlone:
    """Six parts, because the child reads nothing but the seed."""

    @pytest.mark.parametrize(
        "part",
        [
            "owner's words",
            "inputs",
            "ownership",
            "acceptance",
            "stop conditions",
            "test bar",
        ],
    )
    def test_the_seed_names_each_part(self, text: str, part: str) -> None:
        assert part in text

    def test_the_child_may_not_end_its_turn_before_the_output_exists(self, text: str) -> None:
        assert "do not end your turn before the output exists" in text

    def test_a_guardrail_block_is_reported_with_command_rule_and_message(self, text: str) -> None:
        assert "the rule that fired" in text
        assert "the message, and stops" in text

    def test_re_spelling_a_refused_command_is_named_a_bypass(self, text: str) -> None:
        assert "bypass" in text


# -- 3. a stalled fleet is one fault ----------------------------------------


class TestAStalledFleetIsOneFault:
    def test_many_stale_items_at_once_are_read_as_one_fault(self, text: str) -> None:
        assert "`stale`" in text
        assert "one fault" in text

    def test_the_output_is_checked_before_an_item_is_reseeded(self, text: str) -> None:
        assert "before you reseed" in text

    def test_the_rule_reuses_the_derived_flags_and_adds_no_timer(self, text: str) -> None:
        """Pinned on the whole prohibition, which is unique in each text.

        ``orphaned`` and ``timer`` each occur up to three times, so either alone
        would still be satisfied by a text that had dropped this rule.
        """
        assert "add a timer of your own" in text


# -- 4. a handoff is an artifact --------------------------------------------


class TestAHandoffIsAnArtifact:
    def test_what_moves_is_a_sha_a_pr_number_or_a_path(self, text: str) -> None:
        assert "commit sha" in text
        assert "pull-request number" in text

    def test_the_value_is_read_from_artifacts_and_not_from_the_summary(self, text: str) -> None:
        assert "`artifacts`" in text
        assert "not from the worker's `summary`" in text

    def test_the_item_record_is_not_a_message_bus(self, text: str) -> None:
        """``decision`` is one string that ``decide`` overwrites, so a dependency
        parked there is a message nothing guarantees anyone reads."""
        assert "not a message bus" in text

    def test_an_awaited_artifact_that_is_the_bar_becomes_the_acceptance(self, text: str) -> None:
        """``action=accept`` occurs three times in each text -- the claimed-``pr``
        promotion and the capacity rule both name it -- so the pin carries the verb
        that makes this occurrence the dependency one."""
        assert "promoted with `action=accept`" in text

    def test_an_artifact_that_cannot_be_a_bar_is_relayed_by_the_parent(self, text: str) -> None:
        assert "common parent" in text
        assert "relay" in text

    def test_a_mutual_wait_is_stated_by_whoever_noticed(self, text: str) -> None:
        assert "who owes what" in text


# -- 5. a standing ruling lives in the ledger -------------------------------


class TestAStandingRulingLivesInTheLedger:
    def test_a_ruling_past_one_item_is_recorded_with_decide(self, text: str) -> None:
        assert "a ruling you make once is recorded once" in text
        assert "`action=decide`" in text

    def test_decision_is_the_field_a_child_reads_as_an_instruction(self, text: str) -> None:
        assert "`decision`" in text
        assert "as an instruction" in text

    def test_a_ruling_in_one_transcript_only_is_named_as_the_failure(self, text: str) -> None:
        assert "transcript" in text

    def test_a_decide_is_stated_to_replace_rather_than_append(self, text: str) -> None:
        """The field is one string and ``decide`` sets it, so an increment drops the
        earlier ruling. A conductor that is not told this writes increments."""
        assert "`decide` replaces it" in text
        assert "whole instruction" in text

    def test_decision_is_named_as_the_current_instruction_not_a_log(self, text: str) -> None:
        assert "never a log" in text


def test_decision_really_is_one_string_that_decide_overwrites() -> None:
    """The two code facts the replace-not-append rule rests on.

    Asserted here so the rule cannot outlive them: if ``decision`` ever became a
    list, or ``decide`` gained an append mode, this test is what sends a reader
    back to the prose.
    """
    from dataclasses import fields

    from kiro_crew import work_vocab

    (decision,) = [f for f in fields(work_ledger.WorkItem) if f.name == "decision"]
    assert decision.type in ("str", str)
    assert work_vocab.WORK_CONDUCTOR_FIELDS["decide"] == ("decision", "round")


def test_a_dependency_has_the_two_homes_the_vocab_allows() -> None:
    """``accept`` is the only action that writes ``acceptance``, which is why an
    awaited artifact that IS the bar goes there and nowhere else."""
    from kiro_crew import work_vocab

    assert work_vocab.WORK_CONDUCTOR_FIELDS["accept"] == ("acceptance",)


# -- 6. verified and relayed are not interchangeable ------------------------


class TestVerifiedIsSeparatedFromRelayed:
    def test_both_grades_are_named(self, text: str) -> None:
        assert "verified" in text
        assert "relayed" in text

    def test_verified_means_the_evaluator_or_output_read_first_hand(self, text: str) -> None:
        assert "accept_eval.py" in text

    def test_the_shell_is_described_as_withheld_rather_than_absent(self, text: str) -> None:
        """``execute_bash`` IS mounted; it is kept out of ``allowedTools`` only.

        So the honest statement is a policy one -- every call prompts, it is there
        for the two bundled scripts, and a work item's build through it is the
        boundary violation -- not a capability one. Saying the conductor "has no
        way to run" a command is false, and a charter that overstates a limit
        teaches a reader to distrust the limits that are real.
        """
        assert "mounted and never auto-approved" in text
        assert "boundary violation" in text
        assert "no way to run" not in text

    def test_a_claim_stays_relayed_until_the_evaluator_answers(self, text: str) -> None:
        assert "until the evaluator answers" in text

    def test_relayed_evidence_is_attributed_rather_than_stated(self, text: str) -> None:
        assert "attribute it" in text


# -- 7. a dropped item is still owed ----------------------------------------


class TestADroppedItemIsStillOwed:
    def test_the_close_says_dropped_and_still_owed(self, text: str) -> None:
        assert "dropped" in text
        assert "owed" in text

    def test_the_record_carries_the_resume_trigger(self, text: str) -> None:
        assert "worth" in text and "resum" in text

    def test_it_reuses_the_abandoned_state_rather_than_a_new_one(self, text: str) -> None:
        assert "`state=abandoned`" in text

    def test_the_trigger_goes_in_closes_own_decision(self, text: str) -> None:
        """``close`` writes ``(state, decision)``; ``summary`` and ``artifacts`` are
        the worker's, so ``decision`` is the only field left for the reason."""
        assert "`close` writes" in text
        assert "`decision`" in text

    def test_the_worker_owned_fields_are_named_as_unavailable(self, text: str) -> None:
        assert "`work_report`" in text
        assert "`summary`" in text


def test_close_writes_only_the_two_fields_the_texts_name() -> None:
    """The constraint the resume-trigger rule is derived from, pinned against the
    vocabulary table both the write route and the fold read."""
    from kiro_crew import work_vocab

    assert work_vocab.WORK_CONDUCTOR_FIELDS["close"] == ("state", "decision")


# -- 8. the dynamic dashboard is the person's status board ------------------


class TestTheDynamicDashboardIsTheStatusBoard:
    def test_the_board_verbs_are_named(self, text: str) -> None:
        assert "`dashboard_fields`" in text
        assert "`dashboard_write`" in text

    @pytest.mark.parametrize("field", ["`for_you`", "`verdict`", "`ci`"])
    def test_the_refresh_names_every_agentic_field(self, text: str, field: str) -> None:
        """All THREE, not the two a reader notices first.

        A field the text never names is one the conductor never writes, and ``ci``
        is the one that goes missing: ``verdict`` and ``for_you`` feel like the
        whole job, and nothing else fills ``ci`` because no fold polls a code
        host.
        """
        assert "milestone" in text
        assert field in text

    def test_a_value_a_fold_already_provides_is_not_typed_by_hand(self, text: str) -> None:
        assert "fold" in text

    def test_the_mount_is_stated_rather_than_assumed(self, text: str) -> None:
        """``_conductor_spec`` mounts no ``@kirocrew-panel``, so the verbs are a crew
        member's path and the texts must say so instead of promising them.

        Both texts carry the SAME sentence. Matching wording rather than each
        making the point its own way is deliberate: two phrasings of one caveat is
        how the two texts start disagreeing about it.
        """
        assert "which this spec does not mount" in text

    def test_the_caveat_covers_the_drawer_verb_too(self, text: str) -> None:
        """``panel_publish`` is on the same unmounted server as the two dashboard
        verbs, so EVERY mention of it must sit inside the crew-member passage that
        scopes it -- not merely one of them.

        Position, and every occurrence. The sentence read wrong because of WHERE it
        sat: above the crew-member heading, in the section about a conductor's own
        non-delegable jobs, where a plain conductor reads it as a verb it has. A
        presence check cannot see that at all, and an any-occurrence check passes
        the moment the caveat's own mention exists -- which is how the first
        version of this test passed against a deliberately reintroduced
        regression.
        """
        marker = text.find("running as a crew member")
        assert marker != -1, "the crew-member passage is gone"
        stray = [index for index in range(marker) if text.startswith("`panel_publish`", index)]
        assert not stray, (
            f"{len(stray)} mention(s) of panel_publish sit above the crew-member "
            "passage, where a plain conductor reads them as a verb it has"
        )
        assert text.find("`panel_publish`", marker) != -1, "the caveat lost the drawer verb"

    def test_the_template_is_not_confused_with_the_verb(self, text: str) -> None:
        """``BOARD_TEMPLATE_ID`` is ``kirocrew-conductor``, so the board is a
        conductor's board by name however it is published. Only the VERB is
        member-only, and a text that blurred the two would read as though the
        conductor had no board at all."""
        assert "the template is not what is unreachable" in SKILL


def test_the_template_really_marks_three_fields_agentic() -> None:
    """Read from the manifest, so the count in both texts cannot drift from it.

    The texts name the agentic fields one by one; if the template ever declared a
    fourth, naming three would quietly leave it unwritten on every page.
    """
    import json

    manifest = json.loads(
        (
            REPO_ROOT / "src/kiro_crew/dashboard_templates/builtin/project-report/manifest.json"
        ).read_text(encoding="utf-8")
    )
    agentic = sorted(
        name for name, spec in manifest["fields"].items() if spec.get("source", {}).get("agentic")
    )
    assert agentic == ["ci", "for_you", "verdict"]


def test_the_conductor_spec_mounts_the_shell_it_never_auto_approves() -> None:
    """The fact N1 turned on: mounted in ``tools``, absent from ``allowedTools``.

    Both halves are asserted, because the texts now rest on the GAP between them
    -- a tool that is reachable with an approval is not a tool you do not have.
    """
    from kiro_crew.agent_materialization import conductor_agents

    source = inspect.getsource(conductor_agents._conductor_spec)
    assert '"execute_bash",' in source, "execute_bash is no longer mounted"
    assert "execute_bash" not in str(agent._CONDUCTOR_CORE_GRANTS)


def test_the_board_template_is_still_the_conductors_own() -> None:
    """The other half of the template/verb split, read from the contract module.

    If this id ever stopped naming the conductor, the skill's "the template is not
    what is unreachable" would be wrong in the opposite direction -- so the split
    is pinned from both sides rather than asserted once in prose.
    """
    from kiro_crew import conductor_board_contract

    assert conductor_board_contract.BOARD_TEMPLATE_ID == "kirocrew-conductor"


def test_the_conductor_spec_still_does_not_mount_the_panel_server() -> None:
    """The condition the dashboard clause is written around, asserted against the
    spec rather than trusted: if the panel server is ever mounted here, the
    "simply absent" wording in both texts becomes wrong."""
    from kiro_crew.agent_materialization import conductor_agents

    servers = conductor_agents._conductor_mcp_servers({})
    assert "kirocrew-work" in servers
    assert "kirocrew-panel" not in servers


# -- 9. the scope is pinned in one line -------------------------------------


class TestTheScopeIsPinnedInOneLine:
    def test_the_ask_is_restated_as_a_single_line(self, text: str) -> None:
        assert "pin the scope in one line" in text

    def test_the_line_is_recorded_with_the_goal_action(self, text: str) -> None:
        assert "`action=goal`" in text

    def test_the_newest_owner_statement_wins(self, text: str) -> None:
        assert "newest statement wins" in text

    def test_the_round_report_opens_with_it(self, text: str) -> None:
        assert "round report" in text


# -- the two negative contracts ---------------------------------------------

#: The one number a headcount scan must not flag: the documented default item
#: cap, which the procedure states and the conductor counts against. Deliberately
#: a single entry. An allowlist wide enough to hold every digit the texts happen to
#: contain is not a contract, it is a record of what was there when the scan was
#: written -- so anything else the scan catches is either a real hard-coded
#: headcount or a sentence to reword, and adding to this set is a visible act a
#: reviewer sees in the diff.
_PERMITTED_NUMBERS = {"20"}

#: A digit next to a noun that counts sessions, items or children. The noun group is
#: deliberately wider than "session": capacity leaks into these texts as a number of
#: ITEMS or CHATS just as readily, and a scan that only knew the word "session" is
#: what let the first draft past.
_HEADCOUNT_RE = re.compile(
    r"\b(\d+)\s+(?:concurrent\s+|live\s+|parallel\s+)?"
    r"(sessions?|workers?|conductors?|crewmates?|slots?|items?|children|chats?|tasks?)\b"
)


def _headcounts(text: str) -> list[str]:
    return [
        match.group(0)
        for match in _HEADCOUNT_RE.finditer(text)
        if match.group(1) not in _PERMITTED_NUMBERS
    ]


def test_the_headcount_scan_can_fail() -> None:
    """The positive control, without which the scan below proves nothing.

    A regex that matches nothing passes whatever the texts say, and a scan with no
    control cannot tell "the texts are clean" from "the pattern is broken". So this
    asserts the pattern fires on a sentence of exactly the shape it exists to
    refuse, and that the allowlist does not swallow it.
    """
    assert _headcounts("hold a fleet of 15 sessions") == ["15 sessions"]
    assert _headcounts("dispatch 4 workers per round") == ["4 workers"]
    assert _headcounts("keep 8 chats open") == ["8 chats"]
    assert _headcounts("a goal holds at most 20 items") == [], "the one permitted bound"


@pytest.mark.parametrize("name", sorted(BOTH))
def test_neither_text_hard_codes_a_session_or_headcount_number(name: str) -> None:
    """Capacity is ``resource_status`` plus the server's own slot ceilings.

    A number typed into a charter is a number no operator can change and no host
    can be measured against, so a sentence that puts a digit next to a noun
    counting sessions, items or children is what this scan refuses. A legitimate
    bound is reworded to carry its name rather than added to the allowlist --
    "a session at ``depth`` 2" rather than "a ``depth``-2 session", which is a
    depth value the scan would otherwise read as a headcount.
    """
    offenders = _headcounts(BOTH[name])
    assert not offenders, f"{name} hard-codes a headcount: {offenders}"


@pytest.mark.parametrize("name", sorted(BOTH))
def test_capacity_is_delegated_to_the_resource_reader(name: str) -> None:
    assert "resource_status" in BOTH[name]


@pytest.mark.parametrize("name", sorted(BOTH))
def test_the_wake_is_the_existing_work_ledger_watch(name: str) -> None:
    """No practice here introduces a poll. The event wake already exists, so each
    cadence rule hangs off it."""
    assert 'watch="work-ledger"' in BOTH[name]
