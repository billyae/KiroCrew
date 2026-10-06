"""Characterization tests for the pre-first-turn reaper coverage gap.

A subagent shown as ``starting`` is registered but has not advanced past
turn 0. Two watchdogs are meant to bound that state:

* the fast startup watchdog (:meth:`SubagentManager._is_startup_stalled`,
  window :data:`_STARTUP_TIMEOUT_SECS`), and
* the stuck-wave sweep (:meth:`SubagentManager._sweep_stuck_waves`).

This file covers two pre-execution states against the reaper's bounds.
The first is a wave member still sitting in the spawn
queue (``_queue``, never in ``_agents``): it is failed only when a run holding
a concurrency slot is positively wedged, judged by the same
:meth:`SubagentManager._stall_verdict` oracle the running members use, enforced
by :meth:`SubagentManager._sweep_stranded_queue_entries` from the reaper loop.
A busy slot held by a healthy long run is never read as a strand. The tests
below assert that coverage; a direct test of the sweep is added at the end.

The second state -- a registered run with ``_exec_started is None`` (e.g. parked
on a spawn approval) -- is deliberately NOT bounded by a fast reaper here: it is
owned by the approval window (2 h on the dashboard/Slack paths), which denies an
unanswered prompt and ends the run as ``spawn rejected``. Those tests still pin
that the reaper's per-agent loop adds no shorter bound, which is correct and
intended.
"""

from __future__ import annotations

import asyncio
import time
from unittest.mock import MagicMock

from kiro_crew.subagent import (
    _STARTUP_TIMEOUT_SECS,
    _WAVE_STUCK_SECS,
    VERDICT_DEAD,
    VERDICT_STUCK_INPUT,
    VERDICT_UNKNOWN,
    VERDICT_WORKING,
    SubagentInfo,
    SubagentManager,
)


def _make_manager(max_concurrent: int = 1) -> SubagentManager:
    mgr = SubagentManager(
        sessions=MagicMock(),
        ctx_builder=MagicMock(),
        max_concurrent=max_concurrent,
    )
    mgr._on_done = None
    return mgr


def _reaper_would_terminate(mgr: SubagentManager, info: SubagentInfo, now: float) -> bool:
    """Reproduce the reaper's per-agent terminal decision without running the
    async loop: a live run is force-reaped only when the startup watchdog
    fires or when elapsed exceeds the wall-clock ``_default_timeout``. Mirrors
    ``_MonitoringMixin._reaper_loop`` in ``subagent_manager/monitoring.py``.
    """
    if info.done:
        return False
    if mgr._is_startup_stalled(info, now):
        return True
    return (now - info.started) > mgr._default_timeout


# --- A queued wave member is failed only when a run ahead is wedged ----------


def _sweep(mgr: SubagentManager, now: float = 0.0) -> None:
    """Run one reaper strand sweep (``now`` is accepted but unused -- the reap
    keys off the stall verdict of the running members, not a clock)."""
    asyncio.run(mgr._sweep_stranded_queue_entries(now))


def _running_slot_holder(
    mgr: SubagentManager, agent_id: str = "runner", parent: str = "p"
) -> SubagentInfo:
    """Register a run that holds a concurrency slot (``_pid`` set, not done).

    ``parent`` is the slot-holder's ``parent_session_key``; the strand reap is
    scoped to the wedged run's own parent, so a queued member is failed only
    when its ``parent_session_key`` matches a wedged slot-holder's.
    """
    info = SubagentInfo(id=agent_id, task="t", agent="", parent_session_key=parent)
    info._pid = 4242  # a live runtime, so it is a real slot-holder
    mgr._agents[agent_id] = info
    return info


def _set_verdict(mgr: SubagentManager, verdict: str) -> None:
    """Make every ``_stall_verdict`` consult on this manager return *verdict*."""

    async def _fake(info: SubagentInfo) -> tuple[str, str]:
        return verdict, "test"

    mgr._stall_verdict = _fake  # type: ignore[assignment,method-assign]


def _queue_member(mgr: SubagentManager, agent_id: str, **extra) -> dict:
    params = {
        "task": "t",
        "parent_session_key": "p",
        "agent": "amzn-builder",
        "_preassigned_id": agent_id,
        **extra,
    }
    mgr._queue.append(params)
    return params


