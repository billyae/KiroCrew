/**
 * Evidence for the shipped Settings → Chat → Sessions "Hide Empty Folders" toggle
 * (#16046) — the control the sidebar frames cannot show, which the UX review needs to
 * verify against its help text.
 *
 * Mounts the REAL `SettingsToggle` with the SAME label/hint props the shipped
 * `ChatPanel` passes — read live from the i18n catalog
 * (pages.settings.chatPanel.hide_empty_folders[/...]) — against the real stylesheet and
 * theme tokens, beside the existing "Compact Empty Folders" row so the relationship is
 * visible. The hint strings (an InfoTip in production) are rendered as a permanent
 * `description` here so the frame shows the wording the toggle explains. The two rows
 * mirror the shipped order and the disable-when-on behaviour: with the setting ON,
 * "Compact Empty Folders" is disabled because an empty folder is already gone.
 *
 * Query string: ?theme=dark|light&on=1  (on=1 renders "Hide Empty Folders" checked, which
 * disables "Compact Empty Folders").
 */
import { createRoot } from 'react-dom/client'
import { SettingsToggle } from '../src/components/settings'
import { initI18n } from '../src/i18n/all'
import { i18nT } from '../src/i18n/t'
import '../src/index.css'

const params = new URLSearchParams(location.search)
const theme = params.get('theme') === 'light' ? 'light' : 'dark'
const on = params.get('on') === '1'
document.documentElement.setAttribute('data-theme', theme === 'light' ? 'kiro-light' : 'kiro-dark')

await initI18n()

createRoot(document.getElementById('root')!).render(
  <div
    data-capture-root
    style={{
      width: 680,
      minHeight: 160,
      padding: 24,
      background: 'var(--bg)',
      color: 'var(--text)',
      fontSize: 14,
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}
  >
    <SettingsToggle
      label={i18nT('pages.settings.chatPanel.compact_empty_folders')}
      description={i18nT('pages.settings.chatPanel.a_folder_with_no_chats_takes_one_row_instead_of')}
      checked={false}
      onChange={() => {}}
      disabled={on}
    />
    <SettingsToggle
      label={i18nT('pages.settings.chatPanel.hide_empty_folders')}
      description={i18nT('pages.settings.chatPanel.hide_folders_with_no_sessions_entirely_they_reap')}
      checked={on}
      onChange={() => {}}
    />
  </div>,
)
