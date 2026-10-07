"""The freestyle agent-task spawn path backs off when the HOST declines.

The ``route == "execute"`` block in ``_do_poll`` spawns freestyle tasks
serially. A host decline (the admission gate had no capacity, surfaced as a
raised ``SpawnError`` with ``declined=True``) leaves the due task undone, so
without a backoff it re-attempts on EVERY one-second poll — the ~400
attempts/min storm.

The fix backs off ONLY on a flagged decline: a ``SpawnError`` whose ``declined``
is True arms a cooldown during which no freestyle spawn is attempted, and a
spawn that lands clears it at once. A ``SpawnError`` that is NOT a decline (an
empty task/agent, a normalised impl fault) is a per-task problem — it does NOT
arm the cooldown and does NOT stop the other due tasks that poll. A healthy host
whose spawns succeed is never throttled, and the hourly ``activity_budget`` meter
(recorded only after a successful spawn, see ``hooks.py``) is left untouched.
"""

from __future__ import annotations

import pytest

from kiro_crew.apps.builtins.mochi import queue_file as qf
from kiro_crew.apps.builtins.mochi.queue_poller import (
    FREESTYLE_DECLINE_BACKOFF_MS,
    QueuePoller,
)
from kiro_crew.apps.spawn_sdk import SpawnError


def _execute_queue(n_tasks: int) -> dict:
    """A queue of ``n_tasks`` due freestyle tasks that routes to 'execute'."""
    return {
        # planned_until far in the future keeps route_poll on 'execute' (no
        # plan/replan branch stealing the poll).
        "planned_until": "2999-01-01T00:00:00.000Z",
        "tasks": [
            {
                "id": f"fs-{i}",
                "type": "freestyle",
                "execute_after": "1970-01-01T00:00:00.000Z",  # long overdue
                "done": False,
                "action": {"prompt": f"do task {i}"},
            }
            for i in range(n_tasks)
        ],
    }


class _DecliningCallbacks:
    """spawn_agent always raises a FLAGGED decline — the host out of capacity.

    ``declined=True`` is the host-pressure signal (an empty spawn id in
    ``SpawnSDK.run``); it is the only SpawnError the backoff reacts to.
    """

    def __init__(self) -> None:
        self.attempts = 0

    async def spawn_agent(self, prompt: str) -> str:
        self.attempts += 1
        raise SpawnError("host declined the spawn (low memory)", declined=True)


class _FailingNonDeclineCallbacks:
    """spawn_agent raises a NON-decline SpawnError every call.

    A fault that no cooldown fixes (an empty agent, a normalised impl error):
    ``declined`` is False, so the backoff must NOT arm and the other due tasks
    must still be attempted.
    """

    def __init__(self) -> None:
        self.attempts = 0

    async def spawn_agent(self, prompt: str) -> str:
        self.attempts += 1
        raise SpawnError("spawn failed: boom")  # declined defaults to False


class _HealthyThenDone:
    """spawn_agent succeeds; the queue marks the task done so it is not re-due.

    Models a well-behaved host: every spawn lands, so the backoff must never
    engage no matter how many polls run.
    """

    def __init__(self) -> None:
        self.attempts = 0

    async def spawn_agent(self, prompt: str) -> str:
        self.attempts += 1
        return f"spawn-{self.attempts}"


def _silence_writeback(monkeypatch) -> None:
    import contextlib

    monkeypatch.setattr(qf, "write_queue_atomic", lambda p, d: None)
    monkeypatch.setattr(qf, "queue_mutation", lambda p: contextlib.nullcontext())


@pytest.mark.asyncio
async def test_declined_freestyle_spawns_back_off_instead_of_storming(tmp_path, monkeypatch):
    """Repro: many polls, every spawn declined. On main every poll re-attempts
    (hundreds of attempts); the fix caps attempts to one per backoff window."""
    _silence_writeback(monkeypatch)
    cb = _DecliningCallbacks()
    now = [1_000_000]
    poller = QueuePoller(
        str(tmp_path / "q.json"),
        cb,
        clock=lambda: now[0],
        budget_provider=None,
    )
    poller.start()
    # Far more due freestyle tasks than any budget, re-read each poll (the
    # storm's shape: a declined task is never marked done).
    monkeypatch.setattr(qf, "read_queue", lambda p: _execute_queue(50))

    # 30 one-second polls inside one backoff window.
    for _ in range(30):
        now[0] += 1_000
        await poller.poll()

    # On main this is 30+ (one per poll, and more per poll before any gate).
    # With the decline backoff only the FIRST poll attempts; the rest are
    # deferred until the cooldown elapses.
    assert cb.attempts == 1, (
        "a declined freestyle spawn must arm a backoff, not re-attempt every "
        f"poll; got {cb.attempts} attempts in one window"
    )