def _landed_cancel(mgr: SubagentManager, monkeypatch) -> None:
    """Model a durable row whose cancel LANDS: a real spawn always has a row
    while a store is attached, so the async cancel returns its params (not None)
    and the reap proceeds to drop + report. (The tests append raw ``_queue``
    entries, bypassing ``spawn``, so without this the real store has no row and
    the persist-before-publish guard would correctly refuse to publish.) The
    admission coordinator uses ``__slots__``, so the method is patched on its
    class rather than the instance."""

    async def _cancel(self, agent_id, *, allow_admitted=True):
        for p in mgr._queue:
            if str(p.get("_preassigned_id") or "") == agent_id:
                return dict(p)
        return {"_preassigned_id": agent_id}

    monkeypatch.setattr(type(mgr._admission), "taskq_cancel_queued_async", _cancel)


def test_strand_sweep_reaps_a_queue_only_when_a_run_ahead_is_wedged(monkeypatch):
    """A wave member behind the stagger/concurrency gate lives only in
    ``_queue``; it is never registered in ``_agents``, so the reaper's per-agent
    loop and the startup watchdog never see it.

    The reap keys off ``_stall_verdict``: while the run holding the slot reads
    WORKING nothing is reaped, and only once that run is judged DEAD is the
    stranded tail failed. The reaped member is settled, not merely dropped: it
    leaves ``_queue`` and a terminal ``queued`` failure record is published.
    """
    mgr = _make_manager(max_concurrent=1)
    mgr._running_count = 1  # a slot is held by the run ahead
    _running_slot_holder(mgr)
    _queue_member(mgr, "queued_member", batch_id="wave", batch_total=2)
    assert "queued_member" not in mgr._agents

    # The run ahead is healthy: nothing is reaped, however many sweeps run.
    _set_verdict(mgr, VERDICT_WORKING)
    _sweep(mgr)
    _sweep(mgr)
    assert any(p.get("_preassigned_id") == "queued_member" for p in mgr._queue)

    # The run ahead is now judged wedged: the stranded tail is failed.
    _set_verdict(mgr, VERDICT_DEAD)
    _landed_cancel(mgr, monkeypatch)
    _sweep(mgr)
    assert all(p.get("_preassigned_id") != "queued_member" for p in mgr._queue)
    record = mgr._agents.get("queued_member")
    assert record is not None and record.queued and record.error


def test_strand_sweep_only_reaps_the_wedged_runs_own_parent(monkeypatch):
    """The reap is scoped to the wedged slot-holder's own parent. A run hung in
    parent A's fan-out must not fail parent B's healthy queued spawns that are
    only waiting behind the SAME global concurrency gate. One wedged slot-holder
    for parent ``A`` is DEAD; a queued member of ``A`` is reaped, a queued member
    of ``B`` is left untouched.
    """
    mgr = _make_manager(max_concurrent=1)
    mgr._running_count = 1
    _running_slot_holder(mgr, "runner_A", parent="A")
    _queue_member(mgr, "member_A", parent_session_key="A", batch_id="wa", batch_total=2)
    _queue_member(mgr, "member_B", parent_session_key="B", batch_id="wb", batch_total=2)
    _set_verdict(mgr, VERDICT_DEAD)
    _landed_cancel(mgr, monkeypatch)
    _sweep(mgr)
    ids = {p.get("_preassigned_id") for p in mgr._queue}
    assert ids == {"member_B"}  # only A's tail was reaped; B is untouched
    assert mgr._agents.get("member_A") and mgr._agents["member_A"].error
    assert not mgr._agents.get("member_B")


def test_strand_sweep_distrusts_a_wedge_on_a_session_sharing_slot_holder():
    """A ``DEAD``/``STUCK_INPUT`` verdict on a ``session_sharing`` slot-holder is
    NOT trusted as a wedge, exactly as ``_maybe_flag_stall`` withdraws trust
    there: on a shared runtime the cmdline match can land on a sibling's or the
    parent's child, so a sibling's matched child exiting reads DEAD on a healthy
    run. A terminal cancel must never rest on that fallible match, so the queued
    tail is spared.
    """
    mgr = _make_manager(max_concurrent=1)
    mgr._running_count = 1
    holder = _running_slot_holder(mgr)
    holder._session_sharing = True
    _queue_member(mgr, "queued_member", batch_id="wave", batch_total=2)
    _set_verdict(mgr, VERDICT_DEAD)
    _sweep(mgr)
    _sweep(mgr)
    assert any(p.get("_preassigned_id") == "queued_member" for p in mgr._queue)
    assert not mgr._agents.get("queued_member")


