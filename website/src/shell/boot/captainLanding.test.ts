import { describe, it, expect } from 'vitest'
import { firstRunLandsOnCaptain } from './captainLanding'

const fresh = { onboarded: false, hasCaptain: true, entry: '/chat' }

describe('firstRunLandsOnCaptain', () => {
  it('lands a fresh install on Captain when opened on the default landing', () => {
    expect(firstRunLandsOnCaptain(fresh)).toBe(true)
    expect(firstRunLandsOnCaptain({ ...fresh, entry: '/' })).toBe(true)
    expect(firstRunLandsOnCaptain({ ...fresh, entry: '/chat/' })).toBe(true)
    // A login token on the entry address is not a destination.
    expect(firstRunLandsOnCaptain({ ...fresh, entry: '/?token=abc' })).toBe(true)
  })

  it('leaves an onboarded user replaying the tour where they are', () => {
    expect(firstRunLandsOnCaptain({ ...fresh, onboarded: true })).toBe(false)
  })

  it('does nothing without Captain', () => {
    expect(firstRunLandsOnCaptain({ ...fresh, hasCaptain: false })).toBe(false)
  })

  it('never overrides a deep link or a popout/embed window', () => {
    expect(firstRunLandsOnCaptain({ ...fresh, entry: '/schedule' })).toBe(false)
    expect(firstRunLandsOnCaptain({ ...fresh, entry: '/chat/some-session' })).toBe(false)
    // A link to a named untitled session is a deep link too.
    expect(firstRunLandsOnCaptain({ ...fresh, entry: '/chat/new-session?sid=chat-1-7' })).toBe(false)
    expect(firstRunLandsOnCaptain({ ...fresh, entry: '/chat?slot=chat-2' })).toBe(false)
    // A sign-in link that carries a task opens that task.
    const tok = (claims: object) => `${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.sig`
    expect(firstRunLandsOnCaptain({ ...fresh, entry: `/chat?token=${tok({ sub: 'u' })}` })).toBe(true)
    expect(firstRunLandsOnCaptain({ ...fresh, entry: `/chat?token=${tok({ prompt: 'fix the build' })}` })).toBe(false)
    expect(firstRunLandsOnCaptain({ ...fresh, entry: `/chat?token=${tok({ session_key: 'slack:C1:1.2' })}` })).toBe(false)
    expect(firstRunLandsOnCaptain({ ...fresh, entry: `/?token=${tok({ channel: 'C1', thread_ts: '1.2' })}` })).toBe(false)
    expect(firstRunLandsOnCaptain({ ...fresh, isPopout: true })).toBe(false)
    expect(firstRunLandsOnCaptain({ ...fresh, isEmbed: true })).toBe(false)
  })
})
