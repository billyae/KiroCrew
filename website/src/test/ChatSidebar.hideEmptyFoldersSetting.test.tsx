/**
 * The global "Hide empty folders" setting (ChatConfig.hideEmptyFolders), issue #16046.
 *
 * The per-folder `hidden` attribute and the filter-menu checkboxes let a person put
 * ONE folder away. This setting is the one toggle that drops EVERY folder whose subtree
 * holds no active session, off by default so an existing sidebar is unchanged.
 *
 * Both directions are asserted, because an implementation that hid every folder would
 * pass "the empty one is gone" on its own: a folder that still holds a session must
 * stay, and with the setting OFF every folder — empty or not — must render.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { createTestStore } from './helpers'
import { ThemeProvider } from '../hooks/useTheme'

// Render framer-motion elements as plain DOM (jsdom can't run projection).
vi.mock('framer-motion', async () => {
  const React = await import('react')
  const FRAMER_PROPS = new Set([
    'layout', 'layoutId', 'layoutScroll', 'initial', 'animate', 'exit',
    'transition', 'variants', 'whileHover', 'whileTap', 'whileInView',
    'drag', 'dragConstraints', 'dragElastic', 'onAnimationComplete',
  ])
  const make = (tag: string) =>
    React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
      const clean: Record<string, unknown> = {}
      for (const k of Object.keys(props)) {
        if (k === 'children') continue
        if (k === 'layoutId') { clean['data-layout-id'] = props[k]; continue }
        if (FRAMER_PROPS.has(k)) continue
        clean[k] = props[k]
      }
      return React.createElement(tag, { ...clean, ref }, props.children as React.ReactNode)
    })
  const motion = new Proxy({}, { get: (_t, tag: string) => make(tag) })
  return {
    motion,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    LayoutGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  }
})

vi.mock('../components/ProjectPicker', () => ({ default: () => null }))

vi.mock('../api/client', () => ({
  SEARCH_MIN_CHARS: 2,
  api: new Proxy({} as Record<string, unknown>, {
    get: () => vi.fn().mockResolvedValue([]),
  }),
}))

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })),
})

import ChatSidebar from '../pages/ChatSidebar'
import type { RootState } from '../store'
import type { ChatFolder, ChatSlot } from '../types'

const EMPTY_FOLDER = 'folder-empty'
const FULL_FOLDER = 'folder-full'

const FOLDERS: ChatFolder[] = [
  { id: EMPTY_FOLDER, name: 'empty folder', collapsed: false, order: 0 },
  { id: FULL_FOLDER, name: 'full folder', collapsed: false, order: 1 },
] as unknown as ChatFolder[]

// Only the full folder holds a session; the empty one is what the setting removes.
const SLOTS: ChatSlot[] = [
  { key: 'k-in-full', title: 'Session In Full', running: false, messages: 2, modified: 2000, folder_id: FULL_FOLDER },
] as unknown as ChatSlot[]

function renderSidebar() {
  const store = createTestStore({
    dashboard: {
      status: {}, connected: true, slots: SLOTS, approvalMode: 'normal',
      channelTrusted: false, refreshTrigger: 0, unreadSlots: [], updateProgress: null,
      slotsLoaded: true,
      subagentRunning: {}, subagentDetails: {}, subagentText: {},
      sessionDefaultColor: null, sessionColorsMode: 'tint', sessionColorsPalette: 'horizon', sessionColorsIntensity: 'clear',
    } as unknown as RootState['dashboard'],
    chat: { activeSlot: null, slotStatusDetail: {}, subagents: {}, slotActivity: {}, workflowRuns: {} } as unknown as RootState['chat'],
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false }, mutations: { retry: false } } })
  qc.setQueryData(['chat-folders'], FOLDERS)
  qc.setQueryData(['tag-columns'], [])
  return render(
    <QueryClientProvider client={qc}>
      <Provider store={store}>
        <ThemeProvider>
          <MemoryRouter>
            <ChatSidebar
              slots={SLOTS} activeSlot={null} unreadSlots={[]}
              history={[]} historyHasMore={false} defaultAgent="" installedAgents={[]}
            />
          </MemoryRouter>
        </ThemeProvider>
      </Provider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('mc-session-stale-collapse-ms', '0')
  localStorage.setItem('mc-sidebar-lane', 'tree')
})
afterEach(() => vi.clearAllMocks())

describe('ChatConfig.hideEmptyFolders — global hide of empty session folders', () => {
  it('renders both an empty and a non-empty folder when the setting is off (default)', () => {
    const { getByText } = renderSidebar()
    expect(getByText('empty folder')).toBeTruthy()
    expect(getByText('full folder')).toBeTruthy()
    expect(getByText('Session In Full')).toBeTruthy()
  })

  it('drops the empty folder but keeps the folder that still holds a session when on', () => {
    localStorage.setItem('mc-chat-config', JSON.stringify({ hideEmptyFolders: true }))
    const { queryByText, getByText } = renderSidebar()
    expect(
      queryByText('empty folder'),
      'the empty folder header should be gone with hideEmptyFolders on',
    ).toBeNull()
    // The folder that still holds a session is not empty, so it stays.
    expect(getByText('full folder')).toBeTruthy()
    expect(getByText('Session In Full')).toBeTruthy()
  })
})