def test_strand_sweep_spares_a_healthy_fanout_whose_runs_outlast_the_window():
    """The Design/Opus clears-when case: a wave wider than the concurrency cap
    whose members each run far longer than any fixed window keeps its whole
    queued tail, because a busy slot held by a WORKING run is never read as a
    strand. This is the exact scenario the earlier time/movement heuristic
    wrongly reaped (cap 3, a 9-member wave, each run healthy for ~40 min).
    """
    mgr = _make_manager(max_concurrent=3)
    mgr._running_count = 3
    for i in range(3):
        _running_slot_holder(mgr, f"runner_{i}")
    for i in range(6):
        _queue_member(mgr, f"member_{i}", batch_id="wave", batch_total=9)
    _set_verdict(mgr, VERDICT_WORKING)
    # Sweep many times -- the runs are healthy, so nothing is ever reaped.
    for _ in range(10):
        _sweep(mgr)
    assert len(mgr._queue) == 6
    assert all(not info.error for info in mgr._agents.values() if info.queued)


def test_strand_sweep_does_not_reap_on_an_unknown_verdict():
    """``UNKNOWN`` (no attributable /proc evidence -- a model-wait, a non-shell
    tool, an unreadable subtree) is NOT positive evidence of a wedge, so the
    sweep is fail-safe and reaps nothing. Only DEAD/STUCK_INPUT reap.
    """
    mgr = _make_manager(max_concurrent=1)
    mgr._running_count = 1
    _running_slot_holder(mgr)
    _queue_member(mgr, "queued_member", batch_id="wave", batch_total=2)
    _set_verdict(mgr, VERDICT_UNKNOWN)
    _sweep(mgr)
    _sweep(mgr)
    assert any(p.get("_preassigned_id") == "queued_member" for p in mgr._queue)
    assert not mgr._agents.get("queued_member")


def test_strand_sweep_reaps_on_a_stuck_input_verdict(monkeypatch):
    """``STUCK_INPUT`` (subtree flat, blocked on a tty/stdin read) is a wedge
    just like ``DEAD``, so the stranded tail behind it is failed.
    """
    mgr = _make_manager(max_concurrent=1)
    mgr._running_count = 1
    _running_slot_holder(mgr)
    _queue_member(mgr, "queued_member", batch_id="wave", batch_total=2)
    _set_verdict(mgr, VERDICT_STUCK_INPUT)
    _landed_cancel(mgr, monkeypatch)
    _sweep(mgr)
    assert all(p.get("_preassigned_id") != "queued_member" for p in mgr._queue)
    record = mgr._agents.get("queued_member")
    assert record is not None and record.queued and record.error


def test_strand_sweep_delivers_terminal_failure_for_a_non_batch_spawn(monkeypatch):
    """A non-batch (e.g. incognito/temporary) queued spawn stranded behind a
    wedged run must still receive a terminal failure -- it is not dropped
    silently. ``_report_queued_stop`` registers a synthetic record and delivers
    it even with no ``batch_id``, unlike the batch-only announce path.
    """
    mgr = _make_manager(max_concurrent=1)
    mgr._running_count = 1
    _running_slot_holder(mgr)
    _queue_member(mgr, "solo")  # no batch_id
    _set_verdict(mgr, VERDICT_DEAD)
    _landed_cancel(mgr, monkeypatch)
    _sweep(mgr)
    assert all(p.get("_preassigned_id") != "solo" for p in mgr._queue)
    record = mgr._agents.get("solo")
    assert record is not None and record.queued and record.error


def test_strand_sweep_persists_before_publish_leaves_entry_queued_on_cancel_outage(monkeypatch):
    """GPT persist-before-publish: with a store attached, if the durable cancel
    does not land (an outage returns ``None``), the entry is LEFT queued and
    nothing is published -- so a surviving durable row can never dispatch work
    already reported failed. The next sweep retries.
    """
    mgr = _make_manager(max_concurrent=1)
    mgr._running_count = 1
    _running_slot_holder(mgr)
    _queue_member(mgr, "queued_member", batch_id="wave", batch_total=2)
    _set_verdict(mgr, VERDICT_DEAD)

    # A store IS attached, but its cancel refuses (outage) -> async cancel None.
    def _store(self):
        return object()

    async def _refuse(self, agent_id, *, allow_admitted=True):
        return None

    monkeypatch.setattr(type(mgr._admission), "taskq_store", _store)
    monkeypatch.setattr(type(mgr._admission), "taskq_cancel_queued_async", _refuse)

    _sweep(mgr)
    # Still queued, NOT reported failed: the row was never settled.
    assert any(p.get("_preassigned_id") == "queued_member" for p in mgr._queue)
    assert not mgr._agents.get("queued_member")


