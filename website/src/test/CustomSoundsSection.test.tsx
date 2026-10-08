import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render as rtlRender, fireEvent, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NotificationsPanel } from '../pages/settings/NotificationsPanel'
import { parseToneText } from '../pages/settings/CustomSoundsSection'
import { __resetForTests, playPreset, loadSoundSettings, customSoundId } from '../hooks/useNotificationSound'

vi.mock('../hooks/useNotificationSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useNotificationSound')>()
  return { ...actual, playPreset: vi.fn() }
})

const STORAGE_KEY = 'mc-notification-sound'

function render(sub: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return rtlRender(
    <MemoryRouter initialEntries={[`/settings?tab=notifications&sub=${sub}`]}>
      <QueryClientProvider client={qc}><NotificationsPanel /></QueryClientProvider>
    </MemoryRouter>,
  )
}

const addSound = (name: string, tones: string) => {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('Tones'), { target: { value: tones } })
  fireEvent.click(screen.getByRole('button', { name: 'Add sound' }))
}

beforeEach(() => {
  localStorage.clear()
  __resetForTests()
  vi.mocked(playPreset).mockClear()
})

describe('Custom sounds settings', () => {
  it('parses the shorthand from the request as data', () => {
    expect(parseToneText('[{freq:523, start:0, dur:.2, gain:1}]')).toEqual([{ freq: 523, start: 0, dur: 0.2, gain: 1 }])
    expect(parseToneText('[{"freq":523,"start":0,"dur":0.2,"gain":1}]')).toEqual([{ freq: 523, start: 0, dur: 0.2, gain: 1 }])
    expect(parseToneText('alert(1)')).toBeUndefined()
  })

  it('adds a named sound, lists it, and offers it in the per-category picker', () => {
    const { unmount } = render('custom')
    addSound('myAlert', '[{freq:523, start:0, dur:.2, gain:1}, {freq:784, start:.2, dur:.3, gain:.9}]')
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(stored.customTones.myAlert).toHaveLength(2)
    const list = screen.getByRole('list', { name: 'Custom sounds' })
    expect(within(list).getByText('myAlert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Play myAlert' }))
    expect(vi.mocked(playPreset).mock.calls[0][0]).toBe(customSoundId('myAlert'))
    unmount()

    // A category set to the custom sound shows it by its own name.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stored, perCategory: { all: customSoundId('myAlert') } }))
    const { container } = render('percategory')
    expect(container.textContent).toContain('myAlert')
  })

  it('shows the problem and saves nothing when a bound is broken', () => {
    render('custom')
    addSound('loud', '[{freq:523, start:0, dur:.2, gain:5}]')
    expect(screen.getByText(/gain must be above 0/)).toBeTruthy()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    addSound('chime', '[{freq:523, start:0, dur:.2, gain:1}]')
    expect(screen.getByText(/already used/)).toBeTruthy()
    addSound('x', 'not a list')
    expect(screen.getByText(/written like the example/)).toBeTruthy()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('deleting a sound clears the categories that used it', () => {
    const tones = [{ freq: 523, start: 0, dur: 0.2, gain: 1 }]
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      customTones: { mine: tones },
      perCategory: { all: customSoundId('mine'), cron: customSoundId('mine'), hook: 'ding' },
    }))
    render('custom')
    fireEvent.click(screen.getByRole('button', { name: 'Delete mine' }))
    const s = loadSoundSettings()
    expect(s.customTones).toBeUndefined()
    expect(s.perCategory).toEqual({ all: 'chime', hook: 'ding' })
    expect(screen.getByText('No custom sounds yet.')).toBeTruthy()
  })
})
