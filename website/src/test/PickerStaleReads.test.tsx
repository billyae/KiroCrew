import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, act, waitFor } from '@testing-library/react'
import { defaultScheduler, notifyManager } from '@tanstack/react-query'
import { renderWithProviders } from './helpers'
import WorkspacePicker from '../components/WorkspacePicker'
import ProjectPicker from '../components/ProjectPicker'
import { api } from '../api/client'
import { ApiError } from '../api/apiError'

/**
 * Regression cover for the useQuery migration (#14731). The pickers used to bound their reads
 * with hand-rolled `listingSeq` / `recentSeq` tickets and an `inputEdits` edit counter; those are
 * gone, replaced by react-query keyed on a per-request generation plus `retiredGenRef` /
 * `editedGenRef` guards. react-query notifies observers on a BATCHED scheduler, which the picker
 * suites' fake timers do not flush deterministically, so a late read's landing is invisible to a
 * synchronous assertion there. These tests pin the scheduler to `queueMicrotask` so a late
 * SUCCESS or FAILURE really is delivered to the observer, and assert the guards drop it: the
 * behaviour the retired-ticket model used to give, which code review (#14731) flagged as
 * otherwise untested after the migration.
 */

type R = Awaited<ReturnType<typeof api.browseDirs>>
const WS_DIRS = [{ name: 'alpha', path: '/home/u/alpha' }, { name: 'beta', path: '/home/u/beta' }]
const wsRes = (path = '/home/u', parent = '/home', dirs = WS_DIRS): R => ({ path, parent, dirs })
const timeout = () => Object.assign(new Error('deadline exceeded'), { name: 'TimeoutError' })

const rect = (top: number, left: number, width = 80, height = 24): DOMRect => ({
  top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}),
} as DOMRect)

let anchor: HTMLButtonElement
let anchorRef: { current: HTMLElement | null }

beforeEach(() => {
  // Deliver react-query's observer notifications on the microtask queue so an awaited `act`
  // flushes a late read's landing; the default batched scheduler does not under this harness.
  notifyManager.setScheduler(queueMicrotask)
  anchor = document.createElement('button')
  document.body.appendChild(anchor)
  anchorRef = { current: anchor }
  Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true })
})

afterEach(() => {
  notifyManager.setScheduler(defaultScheduler)
  anchor.remove()
  vi.restoreAllMocks()
})