def test_strand_sweep_reports_an_incognito_entry_even_when_cancel_returns_none(monkeypatch):
    """GPT F2: an incognito/temporary entry has no durable row by design, so a
    ``None`` cancel from it is NOT an outage -- the persist-before-publish retry
    guard applies only to PERSISTENT entries. The incognito entry must still run
    its documented terminal-failure path (dropped from ``_queue`` and reported),
    not be left queued forever.
    """
    mgr = _make_manager(max_concurrent=1)
    mgr._running_count = 1
    _running_slot_holder(mgr)
    _queue_member(mgr, "ghost", batch_id="wave", batch_total=2, _memory_mode="incognito")
    _set_verdict(mgr, VERDICT_DEAD)

    # A store is attached, but an incognito entry has no row, so cancel is None.
    async def _refuse(self, agent_id, *, allow_admitted=True):
        return None

    monkeypatch.setattr(type(mgr._admission), "taskq_cancel_queued_async", _refuse)

    _sweep(mgr)
    # Dropped and reported despite the None cancel -- it had no durable row.
    assert all(p.get("_preassigned_id") != "ghost" for p in mgr._queue)
    record = mgr._agents.get("ghost")
    assert record is not None and record.queued and record.error


def test_stuck_wave_sweep_reconciles_once_the_strand_sweep_clears_the_queue(monkeypatch):
    """The stuck-wave sweep reconciles a wave only when nothing of it is still
    queued, and it skips a wave with a lost submission while any member remains
    in ``_queue``. Once a wedged run ahead lets the strand sweep remove the
    queued member, ``_sweep_stuck_waves`` reconciles the lost-submission wave and
    ``batch_members_pending`` reads it as not pending.
    """
    mgr = _make_manager(max_concurrent=1)
    mgr._running_count = 1
    _running_slot_holder(mgr)
    batch_id = "wave"
    now = time.time()
    terminal = SubagentInfo(
        id="done_member", task="t", agent="", batch_id=batch_id, batch_total=2, done=True
    )
    mgr._agents["done_member"] = terminal
    _queue_member(mgr, "queued_member", batch_id=batch_id, batch_total=2)
    # Lost-submission shape: 1 of 2 submitted, past the grace window.
    mgr._batch_submitted[batch_id] = [1, 2]
    mgr._batch_progress_ts[batch_id] = now - _WAVE_STUCK_SECS - 100

    # While the member is queued the stuck-wave sweep still skips it.
    before = list(mgr._batch_submitted[batch_id])
    mgr._sweep_stuck_waves(now)
    assert list(mgr._batch_submitted[batch_id]) == before

    # The run ahead is wedged: the strand sweep clears the queued member...
    _set_verdict(mgr, VERDICT_DEAD)
    _landed_cancel(mgr, monkeypatch)
    _sweep(mgr)
    assert all(p.get("batch_id") != batch_id for p in mgr._queue)

    # ...and the stuck-wave sweep is now free of the queued-member block.
    mgr._sweep_stuck_waves(now + 20)
    assert mgr.batch_members_pending(batch_id) is False


def test_strand_sweep_leaves_the_tail_in_place_while_no_run_is_wedged():
    """A legitimate long-queued fan-out tail keeps waiting for its slot: while
    every run ahead reads WORKING, the sweep reaps nothing no matter how long it
    has been queued (there is no time-based deadline any more).
    """
    mgr = _make_manager(max_concurrent=1)
    mgr._running_count = 1
    _running_slot_holder(mgr)
    _queue_member(mgr, "fresh_member", batch_id="wave", batch_total=2)
    _set_verdict(mgr, VERDICT_WORKING)
    _sweep(mgr)
    _sweep(mgr)
    assert any(p.get("_preassigned_id") == "fresh_member" for p in mgr._queue)


