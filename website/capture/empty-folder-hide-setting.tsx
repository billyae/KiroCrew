/**
 * Isolated capture entry for the global "Hide empty folders" setting (#16046).
 *
 * WHY ISOLATED: the subject is a folder a lane does NOT draw once the setting is on. On a
 * live gateway the frame would depend on that gateway's own sessions and folders, so the
 * one row whose absence is the evidence would differ per machine and per hour. Here the
 * population is one fixed session in one of two fixed folders, so "the empty folder is
 * gone" is a statement about the setting rather than about whoever's box took the picture.
 *
 * Nothing about the hide is stubbed: the setting is seeded in the same `mc-chat-config`
 * key the Settings toggle writes, the folders arrive over the same `/api/chat/folders`
 * read, and the REAL `ChatSidebar` decides every row.
 *
 * Query string: ?hide=1|0&theme=dark|light
 *   hide=1 turns the setting on; hide=0 (default) is the before frame — every install's
 *   current behaviour, both folders drawn.
 */
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { Provider } from 'react-redux'

import { initI18n } from '../src/i18n/all'
import { store } from '../src/store'
import { sseConnected, sseSlots } from '../src/store/dashboardSlice'
import { ThemeProvider } from '../src/hooks/useTheme'
import ChatSidebar from '../src/pages/ChatSidebar'
import type { ChatSlot } from '../src/types'
import '../src/index.css'

const params = new URLSearchParams(location.search)
const hideEmpty = params.get('hide') === '1'
const light = params.get('theme') === 'light'

/** The id the session's folder carries. The empty folder (`folder-empty`), which the
 *  setting removes, is served by the capture harness and never named here. */
const FULL = 'folder-full'

// ThemeProvider reads these and writes `data-theme` itself, so setting the attribute
// alone is overridden on mount. Both keys are pinned: the colour theme otherwise drifts
// with whatever the machine's gateway last stored.
localStorage.setItem('mc-theme', light ? 'light' : 'dark')
localStorage.setItem('mc-color-theme', 'kiro')
localStorage.setItem('mc-sidebar-lane', 'tree')
// THE input under test: the global setting the Settings toggle persists. Seeded rather
// than clicked — a click would have to open the Settings page, which is not the sidebar
// this frame is of.
localStorage.setItem('mc-chat-config', JSON.stringify({ hideEmptyFolders: hideEmpty }))
// Disable stale-collapse (<=0 short-circuits the stale split) so a settled row is never
// folded behind a "stale"/older expander — a folded row would read as a hidden folder,
// which is the exact thing this frame must show the difference of.
localStorage.setItem('mc-session-stale-collapse-ms', '0')
// Wide enough that no title is truncated.
localStorage.setItem('mc-sidebar-width', '520')

const now = Date.now()
const at = (msAgo: number) => new Date(now - msAgo).toISOString()

/**
 * One running session, filed in FULL. EMPTY holds nothing, so it is exactly the folder
 * the setting drops when it is on and keeps when it is off. `running` keeps the row in
 * the active group so the folder's body is visibly populated in the frame.
 */
const SLOTS = [
  {
    key: 'k-in-full', title: 'Working Session', agent: 'kirocrew',
    running: true, messages: 7, last_ts: at(5_000), modified: now, created: now - 60_000,
    folder_id: FULL, last_message: 'A folder that still holds work.',
  },
] as unknown as ChatSlot[]

function Harness() {
  useEffect(() => {
    store.dispatch(sseConnected())
    store.dispatch(sseSlots(SLOTS))
  }, [])
  return (
    <div className="flex h-screen bg-bg" data-capture-ready="">
      <ChatSidebar
        slots={SLOTS}
        activeSlot={null}
        unreadSlots={[]}
        history={[]}
        historyHasMore={false}
        defaultAgent="kirocrew"
        installedAgents={[{ name: 'kirocrew', source: 'builtin' }]}
      />
    </div>
  )
}

// The two folders (one empty, one holding the session above) are served over the real
// `/api/chat/folders` read by the capture harness's stub, so this fixture needs no
// folder seed of its own — the REAL ChatSidebar reads them through React Query.

initI18n()
createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  </Provider>,
)
