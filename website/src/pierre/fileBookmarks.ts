/**
 * User-curated file bookmarks for the file browser, keyed by project
 * directory.
 *
 * A bookmark is a shortcut to a frequently-used file, independent of where it
 * sits in the folder tree, so the user can open it in one click without
 * walking the tree each time (issue #6325). The list is a flat set of ABSOLUTE
 * file paths: the rail opens a bookmark the same way the tree does
 * (`onFileOpen` takes an absolute path). Order is insertion order, so a newly
 * added bookmark lands at the end of the list.
 *
 * Keyed per project directory, not globally: a bookmark is a path, and a path
 * only resolves inside the project it belongs to.
 *
 * STORAGE MODEL — `localStorage` is the ONLY source of truth. There is no
 * in-memory session list, and no pending/dirty reconciliation state. Each
 * project has its OWN key (`mc-files-bookmarks:<projectDir>`) holding a JSON
 * array of paths; every operation reads that key, modifies the array, and
 * writes it straight back:
 *
 *  - Reads (`recallBookmarks`, `isBookmarked`, `useBookmarks`) parse the
 *    current `localStorage` value every time (memoised only for referential
 *    stability — see `snapshotFor`).
 *  - Mutations (`toggleBookmark`, `removeBookmark`, `rememberBookmarks`) do a
 *    read-modify-write against the project's key and return the freshly-read
 *    result.
 *  - Cross-tab: a `storage` event (any key under the prefix) bumps a version
 *    counter so every `useSyncExternalStore` subscriber re-reads. Because each
 *    project is a SEPARATE key, two tabs editing DIFFERENT projects never
 *    clobber each other; two tabs editing the SAME project resolve
 *    LAST-WRITE-WINS (stated in the PR body; acceptable for one user's own
 *    favourites).
 *  - If `localStorage` is unavailable (private mode / disabled), a write
 *    cannot persist and there is deliberately no in-memory fallback: the
 *    bookmark does not "take". `isStorageAvailable()` lets the panel show a
 *    clear error state instead of a list that would silently vanish — honest
 *    about the browser's own limitation.
 *
 * A per-project path cap (`MAX_PER_PROJECT`) is enforced by REFUSING an add
 * past it and keeping the existing list — never by dropping a saved bookmark.
 *
 * The store is OBSERVABLE: a bookmark is toggled from the tree's row context
 * menu and must appear in the rail's Bookmarks section — a different component
 * subtree — without a remount. `useBookmarks` subscribes through
 * `useSyncExternalStore`; a mutation and a cross-tab event both bump the
 * version and notify. A per-project snapshot cache, invalidated on every
 * version bump, keeps `getSnapshot` referentially stable between real changes,
 * as `useSyncExternalStore` requires.
 */

import { useSyncExternalStore } from 'react'
import { safeGetItem, safeSetItem, safeRemoveItem } from '../utils/safeStorage'

/** The `localStorage` key the whole record lives under. */
/** `localStorage` key PREFIX. Each project gets its OWN key
 *  (`mc-files-bookmarks:<projectDir>`) rather than one shared record, so two
 *  tabs editing DIFFERENT projects write different keys and cannot clobber
 *  each other — the single-blob read-modify-write had that cross-project
 *  hazard. Within one project, two tabs still resolve last-write-wins (stated
 *  in the PR body). The prefix (not the bare key) is what the cross-tab
 *  `storage` listener matches. */
const STORAGE_PREFIX = 'mc-files-bookmarks:'

/** The storage key for one project. The projectDir is used verbatim —
 *  `localStorage` keys may contain any character, so no escaping is needed,
 *  and two distinct project dirs always map to two distinct keys. */
function keyFor(projectDir: string): string {
  return STORAGE_PREFIX + projectDir
}

/** Per-project path cap. An add past this is REFUSED (the existing list is
 *  kept); a saved bookmark is never dropped to make room. */
const MAX_PER_PROJECT = 500

/** Bumped on every mutation and every cross-tab `storage` event. The store has
 *  no in-memory list, so this is the single signal that storage changed; it
 *  invalidates the snapshot cache and drives `useSyncExternalStore` re-reads. */
let version = 0

/** Global subscribers (one per mounted `useBookmarks`). Called on any version
 *  bump; each re-reads its own project's snapshot. */
const subscribers = new Set<() => void>()

/** Referential-stability cache: the array last returned for a project, tagged
 *  with the version it was read at. `useSyncExternalStore` loops if
 *  `getSnapshot` returns a fresh array each call, so an unchanged version must
 *  return the same reference. */
const snapshotCache = new Map<string, { version: number; value: readonly string[] }>()

const EMPTY: readonly string[] = []

/** This project's list straight from its OWN `localStorage` key: a JSON array
 *  of clean strings, capped. `EMPTY` for anything unusable (missing,
 *  unreadable, or not a JSON array) so one corrupt value is overwritten by the
 *  next write rather than wedging reads. */
