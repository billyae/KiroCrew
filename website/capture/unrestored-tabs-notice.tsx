/**
 * Evidence for the "N tabs were not restored" notice on the chat pane.
 *
 * THE CHANGE: a tab the gateway's startup restore listed and could not rebuild
 * used to leave no trace a person could see. The session was intact, nothing was
 * closed and nothing was deleted, so the sidebar simply had fewer rows than
 * before the restart -- the only way to notice was to remember what used to be
 * there. This notice is that trace, and its link is the remedy.
 *
 * The scene mounts the REAL `UnrestoredTabsNotice` from `src/` against the real
 * stylesheet, theme tokens and live i18n catalog, so the band in the frame is
 * the component's own render and its sentence comes from the catalog through
 * `i18nT` -- a frame also proves the new plural keys resolve. Nothing here
 * re-implements the notice, its classes or its strings.
 *
 * `fetch` is stubbed rather than the api module so the component's real arrival
 * read runs and answers exactly what the new endpoint answers.
 *
 *   ?theme=dark|light&count=<n>
 */
import { createRoot } from 'react-dom/client'

import { UnrestoredTabsNotice } from '../src/pages/chat/page/ChatPaneNotices'
import { initI18n } from '../src/i18n'
import '../src/index.css'

const params = new URLSearchParams(location.search)
const theme = params.get('theme') === 'light' ? 'light' : 'dark'
const count = Number(params.get('count') || '16')

document.documentElement.setAttribute('data-theme', theme === 'light' ? 'kiro-light' : 'kiro-dark')

// A dismissal is remembered per count, so a stale one from an earlier frame in
// the same browser would silence the next shot.
try { sessionStorage.clear() } catch { /* ignore */ }

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.includes('/api/chat/slots/unrestored')) {
    // Verbatim the shipped response shape, including `reported` -- the field that
    // separates "no tabs were dropped" from "the restore has not answered yet".
    return Promise.resolve(
      json({
        reported: true,
        count,
        keys: Array.from({ length: count }, (_, i) => `chat-${i + 1}-tab`),
      }),
    )
  }
  if (url.includes('/api/')) return Promise.resolve(json({}))
  return realFetch(input, init)
}) as typeof globalThis.fetch

initI18n('en')

createRoot(document.getElementById('root')!).render(
  // The width the chat pane gives its notices, and the pane's own `mx-4` gutter
  // is the component's, so the frame shows the band at its shipped inset.
  <div data-capture-root className="bg-bg text-text w-[900px] py-4">
    <UnrestoredTabsNotice />
  </div>,
)
