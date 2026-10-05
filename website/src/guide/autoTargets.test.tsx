/**
 * Auto guide targets in the browser: a stamped `data-ui-auto` site resolves
 * under the same exactly-one rule as a curated `data-ui-location`, and an auto
 * `ui.show` plan is walked only from the guide record AND only when its digest
 * is this bundle's own auto digest (the build that stamped the markers).
 *
 * The digest is defined by the ui-auto-stamp Vite plugin at build time and is
 * absent under Vitest, so it is mocked here; the unmocked case (no stamped
 * build: every auto guide refused) is in liveRegistry.test.tsx.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render } from '@testing-library/react'

vi.mock('../uiLocations/autoBuild', async (orig) => ({
  ...(await orig<typeof import('../uiLocations/autoBuild')>()),
  UI_AUTO_BUILD_DIGEST: 'sha256:auto-of-this-build',
}))

import { findUiLocation, resolveGuideAction, type GuideAction } from './guideActions'
import { isDisplayed, liveTarget } from './liveRegistry'

const LID = 'auto:page.schedule:pages.schedulePage.retry'
const SITE = 'auto:page.schedule:SchedulePage:pages.schedulePage.retry'
const box = (el: HTMLElement | null) => {
  if (!el) return
  el.getBoundingClientRect = () => ({ top: 10, left: 10, width: 40, height: 20, right: 50, bottom: 30, x: 10, y: 10, toJSON: () => ({}) }) as DOMRect
}

function action(over: Partial<GuideAction> = {}): GuideAction {
  return {
    id: 'ui.show',
    params: { location_id: LID },
    build_digest: 'sha256:auto-of-this-build',
    plan_version: 2,
    placements: { any: [`any:${LID}`] },
    auto_plan: {
      version: 2,
      label_key: 'pages.schedulePage.retry',
      placements: [{ id: 'any', route: '/schedule', steps: [{ id: `any:${LID}`, location: SITE, label_key: 'pages.schedulePage.retry' }] }],
    },
    ...over,
  }
}

afterEach(() => cleanup())

describe('auto ui.show', () => {
  it('walks the record\'s single-step plan at the site id', () => {
    const r = resolveGuideAction(action())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.action.steps).toHaveLength(1)
    expect(r.action.steps[0].target).toEqual({ kind: 'location', id: SITE })
    expect(r.action.steps[0].complete).toEqual({ kind: 'ack' })
  })

  it('refuses a plan of another build (the curated digest included) as build_mismatch', () => {
    expect(resolveGuideAction(action({ build_digest: 'sha256:other' }))).toEqual({ ok: false, reason: 'build_mismatch' })
    expect(resolveGuideAction(action({ build_digest: undefined }))).toEqual({ ok: false, reason: 'build_mismatch' })
  })

  it('refuses a record with no plan, several steps, or a step that is not a site', () => {
    expect(resolveGuideAction(action({ auto_plan: undefined }))).toEqual({ ok: false, reason: 'unknown_location' })
    const two = action()
    two.auto_plan!.placements[0].steps.push({ id: 'any:x', location: SITE, label_key: 'k' })
    expect(resolveGuideAction(two)).toEqual({ ok: false, reason: 'unknown_location' })
    const curatedTarget = action()
    curatedTarget.auto_plan!.placements[0].steps[0].location = 'chat.older-sessions'
    expect(resolveGuideAction(curatedTarget)).toEqual({ ok: false, reason: 'unknown_location' })
  })
})

describe('auto targets under the exactly-one rule', () => {
  it('a stamped site is found and pointable', () => {
    render(<button type="button" data-ui-auto={SITE} ref={box}>Retry</button>)
    expect(findUiLocation(SITE, isDisplayed)).not.toBeNull()
    expect(liveTarget(SITE).status).toBe('pointable')
  })

  it('two displayed copies point at neither, whichever attribute each carries', () => {
    render(<><button type="button" data-ui-auto={SITE} ref={box}>a</button><button type="button" data-ui-location={SITE} ref={box}>b</button></>)
    expect(findUiLocation(SITE, isDisplayed)).toBeNull()
    expect(liveTarget(SITE).status).toBe('ambiguous')
  })

  it('a hidden copy is no rival', () => {
    render(<><button type="button" data-ui-auto={SITE} ref={box}>a</button><div hidden><button type="button" data-ui-auto={SITE}>b</button></div></>)
    expect(liveTarget(SITE).status).toBe('pointable')
  })

  it('a curated id never matches a data-ui-auto copy', () => {
    render(<button type="button" data-ui-auto="chat.older-sessions" ref={box}>x</button>)
    expect(liveTarget('chat.older-sessions').status).toBe('unmounted')
  })
})
