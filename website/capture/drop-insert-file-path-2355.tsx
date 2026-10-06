/**
 * Evidence for issue #2355: drag-and-drop a file to INSERT its path instead of
 * uploading the file.
 *
 * THE CHANGE: when a modifier (Alt/Option) is held on a chat-composer drop, the
 * dropped file's resolved absolute path (desktop shell only) is staged as the
 * same `[attached_file N] <path>` reference the @-picker produces — NO upload,
 * no copy of the file's contents. A plain drop still uploads.
 *
 * The drop GESTURE itself cannot be shown in a still, so this captures the
 * RESULT the gesture produces: the composer's preview strip showing the dropped
 * file staged as a path reference (a `role="group"` file chip named by its full
 * path), beside a folder chip (the pre-existing #743 path-insert) for contrast.
 *
 * It mounts the REAL FilePreviewStrip against the real stylesheet and theme
 * tokens — the strip replaces nothing, so what you see is what production
 * renders for a staged path reference.
 */
import { createRoot } from 'react-dom/client'

import { FilePreviewStrip } from '../src/components/chat-input/FilePreviewStrip'
import { initI18n } from '../src/i18n/all'
import '../src/index.css'

const params = new URLSearchParams(location.search)
const theme = params.get('theme') === 'light' ? 'light' : 'dark'

document.documentElement.dataset.mode = theme
document.documentElement.dataset.theme = theme === 'light' ? 'kiro-light' : 'kiro-dark'

initI18n()

// A file dropped under Alt/Option: its resolved absolute path is staged exactly
// as an uploaded file would be, so it renders as a path-reference chip (no
// thumbnail — a reference carries no content to preview).
const FILE_PATH = '/Users/mina/project/docs/architecture.md'
// The pre-existing folder-path-insert (#743) for contrast: both are references
// handed to the agent, neither is an upload.
const DIR_PATH = '/Users/mina/project/src/components'

const root = createRoot(document.getElementById('root')!)
root.render(
  <div
    data-capture-root
    style={{
      width: 560,
      margin: '2rem auto',
      background: 'var(--bg)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      overflow: 'hidden',
    }}
  >
    {/* A faux composer surface under the strip so the chip reads in context the
        way it does above the real textarea. */}
    <FilePreviewStrip
      files={[FILE_PATH]}
      dirs={[DIR_PATH]}
      onRemove={() => {}}
      onRemoveDir={() => {}}
    />
    <div
      style={{
        padding: '0.75rem 1rem',
        color: 'var(--muted)',
        fontSize: 13,
        fontStyle: 'italic',
      }}
    >
      Dropped under Alt/Option — architecture.md is staged by PATH, not uploaded.
    </div>
  </div>,
)
