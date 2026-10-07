/**
 * Screenshot harness for the file-browser Bookmarks panel (issue #6325).
 * House pattern of website/capture/shoot-tree-download-menu.mjs: the REAL built
 * SPA (website/dist) behind the in-process static server, every /api/**
 * answered from fixtures via Playwright route interception -- gateway-free, no
 * kiro-cli, no token. The client code under test is unmodified. The shared
 * tree-shadow-DOM helpers live in scripts/lib/tree-capture-harness.mjs.
 *
 * Frames:
 *   10-tree-bookmark-row     right-clicking a FILE row: the new "Bookmark" row
 *                            sits in the context menu alongside Add to chat +
 *                            Download (files only).
 *   11-rail-bookmarks-panel  the rail's collapsible Bookmarks section, above
 *                            the directory tree, listing two pre-seeded
 *                            bookmarks (seeded through the store's own
 *                            `localStorage` mirror, keyed by project dir).
 *
 * Usage (from website/): node capture/shoot-6325-bookmarks.mjs [outDir]
 */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logPageProblems, stubDashboardApi, json } from '../scripts/lib/stub-dashboard-api.mjs'
import { treeProjectRoutes, makeRecorder, openRowMenu, waitTreeText, filesSlotFixture, bootCapture } from '../scripts/lib/tree-capture-harness.mjs'

const OUT = process.argv[2] || '../temp-screenshots/6325'
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SLOT = 'chat-bookmarks'
const MAX_EDGE = 2000
const MIN_MBPP = 15

mkdirSync(OUT, { recursive: true })

const TREE_PATHS = [
  'README.md',
  'package.json',
  'docs/architecture/side-panel.md',
  'website/src/pierre/PierreWorkspaceTreeImpl.tsx',
  'website/src/pages/chat/FileBrowserRail.tsx',
]

/** The two files pre-seeded as bookmarks for frame 11, as ABSOLUTE paths (the
 *  form the store holds and the rail opens). Each project has its OWN key
 *  `mc-files-bookmarks:<projectDir>` holding a JSON array of paths. */
const BOOKMARKS_PREFIX = 'mc-files-bookmarks:'
const SEEDED = [`${PROJECT}/README.md`, `${PROJECT}/website/src/pages/chat/FileBrowserRail.tsx`]

const { slots, slotDetail, filesTab: FILES_TAB, bucket } = filesSlotFixture({ slot: SLOT, title: 'Bookmarks', project: PROJECT })