def test_strand_sweep_does_nothing_when_no_run_holds_a_slot():
    """With no running slot-holder to consult (an empty ``_agents``), there is
    no wedge to find, so a queued member is never reaped -- the sweep returns
    without calling the oracle.
    """
    mgr = _make_manager(max_concurrent=1)
    _queue_member(mgr, "queued_member", batch_id="wave", batch_total=2)

    async def _boom(info):
        raise AssertionError("stall verdict must not be consulted with no slot-holder... ")

    # No running slot-holder registered: the loop over _agents is empty, so the
    # verdict is never consulted and nothing is reaped.
    mgr._stall_verdict = _boom  # type: ignore[assignment,method-assign]
    _sweep(mgr)
    assert any(p.get("_preassigned_id") == "queued_member" for p in mgr._queue)


def test_strand_sweep_excludes_entries_with_their_own_owner():
    """A resume, an approval-released start, and a memory-deferred row each have
    their own bound, so the strand sweep never reaps them even when a run ahead
    is wedged.
    """
    from kiro_crew.subagent_manager.admission.types import MEMORY_WAIT_UNTIL_KEY

    mgr = _make_manager(max_concurrent=1)
    mgr._running_count = 1
    _running_slot_holder(mgr)
    mgr._queue.extend(
        [
            {"_preassigned_id": "resume", "_resume_id": "r1"},
            {"_preassigned_id": "released", "_startup_release": True},
            {"_preassigned_id": "memwait", MEMORY_WAIT_UNTIL_KEY: 0.0},
        ]
    )
    _set_verdict(mgr, VERDICT_DEAD)
    _sweep(mgr)
    ids = {p.get("_preassigned_id") for p in mgr._queue}
    assert ids == {"resume", "released", "memwait"}


# --- Gap 2: a run that never entered execution is invisible to the ----
#           fast startup watchdog; only the wall clock backstops it.


def test_gap_startup_watchdog_ignores_a_run_that_never_entered_execution():
    """``_is_startup_stalled`` keys on ``_exec_started``. A run registered in
    ``_agents`` but parked before ``_run_inner`` (``_exec_started is None`` --
    e.g. awaiting a spawn approval no surface answered) is not seen by the fast
    watchdog, no matter how long it has been registered.

    Currently observed and expected to change: the fast watchdog never fires
    for a pre-execution run. A fix that gives such a run a deadline measured
    from registration should make the watchdog (or an equivalent reaper) fire,
    which will change this assertion.
    """
    mgr = _make_manager(max_concurrent=1)
    info = SubagentInfo(id="parked", task="t", agent="")
    info._exec_started = None
    info._awaiting_approval = True
    info.turns = 0
    info._pid = None
    now = info.started + _STARTUP_TIMEOUT_SECS * 100  # far past the startup window

    assert mgr._is_startup_stalled(info, now) is False


def test_gap_pre_execution_run_has_no_bound_shorter_than_the_wall_clock():
    """For a registered pre-execution run (``_exec_started is None``), the
    reaper's per-agent decision does not terminate it at any instant short of
    the wall-clock ``_default_timeout`` -- the startup watchdog cannot see it,
    so the wall clock is the only bound.

    Currently observed and expected to change: the sole backstop is the wall
    clock. A fix adding a pre-execution deadline should terminate the run
    before ``_default_timeout``, which will change this assertion. The test
    pins the absence of a shorter bound, not the wall-clock value.
    """
    mgr = _make_manager(max_concurrent=1)
    info = SubagentInfo(id="parked", task="t", agent="")
    info._exec_started = None
    info._awaiting_approval = True
    info.turns = 0
    info._pid = None

    # Just before the wall clock: still not terminated.
    just_before = info.started + mgr._default_timeout - 1
    assert _reaper_would_terminate(mgr, info, just_before) is False

    # Only once the wall clock is exceeded does the reaper act.
    past_wall_clock = info.started + mgr._default_timeout + 1
    assert _reaper_would_terminate(mgr, info, past_wall_clock) is True


def test_startup_watchdog_reaps_a_run_wedged_after_entering_execution():
    """Contrast (the covered half): once ``_run_inner`` has set
    ``_exec_started`` and the run is still on turn 0 with no runtime pid past
    the startup window, the fast watchdog fires. This is stable expected
    behaviour, not a gap; the tests above pin the uncovered half.
    """
    mgr = _make_manager(max_concurrent=1)
    info = SubagentInfo(id="wedged", task="t", agent="")
    info._exec_started = time.time() - (mgr._startup_deadline + 10)
    info.turns = 0
    info._pid = None

    assert mgr._is_startup_stalled(info, time.time()) is True
