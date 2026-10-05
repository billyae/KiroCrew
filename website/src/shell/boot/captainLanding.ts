/**
 * Where a fresh install's first run ends: Captain's chat on the Crewmates page,
 * so a new user meets someone who can explain Kiro Crew instead of an empty
 * session. Kept apart from App so the rule is testable on its own.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { CAPTAIN_ROUTE } from '../../lib/captainHandoff'
import { extractPromptFromToken, extractSlackContextFromToken } from '../../utils/tokenPrompt'

/**
 * Whether the address the user OPENED the dashboard on is the default landing:
 * the root or the bare chat route, with no session named. It is read from the
 * entry address rather than the current one because first run itself moves the
 * page: the chat page rewrites `/chat` to its own empty session, and the tour
 * visits other pages, so the address at the end says nothing about where the
 * user meant to be. A named session (`sid`/`slot`) or any other page is a deep
 * link and never matches.
 */
function isDefaultEntry(entry: string): boolean {
  const url = new URL(entry, 'http://entry.invalid')
  if (url.searchParams.has('sid') || url.searchParams.has('slot')) return false
  // A sign-in link can carry a task (a prompt, or the session/thread it came
  // from); the chat page opens that task, so it is a deep link too. A token
  // that only signs in is not.
  const token = url.searchParams.get('token')
  if (token && tokenCarriesTask(token)) return false
  return /^\/(?:chat\/?)?$/.test(url.pathname)
}

function tokenCarriesTask(token: string): boolean {
  if (extractPromptFromToken(token)) return true
  const ctx = extractSlackContextFromToken(token)
  return !!(ctx.sessionKey || (ctx.channel && ctx.threadTs))
}

/**
 * Whether ending first run should move the user to Captain's chat. True only
 * for the FIRST completion (an onboarded user replaying the tour from Settings
 * stays where they are), when Captain exists, in the main window, and when the
 * dashboard was opened on the default landing (a deep link is never overridden).
 * `entry` is the path and query the dashboard was opened on.
 */
export function firstRunLandsOnCaptain(state: {
  onboarded: boolean
  hasCaptain: boolean
  entry: string
  isPopout?: boolean
  isEmbed?: boolean
}): boolean {
  if (state.onboarded || !state.hasCaptain) return false
  if (state.isPopout || state.isEmbed) return false
  return isDefaultEntry(state.entry)
}

/** sessionStorage key holding the address this tab's first run was opened on. */
const ENTRY_KEY = 'mc-first-run-entry'

/**
 * The address this tab's first run started on. Kept for the tab, not the mount:
 * a reload or a remounted shell (a sign-in or setup-check wall in front of the
 * app) mid-run would otherwise read the address first run itself moved to --
 * the chat page's own `/chat?sid=…` -- as a deep link, and the run would end on
 * that plain chat instead of Captain whichever control closed it.
 */
function firstRunEntry(current: string, onboarded: boolean): string {
  if (onboarded) return current
  try {
    const kept = sessionStorage.getItem(ENTRY_KEY)
    if (kept !== null) return kept
    sessionStorage.setItem(ENTRY_KEY, current)
  } catch {
    // Storage unavailable: this mount's own address is the best there is.
  }
  return current
}

/** Forget the kept first-run entry (first run is over, or a test starts clean). */
export function forgetFirstRunEntry(): void {
  try {
    sessionStorage.removeItem(ENTRY_KEY)
  } catch {
    // Nothing kept, nothing to forget.
  }
}

/**
 * The callback that ends first run: marks onboarding done and, when
 * `firstRunLandsOnCaptain` holds, opens Captain's chat. The entry address is
 * captured on the first render, before first run moves the page.
 *
 * `captainKnown` says whether the crew list that `hasCaptain` is read from has
 * answered yet. Every exit (Done, Skip all, Privacy's Continue) can be pressed
 * before it has on a cold start, and reading `hasCaptain: false` then as "no
 * Captain" dropped the user in a plain chat. So an exit taken while the list is
 * still loading holds the decision and lands once the list answers, unless the
 * user has moved somewhere else in the meantime (their own navigation wins).
 */
export function useFinishFirstRun(state: {
  onboarded: boolean
  hasCaptain: boolean
  captainKnown?: boolean
  isPopout?: boolean
  isEmbed?: boolean
  markOnboarded: () => void
}): () => void {
  const location = useLocation()
  const navigate = useNavigate()
  const navigationType = useNavigationType()
  const { onboarded, hasCaptain, captainKnown = true, isPopout, isEmbed, markOnboarded } = state
  const [entry] = useState(() => firstRunEntry(`${location.pathname}${location.search}`, onboarded))
  // Once first run is over (here, in another tab, or on the server's word) the
  // kept entry has served its purpose.
  useEffect(() => { if (onboarded) forgetFirstRunEntry() }, [onboarded])
  const here = `${location.pathname}${location.search}`
  // Whether a landing is pending: first run ended with the crew list still
  // loading. `moved` records that the USER went somewhere meanwhile; a REPLACE
  // is the page canonicalizing its own address (the chat page writing its
  // empty session's `?sid=`), not the user choosing a destination.
  const pending = useRef(false)
  const moved = useRef(false)
  const lastHere = useRef(here)
  useEffect(() => {
    if (here === lastHere.current) return
    lastHere.current = here
    if (pending.current && navigationType !== 'REPLACE') moved.current = true
  }, [here, navigationType])
  useEffect(() => {
    if (!pending.current || !captainKnown) return
    pending.current = false
    if (!moved.current && hasCaptain) navigate(CAPTAIN_ROUTE)
  }, [captainKnown, hasCaptain, here, navigate])
  return useCallback(() => {
    // Captain's presence is checked separately below, so it can wait for the list.
    const eligible = firstRunLandsOnCaptain({ onboarded, hasCaptain: true, entry, isPopout, isEmbed })
    markOnboarded()
    if (!eligible) return
    if (!captainKnown) {
      pending.current = true
      moved.current = false
      return
    }
    if (hasCaptain) navigate(CAPTAIN_ROUTE)
  }, [onboarded, hasCaptain, captainKnown, entry, isPopout, isEmbed, markOnboarded, navigate])
}
