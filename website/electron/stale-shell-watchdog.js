"use strict";
//
// Blank-dashboard self-healing for the main window, from the MAIN PROCESS.
//
// The problem this solves: the desktop app can open to a blank white screen
// after running fine for days — seen on Windows. The dashboard document loads
// (its HTML arrives, `did-finish-load` fires), but the SPA never paints: a
// hashed entry chunk the webview is replaying from its HTTP cache fails to
// evaluate, the entry `<script type=module>` dies silently, and nothing of ours
// ever runs in that frame. A reopen does not fix it and an ordinary in-app
// reload does not either (a plain reload is cache-permitted, so it re-reads the
// same bytes); only a cache-bypassing hard reload (Ctrl+Shift+R) recovers it.
//
// Why this lives in the MAIN process, not the bundle: the dashboard's own
// boot-time code cannot heal a window where that code never ran. A client-side
// check ships inside the very bundle that failed to evaluate, so on the real
// blank screen it never executes. The main process, by contrast, sees
// `did-finish-load` regardless of whether any renderer JavaScript ran, and
// `webContents.reloadIgnoringCache()` is the literal Ctrl+Shift+R — it bypasses
// the HTTP cache so the reload re-fetches a fresh shell, and it works even when
// the frame is running no code at all.
//
// Mechanism, and why each part is shaped the way it is:
//   1. On a top-level `did-finish-load` at the dashboard's OWN origin, arm a
//      timer. Only the dashboard origin counts: the boot splash (`loading.html`)
//      and any remote-crew pane load must not start or cancel this watch.
//   2. A healthy boot cancels the timer. The dashboard renderer sends one
//      `dashboard:booted` ping from its mount (see website/src/main.tsx); the
//      main process relays it here via `noteBooted()`. A frame that painted and
//      ran its bundle is not the failure this heals.
//   3. If the timer fires first — loaded, but no boot within the window — call
//      `reloadIgnoringCache()` ONCE. Bounded by `maxAttempts` within `windowMs`
//      exactly like renderer-recovery.js: a genuinely broken build that can
//      never boot would otherwise reload forever, spinning CPU and hiding the
//      failure. After the budget is spent the watch goes quiet and reports, so
//      the blank window surfaces instead of looping.
//
// Pure logic + injected dependencies: Electron main is not exercised by the
// unit test runner, so every decision is testable without a live BrowserWindow
// (same pattern as renderer-recovery.js / gpu-crash-fallback.js).
//

// How long after the dashboard document finishes loading we wait for the
// `dashboard:booted` ping before deciding the shell is stuck. Generous: a cold
// start over a slow link, or a large session restoring, legitimately takes many
// seconds to mount, and a false reload throws away a load that would have
// arrived. The failure this heals is permanent (a cache capsule never boots),
// so waiting longer costs only latency on a window that is already blank.
const DEFAULT_BOOT_TIMEOUT_MS = 20_000;

// At most this many cache-ignoring reloads within the sliding window. One is
// almost always enough (a fresh shell boots); the cap stops a build that can
// never boot from reloading forever.
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_WINDOW_MS = 10 * 60_000;

// Reuse the one origin-match helper rather than ship a second copy: whether a
// `did-finish-load` URL is the dashboard's own document is exactly the question
// gpu-crash-fallback.js already answers, with the same origin-comparison rule
// (`http://127.0.0.1:5476` must not match `http://127.0.0.1:54760`; a malformed
// or mismatched URL reads as "not the dashboard" so the watch never arms on
// guesswork).
const { isDashboardDocument } = require("./gpu-crash-fallback");

/**
 * Create the blank-dashboard watchdog.
 *
 * @param {object} deps
 * @param {string} deps.backendUrl        The dashboard origin; only a load of a
 *   document here arms the watch.
 * @param {() => void} deps.reloadIgnoringCache  Force a cache-bypassing reload
 *   of the dashboard window (the literal Ctrl+Shift+R).
 * @param {() => (boolean | Promise<boolean>)} [deps.probeRendered]  Return true
 *   when the window ACTUALLY rendered dashboard content (its SPA root has
 *   children), false when it is blank, and null/undefined when it cannot tell.
 *   Consulted right before a reload so a healthy window that simply never sent
 *   `dashboard:booted` (e.g. an older gateway serving a pre-ping SPA) is not
 *   reloaded and its unsaved input is not discarded. Defaults to "unknown"
 *   (reload proceeds, preserving the original behavior) when not injected.
 * @param {(fn: () => void, ms: number) => any} [deps.setTimer]
 * @param {(t: any) => void} [deps.clearTimer]
 * @param {() => boolean} [deps.isQuitting]
 * @param {(msg: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {number} [deps.bootTimeoutMs]
 * @param {number} [deps.maxAttempts]
 * @param {number} [deps.windowMs]
 * @returns {{
 *   noteNavigationStarted: () => void,
 *   noteDocumentLoaded: (url: string) => void,
 *   noteBooted: () => void,
 *   reset: () => void,
 *   armed: boolean,
 * }}
 */
