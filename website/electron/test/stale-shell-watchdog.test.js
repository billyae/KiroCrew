"use strict";
//
// Blank-dashboard watchdog: on a dashboard `did-finish-load` with no
// `dashboard:booted` ping within the window, force one cache-ignoring reload,
// bounded so a build that can never boot does not loop. Pure logic with
// injected timer/clock, exercised without a live BrowserWindow.
//

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_BOOT_TIMEOUT_MS,
  createStaleShellWatchdog,
} = require("../stale-shell-watchdog");

const BACKEND = "http://127.0.0.1:5476";

// A controllable timer: setTimer records the pending callback; `fire()` runs it
// and returns its result (the timeout handler is async, so callers await it).
function fakeTimers() {
  let pending = null;
  let nextId = 1;
  return {
    setTimer(fn) {
      const id = nextId++;
      pending = { id, fn };
      return id;
    },
    clearTimer(id) {
      if (pending && pending.id === id) pending = null;
    },
    fire() {
      const p = pending;
      pending = null;
      if (!p) throw new Error("no timer armed");
      return p.fn();
    },
    get armed() {
      return pending !== null;
    },
  };
}

function make(overrides = {}) {
  const timers = fakeTimers();
  const logs = [];
  let reloads = 0;
  let clock = 1_000_000;
  const wd = createStaleShellWatchdog({
    backendUrl: BACKEND,
    reloadIgnoringCache: () => { reloads += 1; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    log: (m) => logs.push(m),
    now: () => clock,
    ...overrides,
  });
  return { wd, timers, logs, reloads: () => reloads, advance: (ms) => { clock += ms; } };
}

test("arms only for the dashboard origin", () => {
  const { wd } = make();
  wd.noteDocumentLoaded("file:///splash/loading.html");
  assert.equal(wd.armed, false, "splash must not arm the watch");
  wd.noteDocumentLoaded("http://127.0.0.1:7779/");
  assert.equal(wd.armed, false, "a remote pane must not arm the watch");
  wd.noteDocumentLoaded(`${BACKEND}/chat?token=x`);
  assert.equal(wd.armed, true, "the dashboard document arms it");
});

test("a healthy boot ping disarms the watch and no reload happens", () => {
  const { wd, timers, reloads } = make();
  wd.noteDocumentLoaded(`${BACKEND}/`);
  assert.equal(wd.armed, true);
  wd.noteBooted();
  assert.equal(wd.armed, false, "the boot ping cancels the pending timer");
  assert.equal(timers.armed, false);
  assert.equal(reloads(), 0);
});

test("an EARLY boot ping (before did-finish-load) suppresses the arm", () => {
  // Warm boot: the SPA mounts and pings before `did-finish-load` fires, so the
  // ping arrives while nothing is armed. The subsequent load must NOT arm — the
  // window is healthy. This is the race Opus 5.5 / GPT 6.1 flagged.
  const { wd, reloads } = make();
  wd.noteBooted(); // ping first
  wd.noteDocumentLoaded(`${BACKEND}/`); // did-finish-load after
  assert.equal(wd.armed, false, "a load after an early boot ping must not arm");
  assert.equal(reloads(), 0);
});

test("navigation start resets the boot ack so a later never-boot still arms", async () => {
  const { wd, timers, reloads } = make();
  wd.noteBooted(); // early ping for the first navigation
  wd.noteDocumentLoaded(`${BACKEND}/`);
  assert.equal(wd.armed, false, "first load suppressed by the early ack");
  // A fresh navigation (reload/navigate) invalidates the prior ack.
  wd.noteNavigationStarted();
  wd.noteDocumentLoaded(`${BACKEND}/chat`);
  assert.equal(wd.armed, true, "the new navigation arms with no fresh ack");
  assert.equal(await timers.fire(), "reloaded");
  assert.equal(reloads(), 1);
});

test("navigation start also cancels a pending timer", () => {
  const { wd } = make();
  wd.noteDocumentLoaded(`${BACKEND}/`);
  assert.equal(wd.armed, true);
  wd.noteNavigationStarted();
  assert.equal(wd.armed, false, "a new navigation cancels the pending watch");
});

test("loaded but never booted → one cache-ignoring reload", async () => {
  const { wd, timers, reloads, logs } = make();
  wd.noteDocumentLoaded(`${BACKEND}/`);
  const verdict = await timers.fire();
  assert.equal(verdict, "reloaded");
  assert.equal(reloads(), 1);
  assert.ok(logs.some((l) => l.includes("no boot within") && l.includes("attempt 1/2")));
});

test("a window that actually rendered is NOT reloaded (healthy, silent — e.g. old gateway)", async () => {
  // No boot ping, but the SPA root has rendered content. This is a healthy
  // older-gateway window; reloading it would discard the user's unsaved input.
  const { wd, timers, reloads, logs } = make({ probeRendered: () => true });
  wd.noteDocumentLoaded(`${BACKEND}/`);
  assert.equal(await timers.fire(), "rendered");
  assert.equal(reloads(), 0, "a rendered window must never be reloaded");
  assert.ok(logs.some((l) => l.includes("rendered content") && l.includes("NOT reloading")));
});

test("a genuinely blank root (probe false) still reloads", async () => {
  const { wd, timers, reloads } = make({ probeRendered: () => false });
  wd.noteDocumentLoaded(`${BACKEND}/`);
  assert.equal(await timers.fire(), "reloaded");
  assert.equal(reloads(), 1);
});

test("an unknown probe (null) or a throwing probe falls through to reload", async () => {
  const nullProbe = make({ probeRendered: () => null });
  nullProbe.wd.noteDocumentLoaded(`${BACKEND}/`);
  assert.equal(await nullProbe.timers.fire(), "reloaded");
  assert.equal(nullProbe.reloads(), 1, "unknown health must not suppress the recovery");

  const throwProbe = make({ probeRendered: () => { throw new Error("exec failed"); } });
  throwProbe.wd.noteDocumentLoaded(`${BACKEND}/`);
  assert.equal(await throwProbe.timers.fire(), "reloaded");
  assert.equal(throwProbe.reloads(), 1, "a failed probe must not suppress the recovery");
});

test("bounded: gives up after the attempt cap within the window", async () => {
  const { wd, timers, reloads, logs } = make({ maxAttempts: 2, windowMs: 10 * 60_000 });
  // Each failed load arms, then times out.
  wd.noteDocumentLoaded(`${BACKEND}/`); assert.equal(await timers.fire(), "reloaded");
  wd.noteDocumentLoaded(`${BACKEND}/`); assert.equal(await timers.fire(), "reloaded");
  wd.noteDocumentLoaded(`${BACKEND}/`); assert.equal(await timers.fire(), "gave-up");
  assert.equal(reloads(), 2, "no third reload past the cap");
  assert.ok(logs.some((l) => l.includes("giving up to avoid a reload loop")));
});

test("the sliding window frees the budget once the span passes", async () => {
  const h = make({ maxAttempts: 1, windowMs: 60_000 });
  h.wd.noteDocumentLoaded(`${BACKEND}/`); assert.equal(await h.timers.fire(), "reloaded");
  h.wd.noteDocumentLoaded(`${BACKEND}/`); assert.equal(await h.timers.fire(), "gave-up");
  h.advance(60_001); // the first reload ages out of the window
  h.wd.noteDocumentLoaded(`${BACKEND}/`); assert.equal(await h.timers.fire(), "reloaded");
  assert.equal(h.reloads(), 2);
});

test("ignored during quit — no reload while tearing down", async () => {
  const { wd, timers, reloads } = make({ isQuitting: () => true });
  wd.noteDocumentLoaded(`${BACKEND}/`);
  assert.equal(await timers.fire(), "ignored-quitting");
  assert.equal(reloads(), 0);
});

test("a re-load replaces the pending timer (one window per load)", () => {
  const { wd, timers } = make();
  wd.noteDocumentLoaded(`${BACKEND}/`);
  const first = timers.armed;
  wd.noteDocumentLoaded(`${BACKEND}/chat`); // e.g. the reload this watch triggered
  assert.equal(first, true);
  assert.equal(wd.armed, true, "still exactly one timer armed after re-load");
});

test("a reloadIgnoringCache that throws is swallowed (never escapes the emitter)", async () => {
  const { wd, timers } = make({ reloadIgnoringCache: () => { throw new Error("destroyed"); } });
  wd.noteDocumentLoaded(`${BACKEND}/`);
  assert.equal(await timers.fire(), "reloaded"); // decision still returns; throw is caught
});

test("DEFAULT_BOOT_TIMEOUT_MS is a sane, generous default", () => {
  assert.ok(DEFAULT_BOOT_TIMEOUT_MS >= 10_000);
});
