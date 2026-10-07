/**
 * Isolated capture entry for issue #3218: dashboard markdown links using editor
 * URL schemes (`idea://`, `vscode://`, `cursor://`) now open the editor via the
 * OS on a user click, instead of a CSP-refused dead in-frame navigation.
 *
 * WHY ISOLATED: the scene is "an assistant message contains an editor-scheme
 * link". The surface, the renderer, the sanitizer and the inline `ErrorNotice`
 * are all production code; only the desktop-shell bridge (`window.fileOpenAPI`,
 * which a plain browser does not expose) is stubbed, because that is the thing
 * under test and the capture page has no Electron main process behind it.
 *
 * Scenes (?scene=), each with ?theme=dark|light:
 *   allowed   the editor-scheme link is clicked and the stubbed bridge resolves
 *             {ok:true}: the link stays, no error — the editor opened. The
 *             accompanying `javascript:` link is rendered inert by the sanitizer
 *             (no anchor), showing the allowlist is fail-safe.
 *   blocked   the same link is clicked and the stubbed bridge returns
 *             {ok:false, error}: the inline ErrorNotice appears next to the
 *             link rather than a silent dead click (the #3218 GPT-review fix).
 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { initI18n } from '../src/i18n'
import { i18nT } from '../src/i18n/t'
import MarkdownRenderer from '../src/components/MarkdownRenderer'
import { SettingsToggle, SettingsSelect } from '../src/components/settings'
import '../src/index.css'

initI18n('en')

const params = new URLSearchParams(location.search)
const scene = params.get('scene') || 'allowed'
const theme = params.get('theme') || 'dark'
document.documentElement.setAttribute('data-theme', theme === 'light' ? 'kiro-light' : 'kiro-dark')

// The editor-link feature is OPT-IN, default off (#3218). These frames document
// both states. `?optin=off` leaves it default (main parity); otherwise it is
// enabled the way a user would — the Settings toggle writes this same
// `mc-chat-config` key, which the renderer reads live.
if (params.get('optin') !== 'off') {
  localStorage.setItem('mc-chat-config', JSON.stringify({ openEditorLinks: true }))
}

// Stub the desktop-shell bridge the renderer reaches through on a user click.
// `allowed` resolves ok (the editor opened); `blocked` returns the SAME internal
// code the real bridge returns when no OS handler is registered ('unavailable'),
// so the renderer runs its real friendly-error mapping rather than any copy
// written here. A plain browser never exposes this object, so its presence is
// exactly what the capture documents about the desktop shell. The click itself
// is driven by the capture script, not here.
;(window as unknown as { fileOpenAPI: { openExternalScheme: (u: string) => Promise<{ ok: boolean; error?: string }> } }).fileOpenAPI = {
  openExternalScheme: async () =>
    scene === 'blocked'
      ? { ok: false, error: 'unavailable' }
      : { ok: true },
}

// Two links in one message: an allowed editor scheme (clickable, routes to the
// OS) and a javascript: payload (stripped, so it renders as plain text with no
// anchor). The editor link's VISIBLE text names its target so the shot reads as
// a real transcript line.
const CONTENT = [
  'Open the failing test in your editor:',
  '',
  '[idea://open?file=/home/user/project/src/main.py&line=42](idea://open?file=/home/user/project/src/main.py&line=42)',
  '',
  'A javascript: link is not clickable:',
  '',
  '[javascript:alert(1)](javascript:alert(1))',
].join('\n')

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })

// Settings scene: the actual Settings → Chat toggle this PR adds, shown next to
// its real neighbours ("Simplified tool call names", "File change chips") so the
// UX reviewer can see the only control that turns the feature on, with its label
// and hint (#3218 UX evidence gap). Uses the production SettingsCard/Toggle/
// Select components with their real i18n keys; the toggle's state is local to
// the capture (?optin= drives whether it reads on or off).
function SettingsScene() {
  const on = params.get('optin') !== 'off'
  const [open, setOpen] = useState(on)
  return (
    <div style={{ maxWidth: 560, background: 'var(--surface, var(--bg))', padding: 16, borderRadius: 10 }}>
      <div className="text-[13px] font-semibold text-muted" style={{ marginBottom: 8 }}>Messages</div>
      <SettingsToggle
        label={i18nT('pages.settings.chatPanel.simplified_tool_call_names')}
        hint={i18nT('pages.settings.chatPanel.when_enabled_inline_tool_pills_show_simplified_t')}
        checked={true} onChange={() => {}}
      />
      <SettingsToggle
        label={i18nT('pages.settings.chatPanel.open_editor_links')}
        hint={i18nT('pages.settings.chatPanel.open_editor_links_desc')}
        checked={open} onChange={setOpen}
      />
      <SettingsSelect
        label={i18nT('pages.settings.chatPanel.file_change_chips')}
        hint={i18nT('pages.settings.chatPanel.how_file_diff_chips_appear_below_assistant_messa')}
        value={'expanded'} options={['expanded', 'minimal']}
        optionLabels={[i18nT('pages.settings.chatPanel.expanded_icon_name_stats'), i18nT('pages.settings.chatPanel.minimal_stats_only_name_on_hover')]}
        onChange={() => {}}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={qc}>
    <div
      style={{ background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh', padding: 24, maxWidth: 760 }}
      data-capture-root
    >
      {scene === 'settings' ? <SettingsScene /> : <MarkdownRenderer content={CONTENT} />}
    </div>
  </QueryClientProvider>,
)
