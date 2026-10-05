/**
 * Finds the control the current guide step points at and follows it.
 *
 * The target is the ONE element the registry names: a registered
 * `data-guide-anchor`, the exact Settings row (`resolveSettingElementStrict`),
 * or the one visible element carrying a UI location's `data-ui-location`.
 * It must be visibly rendered; nothing near it stands in. While it is absent
 * the tracker waits a bounded time for a panel that mounts late, then reports
 * `target_missing` once. A `reach` step reports `observed` once the UI shows a
 * later registered target — the human moved the form on (or the menu, panel
 * or sidebar it opens is already open, so the step is skipped). A `committed` step is
 * never reported by the browser; after its save was submitted, the target
 * leaving (a dialog closing on success) is not "missing" either. Once a step
 * IS missing, the same hook runs in `recover` mode: the target (or a later
 * anchor of a `reach` step) coming back reports `onFound`, re-offered on a
 * slower cadence a bounded number of times so one failed write does not
 * strand it, and the gateway returns the guide to that same step.
 *
 * A step carrying runtime predicates (`step.requires`) is never pointed past
 * them: with its target absent and a predicate unmet, the step is reported
 * missing with detail `predicate_unmet` after the short settle, and it
 * recovers only once the predicates hold and the target is drawn.
 */
import { useEffect, useRef, useState } from 'react'
import { resolveSettingElementStrict } from '../hooks/useSettingHighlight'
import { findGuideAnchor, findUiLocation, type GuideStepPlan, type GuideTarget } from './guideActions'
import { predicateState, selectionState, unmetPredicates } from './guidePredicates'
import { isDisplayed, liveTarget, scopeOpen } from './liveRegistry'

/** How long a registered target may take to appear before it is missing. */
export const GUIDE_TARGET_WAIT_MS = 10_000
/** How long the page must show an EARLIER step of the action, with this step's
 *  target absent, before the step counts as missing (and recovers back there). */
export const GUIDE_EARLIER_STEP_WAIT_MS = 1_500
/** Poll cadence while a step is tracked; scroll and resize re-measure at once. */
export const GUIDE_TRACK_TICK_MS = 250
/** A recovered target re-offers `onFound` this often until the guide resumes. */
export const GUIDE_FOUND_RETRY_MS = 2_000
/** How many times a recovered target is offered before the tracker gives up. */
export const GUIDE_FOUND_MAX_ATTEMPTS = 5

export interface GuideRect {
  top: number
  left: number
  width: number
  height: number
}

export function resolveGuideTarget(target: GuideTarget): HTMLElement | null {
  if (target.kind === 'none') return null
  if (target.kind === 'anchor') return findGuideAnchor(target.anchor)
  if (target.kind === 'location') return findUiLocation(target.id, isGuideTargetVisible)
  return resolveSettingElementStrict(target.entry)
}

/** Why a step is missing, when the page can tell (see `GuideMissingDetail`). */
export type GuideStepMissingDetail = 'ambiguous' | 'predicate_unmet' | 'gate_off' | 'selection_empty'

/**
 * A gate or select step's own verdict, read from the page's facts, never
 * from what is drawn: `done` (the gate is on, the entity is picked),
 * `blocked` (the gate is off, the picker is empty: a blocker, no pointing),
 * `waiting` (unknown: no reporter yet), or `point` (a select step pointing at
 * its picker until the pick).
 */
export function factVerdict(step: GuideStepPlan): 'done' | 'blocked' | 'waiting' | 'point' | null {
  const c = step.complete
  if (c.kind === 'gate') {
    const s = predicateState(c.gate)
    return s === 'met' ? 'done' : s === 'unmet' ? 'blocked' : 'waiting'
  }
  if (c.kind === 'select') {
    const s = selectionState(c.selection)
    return s === 'selected' ? 'done' : s === 'empty' ? 'blocked' : 'point'
  }
  return null
}

/**
 * Whether a `reach` step is done: its reveal scope's owner reports it open, or
 * a LATER target is on screen (the human moved on). The scope is the explicit
 * fact; the later target is the fallback for a container no owner reports.
 */
function laterTargetVisible(step: GuideStepPlan): boolean {
  if (step.complete.kind !== 'reach') return false
  if (step.complete.scope && scopeOpen(step.complete.scope) === true) return true
  return step.complete.targets.some(t => isGuideTargetVisible(resolveGuideTarget(t)))
}

/** Rendered and painted: connected, non-empty box, not hidden or inert. */
export const isGuideTargetVisible = isDisplayed

