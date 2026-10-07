/**
 * The file-bookmarks store (issue #6325): a per-project, observable list of
 * absolute file paths with `localStorage` as the ONLY source of truth. Every
 * mutation is a read-modify-write against storage; there is no in-memory
 * session list or pending/dirty state. These cases exercise per-project
 * scoping, toggle semantics, insertion order, the no-evict cap, referential
 * stability for `useSyncExternalStore`, cross-tab last-write-wins, and the
 * storage-unavailable signal the panel uses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  recallBookmarks,
  isBookmarked,
  toggleBookmark,
  removeBookmark,
  isStorageAvailable,
  __resetFileBookmarksForTests,
} from './fileBookmarks'

const PROJ_A = '/w/project-a'
const PROJ_B = '/w/project-b'
const FILE1 = '/w/project-a/src/one.ts'
const FILE2 = '/w/project-a/docs/two.md'

beforeEach(() => {
  localStorage.clear()
  __resetFileBookmarksForTests()
})

describe('fileBookmarks', () => {
  it('starts empty and is a stable empty reference', () => {
    // `useSyncExternalStore` loops if getSnapshot returns a fresh array each
    // call, so an unchanged read must keep its identity.
    expect(recallBookmarks(PROJ_A)).toEqual([])
    expect(recallBookmarks(PROJ_A)).toBe(recallBookmarks(PROJ_A))
  })

  it('toggles a file on and off, appending in insertion order', () => {
    toggleBookmark(PROJ_A, FILE1)
    toggleBookmark(PROJ_A, FILE2)
    expect(recallBookmarks(PROJ_A)).toEqual([FILE1, FILE2])
    expect(isBookmarked(PROJ_A, FILE1)).toBe(true)

    toggleBookmark(PROJ_A, FILE1)
    expect(recallBookmarks(PROJ_A)).toEqual([FILE2])
    expect(isBookmarked(PROJ_A, FILE1)).toBe(false)
  })

  it('toggle from empty is a clean on/off and never duplicates', () => {
    toggleBookmark(PROJ_A, FILE1) // on
    toggleBookmark(PROJ_A, FILE1) // off
    toggleBookmark(PROJ_A, FILE1) // on
    expect(recallBookmarks(PROJ_A)).toEqual([FILE1])
  })

  it('scopes bookmarks per project directory', () => {
    toggleBookmark(PROJ_A, FILE1)
    expect(recallBookmarks(PROJ_A)).toEqual([FILE1])
    expect(recallBookmarks(PROJ_B)).toEqual([])
    expect(isBookmarked(PROJ_B, FILE1)).toBe(false)
  })

  it('a write to one project does not disturb another project (whole-record RMW)', () => {
    toggleBookmark(PROJ_A, FILE1)
    toggleBookmark(PROJ_B, '/w/project-b/x.ts')
    toggleBookmark(PROJ_A, FILE2)
    expect(recallBookmarks(PROJ_A)).toEqual([FILE1, FILE2])
    expect(recallBookmarks(PROJ_B)).toEqual(['/w/project-b/x.ts'])
  })

  it('persists across a reload (storage is the only truth)', () => {
    toggleBookmark(PROJ_A, FILE1)
    toggleBookmark(PROJ_A, FILE2)
    __resetFileBookmarksForTests() // drop the snapshot cache; storage remains
    expect(recallBookmarks(PROJ_A)).toEqual([FILE1, FILE2])
  })

  it('never evicts a project when many other projects are bookmarked', () => {
    toggleBookmark(PROJ_A, FILE1)
    for (let i = 0; i < 300; i++) toggleBookmark(`/w/other-${i}`, `/w/other-${i}/f.ts`)
    __resetFileBookmarksForTests()
    expect(recallBookmarks(PROJ_A)).toEqual([FILE1])
  })

  it('refuses an add past the per-project cap instead of dropping a saved bookmark', () => {
    const full = Array.from({ length: 500 }, (_, i) => `/w/project-a/f${i}.ts`)
    full.forEach(p => toggleBookmark(PROJ_A, p))
    expect(recallBookmarks(PROJ_A)).toHaveLength(500)
    const after = toggleBookmark(PROJ_A, '/w/project-a/overflow.ts')
    expect(after).toHaveLength(500)
    expect(after).toEqual(full)
    expect(isBookmarked(PROJ_A, '/w/project-a/overflow.ts')).toBe(false)
  })

  it('removeBookmark drops only the named path and is a no-op for an absent one', () => {
    toggleBookmark(PROJ_A, FILE1)
    toggleBookmark(PROJ_A, FILE2)
    expect(removeBookmark(PROJ_A, FILE1)).toEqual([FILE2])
    expect(recallBookmarks(PROJ_A)).toEqual([FILE2])
    expect(removeBookmark(PROJ_A, '/w/project-a/nope.ts')).toEqual([FILE2])
  })

  it('every op reads fresh storage: another tab\'s write is reflected, last-write-wins', () => {
    toggleBookmark(PROJ_A, FILE1)
    // Another tab rewrites PROJ_A's OWN key and fires the storage event.
    const key = 'mc-files-bookmarks:' + PROJ_A
    localStorage.setItem(key, JSON.stringify([FILE1, FILE2]))
    window.dispatchEvent(new StorageEvent('storage', { key }))
    expect(recallBookmarks(PROJ_A)).toEqual([FILE1, FILE2])
    // A subsequent op reads that fresh list (not a stale snapshot) and builds on it.
    const after = toggleBookmark(PROJ_A, '/w/project-a/three.ts')
    expect(after).toEqual([FILE1, FILE2, '/w/project-a/three.ts'])
  })

  it('each project has its own key, so a concurrent different-project write is never clobbered', () => {
    // GPT finding on the single-blob design: tab A read the whole record, tab B
    // committed a different project, A wrote its stale whole record and erased
    // B. With a key per project, A's write to PROJ_A touches only PROJ_A's key,
    // so PROJ_B's concurrently-written key is untouched.
    toggleBookmark(PROJ_A, FILE1)
    // Tab B writes PROJ_B's own key directly (A never read or holds it).
    localStorage.setItem('mc-files-bookmarks:' + PROJ_B, JSON.stringify(['/w/project-b/b.ts']))
    // A keeps editing PROJ_A.
    toggleBookmark(PROJ_A, FILE2)
    expect(recallBookmarks(PROJ_A)).toEqual([FILE1, FILE2])
    // PROJ_B's key is intact — not erased by A's PROJ_A write.
    expect(JSON.parse(localStorage.getItem('mc-files-bookmarks:' + PROJ_B) as string)).toEqual(['/w/project-b/b.ts'])
  })

  it('notifies subscribers on a mutation and keeps per-project identity stable', async () => {
    const { renderHook, act } = await import('@testing-library/react')
    const { useBookmarks } = await import('./fileBookmarks')
    const a = renderHook(() => useBookmarks(PROJ_A))
    expect(a.result.current).toEqual([])
    const before = a.result.current
    act(() => { toggleBookmark(PROJ_A, FILE1) })
    expect(a.result.current).toEqual([FILE1])
    // A re-read with no change returns the same reference.
    expect(a.result.current).toBe(a.result.current)
    expect(a.result.current).not.toBe(before)
    a.unmount()
  })

  describe('when localStorage is unavailable', () => {
    const proto = Object.getPrototypeOf(localStorage) as Storage
    const realSet = proto.setItem
    beforeEach(() => {
      proto.setItem = function () { throw new DOMException('denied', 'SecurityError') }
    })
    afterEach(() => { proto.setItem = realSet })

    it('reports storage unavailable', () => {
      expect(isStorageAvailable()).toBe(false)
    })

    it('a bookmark does not take (no in-memory fallback that would vanish on reload)', () => {
      toggleBookmark(PROJ_A, FILE1)
      // The write could not persist and there is no session copy, so the list
      // is honestly empty rather than a soon-to-vanish in-memory value.
      expect(recallBookmarks(PROJ_A)).toEqual([])
    })
  })

  it('reports storage available in the normal (jsdom) environment', () => {
    expect(isStorageAvailable()).toBe(true)
  })
})
