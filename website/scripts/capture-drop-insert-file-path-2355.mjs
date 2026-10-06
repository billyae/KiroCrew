/**
 * Capture the composer preview strip showing a file staged BY PATH (issue
 * #2355), in dark and light, from the isolated capture/drop-insert-file-path-2355.html
 * entry. The drop gesture is not showable in a still, so this is the RESULT it
 * produces: the dropped file rendered as a path-reference chip (no upload).
 *
 * Asserts the file chip rendered with its FULL path as the group name AND that
 * no image thumbnail was fetched (a path reference carries no content), so this
 * can never emit a screenshot of the wrong thing.
 *
 * Usage:
 *   npx vite --host 127.0.0.1 --port 6808 --strictPort   # in another shell
 *   node scripts/capture-drop-insert-file-path-2355.mjs http://127.0.0.1:6808 ../temp-screenshots/2355
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] || 'http://127.0.0.1:6808'
const OUT = process.argv[3] || '../temp-screenshots/2355'
mkdirSync(OUT, { recursive: true })

const FILE_PATH = '/Users/mina/project/docs/architecture.md'

const run = async () => {
  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : undefined,
  )
  let failed = 0
  for (const theme of ['dark', 'light']) {
    const ctx = await browser.newContext({
      viewport: { width: 640, height: 260 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    })
    const page = await ctx.newPage()
    const errors = []
    const rawFetches = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('request', r => { if (r.url().includes('/api/file-raw')) rawFetches.push(r.url()) })
    await page.goto(`${BASE}/capture/drop-insert-file-path-2355.html?theme=${theme}`, {
      waitUntil: 'networkidle',
    })
    try {
      await page.waitForSelector('[data-capture-root]', { timeout: 15000 })
      // The dropped file staged BY PATH: a role=group chip named by the full path.
      await page.getByRole('group', { name: FILE_PATH }).waitFor({ timeout: 10000 })
    } catch {
      console.error(
        `  FAIL ${theme}: path chip never rendered` + (errors.length ? ` (${errors[0]})` : ''),
      )
      failed += 1
      await ctx.close()
      continue
    }
    // A path reference must not fetch content — if a thumbnail was requested the
    // file was treated as an upload, which is the bug this feature avoids.
    if (rawFetches.length) {
      console.error(`  FAIL ${theme}: a path reference must not fetch content, saw ${rawFetches[0]}`)
      failed += 1
      await ctx.close()
      continue
    }
    const target = await page.$('[data-capture-root]')
    await target.screenshot({ path: `${OUT}/${theme}-composer-path-reference.png` })
    console.log(`  ${theme} -> composer shows architecture.md staged by path, not uploaded`)
    await ctx.close()
  }
  await browser.close()
  if (failed) {
    console.error(`${failed} capture(s) failed`)
    process.exit(1)
  }
}

run()
