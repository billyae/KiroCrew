/**
 * "N tabs were not restored" becomes pixels, and says nothing when it should not.
 *
 * A tab the gateway's startup restore lists and cannot show leaves no other trace a
 * person can see: the session is intact, nothing was closed and nothing was deleted,
 * so the sidebar simply has fewer rows than before the restart. The only way to
 * notice was to remember what used to be there.
 *
 * What this file pins is the discipline around that notice rather than its wording:
 * an unreported read is not a reported zero, a dismissal survives a reload of the
 * same browser tab but a LARGER loss still speaks up, and a read that throws cannot
 * take the chat pane down with it -- the notice sits on the transcript's render path,
 * so an escaping error there costs the user the conversation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const reads = vi.hoisted(() => ({ impl: vi.fn() }))
vi.mock('../api/client', () => ({
  api: { get chatSlotsUnrestored() { return reads.impl } },
  SEARCH_MIN_CHARS: 2,
}))

import { UnrestoredTabsNotice } from '../pages/chat/page/ChatPaneNotices'

const NOTICE = 'unrestored-tabs-notice'

describe('the unrestored-tabs notice', () => {
  beforeEach(() => {
    sessionStorage.clear()
    reads.impl = vi.fn()
  })

  it('names the count and offers the pane that can reopen them', async () => {
    reads.impl.mockResolvedValue({ reported: true, count: 16, keys: ['chat-1-a'] })
    render(<UnrestoredTabsNotice />)
    const notice = await screen.findByTestId(NOTICE)
    expect(notice.textContent).toContain('16')
    // The remedy is the pane that lists every session by name. The keys are still in
    // the reopen seed, so what the user needs now is identification, not a retry.
    expect(notice.querySelector('a')?.getAttribute('href')).toBe('/chat?history=1')
  })

  it('says nothing when the restore reports no drops', async () => {
    reads.impl.mockResolvedValue({ reported: true, count: 0, keys: [] })
    render(<UnrestoredTabsNotice />)
    await waitFor(() => expect(reads.impl).toHaveBeenCalled())
    expect(screen.queryByTestId(NOTICE)).toBeNull()
  })

  it('says nothing when the restore has not reported, which is not a reported zero', async () => {
    // Rendering an unreported read as "nothing was lost" would state as fact
    // something nobody has measured.
    reads.impl.mockResolvedValue({ reported: false, count: 0, keys: [] })
    render(<UnrestoredTabsNotice />)
    await waitFor(() => expect(reads.impl).toHaveBeenCalled())
    expect(screen.queryByTestId(NOTICE)).toBeNull()
  })

  it('stays dismissed for the same count and returns for a larger one', async () => {
    reads.impl.mockResolvedValue({ reported: true, count: 3, keys: [] })
    const first = render(<UnrestoredTabsNotice />)
    await screen.findByTestId(NOTICE)
    screen.getByLabelText(/dismiss/i).click()
    await waitFor(() => expect(screen.queryByTestId(NOTICE)).toBeNull())
    first.unmount()

    // Same count, same browser session: the user already answered.
    const again = render(<UnrestoredTabsNotice />)
    await waitFor(() => expect(reads.impl).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId(NOTICE)).toBeNull()
    again.unmount()

    // A later, larger loss is a different fact and must speak up.
    reads.impl.mockResolvedValue({ reported: true, count: 9, keys: [] })
    render(<UnrestoredTabsNotice />)
    expect((await screen.findByTestId(NOTICE)).textContent).toContain('9')
  })

  it('renders nothing when the read throws synchronously', async () => {
    // A cached bundle whose `api` predates this method, or a host supplying a
    // narrower one. The notice is a courtesy; it may not become an outage.
    reads.impl = vi.fn(() => { throw new TypeError('not a function') })
    expect(() => render(<UnrestoredTabsNotice />)).not.toThrow()
    await waitFor(() => expect(reads.impl).toHaveBeenCalled())
    expect(screen.queryByTestId(NOTICE)).toBeNull()
  })

  it('renders nothing when the read rejects', async () => {
    reads.impl.mockRejectedValue(new Error('offline'))
    render(<UnrestoredTabsNotice />)
    await waitFor(() => expect(reads.impl).toHaveBeenCalled())
    expect(screen.queryByTestId(NOTICE)).toBeNull()
  })
})