/** Why a step's target is missing, when the page can tell. */
function missingDetail(step: GuideStepPlan): GuideStepMissingDetail | undefined {
  if (step.complete.kind === 'gate') return 'gate_off'
  if (step.complete.kind === 'select' && selectionState(step.complete.selection) === 'empty') return 'selection_empty'
  if (unmetPredicates(step.requires).length > 0) return 'predicate_unmet'
  return step.target.kind === 'location' && liveTarget(step.target.id).status === 'ambiguous' ? 'ambiguous' : undefined
}

const sameRect = (a: GuideRect | null, b: GuideRect | null) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height)

/** Index of the LATEST earlier step whose own target is visible, or -1. */
export function latestVisibleEarlierStep(steps: readonly GuideStepPlan[] | undefined): number {
  if (!steps) return -1
  for (let i = steps.length - 1; i >= 0; i--) {
    if (isGuideTargetVisible(resolveGuideTarget(steps[i].target))) return i
  }
  return -1
}

export function useGuideStepTracker({
  stepId,
  step,
  enabled,
  recover = false,
  suppressMissing,
  reduceMotion,
  onObserved,
  onMissing,
  onFound,
  earlierSteps,
  onPreselected,
}: {
  /** Changes whenever the tracked step changes (guide, action, step). */
  stepId: string
  step: GuideStepPlan | null
  enabled: boolean
  /** The step's target went missing: watch for it to come back instead of
   *  tracking it. Seeing the target (or, for a `reach` step, a later target)
   *  reports `onFound` once; nothing is outlined and nothing goes missing. */
  recover?: boolean
  /** The committed save was submitted: absence now means "waiting", not missing. */
  suppressMissing: boolean
  reduceMotion: boolean
  /** Each report callback returns false when nothing was sent (a report is
   *  already in flight or accepted); that offer does not count as an attempt. */
  onObserved: () => boolean | void
  /** `detail` 'ambiguous': several copies of the target were shown at once;
   *  'predicate_unmet': a runtime predicate the target needs is unmet;
   *  'gate_off': a gate step's gate is off; 'selection_empty': a select
   *  step's picker has nothing to choose. */
  onMissing: (detail?: GuideStepMissingDetail) => boolean | void
  /** `resumeStepIndex` is set when an EARLIER step's target came back instead. */
  onFound?: (resumeStepIndex?: number) => boolean | void
  /** The current action's steps before this one, in order. */
  earlierSteps?: readonly GuideStepPlan[]
  /**
   * A select step whose pick was already made when its picker first reported
   * (nothing was ever seen unpicked): the step is held instead of completing
   * silently, its picker is pointed at, and this is called once so the panel
   * can ask the person to confirm the pick (its Next reports `observed`).
   */
  onPreselected?: () => void
}): GuideRect | null {
  const [rect, setRect] = useState<GuideRect | null>(null)
  const cb = useRef({ onObserved, onMissing, onFound, suppressMissing, earlierSteps, onPreselected })
  cb.current = { onObserved, onMissing, onFound, suppressMissing, earlierSteps, onPreselected }

  useEffect(() => {
    setRect(null)
    if (!enabled || !step) return
    let done = false
    let lastReport: number | null = null
    let reportAttempts = 0
    let missingSince: number | null = null
    let scrolled = false
    let frame = 0
    // A select step seen unpicked completes when the pick is made; one whose
    // pick was there from the first report is held for the person to confirm.
    let sawUnpicked = false
    let held = false
    const tick = () => {
      if (done) return
      let fact = factVerdict(step)
      if (!recover && step.complete.kind === 'select') {
        if (selectionState(step.complete.selection) === 'none') sawUnpicked = true
        if (fact === 'done' && !sawUnpicked && !held) {
          held = true
          cb.current.onPreselected?.()
        }
        if (held) fact = 'point'
      }
      if (recover) {
        // Back once the step is done or its target is drawn; a step whose
        // predicate is still unmet stays missing until the page says it holds.
        // A gate is back only once it is on; a select step once the pick is
        // made, or its picker has entries again and is drawn.
        const back = fact === 'done'
          || (fact === null && laterTargetVisible(step))
          || ((fact === null || fact === 'point')
            && isGuideTargetVisible(resolveGuideTarget(step.target)) && unmetPredicates(step.requires).length === 0)
        // Not this step, but an earlier one of the same action: the page came
        // back started over (a remounted form), so the guide follows it back.
        // A step the page's facts block (a gate off, an empty picker) stays
        // where it is: walking back to an earlier step would only block again.
        const earlier = back || fact === 'blocked' ? -1 : latestVisibleEarlierStep(cb.current.earlierSteps)
        if (!back && earlier < 0) return
        // The report can fail (network, a refused write): keep watching and
        // offer it again on a slower cadence, a bounded number of times. The
        // Provider de-duplicates while one is in flight or accepted.
        const now = Date.now()
        if (lastReport !== null && now - lastReport < GUIDE_FOUND_RETRY_MS) return
        // Only a report actually sent counts: one the Provider swallowed (the
        // previous is still in flight) must not use up an attempt, or the
        // tracker gives up while the Provider still thinks retries remain.
        if (cb.current.onFound?.(back ? undefined : earlier) === false) return
        lastReport = now
        reportAttempts += 1
        if (reportAttempts >= GUIDE_FOUND_MAX_ATTEMPTS) done = true
        return
      }
      // A gate or select step completes on the page's fact alone. A fact
      // that blocks (a gate off, an empty picker) is said after the short
      // settle; one no reporter knows yet waits the full bound.
      if (fact === 'done' || fact === 'blocked' || fact === 'waiting') {
        setRect(null)
        const now = Date.now()
        if (fact !== 'done') {
          if (missingSince === null) missingSince = now
          const bound = fact === 'blocked' ? GUIDE_EARLIER_STEP_WAIT_MS : GUIDE_TARGET_WAIT_MS
          if (now - missingSince < bound) return
        }
        if (lastReport !== null && now - lastReport < GUIDE_FOUND_RETRY_MS) return
        const sent = fact === 'done' ? cb.current.onObserved() : cb.current.onMissing(missingDetail(step))
        if (sent === false) return
        lastReport = now
        reportAttempts += 1
        if (reportAttempts >= GUIDE_FOUND_MAX_ATTEMPTS) done = true
        return
      }
      if (laterTargetVisible(step)) {
        setRect(null)
        // Offered again on the same bounded cadence as the other reports: a
        // failed write must not leave the guide a step behind the form.
        const now = Date.now()
        if (lastReport !== null && now - lastReport < GUIDE_FOUND_RETRY_MS) return
        if (cb.current.onObserved() === false) return
        lastReport = now
        reportAttempts += 1
        if (reportAttempts >= GUIDE_FOUND_MAX_ATTEMPTS) done = true
        return
      }
      const el = resolveGuideTarget(step.target)
      if (isGuideTargetVisible(el)) {
        missingSince = null
        if (!scrolled) {
          scrolled = true
          el.scrollIntoView?.({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' })
        }
        const r = el.getBoundingClientRect()
        const next = { top: r.top, left: r.left, width: r.width, height: r.height }
        setRect(prev => (sameRect(prev, next) ? prev : next))
        return
      }
      setRect(null)
      // A held pick needs no picker on screen: Next confirms it either way.
      if (held || cb.current.suppressMissing) { missingSince = null; return }
      const now = Date.now()
      // The control cannot be drawn: a predicate it needs is unmet. Nothing to
      // wait out beyond the short settle an earlier step gets.
      const blocked = unmetPredicates(step.requires).length > 0
      if (missingSince === null) missingSince = now
      else if (
        (blocked && now - missingSince >= GUIDE_EARLIER_STEP_WAIT_MS)
        || now - missingSince >= GUIDE_TARGET_WAIT_MS
        // The page already shows an earlier step of this action: it started
        // over, so there is nothing to wait out before recovering at it.
        || (now - missingSince >= GUIDE_EARLIER_STEP_WAIT_MS && latestVisibleEarlierStep(cb.current.earlierSteps) >= 0)
      ) {
        // Re-offered like a recovery: a failed write must not strand the
        // guide on a step the page no longer shows.
        if (lastReport !== null && now - lastReport < GUIDE_FOUND_RETRY_MS) return
        if (cb.current.onMissing(missingDetail(step)) === false) return
        lastReport = now
        reportAttempts += 1
        if (reportAttempts >= GUIDE_FOUND_MAX_ATTEMPTS) done = true
      }
    }
    const onMove = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(tick)
    }
    tick()
    const id = setInterval(tick, GUIDE_TRACK_TICK_MS)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      done = true
      clearInterval(id)
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
    // `stepId` names the step; `step` is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId, enabled, recover, reduceMotion])

  return rect
}
