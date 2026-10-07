/**
 * Screenshots, and an assertion per frame, for the global "Hide empty folders" setting
 * (#16046) in the sidebar tree lane.
 *
 * Two frames: the sidebar with the setting OFF (every install's current behaviour — both
 * the empty folder and the folder that holds a session are drawn) and ON (the empty
 * folder is gone, the folder that still holds a session stays). The OFF frame is the
 * control: a sidebar that drew nothing would satisfy "the empty folder is gone" on its
 * own, so a reader needs to see the folder was there first.
 *
 * This ASSERTS as well as photographs. The unit pin already proves which rows are in the
 * DOM under jsdom with framer-motion mocked out; a DOM row is not the same as a row a
 * person can SEE. So each frame waits for the rows it expects to be painted, checks the
 * folder headers present, checks the pinned theme, and the run exits non-zero on any
 * mismatch.
 *
 * Usage:
 *   npx vite --host 127.0.0.1 --port 6842 --strictPort      # in another shell
 *   node scripts/capture-empty-folder-hide-setting.mjs http://127.0.0.1:6842 [outDir]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { chromiumExecutable } from './lib/chromium-executable.mjs'
import { stubDashboardApi, logPageProblems } from './lib/stub-dashboard-api.mjs'

const BASE = process.argv[2] || 'http://127.0.0.1:6842'
const OUT = process.argv[3] || '../temp-screenshots/16046'
mkdirSync(OUT, { recursive: true })

const EMPTY = 'folder-empty'
const FULL = 'folder-full'
const FOLDERS = [
  { id: EMPTY, name: 'empty folder', collapsed: false, order: 0 },
  { id: FULL, name: 'full folder', collapsed: false, order: 1 },
]

let failed = false
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) failed = true
}

const browser = await chromium.launch({ executablePath: chromiumExecutable() })
const context = await browser.newContext({ viewport: { width: 560, height: 620 }, deviceScaleFactor: 2 })
const page = await context.newPage()
page.on('pageerror', e => { console.log(`FAIL pageerror -- ${e.message}`); failed = true })

let wantTheme = 'dark'
await stubDashboardApi(page, {
  theme: 'dark',
  folders: FOLDERS,
  extra: async (path, route) => {
    if (path === '/api/theme/boot') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mode: wantTheme, theme: '' }) })
      return true
    }
    if (path === '/api/chat/tag-columns') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
      return true
    }
    if (path.startsWith('/api/')) return false
    await route.continue()
    return true
  },
})
logPageProblems(page)

/** Folder header ids in rendered document order. */
const renderedFolders = () => page.$$eval('[data-folder-row]', els => [...new Set(els.map(el => el.getAttribute('data-folder-row')))])

async function settledTheme() {
  let prev = null
  for (let i = 0; i < 20; i++) {
    const now = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    if (now && now === prev) return now
    prev = now
    await page.waitForTimeout(200)
  }
  return prev
}

/**
 * One frame. `hide` decides both the fixture seed and what is asserted, because the two
 * must never drift apart: a frame named for the setting-on state that photographs the
 * setting-off sidebar is exactly the evidence this harness exists to make impossible.
 */
async function frame(hide, name, theme = 'dark') {
  wantTheme = theme
  await page.goto(`${BASE}/capture/empty-folder-hide-setting.html?hide=${hide ? '1' : '0'}&theme=${theme}`)
  await page.waitForSelector('[data-capture-ready]')
  await page.waitForSelector('[data-slot-key="k-in-full"]')
  const settled = await settledTheme()
  check(`${name}: pinned Kiro ${theme}`, settled === `kiro-${theme}`, String(settled))

  const folders = await renderedFolders()
  // The folder that still holds a session is drawn in both frames; its session too.
  check(`${name}: the full folder header renders`, folders.includes(FULL), folders.join(' '))
  const sessionVisible = await page.locator('[data-slot-key="k-in-full"]').count()
  check(`${name}: the working session renders`, sessionVisible === 1, `${sessionVisible}`)
  if (hide) {
    check(`${name}: the empty folder header is gone`, !folders.includes(EMPTY), folders.join(' '))
  } else {
    check(`${name}: the empty folder header renders`, folders.includes(EMPTY), folders.join(' '))
  }

  await page.locator('[data-capture-ready]').screenshot({ path: `${OUT}/${name}.png` })
  console.log(`     ${name}.png`)
}

await frame(false, '01-setting-off-before')
await frame(true, '02-setting-on-after')

/**
 * The new control itself, which the sidebar frames cannot show: Settings → Chat →
 * Sessions, the two folder toggles together, OFF then ON. The UX review's blind reader
 * needs to see the switch and its wording, and the ON frame shows "Compact Empty
 * Folders" disabled because an empty folder is already gone.
 */
async function settingsFrame(on, name) {
  await page.goto(`${BASE}/capture/hide-empty-folders-setting.html?theme=dark&on=${on ? '1' : '0'}`)
  await page.waitForSelector('[data-capture-root]')
  // Both rows painted: the label text present proves the real SettingsToggle mounted.
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-capture-root]')?.textContent || ''
    return t.includes('Hide Empty Folders') && t.includes('Compact Empty Folders')
  }, { timeout: 8000 })
  const text = await page.$eval('[data-capture-root]', el => el.textContent || '')
  check(`${name}: shows the Hide Empty Folders label`, text.includes('Hide Empty Folders'), '')
  check(`${name}: shows the shortened hint`, text.includes('Folders with no sessions are hidden until a session is created or moved into them'), '')
  await page.locator('[data-capture-root]').screenshot({ path: `${OUT}/${name}.png` })
  console.log(`     ${name}.png`)
}

await settingsFrame(false, '03-settings-toggle-off')
await settingsFrame(true, '04-settings-toggle-on')

await context.close()
await browser.close()
console.log(failed ? 'FAILED' : 'all frames ok')
process.exit(failed ? 1 : 0)
