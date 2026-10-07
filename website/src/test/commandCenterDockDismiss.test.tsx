// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { createTestStore, renderWithProviders } from './helpers'
import { api } from '../api/client'
import CommandCenterDock from '../pages/chat/command-center/CommandCenterDock'
import { __resetSettledLatchesForTests } from '../pages/chat/command-center/useCommandCenter'
import type { Artifact } from '../types'

const artifact = (slug: string, session: string): Artifact => ({
  slug, session_key: session, name: slug, kind: 'html', source: 'chat', description: '',
  tags: ['task-dashboard'], version: 1, created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z', content: '<h1>view</h1>',
})

// A running session plus a published task-dashboard view: `relevant` is true and
// the task is not settled, so the dock is shown. Each view's slug is one id in the
// dock's activity set, so adding one is "new activity" and removing one is work
// aging out.
function store() {
  const initial = createTestStore().getState()
  return createTestStore({ ...initial, dashboard: { ...initial.dashboard, connected: true, slots: [
    { key: 'root', title: 'Conductor', messages: 0, running: true },
  ] } })
}

const dock = () => screen.queryByTestId('command-center-dock')
async function openMenu() {
  // Radix opens on keyboard activation in jsdom (no pointer events there).
  fireEvent.keyDown(await screen.findByRole('button', { name: 'More actions' }), { key: 'Enter' })
}
async function clickDismiss() {
  await openMenu()
  fireEvent.click(await screen.findByText('Dismiss until new activity'))
}

describe('command center dock — dismiss control', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    __resetSettledLatchesForTests()
    localStorage.clear()
    vi.spyOn(api, 'pendingQuestions').mockResolvedValue([])
    vi.spyOn(api, 'approvals').mockResolvedValue([])
    vi.spyOn(api, 'workflowRuns').mockResolvedValue({ runs: [] })
    vi.spyOn(api, 'sessionWorkProjection').mockResolvedValue({ value: { items: [] } })
    vi.spyOn(api, 'artifacts').mockResolvedValue({ artifacts: [artifact('plan', 'root')] })
  })

  it('dismiss (via the overflow menu) removes the dock entirely, leaving no pill and no layout', async () => {
    renderWithProviders(<CommandCenterDock slot="root" onOpen={() => {}} />, { store: store() })
    await waitFor(() => expect(dock()).toBeInTheDocument())
    // Hide and Dismiss are both in the overflow menu, each with its own text label.
    await openMenu()
    expect(await screen.findByText('Hide status tiles')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Dismiss until new activity'))
    await waitFor(() => expect(dock()).not.toBeInTheDocument())
  })

  it('a dismissal persists across a remount while the same work is on screen', async () => {
    const shared = store()
    const first = renderWithProviders(<CommandCenterDock slot="root" onOpen={() => {}} />, { store: shared })
    await waitFor(() => expect(dock()).toBeInTheDocument())
    await clickDismiss()
    await waitFor(() => expect(dock()).not.toBeInTheDocument())
    const callsAtDismiss = vi.mocked(api.artifacts).mock.calls.length
    first.unmount()
    // Fresh mount, fresh QueryClient: wait for the remount's OWN artifacts read to
    // land (call count past the first mount's) as a positive signal, then assert
    // the dock stayed dismissed — no bare microtask barrier before an absence.
    renderWithProviders(<CommandCenterDock slot="root" onOpen={() => {}} />, { store: shared })
    await waitFor(() => expect(vi.mocked(api.artifacts).mock.calls.length).toBeGreaterThan(callsAtDismiss))
    await act(async () => { await Promise.resolve() })
    expect(dock()).not.toBeInTheDocument()
  })

  it('re-arms when genuinely new activity appears (a new id in the live set)', async () => {
    const { queryClient } = renderWithProviders(<CommandCenterDock slot="root" onOpen={() => {}} />, { store: store() })
    await waitFor(() => expect(dock()).toBeInTheDocument())
    await clickDismiss()
    await waitFor(() => expect(dock()).not.toBeInTheDocument())
    // A new published view is an id the dismissal was not taken against.
    vi.mocked(api.artifacts).mockResolvedValue({ artifacts: [artifact('plan', 'root'), artifact('timeline', 'root')] })
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['command-center', 'artifacts'] }) })
    await waitFor(() => expect(dock()).toBeInTheDocument())
  })

  it('stays dismissed when work merely ages out (no new id appears)', async () => {
    // Two views on screen at dismiss time.
    vi.mocked(api.artifacts).mockResolvedValue({ artifacts: [artifact('plan', 'root'), artifact('timeline', 'root')] })
    const { queryClient } = renderWithProviders(<CommandCenterDock slot="root" onOpen={() => {}} />, { store: store() })
    await waitFor(() => expect(dock()).toBeInTheDocument())
    await clickDismiss()
    await waitFor(() => expect(dock()).not.toBeInTheDocument())
    // One of them ages out — the live set only SHRINKS, so no new id appeared.
    vi.mocked(api.artifacts).mockResolvedValue({ artifacts: [artifact('plan', 'root')] })
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['command-center', 'artifacts'] }) })
    await act(async () => { await Promise.resolve() })
    expect(dock()).not.toBeInTheDocument()
  })

  it('never hides the dock while something waits on the user (fail-safe)', async () => {
    const { queryClient } = renderWithProviders(<CommandCenterDock slot="root" onOpen={() => {}} />, { store: store() })
    await waitFor(() => expect(dock()).toBeInTheDocument())
    await clickDismiss()
    await waitFor(() => expect(dock()).not.toBeInTheDocument())
    // An approval arrives for the same work: a dismiss must not bury it.
    vi.mocked(api.approvals).mockResolvedValue([
      { id: 'r1', slot: 'root', tool: 'shell', tool_input: 'git status' },
    ])
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['global-approvals'] }) })
    await waitFor(() => expect(dock()).toBeInTheDocument())
  })
})
