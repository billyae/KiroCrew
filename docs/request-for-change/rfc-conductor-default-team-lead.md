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
| 1 | When an item's size is unknown, dispatch `kirocrew-conductor`. A worker only when the item is clearly one leaf. | The Which-agent table in `src/kiro_crew/builtin_skills/goal-conductor/SKILL.md` §"Which agent", bounded by `child_depth` / `MAX_DEPTH` in `src/kiro_crew/work_ledger.py`. Capacity is `resource_status` plus the server's own `MAX_LIVE_SLOTS` and `MAX_SLOTS_PER_CREATOR`. | The table gains an unknown-size row that routes to a conductor. Today it routes to a conductor only for an item already known to decompose, which leaves the unsized item -- the common case -- on a worker. No session or headcount number is written into the text; capacity stays what `resource_status` and the server limits report. See the open question in §3. |
| 2 | A seed stands alone: goal in the owner's words, inputs with paths, shas and URLs, ownership, output and acceptance, stop conditions, the test bar, and "do not end the turn before the output exists". | The item's `acceptance` field and its derived `acceptance_concrete` flag in `src/kiro_crew/work_ledger.py`, which `work_brief` hands the worker as its definition of done. | The dispatch section states the seed's required parts as a list, and adds the guardrail rule: on a policy or denied-command block, report the command, the rule and the message, then stop. Re-spelling a blocked command is a bypass even when the content is fine. |
| 3 | Most items quiet at once means the fleet stopped, not that it is busy. Resume each one, and check the output exists before reseeding. | The derived `stale` and `orphaned` flags (`is_stale` / `is_orphaned` in `src/kiro_crew/work_ledger.py`, surfaced per item by `work_ledger_read`), woken by `watch="work-ledger"` ([rfc-crew-log-wake.md](rfc-crew-log-wake.md)). | The patrol section reads a majority-`stale` board as one event -- a stopped fleet -- rather than item by item, and resumes each item in that cycle. No new timer and no polling rule: the flags and the wake already exist. |
| 4 | A handoff is a concrete artifact: a commit sha, a pull-request link, a file path. Record the dependency so the common parent relays when it lands. | The item's `artifacts` map (worker-owned, capped by `MAX_ARTIFACT_KEYS`) and its `decision` field, which `action=decide` writes and `work_brief` returns as the worker's one instruction. | The patrol section says "it is done" is not a handoff, and that a dependency between two items is written into the depending item's `decision` so the conductor that holds both relays the artifact when the first lands. No new field: `decision` is already the only channel from conductor to worker. |
| 5 | A standing ruling is recorded once, so a child cites it instead of asking again. | `work_ledger_record action=decide` on the item, read back by `work_brief` as `decision`. | The decisions section says to record every ruling made inside the owner's standing permissions, not just the ones a worker asked for, and to cite the recorded ruling in later seeds. |
| 6 | A report separates what the reporter verified from what it relayed. | `src/kiro_crew/builtin_skills/goal-conductor/scripts/accept_eval.py`. A worker's `done` is a claim; the evaluator's verdict is the fact. | The reporting section requires the two to be labelled differently in every report to the person: a verdict or a command's own output is verified, a child's `summary` is relayed. The charter already says acceptance is the evaluator's verdict; this extends the same split to prose reports. |
| 7 | Closing records what was DROPPED and what is still OWED, with the trigger that resumes it. | `action=close` plus the item `summary` and `artifacts` already written at close. | The close section adds the dropped-and-owed line to the end-of-workstream report, each with its resume trigger. |
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

Lesson 1 makes that condition routine. Under it an unsized item at the second
level routes to a conductor too, and that dispatch is refused with
`depth_exceeded`. The item then has to be flattened into leaves at a level where
nobody has sized it -- the failure lesson 1 exists to stop.

This document does **not** propose raising the cap. Two readings are both
consistent with what is on main:

1. **2 is correct, and lesson 1 needs a boundary clause.** Route an unsized item
   to a conductor while `depth` allows it; at the cap, size the item yourself
   before dispatching leaves. `depth_exceeded` stays an error that means flatten,
   never retry.
2. **2 is too tight, and the cap moves.** Each level multiplies sessions and turns
   a report into a summary of summaries, which is why the cap is 2. Raising it is
   a capacity and evidence-fidelity decision rather than a text change, so it
   needs its own proposal, bounded by `resource_status` and the server's slot
   limits rather than by a number in the prompt.

A second input to the same decision: the per-goal item budget is per ledger, not
per program. A second-level conductor opens its own board with its own cap, so the
parent's count does not cover its grandchildren.

**Measurement pending.** How `depth` is enforced on the dispatch path, and at
which call the refusal lands, is being measured against this base. That reading
goes here, and the maintainer's answer goes in §4, before the implementation
merges.

## 4. Decision

Not recorded yet. A maintainer records acceptance here with the date, and answers
§3 at the same time. Until then the status stays `draft`.