describe('WorkspacePicker: a late read that the user has moved past does not land', () => {
  function render() {
    return renderWithProviders(
      <WorkspacePicker open={true} onOpenChange={vi.fn()} anchorRef={anchorRef} onCreated={vi.fn()} />,
    )
  }

  it('a keystroke over an in-flight drill drops that drill\'s late FAILURE (notice never names the replaced path)', async () => {
    let failDrill!: (reason: unknown) => void
    vi.spyOn(api, 'browseDirs')
      .mockResolvedValueOnce(wsRes())
      .mockReturnValueOnce(new Promise<R>((_resolve, reject) => { failDrill = reject }))
    render()
    await screen.findByText('alpha')

    fireEvent.click(screen.getByText('alpha'))                 // drill /home/u/alpha, in flight
    fireEvent.change(screen.getByLabelText('Project directory path'), { target: { value: '/home/u/beta' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await act(async () => { failDrill(timeout()) })            // the typed-over drill fails late
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Project directory path')).toHaveValue('/home/u/beta')
  })

  it('a keystroke over the in-flight drill keeps its late SUCCESS rows but leaves the typed path alone', async () => {
    let landDrill!: (value: R) => void
    vi.spyOn(api, 'browseDirs')
      .mockResolvedValueOnce(wsRes())
      .mockReturnValueOnce(new Promise<R>(resolve => { landDrill = resolve }))
    render()
    await screen.findByText('alpha')

    fireEvent.click(screen.getByText('alpha'))
    fireEvent.change(screen.getByLabelText('Project directory path'), { target: { value: '/home/u/alpha/x' } })
    await act(async () => {
      landDrill(wsRes('/home/u/alpha', '/home/u', [{ name: 'child', path: '/home/u/alpha/child' }]))
    })
    // Rows landed; the typed path is untouched and filters them.
    expect(screen.getByLabelText('Project directory path')).toHaveValue('/home/u/alpha/x')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('WorkspacePicker: an older listing that resolves after a newer one must not win', () => {
  function render() {
    return renderWithProviders(
      <WorkspacePicker open={true} onOpenChange={vi.fn()} anchorRef={anchorRef} onCreated={vi.fn()} />,
    )
  }

  it('resolving drill A after drill B shows B\'s entries and never A\'s', async () => {
    let landA!: (value: R) => void
    let landB!: (value: R) => void
    vi.spyOn(api, 'browseDirs')
      .mockResolvedValueOnce(wsRes())                                             // opening read
      .mockReturnValueOnce(new Promise<R>(resolve => { landA = resolve }))        // drill A (alpha)
      .mockReturnValueOnce(new Promise<R>(resolve => { landB = resolve }))        // drill B (beta)
    render()
    await screen.findByText('alpha')

    fireEvent.click(screen.getByText('alpha'))                                    // start A
    fireEvent.click(screen.getByText('beta'))                                     // switch to B
    // B resolves first, then the older A resolves after it; A must never replace B.
    await act(async () => { landB(wsRes('/home/u/beta', '/home/u', [{ name: 'from-B', path: '/home/u/beta/from-B' }])) })
    expect(await screen.findByText('from-B')).toBeInTheDocument()
    await act(async () => { landA(wsRes('/home/u/alpha', '/home/u', [{ name: 'from-A', path: '/home/u/alpha/from-A' }])) })

    await waitFor(() => expect(screen.getByText('from-B')).toBeInTheDocument())
    expect(screen.queryByText('from-A')).not.toBeInTheDocument()
  })
})

describe('ProjectPicker: an older read that resolves after a newer one must not win', () => {
  const home: R = { path: '/home/u', parent: '/home', dirs: [{ name: 'a', path: '/home/u/a' }, { name: 'b', path: '/home/u/b' }] }
  function render() {
    vi.spyOn(api, 'recentProjects').mockResolvedValue({ dirs: [] })
    return renderWithProviders(
      <ProjectPicker open={true} onOpenChange={vi.fn()} anchorRect={rect(100, 50)} onSelect={vi.fn()} />,
    )
  }

  it('resolving drill A after drill B shows B\'s entries and never A\'s', async () => {
    let landA!: (value: R) => void
    let landB!: (value: R) => void
    vi.spyOn(api, 'browseDirs')
      .mockResolvedValueOnce(home)                                               // opening read
      .mockReturnValueOnce(new Promise<R>(resolve => { landA = resolve }))       // drill A (a)
      .mockReturnValueOnce(new Promise<R>(resolve => { landB = resolve }))       // drill B (b)
    render()
    fireEvent.click(await screen.findByRole('option', { name: /^a$/ }))           // start A
    fireEvent.click(screen.getByRole('option', { name: /^b$/ }))                  // switch to B

    await act(async () => { landB({ path: '/home/u/b', parent: '/home/u', dirs: [{ name: 'from-B', path: '/home/u/b/from-B' }] }) })
    expect(await screen.findByRole('option', { name: /from-B/ })).toBeInTheDocument()
    await act(async () => { landA({ path: '/home/u/a', parent: '/home/u', dirs: [{ name: 'from-A', path: '/home/u/a/from-A' }] }) })

    await waitFor(() => expect(screen.getByRole('option', { name: /from-B/ })).toBeInTheDocument())
    expect(screen.queryByRole('option', { name: /from-A/ })).not.toBeInTheDocument()
  })
})

describe('ProjectPicker: a late read the user typed over does not land its failure', () => {
  const home: R = { path: '/home/u', parent: '/home', dirs: [{ name: 'slow', path: '/home/u/slow' }] }
  function render() {
    vi.spyOn(api, 'recentProjects').mockResolvedValue({ dirs: [] })
    return renderWithProviders(
      <ProjectPicker open={true} onOpenChange={vi.fn()} anchorRect={rect(100, 50)} onSelect={vi.fn()} />,
    )
  }

  it('a keystroke over an in-flight drill drops its late FAILURE, so the typed path stays committable', async () => {
    let failDrill!: (reason: unknown) => void
    vi.spyOn(api, 'browseDirs')
      .mockResolvedValueOnce(home)
      .mockReturnValueOnce(new Promise<R>((_resolve, reject) => { failDrill = reject }))
    render()
    fireEvent.click(await screen.findByRole('option', { name: /slow/ }))      // drill /home/u/slow, in flight
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '/home/u/other' } })

    await act(async () => { failDrill(timeout()) })
    // No notice for the replaced path, and the typed path is still committable (Select enabled).
    expect(screen.queryByTestId('pp-listing-error')).toBeNull()
    await waitFor(() => expect((screen.getByRole('button', { name: 'Select' }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('typing during a deleted-startPath opening read: the $HOME fallback keeps the typed field and raises no carried notice', async () => {
    const notFound = () => new ApiError(400, 'not a directory', JSON.stringify({ error: 'gone', code: 'not_a_directory', path: '/home/u/gone' }))
    let failOpening!: (reason: unknown) => void
    vi.spyOn(api, 'browseDirs')
      // opening read of the deleted startPath, held so the user can type over it
      .mockReturnValueOnce(new Promise<R>((_resolve, reject) => { failOpening = reject }))
      // the $HOME fallback the homeOnGone branch issues
      .mockResolvedValueOnce(home)
    vi.spyOn(api, 'recentProjects').mockResolvedValue({ dirs: [] })
    renderWithProviders(
      <ProjectPicker open={true} onOpenChange={vi.fn()} anchorRect={rect(100, 50)} onSelect={vi.fn()} startPath="/home/u/gone" />,
    )
    const combo = await screen.findByRole('combobox')
    fireEvent.change(combo, { target: { value: '/home/u/ty' } })               // type over the opening read
    await act(async () => { failOpening(notFound()) })                          // opening read is gone -> $HOME fallback
    // The fallback ($HOME) landed under a preserved field, so the typed text stands and the
    // carried "gone" refusal does NOT come back (it would re-raise a notice the keystroke cleared
    // and disable Select for the typed path). The $HOME rows are hidden only by the typed filter.
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('/home/u/ty'))
    expect(screen.queryByTestId('pp-listing-error')).toBeNull()
    // Clearing the filter reveals the $HOME listing the fallback actually loaded.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '/home/u' } })
    expect(await screen.findByText('slow')).toBeInTheDocument()
  })
})
