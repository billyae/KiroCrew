---
title: The conductor is the default team lead -- nine field lessons folded into the shipped charter
status: draft
author: chenmingwei23, with kirocrew-worker
created: 2026-10-08
last-audited: 2026-10-08
audited-at: 1c5a71db4d
doc-pr: null
implementation-prs: []
tracking-issues: [18049]
supersedes: []
superseded-by: []
---

# RFC: The conductor is the default team lead

> **Status:** `draft`. Acceptance is requested from a maintainer; the status flips
> to `accepted` when one records it in §4 with the date. This is a tier T3 change:
> it reworks text users already rely on, so the decision is recorded here before
> the implementation merges. Nothing proposed below is a new mechanism. Every row
> in §2 names a mechanism that is already on main, measured at `1c5a71db4d`.

- Tracking issue: [#18049](https://github.com/kirodotdev/KiroCrew/issues/18049).
- The implementation changes two texts and the tests that pin them:
  `_CONDUCTOR_SYSTEM_PROMPT` in `src/kiro_crew/agent.py` and
  `src/kiro_crew/builtin_skills/goal-conductor/SKILL.md`. No runtime code change.
- Builds on [rfc-conductor-work-ledger.md](rfc-conductor-work-ledger.md) (the board,
  its actions and the `depth` cap), [rfc-crew-log-wake.md](rfc-crew-log-wake.md)
  (how a report wakes the conductor) and
  [rfc-crewmate-dynamic-dashboard.md](rfc-crewmate-dynamic-dashboard.md) (the
  crewmate's status board). It amends none of them.

## 1. Problem

The shipped conductor charter describes one conductor over one flat layer of
workers. Running real multi-team programs on it surfaced nine failures, listed one
per row in §2. Every one of them is a gap in the charter text rather than a bug in
the runtime, and every one already has a mechanism in the repo that the charter
does not point at. The sharpest is the first: an item nobody has sized yet goes to
a worker, so it is never decomposed and one session carries work meant for a team.

Folding the lessons in is what makes a conductor the default team lead instead of
something each owner re-teaches by hand in every seed.

## 2. The nine lessons, and the mechanism each one reuses

| # | Lesson, in one line | Existing mechanism it reuses | What changes in the charter or skill text |
|---|---|---|---|
| 1 | When an item's size is unknown, dispatch `kirocrew-conductor`. A worker only when the item is clearly one leaf. | The Which-agent table, which exists TWICE: `### Which agent` in `_CONDUCTOR_SYSTEM_PROMPT` in `src/kiro_crew/agent.py`, and §"Which agent" in `src/kiro_crew/builtin_skills/goal-conductor/SKILL.md`. The charter copy is the one a conductor boots on; the skill copy is loaded for a goal run. Bounded by `child_depth` / `MAX_DEPTH` in `src/kiro_crew/work_ledger.py`. Capacity is `resource_status` plus the server's own `MAX_LIVE_SLOTS` and `MAX_SLOTS_PER_CREATOR`. | Both copies gain an unknown-size row that routes to a conductor. Today both route to a conductor only for an item already known to decompose, which leaves the unsized item -- the common case -- on a worker. The two copies have already drifted (the charter names the cap inline in its conductor row, the skill names it in a paragraph below the table), so the change has to land in both or a booted conductor will not carry it. No session or headcount number is written into either text; capacity stays what `resource_status` and the server limits report. See the open question in §3. |
| 2 | A seed stands alone: goal in the owner's words, inputs with paths, shas and URLs, ownership, output and acceptance, stop conditions, the test bar, and "do not end the turn before the output exists". | None of the seed is a ledger field except its acceptance half. The seed is prose the conductor writes in the dispatch step's `session_send`; the bar it states is the item's `acceptance`, set at `create` and promoted later with `action=accept` (`apply_acceptance_update` in `src/kiro_crew/work_ledger.py`), which is what `work_brief` hands the worker as its definition of done. | The dispatch section states the seed's required parts as a list, so the prose half is written to a checklist rather than from memory, and names the acceptance half as the one part that must also reach the ledger. It adds the guardrail rule: on a policy or denied-command block, report the command, the rule and the message, then stop. Re-spelling a blocked command is a bypass even when the content is fine. |
| 3 | Most items quiet at once means the fleet stopped, not that it is busy. Resume each one, and check the output exists before reseeding. | The derived `stale` and `orphaned` flags (`is_stale` / `is_orphaned` in `src/kiro_crew/work_ledger.py`, surfaced per item by `work_ledger_read`), woken by `watch="work-ledger"` ([rfc-crew-log-wake.md](rfc-crew-log-wake.md)). | The patrol section reads a majority-`stale` board as one event -- a stopped fleet -- rather than item by item, and resumes each item in that cycle. No new timer and no polling rule: the flags and the wake already exist. |
| 4 | A handoff is a concrete artifact: a commit sha, a pull-request link, a file path. Not "it is done". | The producing item's `artifacts` map, worker-owned and capped by `MAX_ARTIFACT_KEYS`. For the dependency itself, the depending item's `acceptance`, promoted with `action=accept`, and the evaluator `src/kiro_crew/builtin_skills/goal-conductor/scripts/accept_eval.py` that gates on it. | The patrol section says "it is done" is not a handoff, and splits the dependency two ways. Where the awaited artifact IS the depending item's bar, it becomes that item's `acceptance` and the evaluator gates on it. Where it cannot be expressed as an acceptance condition -- a sha for a later item to cherry-pick -- the conductor holds it in its own crew-log state and relays it by message when it lands. The item record is not a message bus: no new field, and the dependency does not go in `decision` (see row 5). |
| 5 | A standing ruling is recorded once, as the whole current instruction, so a child cites it instead of asking again. | `work_ledger_record action=decide` on the item, read back by `work_brief` as `decision`. | The decisions section says to record every ruling made inside the owner's standing permissions, not just the ones a worker asked for, and states what `decide` actually does: `decision` is a single string (`src/kiro_crew/work_ledger.py`) and `decide` sets only `decision` and `round` (`WORK_CONDUCTOR_FIELDS` in `src/kiro_crew/work_vocab.py`), so a write REPLACES the previous ruling. It is the conductor's current standing instruction, never a log and never a queue. A conductor therefore writes the whole instruction each time rather than an increment, and an earlier ruling that still applies is restated. |
| 6 | A report separates what the reporter verified from what it relayed. | `src/kiro_crew/builtin_skills/goal-conductor/scripts/accept_eval.py`. A worker's `done` is a claim; the evaluator's verdict is the fact. | The reporting section requires the two to be labelled differently in every report to the person: a verdict or a command's own output is verified, a child's `summary` is relayed. The charter already says acceptance is the evaluator's verdict; this extends the same split to prose reports. |
| 7 | Closing records what was DROPPED and what is still OWED, with the trigger that resumes it. | `action=close` with `state=abandoned` (`WORK_ITEM_STATES` in `src/kiro_crew/work_vocab.py`), and the resume trigger written in that same close's own `decision` field -- the two fields `close` sets. | The close section says a dropped item is closed `abandoned` rather than left open or closed `rejected`, with its resume trigger in the close `decision`, and that the dropped-and-owed list goes in the end-of-workstream report too. `summary` and `artifacts` cannot carry it: those are worker fields, written only by `work_report`, and a dropped item's worker is usually already gone. |
| 8 | When the conductor runs as a crewmate, the dynamic dashboard is the person's status board. | `dashboard_fields` / `dashboard_write` ([rfc-crewmate-dynamic-dashboard.md](rfc-crewmate-dynamic-dashboard.md)) for the agentic fields, and `panel_publish` with the `kirocrew-conductor` template (`kiro_crew.conductor_board_contract`) for the drawer board. | The dashboard section says to refresh the agentic fields -- the verdict line and "what I want you to look at next" -- at each milestone from ledger data, and never to type a number the fold already provides. |
| 9 | Pin the scope in one line before fanning out. The newest owner statement wins. | The ledger `goal` and its `goal_version`, written by `action=goal`, and the skill's existing "Goal changes mid-flight" section. | Round 0 restates the ask in one sentence and checks it against what the owner said earlier. On a conflict, the newest statement wins and the conductor says which one it is following. |

## 3. Open question

**Is `depth` 2 the right cap once a conductor is the default?**

`MAX_DEPTH` is 2 in `src/kiro_crew/work_ledger.py`, and `child_depth` refuses past
it rather than clamping. A root conductor may dispatch a conductor; that child's
items must be leaves. The code comment at `child_depth` calls the number "a guess
informed by session multiplication, not a measurement", and
[rfc-conductor-work-ledger.md](rfc-conductor-work-ledger.md) Q5 sets the condition
for re-examining it: once a conductor of conductors has actually run.

Lesson 1 makes that condition routine, and makes the cap bite: an unsized item at
the second level routes to a conductor too, that dispatch is refused, and the item
is left to be flattened into leaves at a level where nobody has sized it -- the
failure lesson 1 exists to stop.

This document does **not** propose raising the cap. Two readings are both
consistent with what is on main:

1. **2 is correct, and lesson 1 needs a boundary clause.** Route an unsized item
   to a conductor only while `depth` allows it, which a conductor can tell from
   its own `depth` before it creates the item. At the cap, size the item yourself
   and dispatch leaves. `depth_exceeded` stays an error that means flatten, never
   retry.
2. **2 is too tight, and the cap moves.** Each level multiplies sessions and turns
   a report into a summary of summaries, which is why the cap is 2. Raising it is
   a capacity and evidence-fidelity decision rather than a text change, so it
   needs its own proposal, bounded by `resource_status` and the server's slot
   limits rather than by a number in the prompt.

A second input to the same decision: the per-goal item budget is per ledger, not
per program. A second-level conductor opens its own board with its own cap, so the
parent's count does not cover its grandchildren.

**How the cap is enforced**, measured at `1c5a71db4d`. Three guards, each raising
`CODE_DEPTH_EXCEEDED`, all in `src/kiro_crew/work_ledger.py`: `child_depth`
refuses when `depth + 1 > MAX_DEPTH`, `ensure_conductor` refuses a ledger whose
own `depth > MAX_DEPTH`, and `_create_item` refuses when
`record.depth >= MAX_DEPTH`.

Which guard a real run meets, and where, is the part that bears on this question.
`_bootstrap` in `src/kiro_crew/dashboard/handlers/work_ledger.py` opens a
session's own ledger and derives its depth from its parent, and its docstring pins
the refusal point: the 409 "surfaces ... at the moment the child tries to open a
ledger, rather than later when it tries to create an item". So the guard that
fires is `child_depth`, on the CHILD's first `work_ledger_record` call, after that
session was created, seeded and started a turn. The parent's own `create` is not
refused: at depth 1 `record.depth >= MAX_DEPTH` is false, so `_create_item`'s
guard is reached only by a depth-2 record, which `_bootstrap` never produces. It
is defence in depth, not the refusal anyone meets.

That sharpens the question rather than settling it. Under lesson 1 a grandchild
conductor is created, seeded and spends a turn before learning it may not conduct,
and the item it was dispatched for is then held by a session that cannot decompose
it. Reading 1 therefore has to put its boundary clause in the text that PLANS an
item, where the conductor knows its own depth, and not in the Which-agent table,
which the refused session reaches too late. The maintainer's answer goes in §4,
before the implementation merges.

## 4. Decision

Not recorded yet. A maintainer records acceptance here with the date, and answers
§3 at the same time. Until then the status stays `draft`.
