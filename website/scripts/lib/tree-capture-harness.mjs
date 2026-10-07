/**
 * Shared helpers for the file-tree screenshot harnesses under website/capture/
 * (shoot-tree-download-menu.mjs, shoot-6325-bookmarks.mjs). Each shoot script
 * stubs its own feature-specific /api/** branches and composes its own frames;
 * what they share — the fixed /api/project/** + /api/recent-projects answers,
 * the PNG blank/size floor recorder, and the shadow-root row locator the Pierre
 * tree needs for a real right-click — lives here once so the copy-paste
 * detector (jscpd, threshold 0) stays satisfied and a fix lands in one place.
 */
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { serveDist } from './serve-dist.mjs'
import { chromiumExecutable } from './chromium-executable.mjs'

/** A one-slot chat fixture for a Files-tab capture: the slot list, its empty
 *  detail, the single Files tab, and the panel-tabs bucket encoder. Both tree
 *  captures want exactly this shape, differing only in the slot's title/key. */
export function filesSlotFixture({ slot, title, project }) {
  const slots = [{
    key: slot, title, running: false, last_message: title,
    messages: 1, agent: 'kirocrew', memory_mode: 'persistent', project,
    modified: Math.floor(Date.now() / 1000), source_links: [], source_links_total: 0,
  }]
  const slotDetail = { running: false, has_more: false, total: 0, queue: [], messages: [] }
  const filesTab = { id: 'files', kind: 'files', title: 'Files' }
  const bucket = (tabs, activeId) => JSON.stringify({ activeId, tabs })
  return { slots, slotDetail, filesTab, bucket }
}

/** Serve website/dist and launch a Chromium page at the capture's standard
 *  viewport + 2x scale. Returns the server, base URL, browser and page; the
 *  caller stubs its API and closes both when done. */
export async function bootCapture({ viewport = { width: 1200, height: 820 }, deviceScaleFactor = 2 } = {}) {
  const { srv, base } = await serveDist()
  const executablePath = chromiumExecutable()
  console.log('chromium:', executablePath || '(playwright default)')
  const browser = await chromium.launch({ executablePath })
  const context = await browser.newContext({ viewport, deviceScaleFactor })
  const page = await context.newPage()
  return { srv, base, browser, page }
}

/** Answer the project-tree / git / recent-projects reads every tree capture
 *  needs identically, so each shoot script's own `extra` only has to handle
 *  its feature endpoints. Returns true when it handled the path. */
export function treeProjectRoutes(path, route, { project, paths, json }) {
  if (path === '/api/project/tree') return json(route, { root: project, paths, repo: true, truncated: false }), true
  if (path === '/api/project/git/status') return json(route, { repo: true, repoRoot: project, branch: 'main', ahead: 0, behind: 0, files: [] }), true
  if (path === '/api/project/git') return json(route, { path: project, repo: true, repoRoot: project, branch: 'main', detached: false, head: 'a1b2c3d' }), true
  if (path === '/api/project/git/log') return json(route, { repo: true, commits: [] }), true
  if (path === '/api/recent-projects') return json(route, { dirs: [project] }), true
  return false
}

/** PNG width/height from the IHDR header, without decoding the image. */
export function pngSize(path) {
  const b = readFileSync(path)
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

/** A recorder that enforces the blank (milli-bytes-per-pixel) and max-edge
 *  floors every capture frame must clear, accumulating into `wrote`. Throws on
 *  a blank or oversized frame so a broken capture fails the run, not review. */
export function makeRecorder({ wrote, maxEdge, minMbpp }) {
  return function record(file, note) {
    const { w, h } = pngSize(file)
    const bytes = readFileSync(file).length
    const mbpp = Math.round((bytes * 1000) / (w * h))
    const over = w > maxEdge || h > maxEdge
    const blank = mbpp < minMbpp
    console.log(`wrote ${file}  ${w}x${h}  ${bytes}B  ${mbpp} mB/px${over ? '  OVER' : ''}${blank ? '  BLANK' : ''}  ${note}`)
    wrote.push({ file, over, blank })
    if (blank) throw new Error(`frame ${file}: ${mbpp} mB/px below ${minMbpp} blank floor`)
    if (over) throw new Error(`frame ${file}: over ${maxEdge}px`)
  }
}

/** Screen-space center of the shortest tree row whose text (truncation markers
 *  dropped) contains `label`, measured INSIDE the `<file-tree-container>`
 *  shadow root (Pierre renders the tree there and binds its own contextmenu
 *  handler, so a row menu is opened with a real right-click at these coords). */
export function rowCenter(page, label) {
  return page.evaluate((lbl) => {
    const root = document.querySelector('file-tree-container')?.shadowRoot
    if (!root) return null
    const norm = s => (s || '').replace(/…/g, '').replace(/\s+/g, '')
    const candidates = [...root.querySelectorAll('*')].filter(r => norm(r.textContent).includes(lbl))
    if (!candidates.length) return { notFound: true, sample: norm(root.textContent).slice(0, 120) }
    candidates.sort((a, b) => a.textContent.length - b.textContent.length)
    const rect = candidates[0].getBoundingClientRect()
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
  }, label)
}

/** Right-click the tree row carrying `label` to open its context menu. */
export async function openRowMenu(page, label) {
  const c = await rowCenter(page, label)
  if (!c || c.notFound) return { ok: false, c }
  await page.mouse.move(c.x, c.y)
  await page.waitForTimeout(150)
  await page.mouse.click(c.x, c.y, { button: 'right' })
  return { ok: true, c }
}

/** Wait until the tree's shadow root has rendered a row whose text contains
 *  `name` (truncation markers dropped). */
export function waitTreeText(page, name) {
  return page.waitForFunction(
    n => (document.querySelector('file-tree-container')?.shadowRoot?.textContent ?? '').replace(/…/g, '').includes(n),
    name, { timeout: 20000 })
}
