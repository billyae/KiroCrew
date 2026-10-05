/**
 * Every way out of first run ends in Captain's chat.
 *
 * The chapters are stubbed down to their exits (the props App hands them), and
 * the real chapter sequencing (`useFirstRunChapters` + `FirstRunChapters`) and
 * the real finish path (`useFinishFirstRun`) are wired the way App wires them.
 * Which control closes the last surface must not decide where the user lands.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCallback, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'

vi.mock('../../components/AgentImportFlow', () => ({
  default: ({ initialOpen, onComplete, onSkipAll }: { initialOpen: boolean; onComplete: () => void; onSkipAll?: () => void }) =>
    initialOpen ? (
      <div>
        <button onClick={onComplete}>import-done</button>
        <button onClick={() => onSkipAll?.()}>import-skip-all</button>
      </div>
    ) : null,
}))
vi.mock('../../components/PrivacyChapter', () => ({
  default: ({ open, onContinue }: { open: boolean; onContinue: () => void }) =>
    open ? <button onClick={onContinue}>privacy-continue</button> : null,
}))
vi.mock('../../components/OnboardingFlow', () => ({
  default: ({ initialOpen, onComplete, onSkipAll }: { initialOpen: boolean; onComplete: () => void; onSkipAll?: () => void }) =>
    initialOpen ? (
      <div>
        <button onClick={onComplete}>tour-done</button>
        {/* "Skip all", a popover Skip and Escape all call onSkipAll. */}
        <button onClick={() => onSkipAll?.()}>tour-skip</button>
      </div>
    ) : null,
}))
vi.mock('../../components/OnboardingChapterShell', () => ({
  OnboardingShellHost: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { FirstRunChapters, useFirstRunChapters } from './firstRun'
import { forgetFirstRunEntry, useFinishFirstRun } from './captainLanding'
import { CAPTAIN_ROUTE } from '../../lib/captainHandoff'

let where = ''
let go: (to: string, replace?: boolean) => void = () => {}

/** App's wiring of first run, with useTheme's flags as plain state. */
function Harness({ captainKnown = true }: { captainKnown?: boolean }) {
  const [onboarded, setOnboarded] = useState(false)
  const [importOnboarded, setImportOnboarded] = useState(false)
  const [privacyAcked, setPrivacyAcked] = useState(false)
  const markOnboarded = useCallback(() => setOnboarded(true), [])
  const finish = useFinishFirstRun({ onboarded, hasCaptain: captainKnown, captainKnown, markOnboarded })
  const firstRun = useFirstRunChapters({ onboarded, importOnboarded, privacyAcked, themeBootReady: true, markOnboarded: finish })
  const location = useLocation()
  const navigate = useNavigate()
  where = `${location.pathname}${location.search}`
  go = (to, replace) => navigate(to, { replace })
  return (
    <FirstRunChapters
      firstRun={firstRun}
      onboarded={onboarded}
      privacyAcked={privacyAcked}
      markOnboarded={finish}
      markImportOnboarded={() => setImportOnboarded(true)}
      markPrivacyAcked={() => setPrivacyAcked(true)}
    />
  )
}

function open(entry = '/chat', props: { captainKnown?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Harness {...props} />
    </MemoryRouter>,
  )
}

const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

beforeEach(() => {
  localStorage.clear()
  forgetFirstRunEntry()
})

describe('every first-run exit lands in Captain', () => {
  it('Skip all in Import, then Privacy Continue', () => {
    open()
    // The chat page canonicalizes `/chat` to its own empty session meanwhile.
    act(() => go('/chat/new-session?sid=chat-1-1', true))
    press('import-skip-all')
    press('privacy-continue')
    expect(where).toBe(CAPTAIN_ROUTE)
  })

  it('Import done, Privacy Continue, then the tour Done', () => {
    open()
    press('import-done')
    press('privacy-continue')
    press('tour-done')
    expect(where).toBe(CAPTAIN_ROUTE)
  })

  it('Import done, Privacy Continue, then the tour skipped (Skip all, a popover Skip, Escape)', () => {
    open()
    press('import-done')
    press('privacy-continue')
    press('tour-skip')
    expect(where).toBe(CAPTAIN_ROUTE)
  })

  it('a shell remounted mid-run on the chat page\'s own address still lands', () => {
    const first = open()
    act(() => go('/chat/new-session?sid=chat-1-1', true))
    press('import-skip-all')
    // A sign-in or setup-check wall remounts the app on the rewritten address.
    first.unmount()
    open('/chat/new-session?sid=chat-1-1')
    // Privacy is still owed after the remount (its flag was never written).
    press('import-skip-all')
    press('privacy-continue')
    expect(where).toBe(CAPTAIN_ROUTE)
  })

  it('an exit before the crew list answers lands once it does, through the chat page\'s own rewrite', () => {
    const view = open('/chat', { captainKnown: false })
    press('import-skip-all')
    press('privacy-continue')
    act(() => go('/chat/new-session?sid=chat-1-1', true))
    view.rerender(
      <MemoryRouter initialEntries={['/chat']}>
        <Harness captainKnown />
      </MemoryRouter>,
    )
    expect(where).toBe(CAPTAIN_ROUTE)
  })

  it('a deep link the user opened is still never overridden', () => {
    open('/chat/new-session?sid=chat-9-9')
    press('import-skip-all')
    press('privacy-continue')
    expect(where).toBe('/chat/new-session?sid=chat-9-9')
  })
})
