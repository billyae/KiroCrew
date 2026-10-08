---
title: The conductor is the default team lead -- nine field lessons folded into the shipped charter
status: in-progress
author: chenmingwei23, with kirocrew-worker
created: 2026-10-08
last-audited: 2026-10-08
audited-at: 1c5a71db4d
doc-pr: null
implementation-prs: [18107]
tracking-issues: [18049]
supersedes: []
superseded-by: []
---

# RFC: The conductor is the default team lead

> **Status:** `in-progress`. The design is written and the implementation is in
> flight as [#18107](https://github.com/kirodotdev/KiroCrew/pull/18107). This
> status records that, and not a maintainer's acceptance, which is still
> requested and goes in §4 -- the same arrangement
> [rfc-crewmate-dynamic-dashboard.md](rfc-crewmate-dynamic-dashboard.md) records
> for itself. This is a tier T3 change: it reworks text users already rely on, so
> the decision is recorded here before the implementation merges. This document
> ships INSIDE that pull request rather than as a standalone docs PR, so `doc-pr`
> is null and the implementation is the one named in `implementation-prs`. The
> First Principles lane reads an RFC's status off the **base** branch, so until
> this document is on main it reads as absent to that lane; clearing the lane is
> a maintainer's call, not this pull request's. Nothing proposed below is a new
> mechanism. Every row in §2 names a mechanism that is already on main, measured
> at `1c5a71db4d`.

- Tracking issue: [#18049](https://github.com/kirodotdev/KiroCrew/issues/18049).
- The implementation changes both shipped conductor texts and the tests that pin
  them: `_CONDUCTOR_SYSTEM_PROMPT` in `src/kiro_crew/agent.py` and
  `src/kiro_crew/builtin_skills/goal-conductor/SKILL.md`. No runtime code change.
- Builds on [rfc-conductor-work-ledger.md](rfc-conductor-work-ledger.md) (the board,
  its actions and the `depth` cap), [rfc-crew-log-wake.md](rfc-crew-log-wake.md)
  (how a report wakes the conductor) and
  [rfc-crewmate-dynamic-dashboard.md](rfc-crewmate-dynamic-dashboard.md) (the
  crewmate's status board). It AMENDS the first, in the one place §1 names, and
  neither of the other two.
- Known limit: lesson 8's mechanism reaches the conductor only in crew-member
  mode, because the shipped `kirocrew-conductor` spec does not mount
  `@kirocrew-panel`. Separate work is closing that, not this change, so row 8
  stays scoped to the mode where those verbs are reachable today.

## 1. Problem

The shipped conductor charter describes one conductor over one flat layer of
workers. Running real multi-team programs on it surfaced nine failures, listed one
per row in §2. Every one of them is a gap in the charter text rather than a bug in
the runtime, and every one already has a mechanism in the repo that the charter
does not point at. The sharpest is the first: an item nobody has sized yet goes to
a worker, so it is never decomposed and one session carries work meant for a team.

Folding the lessons in is what makes a conductor the default team lead instead of
something each owner re-teaches by hand in every seed.

**This document AMENDS the `Dispatch rule` section of
[rfc-conductor-work-ledger.md](rfc-conductor-work-ledger.md).** That section
records its table as "As implemented" in the same two texts this change edits, so
lesson 1 does not merely add to it -- it rewrites two of its three rows:

| `agent` | the item, as that section records it | the item, after this change |
|---|---|---|
| `kirocrew-worker` | a leaf — one assertable acceptance condition | clearly ONE leaf — a single assertable acceptance condition, and you can already name the change it makes |
| `kirocrew-conductor` | decomposes into two or more independently acceptable sub-items, subject to `depth` ≤ 2 | decomposes, or you cannot yet tell how big it is |

The `select_crew` row is unchanged. Note that the `depth` qualifier leaves the
middle row: the cap still applies and is still enforced in the store, and §3 is
why stating it inside this row would overstate what it guarantees.

`rfc-conductor-work-ledger.md` is **not edited here**. Its status is `partial`,
and whatever acceptance it holds does **not** extend to this amendment, which is
recorded and accepted on its own in §4. This is the arrangement
[rfc-question-card-auto-submit.md](rfc-question-card-auto-submit.md) uses for the
same reason: the amended document stays as its own authors left it.

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

## 3. Open question: three `depth` guards, two comparison operators, and they disagree

Making a conductor the default dispatch target means conductors dispatching
conductors, which is the case the `depth` cap bounds. Measuring that cap at
`1c5a71db4d` turned up something other than "is 2 too tight". **Three guards read
the same `MAX_DEPTH`, and they do not all compare against it the same way, so they
disagree about whether a conductor may exist at the cap.**

`MAX_DEPTH` is 2 in `src/kiro_crew/work_ledger.py`, and exactly three guards there
read it, between them using two comparison operators: two guards compare with `>`
and one with `>=`. That is the whole finding:

| Guard | Its comparison | A conductor at depth 2 |
|---|---|---|
| `child_depth` | `depth + 1 > MAX_DEPTH` | ADMITTED -- a depth-1 parent may create it |
| `ensure_conductor` | `checked_depth > MAX_DEPTH` | ADMITTED -- its ledger opens |
| `_create_item` | `record.depth >= MAX_DEPTH` | REFUSED on every item, worker items included |

The middle guard is why the failure arrives late rather than early. It admits the
depth-2 ledger, so the child bootstraps successfully and only then finds it can
create nothing. The full chain:

1. A depth-1 conductor creates an item for work nobody has sized.
2. It creates and seeds a `kirocrew-conductor` child. Session creation carries no
   depth check.
3. `child_depth(1)` returns 2, because `1 + 1 > 2` is false, so the child's own
   ledger opens at depth 2 through `ensure_conductor`, whose `>` admits it. The
   child can record a goal: no depth comparison reads that write.
4. The child's first `create` is refused -- "conductor is at depth 2 and the cap
   is 2". `_create_item` takes no agent and no kind, so it cannot tell a conductor
   item from a leaf worker item, and refuses both.

The session, its slot and its whole seed are spent before anything discovers the
dead end, and only the child ever sees the refusal: its parent's `create`
succeeded.

**A doc-versus-code mismatch rides along with this.** `_bootstrap` in
`src/kiro_crew/dashboard/handlers/work_ledger.py` promises in its docstring that
the refusal "surfaces as `depth_exceeded` (409) at the moment the child tries to
open a ledger, rather than later when it tries to create an item". That holds for
the generation PAST the cap -- a child of a depth-2 conductor is refused by
`child_depth` at ledger-open -- and not for the generation AT the cap, which is
the one that gets the late item-creation refusal. The docstring is neither simply
right nor simply wrong: it states a guarantee that holds for one generation and
not the other, and whichever shape below is chosen has to settle it. This document
changes no code and no docstring.

The fix is a choice between two shapes, and this document recommends neither:

(a) **Refuse one level earlier.** Align `child_depth` with the item guard so a
conductor is never created at a depth where it cannot create items. The refusal
moves onto the parent, which still has its turn and can flatten the item into
leaves instead, and the `_bootstrap` docstring's promise then holds for every
generation.

(b) **Let a conductor at the cap create LEAF items.** Refuse only a conductor
child, which is what the cap is actually for. The third level stays useful as a
worker-only lead, and nothing is wasted.

`MAX_DEPTH` is **not raised here**, and this document carries **no code** for
either shape. It is text only. The decision belongs to a maintainer and goes in
§4; the size of the cap is a separate capacity and evidence-fidelity question that
[rfc-conductor-work-ledger.md](rfc-conductor-work-ledger.md) Q5 already holds, and
would be bounded by `resource_status` and the server's slot limits rather than by
a number in a prompt.

One more input to the same decision: the per-goal item budget is per ledger, not
per program. A second-level conductor opens its own board with its own cap, so a
parent's count does not cover its grandchildren.

## 4. Decision

Not recorded yet. A maintainer records acceptance here with the date, and answers
§3 at the same time. The `in-progress` status above does not stand in for that:
it says the implementation is in flight, and the status moves to `accepted` when
a maintainer records the decision here.