@pytest.mark.asyncio
async def test_backoff_releases_after_the_window(tmp_path, monkeypatch):
    """The backoff is a deferral, not a permanent stop: once the cooldown
    elapses, exactly one more attempt is made (and re-arms the backoff)."""
    _silence_writeback(monkeypatch)
    cb = _DecliningCallbacks()
    now = [1_000_000]
    poller = QueuePoller(
        str(tmp_path / "q.json"),
        cb,
        clock=lambda: now[0],
        budget_provider=None,
    )
    poller.start()
    monkeypatch.setattr(qf, "read_queue", lambda p: _execute_queue(50))

    await poller.poll()  # first attempt arms the backoff
    assert cb.attempts == 1

    for _ in range(5):  # still inside the window: no new attempt
        now[0] += 1_000
        await poller.poll()
    assert cb.attempts == 1

    now[0] += FREESTYLE_DECLINE_BACKOFF_MS + 1  # window elapses
    await poller.poll()
    assert cb.attempts == 2, "one more attempt is allowed once the backoff elapses"


@pytest.mark.asyncio
async def test_healthy_host_is_never_throttled(tmp_path, monkeypatch):
    """A host whose spawns all SUCCEED is never backed off, however many run —
    the fix throttles declines only, not healthy throughput."""
    import asyncio
    import contextlib

    _silence_writeback(monkeypatch)
    cb = _HealthyThenDone()
    now = [1_000_000]
    poller = QueuePoller(
        str(tmp_path / "q.json"),
        cb,
        clock=lambda: now[0],
        budget_provider=None,
    )
    poller.start()

    # One due freestyle task per poll, each spawn succeeding. The poller's
    # serial wait is resolved by notify_agent_done so each poll completes.
    monkeypatch.setattr(qf, "read_queue", lambda p: _execute_queue(1))

    async def _resolve_when_waiting(task: asyncio.Future) -> None:
        # Spin until the poll has created its serial future, then resolve it.
        while not task.done() and poller._spawn_future is None:
            await asyncio.sleep(0)
        poller.notify_agent_done()

    for _ in range(20):
        now[0] += 1_000
        poll_task = asyncio.ensure_future(poller.poll())
        try:
            # Bound both waits: a broken handshake fails here, loudly and
            # locally, instead of hanging until the suite timeout kills the
            # worker (tests-are-deterministic).
            await asyncio.wait_for(_resolve_when_waiting(poll_task), timeout=5)
            await asyncio.wait_for(poll_task, timeout=5)
        except BaseException:
            poll_task.cancel()
            with contextlib.suppress(BaseException):
                await poll_task
            raise

    assert cb.attempts == 20, (
        "every successful freestyle spawn must be allowed; a healthy host is "
        f"never throttled, got {cb.attempts}/20"
    )
    assert poller._freestyle_backoff_until == 0, "a success must leave no backoff armed"


@pytest.mark.asyncio
async def test_non_decline_spawn_error_does_not_arm_the_cooldown(tmp_path, monkeypatch):
    """A SpawnError that is NOT a host decline (declined=False) is a per-task
    fault, not host pressure: it must leave the backoff disarmed so the next
    poll is free to try again immediately."""
    _silence_writeback(monkeypatch)
    cb = _FailingNonDeclineCallbacks()
    now = [1_000_000]
    poller = QueuePoller(
        str(tmp_path / "q.json"),
        cb,
        clock=lambda: now[0],
        budget_provider=None,
    )
    poller.start()
    monkeypatch.setattr(qf, "read_queue", lambda p: _execute_queue(1))

    await poller.poll()

    assert poller._freestyle_backoff_until == 0, (
        "a non-decline SpawnError must NOT arm the decline cooldown"
    )


