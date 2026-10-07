/**
 * Screenshot harness for PR #16376 (crew captain): the `kirocrew-captain` entry
 * in the chat agent picker, shown next to the conductor entries.
 *
 * Runs the REAL built SPA (website/dist) gateway-free behind the shared
 * `serveDist` server, with every /api/** call answered from fixtures via
 * `stubDashboardApi`. The picker renders whatever roster `GET /api/agents`
 * returns (AgentDropdownList maps each row to name + source badge +
 * description), so seeding the roster the backend installers now emit is a
 * faithful shot of the real surface rather than a mock-up.
 *
 * Agent names and descriptions below are copied VERBATIM from the backend
 * installers in `src/kiro_crew/agent_materialization/conductor_agents.py`
 * (`_install_captain_agent`, `_install_conductor_agent`,
 * `_install_pipeline_conductor_agent`, `_install_security_conductor_agent`), so
 * the frame documents strings the gateway genuinely emits.
 *
 * The script ASSERTS the kirocrew-captain row and its description are on screen
 * before the shutter and FAILS (exit 1) otherwise, so a regressed roster cannot
 * yield a citable but empty PNG.
 *
 * Usage: node scripts/capture-crew-captain-agent-picker.mjs [outFile]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { json } from './lib/boot-api.mjs'
import { serveDist } from './lib/serve-dist.mjs'
import { stubDashboardApi, logPageProblems } from './lib/stub-dashboard-api.mjs'

// Default output is resolved relative to the repo root (two levels up from
// website/scripts/), so the script carries no machine-specific path.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = process.argv[2]
  || resolve(REPO_ROOT, '.github/screenshots/16376/crew-captain-agent-picker.png')
mkdirSync(dirname(OUT), { recursive: true })

const SLOT = 'chat-1'
const CAPTAIN = 'kirocrew-captain'
const CAPTAIN_DESC_PREFIX = 'Coordinates conductors other sessions opened'

// The chat agent picker's roster comes from GET /api/agents/catalog
// (useAgents -> api.agentCatalog), whose rows are KiroCrewAgent records tagged
// `selection_kind`. The conductors and the captain are Crew-shipped INSTALLED
// agent specs, so they appear here as `template` rows (source 'builtin').
//
// Names and descriptions are copied VERBATIM from the backend installers in
// conductor_agents.py, so the frame documents strings the gateway emits.
const tmpl = (name, description) => ({
  name,
  kiro_agent: name,
  workspace: 'default',
  memory_store: 'default',
  description,
  source: 'builtin',
  selection_kind: 'template',
  scope: 'global',
})

const AGENTS = [
  tmpl('kirocrew', 'The default Kiro Crew agent for everyday chat sessions.'),
  tmpl(
    'kirocrew-conductor',
    'Owns a long-horizon goal and tracks it in the work ledger: decomposes it '
    + 'into items, dispatches one session per item, reads their reported status '
    + 'as data rather than as a transcript, verifies claims with the acceptance '
    + 'evaluator, and decides each next round. Never does the work itself.',
  ),
  tmpl(
    CAPTAIN,
    'Coordinates conductors other sessions opened, from one session you '
    + 'started. Asks before it sends or stops, and stays in its workspace.',
  ),
  tmpl(
    'kirocrew-pipeline-conductor',
    'Runs one repository pipeline as a supervised fleet: picks up queued work '
    + 'items, dispatches one worker session per item, probes and verifies them, '
    + 'intervenes on stalls, adjudicates blocked items, and governs host '
    + 'resources and per-item credit budgets. Never does a work item\'s work itself.',
  ),
  tmpl(
    'kirocrew-security-conductor',
    'Runs one security audit as a supervised fleet: decomposes a target into '
    + 'attack surfaces, dispatches one auditor session per surface and an '
    + 'independent verifier per finding, adjudicates severity, and gates any fix '
    + 'behind a human yes. Never touches the target itself.',
  ),
]

const { srv, base } = await serveDist()
const browser = await chromium.launch()

try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 980 }, deviceScaleFactor: 2 })
  const page = await context.newPage()
  logPageProblems(page)

  const extra = async (path, route) => {
    // The chat picker's roster source.
    if (path === '/api/agents/catalog') {
      await json(route, { agents: AGENTS, default_agent: 'kirocrew' })
      return true
    }
    // Name-only consumers / safety.
    if (path === '/api/agents' || path === '/api/chat/agents') {
      await json(route, { agents: AGENTS, default_agent: 'kirocrew' })
      return true
    }
    return false
  }

  await stubDashboardApi(page, {
    slots: [{ key: SLOT, messages: 0, running: false, agent: 'kirocrew', mode: '' }],
    extra,
  })
  await page.addInitScript(slot => {
    localStorage.setItem('mc-active-slot', slot)
    localStorage.setItem('mc-lang', 'en')
  }, SLOT)

  await page.goto(base + '/chat', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  // Open the agent picker from the chat composer.
  await page.getByRole('button', { name: /^Agent: / }).first().click()
  const picker = page.getByRole('dialog', { name: 'Agent selector' })
  await picker.waitFor({ state: 'visible', timeout: 5000 })

  // Assert the captain row AND its description are present before shooting, so
  // the evidence cannot photograph a roster that dropped the captain.
  const captainOption = picker.getByRole('option', { name: new RegExp(CAPTAIN) })
  await captainOption.waitFor({ state: 'visible', timeout: 5000 })
  const captainText = (await captainOption.textContent()) || ''
  if (!captainText.includes(CAPTAIN_DESC_PREFIX)) {
    throw new Error(
      `kirocrew-captain row is missing its description. Row text was: ${JSON.stringify(captainText)}`,
    )
  }
  // Confirm it sits among the conductor entries.
  const names = await picker.getByRole('option').allTextContents()
  const haveConductors = names.some(t => t.includes('kirocrew-conductor'))
    && names.some(t => t.includes('kirocrew-pipeline-conductor'))
  if (!haveConductors) {
    throw new Error(`conductor sibling rows missing; options were: ${JSON.stringify(names.map(t => t.slice(0, 40)))}`)
  }

  await picker.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await picker.screenshot({ path: OUT })
  console.log('wrote', OUT)
  console.log('captain row text:', JSON.stringify(captainText.slice(0, 160)))
  console.log('rows:', names.length)
} finally {
  await browser.close()
  srv.close()
}
