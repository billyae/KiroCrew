/**
 * Phase 4 of the live UI map: auto render-site ids, guide policy, auto plans
 * and the build-time `data-ui-auto` marker (`scripts/lib/ui-index.mjs`,
 * `scripts/lib/ui-auto-stamp.mjs`). Synthetic inputs pin each rule; one run of
 * the real generator pins the shipped shape (unique, stable ids, stamps only
 * on audited primitives).
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  AUDITED_PRIMITIVES,
  autoSiteIds,
  autoSitePolicy,
  autoStampManifest,
  buildAutoArtifact,
  buildUiIndex,
  GUIDE_DENY_IDS,
  parseSource,
  scanCandidates,
  scanImports,
} from '../../scripts/lib/ui-index.mjs'
import { applyAutoStamps } from '../../scripts/lib/ui-auto-stamp.mjs'
import { UI_CONDITIONS, UI_REVEAL_STATES } from './conditions'

type AutoLoc = {
  id: string; guide_policy?: string
  guide_plan?: { placements: { id: string; route: string | null; steps: { id: string; location: string }[] }[] }
}
type Artifact = { base_build_digest: string; build_digest: string; coverage: Record<string, unknown>; locations: AutoLoc[] }
type Cand = { page: string; tab: string | null; key: string; rel: string; pos: number }
const cand = (rel: string, pos: number, key = 'k.retry', page = 'page.schedule'): Cand => ({ page, tab: null, key, rel, pos })

describe('autoSiteIds', () => {
  it('names each site by parent, file stem and label key', () => {
    expect(autoSiteIds([cand('src/pages/SchedulePage.tsx', 5)])).toEqual(['auto:page.schedule:SchedulePage:k.retry'])
    expect(autoSiteIds([{ ...cand('src/a/Rail.tsx', 1), page: 'shell' }])).toEqual(['auto:shell:Rail:k.retry'])
    expect(autoSiteIds([{ ...cand('src/a/X.tsx', 1), tab: 'tab.capabilities.mcp' }])).toEqual(['auto:tab.capabilities.mcp:X:k.retry'])
  })

  it('is collision-free per page: one file drawing the label twice, two files with one stem', () => {
    const cs = [cand('src/a/Page.tsx', 90), cand('src/a/Page.tsx', 10), cand('src/b/Page.tsx', 3)]
    const ids = autoSiteIds(cs)
    expect(new Set(ids).size).toBe(3)
    expect(ids).toEqual(['auto:page.schedule:Page:k.retry:2', 'auto:page.schedule:Page:k.retry', 'auto:page.schedule:Page:k.retry:3'])
  })

  it('is stable: input order never changes a site\'s id', () => {
    const cs = [cand('src/a/Page.tsx', 90), cand('src/a/Page.tsx', 10), cand('src/b/Page.tsx', 3), cand('src/c/Other.tsx', 1, 'k.other')]
    const want = new Map(cs.map((c, i) => [c, autoSiteIds(cs)[i]]))
    const shuffled = [cs[3], cs[2], cs[0], cs[1]]
    autoSiteIds(shuffled).forEach((id, i) => expect(id).toBe(want.get(shuffled[i])))
  })

  it('does not merge two pages that share a label (search grouping is separate)', () => {
    const ids = autoSiteIds([cand('src/X.tsx', 1, 'k.retry', 'page.a'), cand('src/X.tsx', 1, 'k.retry', 'page.b')])
    expect(ids[0]).not.toBe(ids[1])
  })
})

describe('autoSitePolicy', () => {
  const site = 'auto:page.schedule:SchedulePage:k.retry'
  const base = { page: 'page.schedule', tab: null, primitive: 'Btn', spread: false, danger: false, inContainer: false }
  const ctx = { siteId: site, deny: new Set<string>(), english: 'Retry' }

  it('defaults to search-only; point needs an audited primitive', () => {
    expect(autoSitePolicy({ ...base, primitive: null }, ctx).policy).toBe('search-only')
    expect(autoSitePolicy(base, ctx)).toEqual({ policy: 'point', reason: 'audited_primitive' })
  })

  it('the deny list wins over an audited primitive', () => {
    expect(autoSitePolicy(base, { ...ctx, deny: new Set([site]) })).toEqual({ policy: 'deny', reason: 'denied' })
  })

  it('a destructive control is denied by its prop, a sensitive page by its parent', () => {
    expect(autoSitePolicy({ ...base, danger: true }, ctx).policy).toBe('deny')
    expect(autoSitePolicy({ ...base, page: 'settings.tab.security' }, ctx).policy).toBe('deny')
  })

  it('the destructive-label regex only keeps a site search-only; it never promotes', () => {
    expect(autoSitePolicy(base, { ...ctx, english: 'Delete everything' })).toEqual({ policy: 'search-only', reason: 'destructive_lint' })
    expect(autoSitePolicy({ ...base, primitive: null }, { ...ctx, english: 'Perfectly harmless' }).policy).toBe('search-only')
  })

  it('a spread or a closed container keeps it search-only', () => {
    expect(autoSitePolicy({ ...base, spread: true }, ctx).reason).toBe('spread_props')
    expect(autoSitePolicy({ ...base, inContainer: true }, ctx).reason).toBe('in_container')
  })
})

describe('scanned site facts', () => {
  const src = `import { Btn, IconButton as IB } from './components/ui'
import { i18nT } from './i18n/t'
export function F() {
  return (<div>
    <Btn onClick={go}>{i18nT('k.go')}</Btn>
    <Btn danger onClick={go}>{i18nT('k.rm')}</Btn>
    <Btn danger={false} {...rest}>{i18nT('k.ok')}</Btn>
    <DropdownMenuContent><Btn>{i18nT('k.in')}</Btn></DropdownMenuContent>
    <button type="button" data-ui-location="x.y">{i18nT('k.cur')}</button>
  </div>)
}
`
  const sf = parseSource(src, '/virtual/src/F.tsx')
  const cs = scanCandidates(src, '/virtual/src/F.tsx', 'src/F.tsx', sf) as Record<string, unknown>[]
  const by = (k: string) => cs.find((c) => (c.keys as string[])[0] === k)!

  it('records the danger prop, spreads, containers and the insert offset', () => {
    expect(by('k.go')).toMatchObject({ tag: 'Btn', danger: false, spread: false, inContainer: false })
    expect(by('k.rm').danger).toBe(true)
    expect(by('k.ok')).toMatchObject({ danger: false, spread: true })
    expect(by('k.in').inContainer).toBe(true)
    expect(src.slice((by('k.go').tagEnd as number) - 4, by('k.go').tagEnd as number)).toBe('<Btn')
  })

  it('remembers the exported name each import binds, so an alias is not the primitive', () => {
    const edge = (scanImports(sf) as { spec: string; imported: Record<string, string> }[]).find((e) => e.spec === './components/ui')!
    expect(edge.imported).toEqual({ Btn: 'Btn', IB: 'IconButton' })
    expect(Object.keys(AUDITED_PRIMITIVES)).toEqual(expect.arrayContaining(['Btn', 'IconButton']))
  })
})

describe('the marker step', () => {
  const src = `export const A = () => <Btn onClick={go}>{t('k.a')}</Btn>\nexport const B = () => <Btn data-ui-location="x.y">{t('k.b')}</Btn>\n`
  const sf = parseSource(src, '/virtual/src/A.tsx')
  const cs = scanCandidates(src, '/virtual/src/A.tsx', 'src/A.tsx', sf) as { tagEnd: number; openEnd: number; tag: string }[]
  const stamps = cs.map((c, i) => ({ rel: 'src/A.tsx', tagEnd: c.tagEnd, openEnd: c.openEnd, tag: c.tag, siteId: `auto:page.a:A:k.${i}` }))
  const m = autoStampManifest({ stamps, textOf: () => src, buildDigest: 'sha256:x' })
  const entry = m.files['src/A.tsx']

  it('stamps the listed site right after its tag name, and skips a curated element', () => {
    const r = applyAutoStamps(src, entry)
    expect(r.stamped).toBe(1)
    expect(r.code).toContain('<Btn data-ui-auto="auto:page.a:A:k.0" onClick={go}>')
    expect(r.code).toContain('<Btn data-ui-location="x.y">')
    expect(r.code).not.toContain('auto:page.a:A:k.1')
  })

  it('leaves a file whose text moved on unstamped, and refuses a manifest that does not fit', () => {
    expect(applyAutoStamps(`${src}\n`, entry)).toEqual({ code: `${src}\n`, skipped: 'stale' })
    const bad = { ...entry, stamps: [{ ...entry.stamps[0], offset: entry.stamps[0].offset + 1 }] }
    expect(() => applyAutoStamps(src, bad)).toThrow(/no <Btn tag ends/)
    const quote = { ...entry, stamps: [{ ...entry.stamps[0], site: 'auto:a:b:c" onclick="x' }] }
    expect(() => applyAutoStamps(src, quote)).toThrow(/malformed site id/)
  })

  it('hashes exactly the text it was cut from', () => {
    expect(entry.sha256).toBe(createHash('sha256').update(src).digest('hex'))
  })
})

describe('auto locations from buildUiIndex', () => {
  const EN = {
    'nav.chat': 'Sessions', 'nav.settings': 'Settings', 'tab.chat': 'Chat', 'k.toggle': 'Show sessions', 'k.setting': 'A setting',
    'k.retry': 'Retry the job', 'k.save': 'Save the job', 'k.dup': 'Duplicate job', 'k.del': 'Delete the job', 'k.wipe': 'Wipe the job',
  }
  const ROUTES = [
    { path: '/chat', catchAll: false, redirect: null },
    { path: '/settings', catchAll: false, redirect: null },
    { path: '/settings/:tab', catchAll: false, redirect: null },
  ]
  const build = (autoCandidates: unknown[], guideDeny?: string[]) => buildUiIndex({
    surfaces: [
      { navId: 'chat', route: '/chat', label: 'Sessions', labelKey: 'nav.chat', group: 'Main' },
      { navId: 'settings', route: '/settings', label: 'Settings', labelKey: 'nav.settings', group: 'Bottom' },
    ],
    extraPages: [], extraTitleKeys: {}, capabilityTabs: [], settingsSubs: {}, settingsTabPreview: {},
    settingsTabs: [{ id: 'chat', key: 'tab.chat' }],
    settingsEntries: [{ id: 'chat.a-setting', label: 'A setting', labelKey: 'k.setting', tab: 'chat', type: 'toggle', occurrence: 1 }],
    agentSettings: [{ id: 'chat.a-setting', label: 'A setting', tab: 'chat', route: '/settings/chat?highlight=chat.a-setting' }],
    descriptors: { 'chat.toggle': { kind: 'toggle', placements: [{ surface: 'chat', parent: 'page.chat', entry: 'toolbar' }] } },
    markerSites: [{ id: 'chat.toggle', rel: 'F.tsx', line: 1, resolved: { source: { key: 'k.toggle' }, excluded: [] } }],
    previewEnablers: {}, catalogs: { en: EN }, locales: ['en'], productName: 'Kiro Crew', inputDigest: 'sha256:test',
    routes: ROUTES, conditions: UI_CONDITIONS, revealStates: UI_REVEAL_STATES,
    resolveGuide: () => ({ ok: false, reason: 'none' }),
    autoCandidates,
    ...(guideDeny ? { guideDeny } : {}),
  } as never) as { index: { locations: AutoLoc[] }; errors: string[]; auto: { stamps: { siteId: string }[]; policy: Record<string, number> } }
  const c = (key: string, siteId: string, over: Record<string, unknown> = {}) => ({
    page: 'page.chat', tab: null, key, kind: 'button', rel: 'src/S.tsx', line: 1, pos: 1, tagEnd: 4, openEnd: 9, tag: 'Btn',
    primitive: 'Btn', spread: false, danger: false, inContainer: false, siteId, ...over,
  })
  const all = () => build([
    c('k.retry', 'auto:page.chat:S:k.retry'),
    c('k.save', 'auto:page.chat:S:k.save', { primitive: null }),
    c('k.dup', 'auto:page.chat:S:k.dup'),
    c('k.dup', 'auto:page.chat:T:k.dup', { rel: 'src/T.tsx' }),
    c('k.del', 'auto:page.chat:S:k.del', { danger: true }),
    c('k.wipe', 'auto:page.chat:S:k.wipe'),
  ])
  const byId = (r: ReturnType<typeof build>) => new Map(r.index.locations.map((l) => [l.id as string, l]))

  it('only a point location gets a plan, with one step at its site; search-only is the default', () => {
    const r = all()
    expect(r.errors).toEqual([])
    const m = byId(r)
    expect(m.get('auto:page.chat:k.retry')).toMatchObject({
      guide_policy: 'point',
      guide_plan: { version: 2, placements: [{ id: 'any', route: '/chat', steps: [{ id: 'any:auto:page.chat:k.retry', location: 'auto:page.chat:S:k.retry' }] }] },
    })
    expect(m.get('auto:page.chat:k.save')!.guide_policy).toBe('search-only')
    expect(m.get('auto:page.chat:k.save')!.guide_plan).toBeUndefined()
    // Two render sites behind one search entry: which one is meant is unknown.
    expect(m.get('auto:page.chat:k.dup')!.guide_policy).toBe('search-only')
    expect(m.get('auto:page.chat:k.del')!.guide_policy).toBe('deny')
    // The destructive-label lint keeps an audited primitive search-only.
    expect(m.get('auto:page.chat:k.wipe')!.guide_policy).toBe('search-only')
    expect(r.auto.stamps.map((s) => s.siteId)).toEqual(['auto:page.chat:S:k.retry'])
    expect(r.auto.policy).toEqual({ point: 1, 'search-only': 3, deny: 1 })
    // Curated locations are point unless denied.
    expect(m.get('chat.toggle')!.guide_policy).toBe('point')
  })

  it('a deny-listed auto location (or site) is denied, and stamps nothing', () => {
    for (const deny of ['auto:page.chat:k.retry', 'auto:page.chat:S:k.retry']) {
      const r = build([c('k.retry', 'auto:page.chat:S:k.retry')], [deny])
      const retry = byId(r).get('auto:page.chat:k.retry')!
      expect(retry.guide_policy).toBe('deny')
      expect(retry.guide_plan).toBeUndefined()
      expect(r.auto.stamps).toEqual([])
    }
  })

  it('the artifact counts the policies and carries its own digest over the base', () => {
    const r = all()
    const a = buildAutoArtifact(r.index as never, { baseInputDigest: 'sha256:t', baseBuildDigest: 'sha256:b', inputDigest: 'sha256:i' }) as Artifact
    expect(a.base_build_digest).toBe('sha256:b')
    expect(a.coverage).toMatchObject({ auto_point: 1, auto_search_only: 3, auto_denied: 1 })
    expect(a.build_digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    const again = buildAutoArtifact(r.index as never, { baseInputDigest: 'sha256:t', baseBuildDigest: 'sha256:other', inputDigest: 'sha256:i' }) as Artifact
    expect(again.build_digest).not.toBe(a.build_digest)
  })
})

describe('the real generator', () => {
  const dir = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH ?? os.tmpdir(), 'ui-auto-'))
  const gen = () => {
    const out = path.join(dir, `${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(out)
    const r = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/gen-ui-index.mjs'), '--out', path.join(out, 'i.json'),
      '--auto-out', path.join(out, 'a.json'), '--sites-out', path.join(out, 's.json')], { encoding: 'utf-8' })
    expect(r.status, r.stderr).toBe(0)
    return { auto: JSON.parse(fs.readFileSync(path.join(out, 'a.json'), 'utf-8')), sites: JSON.parse(fs.readFileSync(path.join(out, 's.json'), 'utf-8')) }
  }
  const first = gen()

  it('stamps only audited primitives, each site once, each the site its point plan names', { timeout: 120_000 }, () => {
    const stamps = Object.entries(first.sites.files as Record<string, { stamps: { tag: string; site: string }[] }>)
      .flatMap(([rel, f]) => f.stamps.map((s) => ({ rel, ...s })))
    expect(stamps.length).toBeGreaterThan(0)
    for (const s of stamps) expect(Object.keys(AUDITED_PRIMITIVES)).toContain(s.tag)
    const ids = stamps.map((s) => s.site)
    expect(new Set(ids).size).toBe(ids.length)
    const planned = (first.auto.locations as AutoLoc[]).filter((l) => l.guide_policy === 'point').map((l) => l.guide_plan!.placements[0].steps[0].location)
    expect([...planned].sort()).toEqual([...ids].sort())
    expect(first.sites.build_digest).toBe(first.auto.build_digest)
    // No plan on anything but a point location, and the deny list still names real ids.
    for (const l of first.auto.locations as AutoLoc[]) if (l.guide_plan) expect(l.guide_policy).toBe('point')
    expect(GUIDE_DENY_IDS.length).toBeGreaterThan(0)
  })

  it('names every site the same on a rebuild of the same tree', { timeout: 120_000 }, () => {
    expect(gen().sites).toEqual(first.sites)
  })
})
