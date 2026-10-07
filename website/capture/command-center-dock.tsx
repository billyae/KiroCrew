/**
 * Isolated capture entry for the chat composer's Command Center dock
 * (`CommandCenterDock`), for issue #16250 — the dock's new Dismiss control.
 *
 * WHY ISOLATED: the dock lives above the chat composer and reads a team's work
 * through `useCommandCenter` (sessions, sub-agents, workflows, work items,
 * published views, pending questions and approvals). Standing up a gateway for
 * that is unnecessary: the dock's relevance comes from the Redux store, so a
 * seeded store with one running session plus one running sub-agent makes the
 * dock shown and not-settled, and the five read endpoints are stubbed empty so
 * nothing waits on the user. The REAL component renders — real Tailwind, real
 * theme tokens, the real overflow DropdownMenu.
 *
 * Scenes (the shoot script drives the menu + dismiss interactions):
 *   before   — the expanded dock above a mock composer: three tiles and the
 *              two-action control row (Open + overflow).
 *   menu     — the same, used by the shoot script after it opens the overflow
 *              menu, which holds Hide and Dismiss.
 *   dismissed— the same mount; the shoot script dismisses via the menu, leaving
 *              the composer with no dock above it (zero footprint).
 *
 * ?theme=dark|light&scene=before|menu|dismissed
 */
import { createRoot } from 'react-dom/client'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

import CommandCenterDock from '../src/pages/chat/command-center/CommandCenterDock'
import chatReducer from '../src/store/chatSlice'
import dashboardReducer from '../src/store/dashboardSlice'
import notificationsReducer from '../src/store/notificationsSlice'
import instancesReducer from '../src/store/instancesSlice'
import type { RootState } from '../src/store'
import { ThemeProvider } from '../src/hooks/useTheme'
import { initI18n } from '../src/i18n/all'
import '../src/index.css'

const params = new URLSearchParams(location.search)
const theme = params.get('theme') === 'light' ? 'light' : 'dark'
document.documentElement.setAttribute('data-theme', theme === 'light' ? 'kiro-light' : 'kiro-dark')

const SLOT = 'root'

// Empty answers for the five read endpoints the dock polls: nothing waits on the
// user, so the dock is shown for the WORK (the running session + sub-agent seeded
// in the store), never for an approval — which keeps the dismiss honest (a dismiss
// never applies while something needs the user).
const realFetch = window.fetch.bind(window)
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  if (url.includes('/api/ask-question/pending')) return ok([])
  if (url.includes('/api/approvals')) return ok([])
  if (url.includes('/api/workflows/runs')) return ok({ runs: [] })
  if (url.includes('/crew-log/projection/work')) return ok({ value: { items: [] } })
  if (url.includes('/api/artifacts')) return ok({ artifacts: [] })
  return realFetch(input as RequestInfo, init)
}) as typeof window.fetch

const store = configureStore({
  reducer: {
    dashboard: dashboardReducer,
    chat: chatReducer,
    notifications: notificationsReducer,
    instances: instancesReducer,
  },
  preloadedState: {
    dashboard: {
      connected: true,
      approvalMode: 'normal',
      slots: [{ key: SLOT, title: 'Build the upload endpoint', messages: 3, running: true }],
    } as unknown as RootState['dashboard'],
    chat: {
      activeSlot: SLOT,
      // One running sub-agent on the active slot — a non-session node, which is
      // what makes the dock relevant without anything waiting on the user.
      subagents: { 'sa-1': { id: 'sa-1', task: 'Add the rate-limit middleware', agent: 'kirocrew', status: 'running' } },
      slotActivity: {},
      workflowRuns: {},
    } as unknown as RootState['chat'],
  },
})

function MockComposer() {
  return (
    <div className="mx-auto w-full px-4" style={{ maxWidth: 'var(--mc-input-width, 900px)' }}>
      <div className="rounded-xl border border-border bg-card px-3 py-2.5 text-[13px] text-muted">
        Message Build the upload endpoint…
      </div>
    </div>
  )
}

function Scene() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <Provider store={store}>
        <ThemeProvider>
          <MemoryRouter>
            <div data-capture-root className="bg-bg text-text pt-10 pb-6" style={{ width: 720 }}>
              {/* The dock sits in the composer's own column, as in the chat. */}
              <CommandCenterDock key={SLOT} slot={SLOT} onOpen={() => {}} />
              <MockComposer />
            </div>
          </MemoryRouter>
        </ThemeProvider>
      </Provider>
    </QueryClientProvider>
  )
}

await initI18n()
createRoot(document.getElementById('root')!).render(<Scene />)
