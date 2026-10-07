// Shoot the chat composer's Command Center dock and its new Dismiss control
// (issue #16250) via the command-center-dock capture fixture.
//
// Pattern of capture/shoot-cron-secrets-panel.mjs: a vite dev server serves the
// REAL built component from capture/command-center-dock.html, Playwright drives
// real pointer events (so the Radix overflow menu opens), and frames land under
// temp-screenshots/16250/. Gateway-free — the fixture seeds the Redux store and
// stubs the dock's read endpoints empty.
//
// Frames (both themes):
//   before    — the expanded dock above the composer: three tiles, the two-action
//               control row (Open + overflow).
//   menu      — the overflow menu open, showing Hide and Dismiss.
//   dismissed — after choosing Dismiss: the composer with no dock above it.
//
// Run from website/: node capture/shoot-command-center-dock.mjs <outdir>
import { createServer } from 'vite'
import { chromium } from 'playwright-core'
import path from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromiumExecutable } from '../scripts/lib/chromium-executable.mjs'

const outDir = process.argv[2] || path.resolve('../temp-screenshots/16250')
mkdirSync(outDir, { recursive: true })
const executablePath = process.env.CHROMIUM_PATH || chromiumExecutable()

const MAX_EDGE = 2000
const MIN_MBPP = 15
function check(file) {
  const b = readFileSync(file)
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20)
  const mbpp = Math.round((b.length * 1000) / (w * h))
  const over = w > MAX_EDGE || h > MAX_EDGE
  const blank = mbpp < MIN_MBPP
  console.log(`wrote ${file}  ${w}x${h}  ${b.length}B  ${mbpp} mB/px${over ? '  OVER' : ''}${blank ? '  BLANK' : ''}`)
  if (blank) throw new Error(`${file}: ${mbpp} mB/px below ${MIN_MBPP} blank floor`)
  if (over) throw new Error(`${file}: over ${MAX_EDGE}px`)
}

const server = await createServer({
  configFile: 'vite.config.ts',
  server: { port: 5207, strictPort: true, host: '127.0.0.1' },
})
await server.listen()
const browser = await chromium.launch({ executablePath })

const root = () => '[data-capture-root]'

for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 760, height: 520 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  page.on('console', m => { if (m.type() === 'error') console.log('PAGE ERROR:', m.text()) })
  page.on('pageerror', e => console.log('PAGE EXCEPTION:', e.message))
  await page.goto(`http://127.0.0.1:5207/capture/command-center-dock.html?theme=${theme}`)

  // The dock is shown once the store-driven work resolves.
  await page.waitForSelector('[data-testid="command-center-dock"]', { timeout: 45000 })
  await page.getByRole('button', { name: 'Open Dashboard' }).waitFor({ timeout: 10000 })
  await page.waitForTimeout(500)

  // before — expanded dock, two-action row.
  await page.locator(root()).screenshot({ path: path.join(outDir, `dock-before-${theme}.png`) })
  check(path.join(outDir, `dock-before-${theme}.png`))

  // menu — open the overflow, showing Hide + Dismiss.
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Dismiss until new activity' }).waitFor({ timeout: 8000 })
  await page.waitForTimeout(300)
  await page.locator(root()).screenshot({ path: path.join(outDir, `dock-menu-${theme}.png`) })
  check(path.join(outDir, `dock-menu-${theme}.png`))

  // dismissed — choose Dismiss; the dock leaves the layout entirely.
  await page.getByRole('menuitem', { name: 'Dismiss until new activity' }).click()
  await page.waitForSelector('[data-testid="command-center-dock"]', { state: 'detached', timeout: 8000 })
  await page.waitForTimeout(400)
  await page.locator(root()).screenshot({ path: path.join(outDir, `dock-dismissed-${theme}.png`) })
  check(path.join(outDir, `dock-dismissed-${theme}.png`))

  await ctx.close()
}

await browser.close()
await server.close()
console.log('\nall frames ok')
