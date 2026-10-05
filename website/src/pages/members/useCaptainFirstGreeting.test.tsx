import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../api/client', () => ({
  api: { memberGreet: vi.fn(() => Promise.resolve({ outcome: 'started' })) },
}))

import { api } from '../../api/client'
import { resetCaptainGreetingRequests, useCaptainFirstGreeting } from './useCaptainFirstGreeting'
import { store } from '../../store'
import { selectComposerBusy, selectSlotRunEpoch, sseChatMessage, startServerTurn } from '../../store/chatSlice'

/* The page-side trigger of Captain's first greeting. The server owns the
 * once-only guarantee; this hook only has to ask at the right moment (Captain,
 * confirmed thread) and not ask again for the same thread in this tab. */

const greet = api.memberGreet as ReturnType<typeof vi.fn>

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  vi.clearAllMocks()
  resetCaptainGreetingRequests()
})

describe('useCaptainFirstGreeting', () => {
  it('asks once the Captain thread is confirmed', async () => {
    renderHook(() => useCaptainFirstGreeting('kirocrew-captain', 'member-kirocrew-captain', true), { wrapper })
    await waitFor(() => expect(greet).toHaveBeenCalledWith('kirocrew-captain'))
    expect(greet).toHaveBeenCalledTimes(1)
  })

  it('never asks for another crewmate', async () => {
    renderHook(() => useCaptainFirstGreeting('alpha', 'member-alpha', false), { wrapper })
    await new Promise((r) => setTimeout(r, 0))
    expect(greet).not.toHaveBeenCalled()
  })

  it('waits for the confirmed slot key before asking', async () => {
    const { rerender } = renderHook(
      ({ slot }: { slot: string }) => useCaptainFirstGreeting('kirocrew-captain', slot, true),
      { wrapper, initialProps: { slot: '' } },
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(greet).not.toHaveBeenCalled()
    rerender({ slot: 'member-kirocrew-captain' })
    await waitFor(() => expect(greet).toHaveBeenCalledTimes(1))
  })

  it('does not ask again for the same thread after a remount in this tab', async () => {
    const first = renderHook(() => useCaptainFirstGreeting('kirocrew-captain', 'member-kirocrew-captain', true), { wrapper })
    await waitFor(() => expect(greet).toHaveBeenCalledTimes(1))
    first.unmount()
    renderHook(() => useCaptainFirstGreeting('kirocrew-captain', 'member-kirocrew-captain', true), { wrapper })
    await new Promise((r) => setTimeout(r, 0))
    expect(greet).toHaveBeenCalledTimes(1)
  })

  it('a failed request is reported for that thread and may be asked again', async () => {
    greet.mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useCaptainFirstGreeting('kirocrew-captain', 'member-kirocrew-captain', true), { wrapper })
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(greet).toHaveBeenCalledTimes(1)
    // The failure waits for the person: no re-ask on its own.
    await new Promise((r) => setTimeout(r, 0))
    expect(greet).toHaveBeenCalledTimes(1)
    act(() => result.current.retry())
    await waitFor(() => expect(greet).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.failed).toBe(false))
  })

  it('a failed request does not block the next open of the same thread', async () => {
    greet.mockRejectedValueOnce(new Error('offline'))
    const first = renderHook(() => useCaptainFirstGreeting('kirocrew-captain', 'member-kirocrew-captain', true), { wrapper })
    await waitFor(() => expect(first.result.current.failed).toBe(true))
    first.unmount()
    renderHook(() => useCaptainFirstGreeting('kirocrew-captain', 'member-kirocrew-captain', true), { wrapper })
    await waitFor(() => expect(greet).toHaveBeenCalledTimes(2))
  })

  it('a request that fails after the page unmounted does not block the next open', async () => {
    let reject: (e: Error) => void = () => {}
    greet.mockImplementationOnce(() => new Promise((_res, rej) => { reject = rej }))
    const first = renderHook(() => useCaptainFirstGreeting('kirocrew-captain', 'member-kirocrew-captain', true), { wrapper })
    await waitFor(() => expect(greet).toHaveBeenCalledTimes(1))
    first.unmount()
    await act(async () => { reject(new Error('offline')) })
    renderHook(() => useCaptainFirstGreeting('kirocrew-captain', 'member-kirocrew-captain', true), { wrapper })
    await waitFor(() => expect(greet).toHaveBeenCalledTimes(2))
  })

  it('reports no failure for another crewmate', () => {
    const { result } = renderHook(() => useCaptainFirstGreeting('alpha', 'member-alpha', false), { wrapper })
    expect(result.current.failed).toBe(false)
  })

  // The greeting turn writes nothing until the model speaks, so without this a
  // message sent meanwhile drew an optimistic bubble AND the server's queued
  // copy: the user's words twice, either side of the greeting.
  it('a started greeting makes the thread composer busy before any frame', async () => {
    const slot = 'member-kirocrew-captain-busy'
    expect(selectComposerBusy(store.getState(), slot)).toBe(false)
    renderHook(() => useCaptainFirstGreeting('kirocrew-captain', slot, true), { wrapper })
    await waitFor(() => expect(selectComposerBusy(store.getState(), slot)).toBe(true))
  })

  it('a declined greeting leaves the thread idle', async () => {
    greet.mockResolvedValueOnce({ outcome: 'not_empty' })
    const slot = 'member-kirocrew-captain-declined'
    renderHook(() => useCaptainFirstGreeting('kirocrew-captain', slot, true), { wrapper })
    await waitFor(() => expect(greet).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(selectComposerBusy(store.getState(), slot)).toBe(false)
  })
})

describe('startServerTurn', () => {
  it('ignores an answer older than a frame that already moved the run', () => {
    const slot = 'member-kirocrew-captain-stale'
    const epoch = selectSlotRunEpoch(store.getState(), slot)
    // The turn's first chunk and its `_done` both landed before the response.
    store.dispatch(sseChatMessage({ slot, role: 'chunk', content: 'Hi' } as never))
    store.dispatch(sseChatMessage({ slot, role: '_done', content: '' } as never))
    store.dispatch(startServerTurn({ slot, epoch }))
    expect(selectComposerBusy(store.getState(), slot)).toBe(false)
  })
})
