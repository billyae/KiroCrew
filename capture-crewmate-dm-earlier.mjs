/**
 * Evidence for the earlier-messages bar in a crewmate DM on the Members page.
 *
 * Runs the REAL built SPA (website/dist) gateway-free. The crewmate's thread
 * slot holds 120 rows; the stubbed slot-detail read answers the newest 20 with
 * has_more=true, and a `before=` read answers the 60 rows below that cursor.
 * The DM's slot is made the chat store's active slot first (as when the user
 * last had that session open), then the app navigates in-place to /members.
 *
 * Frames (per theme): 01-idle, 02-loading, 03-failed, 04-loaded.
 * Usage: node scripts/capture-crewmate-dm-earlier.mjs <outDir>
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { serveDist } from './lib/serve-dist.mjs'
import { logPageProblems, stubDashboardApi, json } from './lib/stub-dashboard-api.mjs'

const OUT = process.argv[2] || '../temp-screenshots/crewmate-dm-earlier'
mkdirSync(OUT, { recursive: true })

const NOW = Date.now() / 1000
const SLUG = 'conductor'
const SLOT = `member-${SLUG}`
const TOTAL = 120
const NEWEST = 20
const OLDER = 60
const ROWS = Array.from({ length: TOTAL }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: i % 2 === 0
    ? `Patrol check ${i / 2 + 1}: anything new on the board?`
    : `Patrol ${(i - 1) / 2 + 1} done. Two PRs green, one waiting on review.`,
  cls: '',
  ts: new Date((NOW - (TOTAL - i) * 600) * 1000).toISOString(),
}))
const MEMBERS = [{
  name: SLUG, slug: SLUG, bound: true, slot_key: SLOT, running: false,
  kiro_agent: 'kirocrew', workspace: 'default', memory_store: 'default', model: '',
  last_active_ts: NOW - 60, last_message: ROWS[TOTAL - 1].content,
}]
const SLOTS = [{ key: SLOT, title: SLUG, mode: '', running: false, pinned: true, messages: TOTAL }]

const { srv, base } = await serveDist()
const browser = await chromium.launch()
let failures = 0

async function scene(theme, name, olderMode) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  page.on('pageerror', err => console.log('PAGEERROR:', String(err).slice(0, 300)))
  await stubDashboardApi(page, {
    theme, slots: SLOTS,
    localStorageEntries: { 'mc-preview-crew': '1', 'mc-crewmates-onboarded': '1' },
    extra: async (path, route) => {
      const url = new URL(route.request().url())
      if (path === '/api/members') { await json(route, { members: MEMBERS, default_agent: 'kirocrew' }); return true }
      if (/^\/api\/members\/[^/]+\/thread$/.test(path)) {
        await json(route, { slot_key: SLOT, slug: SLUG, member: SLUG, created: false }); return true
      }
      if (/^\/api\/members\/[^/]+\/activity$/.test(path)) {
        await json(route, { slug: SLUG, member: SLUG, capped: false, entries: [] }); return true
      }
      if (path === '/api/teams') { await json(route, { teams: [] }); return true }
      if (path === '/api/autonudge') { await json(route, { enabled: true, loops: [] }); return true }
      if (path === '/api/chat/slots' && route.request().method() === 'POST') {
        await json(route, { key: 'chat-1', name: 'chat-1', title: 'New Session…', messages: [], running: false }); return true
      }
      if (path === `/api/chat/slots/${SLOT}`) {
        const before = url.searchParams.get('before')
        if (before === null) {
          await json(route, { key: SLOT, title: SLUG, running: false, messages: ROWS.slice(TOTAL - NEWEST), has_more: true, next_before: TOTAL - NEWEST, total: TOTAL })
          return true
        }
        if (olderMode === 'hang') return true
        if (olderMode === 'fail') { await json(route, { error: 'boom' }, 500); return true }
        const b = Number(before)
        const start = Math.max(0, b - OLDER)
        await json(route, { key: SLOT, running: false, messages: ROWS.slice(start, b), has_more: start > 0, next_before: start, total: TOTAL })
        return true
      }
      return false
    },
  })
  await page.goto(`${base}/chat?sid=${SLOT}`)
  try {
    await page.getByText(ROWS[TOTAL - 1].content).first().waitFor({ timeout: 20000 })
  } catch (e) {
    await page.screenshot({ path: `${OUT}/debug-${theme}-${name}.png` })
    throw e
  }
  // In-app navigation keeps the store, so the DM's slot stays the active slot.
  await page.getByText('Crewmates', { exact: true }).first().click()
  await page.waitForURL(/\/members/, { timeout: 15000 })
  const bar = page.locator('[data-testid="load-earlier-messages"]')
  if (!(await bar.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false))) {
    await page.locator('main').getByText(SLUG, { exact: true }).locator('visible=true').first().click()
  }
  try {
    await bar.waitFor({ state: 'visible', timeout: 20000 })
  } catch (e) {
    await page.screenshot({ path: `${OUT}/debug2-${theme}-${name}.png` })
    throw e
  }
  if (!page.url().includes('/members')) throw new Error(`expected /members, at ${page.url()}`)
  const notNow = page.getByTestId('meet-crewmates-not-now')
  if (await notNow.waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false)) {
    await notNow.click()
    await notNow.waitFor({ state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(400)
  }

  await bar.scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  if (name !== 'idle') {
    await bar.click()
    if (name === 'loading') {
      await page.waitForFunction(() => document.querySelector('[data-testid="load-earlier-messages"]')?.getAttribute('aria-busy') === 'true', null, { timeout: 10000 })
    } else if (name === 'failed') {
      await page.waitForTimeout(1500)
    } else {
      // The newest-page row that sat just under the bar before the click.
      const anchor = page.getByText(ROWS[TOTAL - NEWEST].content).first()
      const before = await anchor.boundingBox()
      // The loaded page's rows land above it.
      await page.getByText(ROWS[TOTAL - NEWEST - 1].content).first().waitFor({ state: 'attached', timeout: 15000 })
      await page.waitForTimeout(1500)
      const after = await anchor.boundingBox()
      console.log(`${theme}/loaded: anchor row y before=${before?.y?.toFixed(0)} after=${after?.y?.toFixed(0)}`)
    }
  }
  if (await page.getByText('Something went wrong').isVisible().catch(() => false)) {
    console.error(`FAIL ${theme}/${name}: error boundary visible`); failures++
  }
  const busy = await bar.getAttribute('aria-busy').catch(() => null)
  const label = (await bar.textContent().catch(() => ''))?.trim()
  await page.screenshot({ path: `${OUT}/${theme}-${name}.png` })
  console.log(`${theme}/${name}: bar label="${label}" aria-busy=${busy}`)
  await ctx.close()
}

const ORDER = (process.env.ONLY ? [[process.env.ONLY, process.env.ONLY === 'loading' ? 'hang' : process.env.ONLY === 'failed' ? 'fail' : 'ok']] : [['idle', 'ok'], ['loading', 'hang'], ['failed', 'fail'], ['loaded', 'ok']])
const THEMES = process.env.ONLY ? ['dark'] : ['dark', 'light']
try {
  for (const theme of THEMES) {
    for (const [name, mode] of ORDER) {
      try { await scene(theme, name, mode) } catch (e) { console.error(`FAIL ${theme}/${name}: ${e.message}`); failures++ }
    }
  }
} finally {
  await browser.close()
  srv.close()
}
process.exit(failures ? 1 : 0)