function readProject(projectDir: string): readonly string[] {
  const raw = safeGetItem(keyFor(projectDir))
  if (!raw) return EMPTY
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY
  }
  if (!Array.isArray(parsed)) return EMPTY
  const paths = parsed.filter((p): p is string => typeof p === 'string')
  return paths.length > MAX_PER_PROJECT ? paths.slice(0, MAX_PER_PROJECT) : paths
}

/** Read-modify-write `projectDir`'s list against its OWN storage key. Because
 *  each project has a separate key, a concurrent write to a DIFFERENT project
 *  cannot be clobbered; the SAME project is last-write-wins. Bumps the version
 *  and notifies. No in-memory copy is kept — a failed write simply does not
 *  persist, which `isStorageAvailable` surfaces to the panel. */
function writeProject(projectDir: string, next: readonly string[]): void {
  safeSetItem(keyFor(projectDir), JSON.stringify([...next]))
  version++
  snapshotCache.delete(projectDir)
  for (const fn of subscribers) fn()
}

function snapshotFor(projectDir: string): readonly string[] {
  const cached = snapshotCache.get(projectDir)
  if (cached && cached.version === version) return cached.value
  const fresh = readProject(projectDir)
  const value = fresh.length === 0 ? EMPTY : fresh
  snapshotCache.set(projectDir, { version, value })
  return value
}

/** Pick up another tab's writes: bump the version so every subscriber re-reads
 *  storage (last-write-wins). `storage` fires in OTHER tabs only, `key` null on
 *  a `clear()`; both our key and a clear invalidate. Guarded for non-browser
 *  (test import without a window) environments. */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', e => {
    if (e.key === null || e.key.startsWith(STORAGE_PREFIX)) {
      version++
      snapshotCache.clear()
      for (const fn of subscribers) fn()
    }
  })
}

/** Whether `localStorage` can be used at all. The panel shows the unavailable
 *  state when false, rather than offering a list that cannot persist. Probed
 *  through `safeStorage` — never a raw `localStorage.setItem`, which the
 *  adoption-chokepoint gate forbids in a file that imports safeStorage:
 *  `safeSetItem` returns whether a probe value actually persisted (false in a
 *  denied store or an unreclaimable full quota), and `safeRemoveItem` cleans
 *  it up. */
export function isStorageAvailable(): boolean {
  const probeKey = STORAGE_PREFIX + '__probe__'
  const ok = safeSetItem(probeKey, '1')
  if (ok) safeRemoveItem(probeKey)
  return ok
}

/** The bookmarked absolute file paths for a project directory, read from
 *  `localStorage`. */
export function recallBookmarks(projectDir: string): readonly string[] {
  return snapshotFor(projectDir)
}

/** Whether `absPath` is bookmarked in `projectDir`. */
export function isBookmarked(projectDir: string, absPath: string): boolean {
  return snapshotFor(projectDir).includes(absPath)
}

/** Replace the whole bookmark list for a project directory (capped). */
export function rememberBookmarks(projectDir: string, paths: readonly string[]): void {
  writeProject(projectDir, paths.slice(0, MAX_PER_PROJECT))
}

/**
 * Add or remove `absPath` from the project's bookmarks, returning the new
 * list. The decision and the write both read fresh storage, so there is no
 * stale snapshot: `toggleBookmark` reads the current list, flips `absPath`,
 * and writes. An add past the per-project cap is refused (the list is kept).
 */
export function toggleBookmark(projectDir: string, absPath: string): readonly string[] {
  const current = readProject(projectDir)
  let next: readonly string[]
  if (current.includes(absPath)) {
    next = current.filter(p => p !== absPath)
  } else if (current.length >= MAX_PER_PROJECT) {
    return snapshotFor(projectDir) // refuse; keep the saved list
  } else {
    next = [...current, absPath]
  }
  writeProject(projectDir, next)
  return snapshotFor(projectDir)
}

/**
 * Remove `absPath` from the project's bookmarks, returning the new list. A
 * no-op if it is not bookmarked. Reads fresh storage and writes the filtered
 * list, so it cannot overwrite with a stale snapshot.
 */
export function removeBookmark(projectDir: string, absPath: string): readonly string[] {
  const current = readProject(projectDir)
  if (!current.includes(absPath)) return snapshotFor(projectDir)
  writeProject(projectDir, current.filter(p => p !== absPath))
  return snapshotFor(projectDir)
}

/** Subscribe a React component to the bookmark store. Re-renders on every
 *  mutation and cross-tab change; the per-project array identity is stable
 *  between real changes. */
export function useBookmarks(projectDir: string): readonly string[] {
  return useSyncExternalStore(
    fn => {
      subscribers.add(fn)
      return () => { subscribers.delete(fn) }
    },
    () => snapshotFor(projectDir),
  )
}

/** Test-only: drop the snapshot cache and subscribers so suites stay isolated.
 *  There is no in-memory list to clear — storage is the only state. */
export function __resetFileBookmarksForTests(): void {
  snapshotCache.clear()
  subscribers.clear()
  version++
}
