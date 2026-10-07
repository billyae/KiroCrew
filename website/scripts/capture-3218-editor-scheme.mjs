/**
 * Screenshots for PR #3218 (dashboard editor URL-scheme links). Renders the
 * isolated capture entry website/capture/editor-scheme-link-3218.{html,tsx}
 * over a stubbed desktop-shell bridge, drives a real user click, and ASSERTS
 * the documented state before writing each frame.
 *
 *   allowed-{dark,light}   an editor-scheme link renders as a clickable anchor;
 *                          a javascript: link is stripped to inert text (no
 *                          anchor). The click resolves ok — no error shown.
 *   blocked-dark           the same click with the bridge returning {ok:false}
 *                          surfaces the inline ErrorNotice next to the link,
 *                          instead of a silent dead click (#3218 GPT review).
 *
 * Usage:
 *   npx vite --port 5203 --strictPort   # in another shell
 *   node scripts/capture-3218-editor-scheme.mjs http://127.0.0.1:5203 ../temp-screenshots/3218
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] || 'http://127.0.0.1:5203'
const OUT = process.argv[3] || '../temp-screenshots/3218'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
let failed = false

function check(name, ok, detail) {
  console.log(`${name}: ${ok ? 'OK' : 'MISMATCH'} ${detail}`)
  if (!ok) failed = true
  return ok
}

async function newPage(viewport = { width: 760, height: 360 }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 })
  page.on('pageerror', e => console.error('pageerror:', e.message))
  return page
}

// 1. Allowed scheme, dark + light. The editor link is a real anchor; the
// javascript: link is inert text (no anchor). Clicking the editor link resolves
// ok, so NO error notice renders.
for (const theme of ['dark', 'light']) {
  const page = await newPage()
  await page.goto(`${BASE}/capture/editor-scheme-link-3218.html?scene=allowed&theme=${theme}`)
  await page.waitForSelector('[data-capture-root]')
  const editorLink = page.locator('a[href^="idea://"]')
  await editorLink.first().waitFor()
  // The javascript: destination must NOT be an anchor (sanitizer strips it).
  const jsAnchors = await page.locator('a[href^="javascript:"]').count()
  const jsText = (await page.locator('[data-capture-root]').innerText()).includes('javascript:alert(1)')
  await editorLink.first().click()
  // Settle the awaited hand-off; an ok result shows no notice.
  await page.waitForTimeout(150)
  const errCount = await page.getByTestId('md-link-reveal-error').count()
  const ok = check(`allowed-${theme}`,
    await editorLink.count() === 1 && jsAnchors === 0 && jsText && errCount === 0,
    `editorAnchor=${await editorLink.count()} jsAnchors=${jsAnchors} jsAsText=${jsText} errors=${errCount}`)
  if (ok) await page.screenshot({ path: `${OUT}/allowed-${theme}.png` })
  await page.close()
}

// 2. Blocked/failed hand-off, dark. The click surfaces the inline ErrorNotice
// rather than a silent dead click.
{
  const page = await newPage()
  await page.goto(`${BASE}/capture/editor-scheme-link-3218.html?scene=blocked&theme=dark`)
  await page.waitForSelector('[data-capture-root]')
  const editorLink = page.locator('a[href^="idea://"]')
  await editorLink.first().waitFor()
  await editorLink.first().click()
  const notice = page.getByTestId('md-link-reveal-error')
  await notice.first().waitFor()
  const text = (await notice.first().innerText()).replace(/\s+/g, ' ')
  const ok = check('blocked-dark',
    (await notice.count()) >= 1 && /No app on this computer opens IntelliJ IDEA links/i.test(text),
    `notices=${await notice.count()} text=${JSON.stringify(text.slice(0, 90))}`)
  if (ok) await page.screenshot({ path: `${OUT}/blocked-dark.png` })
  await page.close()
}

// 3. OFF (default) state: idea:// renders as plain text, no anchor, no badge —
// exactly as on main (#3218 UX evidence gap).
{
  const page = await newPage()
  await page.goto(`${BASE}/capture/editor-scheme-link-3218.html?scene=allowed&theme=dark&optin=off`)
  await page.waitForSelector('[data-capture-root]')
  // Wait for the message text to render, then assert the editor link is NOT an anchor.
  await page.getByText('Open the failing test in your editor:').waitFor()
  const anchors = await page.locator('a[href^="idea://"]').count()
  const badges = await page.getByTestId('md-editor-scheme-app').count()
  const asText = (await page.locator('[data-capture-root]').innerText()).includes('idea://open?file=')
  const ok = check('off-default-dark', anchors === 0 && badges === 0 && asText,
    `anchors=${anchors} badges=${badges} asText=${asText}`)
  if (ok) await page.screenshot({ path: `${OUT}/off-default-dark.png` })
  await page.close()
}

// 4. The Settings → Chat toggle this PR adds, shown next to its real neighbours
// (#3218 UX evidence gap — the only control that turns the feature on). ON and
// OFF states.
for (const [state, optin] of [['on', ''], ['off', 'off']]) {
  const page = await newPage({ width: 620, height: 260 })
  const q = optin ? `&optin=${optin}` : ''
  await page.goto(`${BASE}/capture/editor-scheme-link-3218.html?scene=settings&theme=dark${q}`)
  await page.waitForSelector('[data-capture-root]')
  const label = page.getByText('Open code-editor links in your editor', { exact: true })
  await label.first().waitFor()
  // The toggle's checked state matches the opt-in: aria-checked on the switch.
  const toggle = page.locator('[role="switch"]').nth(1)
  const checked = await toggle.getAttribute('aria-checked')
  const want = optin === 'off' ? 'false' : 'true'
  const ok = check(`settings-toggle-${state}-dark`, (await label.count()) === 1 && checked === want,
    `label=${await label.count()} aria-checked=${checked} want=${want}`)
  if (ok) await page.screenshot({ path: `${OUT}/settings-toggle-${state}-dark.png` })
  await page.close()
}

await browser.close()
process.exit(failed ? 1 : 0)