function createStaleShellWatchdog({
  backendUrl,
  reloadIgnoringCache,
  probeRendered = () => null,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  isQuitting = () => false,
  log = () => {},
  now = () => Date.now(),
  bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  windowMs = DEFAULT_WINDOW_MS,
} = {}) {
  const timeout = Math.max(1, Number(bootTimeoutMs) || DEFAULT_BOOT_TIMEOUT_MS);
  const cap = Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS);
  const span = Math.max(1, Number(windowMs) || DEFAULT_WINDOW_MS);

  // The armed timer handle, or null when nothing is pending.
  let timer = null;
  // Whether the dashboard announced a healthy boot for the CURRENT top-level
  // navigation. A warm boot can send `dashboard:booted` from the SPA's mount
  // *before* the main process sees `did-finish-load` (the mount runs as soon as
  // the module evaluates; `did-finish-load` waits on sub-resources like a
  // remote font stylesheet). Without this flag that early ping would disarm
  // nothing and the later arm would reload a perfectly healthy window. Reset at
  // navigation start so a genuine never-boot after a reload still arms.
  let bootedThisNav = false;
  // Timestamps of recent cache-ignoring reloads, pruned to the sliding window
  // so a stable app that hits this once a day never exhausts its budget.
  let recent = [];

  function disarm() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  /** The timer fired: the dashboard loaded but never announced a healthy boot. */
  async function onBootTimeout() {
    timer = null;
    if (isQuitting()) {
      log("stale-shell watchdog: boot timed out during quit — not reloading");
      return "ignored-quitting";
    }
    // Last line of defence before throwing away a window: did it actually
    // render? A healthy SPA that simply never sent `dashboard:booted` — an
    // older gateway serving a pre-ping build — has a populated root; reloading
    // it would discard the user's unsaved input for nothing. Only `false` (a
    // genuinely empty root) permits the reload; `true` suppresses it, and an
    // "unknown" (null / probe threw) falls through to reload, preserving the
    // original behavior where we cannot confirm the window is healthy.
    let rendered = null;
    try {
      rendered = await probeRendered();
    } catch (e) {
      rendered = null;
      log(`stale-shell watchdog: render probe failed: ${e && e.message}`);
    }
    if (rendered === true) {
      log(
        "stale-shell watchdog: no boot ping, but the dashboard root has rendered content — " +
          "treating as healthy (e.g. an older gateway's SPA) and NOT reloading",
      );
      return "rendered";
    }
    const t = now();
    recent = recent.filter((ts) => t - ts < span);
    if (recent.length >= cap) {
      log(
        `stale-shell watchdog: dashboard loaded but did not boot, and ${recent.length} ` +
          `cache-ignoring reload(s) within ${span}ms already did not help — ` +
          `giving up to avoid a reload loop`,
      );
      return "gave-up";
    }
    recent.push(t);
    log(
      `stale-shell watchdog: dashboard document loaded but no boot within ${timeout}ms — ` +
        `forcing a cache-ignoring reload (attempt ${recent.length}/${cap})`,
    );
    try {
      reloadIgnoringCache();
    } catch (e) {
      // Never let a failed reload escape into Electron's event emitter.
      log(`stale-shell watchdog: reloadIgnoringCache failed: ${e && e.message}`);
    }
    return "reloaded";
  }

  /**
   * A top-level navigation STARTED (main-frame `did-start-navigation`). A fresh
   * navigation invalidates any prior boot acknowledgement: reset the flag and
   * cancel any pending watch so the new document gets a clean window. Must be
   * main-frame only — a sub-frame or in-page navigation must not reset it.
   */
  function noteNavigationStarted() {
    bootedThisNav = false;
    disarm();
  }

  /**
   * A top-level document finished loading. Arm the watch only for the
   * dashboard's own origin; a splash or pane load is ignored. If the SPA
   * already announced a healthy boot for THIS navigation (a warm boot whose
   * ping beat `did-finish-load`), do not arm — the window is fine. Re-arming on
   * a fresh dashboard load (including the reload this watch itself triggered)
   * replaces any pending timer — the new load gets its own full window.
   */
  function noteDocumentLoaded(url) {
    if (!isDashboardDocument(url, backendUrl)) return;
    disarm();
    if (bootedThisNav) return;
    timer = setTimer(onBootTimeout, timeout);
  }

  /**
   * The dashboard SPA announced a healthy boot (`dashboard:booted`). Cancel the
   * pending watch and remember the boot for this navigation, so an early ping
   * that arrives before `did-finish-load` still suppresses the arm. The frame
   * painted and ran its bundle, so it is not the blank-shell failure. Harmless
   * if nothing is armed (a boot with no prior dashboard load, or a duplicate
   * ping).
   */
  function noteBooted() {
    bootedThisNav = true;
    disarm();
  }

  return {
    noteNavigationStarted,
    noteDocumentLoaded,
    noteBooted,
    reset() {
      disarm();
      bootedThisNav = false;
      recent = [];
    },
    get armed() {
      return timer !== null;
    },
  };
}

module.exports = {
  DEFAULT_BOOT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_WINDOW_MS,
  createStaleShellWatchdog,
};