@pytest.mark.asyncio
async def test_decline_arms_the_cooldown(tmp_path, monkeypatch):
    """The counterpart: a FLAGGED decline (declined=True) DOES arm the
    cooldown, so the next poll inside the window is skipped."""
    _silence_writeback(monkeypatch)
    cb = _DecliningCallbacks()
    now = [1_000_000]
    poller = QueuePoller(
        str(tmp_path / "q.json"),
        cb,
        clock=lambda: now[0],
        budget_provider=None,
    )
    poller.start()
    monkeypatch.setattr(qf, "read_queue", lambda p: _execute_queue(1))

    await poller.poll()

    assert poller._freestyle_backoff_until > now[0], (
        "a flagged host decline must arm the cooldown"
    )


@pytest.mark.asyncio
async def test_non_decline_failure_still_runs_the_other_due_tasks(tmp_path, monkeypatch):
    """A non-decline fault on one task must not stop the remaining due tasks in
    the same poll — the fix only pauses the rest on a real host decline."""
    _silence_writeback(monkeypatch)
    cb = _FailingNonDeclineCallbacks()
    now = [1_000_000]
    poller = QueuePoller(
        str(tmp_path / "q.json"),
        cb,
        clock=lambda: now[0],
        budget_provider=None,
    )
    poller.start()
    # Three due freestyle tasks in one poll; every spawn faults (non-decline).
    monkeypatch.setattr(qf, "read_queue", lambda p: _execute_queue(3))

    await poller.poll()

    assert cb.attempts == 3, (
        "a non-decline failure must not break out of the loop; every due task "
        f"this poll is still attempted, got {cb.attempts}/3"
    )
    assert poller._freestyle_backoff_until == 0, "no cooldown armed by non-decline faults"


# --- SpawnSDK.run: the typed decline flag the poller backoff gates on ---------
#
# The backoff above arms only on ``SpawnError.declined``. That flag is set in
# exactly one place — ``SpawnSDK.run`` when the injected impl returns an empty
# spawn id (the host/admission gate declined). These tests pin that mapping
# directly, by injecting a tiny async impl, so the decline signal the poller
# relies on is exercised without a real SubagentManager.


def _spawn_sdk_with_impl(impl):
    """A SpawnSDK whose host-call seam is a direct async ``impl``."""
    from kiro_crew.apps.spawn_sdk import SpawnSDK

    return SpawnSDK("mochi", impl)


@pytest.mark.asyncio
async def test_spawn_sdk_empty_id_raises_a_flagged_decline():
    """An empty spawn id (the host declined) raises SpawnError(declined=True)."""
    from kiro_crew.apps.spawn_sdk import SpawnError

    async def _declines(task, agent, silent, model, app):
        return ""  # host had no capacity

    sdk = _spawn_sdk_with_impl(_declines)
    with pytest.raises(SpawnError) as ei:
        await sdk.run("do work", agent="mochi-bg")
    assert ei.value.declined is True, "an empty id is a host-pressure decline"


@pytest.mark.asyncio
async def test_spawn_sdk_impl_fault_is_not_a_decline():
    """A normalised impl exception raises SpawnError with declined=False."""
    from kiro_crew.apps.spawn_sdk import SpawnError

    async def _faults(task, agent, silent, model, app):
        raise RuntimeError("boom")

    sdk = _spawn_sdk_with_impl(_faults)
    with pytest.raises(SpawnError) as ei:
        await sdk.run("do work", agent="mochi-bg")
    assert ei.value.declined is False, "an impl fault is not host pressure — no backoff"


@pytest.mark.asyncio
async def test_spawn_sdk_empty_agent_is_not_a_decline():
    """An empty agent is refused loudly as a non-decline SpawnError."""
    from kiro_crew.apps.spawn_sdk import SpawnError

    async def _never_called(task, agent, silent, model, app):  # pragma: no cover
        raise AssertionError("impl must not be reached for an empty agent")

    sdk = _spawn_sdk_with_impl(_never_called)
    with pytest.raises(SpawnError) as ei:
        await sdk.run("do work", agent="")
    assert ei.value.declined is False, "a refused empty agent is a fault, not a decline"


@pytest.mark.asyncio
async def test_spawn_sdk_success_returns_the_id():
    """A non-empty id is returned unchanged (control: no decline, no raise)."""
    async def _ok(task, agent, silent, model, app):
        return "spawn-123"

    sdk = _spawn_sdk_with_impl(_ok)
    assert await sdk.run("do work", agent="mochi-bg") == "spawn-123"
