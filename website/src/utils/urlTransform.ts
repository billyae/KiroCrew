import { defaultUrlTransform } from 'react-markdown'

// Editor / IDE deep-link schemes a markdown link may navigate to. An EXPLICIT
// allowlist, never a "not http/https" rule: an agent-authored link controls the
// scheme, so admitting anything outside this set would hand `javascript:`,
// `data:`, `file:`, `vbscript:` or an arbitrary attacker-chosen protocol handler
// to the OS. Every entry here is a registered editor scheme that opens a file at
// a line (`idea://open?file=…&line=…`, `vscode://file/…`, `cursor://…`) — the
// targets issue #3218 names — and nothing else. Everything NOT in this set keeps
// the strict `defaultUrlTransform` sanitizer below, which strips it.
//
// SPLIT into two sets because opening an editor link in the OS is an OPT-IN
// behaviour (default off — issue #3218, lead intent rule 2): the feature is a
// product-shape change, so a client with no stored config must see exactly what
// main showed before this change.
//   - BASE_EDITOR_PROTOCOLS: the schemes that ALREADY rendered as anchors before
//     #3218 (`vscode:`, `vscode-insiders:`). They stay clickable regardless of
//     the setting so turning the feature off does not newly STRIP a link that
//     used to render — it only stops the OS hand-off (which, when off, is the
//     pre-#3218 CSP-refused dead click, i.e. unchanged behaviour).
//   - ALLOWED_PROTOCOLS: the full set admitted only when the user opts in. The
//     two added schemes (`idea:`, `cursor:`) render as plain text when the
//     feature is off, exactly as on main.
export const BASE_EDITOR_PROTOCOLS = new Set([
  'vscode:',
  'vscode-insiders:',
])
export const ALLOWED_PROTOCOLS = new Set([
  'vscode:',
  'vscode-insiders:',
  'idea:',
  'cursor:',
])

/** Windows drive-letter absolute path (`C:/…` or `C:\…`). THE single copy of
 *  this predicate — it decides both which image `src` values bypass
 *  `defaultUrlTransform` (below) and which are treated as local file reads
 *  (ImgWithFallback), so the two decisions can never drift apart.
 *
 *  Deliberately EXCLUDES backslash UNC (`\\host\…`): a UNC path names a HOST,
 *  and letting attacker-authored markdown route one to `/api/file-raw` would
 *  hand Windows an outbound SMB authentication probe. Legitimate UNC upload
 *  paths never reach the renderer in backslash form — mdImageDest normalizes
 *  them to `//host/share/…`, which flows through `defaultUrlTransform` as a
 *  scheme-less relative URL and is validated against the gateway's trusted
 *  attachment roots server-side before any filesystem resolution.
 *
 *  Anchored and separator-required so real URI schemes never match — every
 *  registered scheme is 2+ characters (`js:`), and a single-letter scheme
 *  without a following separator (`c:foo`) is still rejected. */
export const WINDOWS_ABS_PATH_RE = /^[A-Za-z]:[\\/]/

/** Recover the on-disk path from a markdown-sourced image `src`.
 *
 *  micromark percent-encodes markdown destinations (a space in an `<…>`
 *  destination arrives as `%20`), and our producer (`mdImageDest` in
 *  fileTokens.ts) escapes a literal `%` to `%25` — so one decode is the exact
 *  inverse for every destination this app produces. Two fail-safe rails keep a
 *  hand-authored src from becoming an attack or a crash:
 *  - a malformed sequence (`%zz`) keeps the raw form instead of throwing;
 *  - a decode that produces control characters (`%00` → NUL would make the
 *    file-raw backend's realpath raise) keeps the raw form. */
export function decodeLocalPath(src: string): string {
  let decoded: string
  try { decoded = decodeURIComponent(src) } catch { return src }
  if (/[\u0000-\u001f]/.test(decoded)) return src
  return decoded
}

export function urlTransform(url: string, key?: string): string {
  // Default (feature OFF / any non-renderer caller): main-parity — only the
  // schemes that already rendered as anchors before #3218. See makeUrlTransform.
  return makeUrlTransform(false)(url, key)
}

/** Build the react-markdown `urlTransform` for the editor-link OPT-IN setting
 *  (#3218). `openEditorLinks=false` (default) admits only BASE_EDITOR_PROTOCOLS,
 *  so `idea:`/`cursor:` are stripped exactly as on main; `true` admits the full
 *  ALLOWED_PROTOCOLS so all four render as anchors (the click hand-off is gated
 *  separately in MdAnchor). Everything else keeps the strict default sanitizer
 *  in both modes. */
export function makeUrlTransform(openEditorLinks: boolean): (url: string, key?: string) => string {
  const allowed = openEditorLinks ? ALLOWED_PROTOCOLS : BASE_EDITOR_PROTOCOLS
  return (url: string, key?: string): string => {
    // A local image on Windows is an absolute drive path (`C:/…/uploads/x.png`).
    // `defaultUrlTransform` parses the drive letter as an unknown `c:` scheme and
    // returns '' — the <img> then renders as nothing (issue #3497). Pass the path
    // through for image `src` only: ImgWithFallback routes local paths to the
    // same-origin `/api/file-raw?path=…` endpoint, so the raw drive path never
    // reaches the DOM. `href` and other keys keep the default strict transform
    // (a link to a bare drive path has no meaning in the browser), and the shape
    // cannot express `javascript:`/`data:` payloads (single letter + separator).
    if (key === 'src' && WINDOWS_ABS_PATH_RE.test(url)) return url
    try {
      const u = new URL(url)
      if (allowed.has(u.protocol) && u.href.length > u.protocol.length + '//'.length)
        return u.href
    } catch {}
    return defaultUrlTransform(url)
  }
}