async function main() {
  const { srv, base, browser, page } = await bootCapture()

  const extra = async (path, route) => {
    if (path === '/api/chat/slots') return json(route, slots), true
    if (/^\/api\/chat\/slots\/[^/]+/.test(path)) return json(route, slotDetail), true
    if (treeProjectRoutes(path, route, { project: PROJECT, paths: TREE_PATHS, json })) return true
    if (path === '/api/file-read') return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }), true
    return false
  }

  await stubDashboardApi(page, { slots, extra })
  logPageProblems(page)

  const wrote = []
  const record = makeRecorder({ wrote, maxEdge: MAX_EDGE, minMbpp: MIN_MBPP })

  async function load(seedBookmarks) {
    await page.addInitScript(([slot, tabsJson, project, bmPrefix, seeded]) => {
      localStorage.clear()
      localStorage.setItem('mc-theme', 'dark')
      localStorage.setItem('mc-onboarded', '1')
      localStorage.setItem('mc-active-slot-chat', slot)
      localStorage.setItem('mc-activity-open:' + slot, 'true')
      localStorage.setItem('mc-panel-tabs:' + slot, tabsJson)
      localStorage.setItem('mc-files-rail-open', '1')
      localStorage.setItem('mc-files-rail-w', '360')
      localStorage.setItem('mc-side-panel-width', '560')
      localStorage.setItem('mc-git-panel-opened:' + slot + ':' + project, '1')
      localStorage.setItem('mc-chat-config', JSON.stringify({ pinLastPrompt: false, streamMode: 'immediate' }))
      if (seeded) localStorage.setItem(bmPrefix + project, JSON.stringify(seeded))
    }, [SLOT, bucket([FILES_TAB], 'files'), PROJECT, BOOKMARKS_PREFIX, seedBookmarks || null])
    await page.goto(base + '/?sid=' + encodeURIComponent(SLOT), { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2600)
  }

  /** Like load(), but every `localStorage.setItem` throws a SecurityError, as a
   *  private-mode / storage-disabled browser does. The SPA's own writes go
   *  through `safeStorage` and degrade; the bookmark store's `isStorageAvailable`
   *  probe write fails, so the rail renders the unavailable state. Seeding reads
   *  still work (boot reads succeed), so the page loads normally. */
  async function loadStorageBlocked() {
    await page.addInitScript(([slot, tabsJson, project]) => {
      localStorage.setItem('mc-theme', 'dark')
      localStorage.setItem('mc-onboarded', '1')
      localStorage.setItem('mc-active-slot-chat', slot)
      localStorage.setItem('mc-activity-open:' + slot, 'true')
      localStorage.setItem('mc-panel-tabs:' + slot, tabsJson)
      localStorage.setItem('mc-files-rail-open', '1')
      localStorage.setItem('mc-files-rail-w', '360')
      localStorage.setItem('mc-side-panel-width', '560')
      localStorage.setItem('mc-git-panel-opened:' + slot + ':' + project, '1')
      localStorage.setItem('mc-chat-config', JSON.stringify({ pinLastPrompt: false, streamMode: 'immediate' }))
      // Now block all WRITES (reads still succeed so boot works); the store's
      // availability probe uses safeSetItem, which returns false here.
      const proto = Object.getPrototypeOf(window.localStorage)
      proto.setItem = function () { throw new DOMException('denied', 'SecurityError') }
    }, [SLOT, bucket([FILES_TAB], 'files'), PROJECT])
    await page.goto(base + '/?sid=' + encodeURIComponent(SLOT), { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2600)
  }

  const panel = () => page.locator('div:has(> .side-panel-strip)').last()

  // ── Frame 10: FILE row context menu shows the Bookmark row ──────────────────
  await load()
  await panel().waitFor({ state: 'visible', timeout: 20000 })
  await waitTreeText(page, 'README.md')
  await page.waitForTimeout(1200)

  const r = await openRowMenu(page, 'README.md')
  console.log('openRowMenu(README.md)', JSON.stringify(r))
  await page.locator('[role="menu"]').first().waitFor({ state: 'visible', timeout: 8000 })
  await page.waitForTimeout(400)
  {
    const rows = await page.locator('[role="menu"] [role="menuitem"]').allInnerTexts()
    console.log('DIAG file-menu rows', JSON.stringify(rows))
    const hasBookmark = rows.some(t => /Bookmark/.test(t))
    if (!hasBookmark) throw new Error(`frame 10: expected a Bookmark row, got ${JSON.stringify(rows)}`)
    const toggle = page.locator('[data-testid="file-tree-bookmark-toggle"]')
    if (!(await toggle.count())) throw new Error('frame 10: no file-tree-bookmark-toggle testid in menu')
    await page.locator('[role="menu"]').first().screenshot({ path: `${OUT}/10-tree-bookmark-row.png` })
    record(`${OUT}/10-tree-bookmark-row.png`, `rows=${JSON.stringify(rows)}`)
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // ── Frame 11: the rail's Bookmarks section, two bookmarks pre-seeded ────────
  await load(SEEDED)
  await panel().waitFor({ state: 'visible', timeout: 20000 })
  await waitTreeText(page, 'README.md')
  const section = page.locator('[data-testid="file-browser-rail-bookmarks"]')
  await section.waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(600)
  {
    const text = (await section.innerText()).trim()
    console.log('DIAG bookmarks section', JSON.stringify(text))
    if (!/Bookmarks/i.test(text)) throw new Error(`frame 11: expected the Bookmarks title, got ${JSON.stringify(text)}`)
    if (!/README/.test(text) || !/FileBrowserRail/.test(text)) {
      throw new Error(`frame 11: expected both seeded bookmark names, got ${JSON.stringify(text)}`)
    }
    await panel().screenshot({ path: `${OUT}/11-rail-bookmarks-panel.png` })
    record(`${OUT}/11-rail-bookmarks-panel.png`, `section=${JSON.stringify(text).slice(0, 120)}`)
  }

  // ── Frame 12: menu on an ALREADY-bookmarked file → "Remove bookmark" ────────
  // README.md was seeded as a bookmark above, so its row menu shows the removal
  // state (StarOff + "Remove bookmark"), the other half of the toggle.
  {
    const rr = await openRowMenu(page, 'README.md')
    console.log('openRowMenu(README.md, bookmarked)', JSON.stringify(rr))
    await page.locator('[role="menu"]').first().waitFor({ state: 'visible', timeout: 8000 })
    await page.waitForTimeout(400)
    const rows = await page.locator('[role="menu"] [role="menuitem"]').allInnerTexts()
    console.log('DIAG bookmarked-file menu rows', JSON.stringify(rows))
    if (!rows.some(t => /Remove bookmark/.test(t))) {
      throw new Error(`frame 12: expected a "Remove bookmark" row on a bookmarked file, got ${JSON.stringify(rows)}`)
    }
    await page.locator('[role="menu"]').first().screenshot({ path: `${OUT}/12-tree-remove-bookmark-row.png` })
    record(`${OUT}/12-tree-remove-bookmark-row.png`, `rows=${JSON.stringify(rows)}`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }

  // ── Frame 13: hover reveals the ✕ remove control on a bookmark row ──────────
  {
    const row = page.locator('[data-testid="file-browser-rail-bookmarks"] [role="listitem"]').first()
    await row.waitFor({ state: 'visible', timeout: 8000 })
    await row.hover()
    await page.waitForTimeout(300)
    const removeBtn = row.getByRole('button', { name: 'Remove bookmark' })
    if (!(await removeBtn.count())) throw new Error('frame 13: no "Remove bookmark" ✕ control on a bookmark row')
    await section.screenshot({ path: `${OUT}/13-rail-bookmark-remove-hover.png` })
    record(`${OUT}/13-rail-bookmark-remove-hover.png`, 'hover reveals the remove control')
  }

  // ── Frame 14: the collapsed Bookmarks section (header only) ─────────────────
  {
    const header = section.getByRole('button').first()
    await header.click()
    await page.waitForTimeout(300)
    if (await header.getAttribute('aria-expanded') !== 'false') {
      throw new Error('frame 14: header did not collapse (aria-expanded still true)')
    }
    // The list is gone; only the header with its count remains.
    if (await section.locator('[role="list"]').count() !== 0) {
      throw new Error('frame 14: bookmark list still rendered while collapsed')
    }
    await section.screenshot({ path: `${OUT}/14-rail-bookmarks-collapsed.png` })
    record(`${OUT}/14-rail-bookmarks-collapsed.png`, 'collapsed header, list hidden')
  }

  // ── Frame 15: the storage-unavailable state (localStorage writes blocked) ───
  await loadStorageBlocked()
  await panel().waitFor({ state: 'visible', timeout: 20000 })
  await waitTreeText(page, 'README.md')
  {
    const unavail = page.locator('[data-testid="file-browser-rail-bookmarks-unavailable"]')
    await unavail.waitFor({ state: 'visible', timeout: 10000 })
    const text = (await unavail.innerText()).trim()
    console.log('DIAG unavailable', JSON.stringify(text))
    if (!/unavailable/i.test(text)) throw new Error(`frame 15: expected an unavailable notice, got ${JSON.stringify(text)}`)
    await panel().screenshot({ path: `${OUT}/15-rail-bookmarks-unavailable.png` })
    record(`${OUT}/15-rail-bookmarks-unavailable.png`, `notice=${JSON.stringify(text).slice(0, 100)}`)
  }

  console.log('\n── SUMMARY ─────────────────────────────')
  const bad = wrote.filter(w => w.over || w.blank)
  console.log(bad.length ? `FAIL ${bad.length}` : `all ${wrote.length} frames ok`)

  await browser.close()
  srv.close()
}

main().catch(err => { console.error(err); process.exit(1) })
