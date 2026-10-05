import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { forgetFirstRunEntry, useFinishFirstRun } from './captainLanding'
import { CAPTAIN_ROUTE } from '../../lib/captainHandoff'

/** Render the hook on a router opened at `entry`; also expose navigation so a
 *  test can move the page the way first run does before it ends. */
function setup(entry: string, overrides: Partial<{ onboarded: boolean; hasCaptain: boolean }> = {}) {
  const markOnboarded = vi.fn()
  const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
  const { result } = renderHook(
    () => ({
      finish: useFinishFirstRun({ onboarded: false, hasCaptain: true, markOnboarded, ...overrides }),
      navigate: useNavigate(),
      location: useLocation(),
    }),
    { wrapper },
  )
  const here = () => `${result.current.location.pathname}${result.current.location.search}`
  return { result, markOnboarded, here }
}

// The first-run entry is kept for the TAB (sessionStorage); each test is a new tab.
beforeEach(() => forgetFirstRunEntry())

describe('useFinishFirstRun', () => {
  it('lands on Captain even after the chat page and the tour moved the page', () => {
    const { result, markOnboarded, here } = setup('/chat')
    // The chat page canonicalizes to its own empty session, then the tour visits Schedule.
    act(() => result.current.navigate('/chat/new-session?sid=chat-1-1'))
    act(() => result.current.navigate('/schedule'))
    act(() => result.current.finish())
    expect(markOnboarded).toHaveBeenCalledTimes(1)
    expect(here()).toBe(CAPTAIN_ROUTE)
  })

  it('leaves an explicit session link where it is', () => {
    const { result, markOnboarded, here } = setup('/chat/new-session?sid=chat-9-9')
    act(() => result.current.finish())
    expect(markOnboarded).toHaveBeenCalledTimes(1)
    expect(here()).toBe('/chat/new-session?sid=chat-9-9')
  })

  it('leaves an onboarded user replaying the tour where they are', () => {
    const { result, here } = setup('/chat', { onboarded: true })
    act(() => result.current.navigate('/settings'))
    act(() => result.current.finish())
    expect(here()).toBe('/settings')
  })

  /** A first run that ends while the crew list (where hasCaptain comes from) is still loading. */
  function setupLoading(entry: string) {
    const markOnboarded = vi.fn()
    const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
    const { result, rerender } = renderHook(
      ({ known, has }: { known: boolean; has: boolean }) => ({
        finish: useFinishFirstRun({ onboarded: false, hasCaptain: has, captainKnown: known, markOnboarded }),
        navigate: useNavigate(),
        location: useLocation(),
      }),
      { wrapper, initialProps: { known: false, has: false } },
    )
    const here = () => `${result.current.location.pathname}${result.current.location.search}`
    return { result, rerender, markOnboarded, here }
  }

  it('lands on Captain when Skip all is pressed before the crew list has loaded', () => {
    const { result, rerender, markOnboarded, here } = setupLoading('/chat')
    act(() => result.current.navigate('/chat/new-session?sid=chat-1-1'))
    act(() => result.current.finish())
    expect(markOnboarded).toHaveBeenCalledTimes(1)
    // Nothing decided yet: "not loaded" is not "no Captain".
    expect(here()).toBe('/chat/new-session?sid=chat-1-1')
    rerender({ known: true, has: true })
    expect(here()).toBe(CAPTAIN_ROUTE)
  })

  it('stays put when the list answers without a Captain', () => {
    const { result, rerender, here } = setupLoading('/chat')
    act(() => result.current.finish())
    rerender({ known: true, has: false })
    expect(here()).toBe('/chat')
  })

  it('does not pull the user back once they navigated while the list was loading', () => {
    const { result, rerender, here } = setupLoading('/chat')
    act(() => result.current.finish())
    act(() => result.current.navigate('/schedule'))
    rerender({ known: true, has: true })
    expect(here()).toBe('/schedule')
  })
})
