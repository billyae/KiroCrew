/**
 * Classify a chat-composer drop BEFORE acting on it, so folders can take the
 * path-insertion route instead of the upload route (issue #743: dropping a
 * folder from the OS file manager tried to upload it), and — when the user
 * asks for it — so a regular FILE can be inserted as an `@`-mention path
 * reference instead of being uploaded (issue #2355: a path reference the
 * agent resolves lazily, not a copy of the contents, for a large file).
 *
 * Detection reads `dataTransfer.items` + `webkitGetAsEntry().isDirectory` —
 * the supported directory signal in Chromium (Electron shell AND the
 * browser-served dashboard). `dataTransfer.files` cannot distinguish a folder:
 * it arrives as a plain File with no useful MIME type and a platform-dependent
 * size, so type/size guesses are exactly the bug this replaces.
 *
 * Path resolution: only the desktop shell can see a real filesystem path
 * (pathForFile → webUtils in the preload). In a plain browser a dropped
 * folder's or file's NAME is all we have, and a bare name is NOT a usable
 * path — a misleading relative string inserted silently is worse than today's
 * upload attempt — so a drop without a resolvable path deliberately falls back
 * to the upload route (today's behaviour), unchanged.
 *
 * FILE path insertion is OPT-IN (`insertFilePaths`): a plain drop keeps
 * uploading, exactly as before, so the common gesture is unchanged and the
 * reporter's "ideally the two behaviors could coexist" is honoured. The caller
 * drives it from a modifier key held on drop. Folders ALWAYS insert their path
 * when one resolves (that is #743's existing behaviour and is unaffected by
 * this flag).
 *
 * Mixed drops keep both routes: files that cannot (or should not) become a
 * path token upload, folders and opted-in files insert paths.
 */
import { pathForFile } from '../lib/electron'

/**
 * Can a folder at `p` NOT be written as a composer folder token? The token
 * grammar (DIR_TOKEN_RE in fileTokens.ts, shared with the @-picker) cannot
 * carry whitespace or `@` in its body, and parseDirTokens rejects slash-only
 * bodies, so filesystem roots (`/`, `C:\`) and such paths would look like a
 * folder reference but never parse into a chip or serialize on send.
 */
export function isUntokenizableDirPath(p: string): boolean {
  return /[\s@]/.test(p) || /^[/\\]+$/.test(p) || /^[A-Za-z]:[/\\]*$/.test(p)
}

/**
 * Can a FILE at `p` NOT be written as a composer `@`-mention file token? The
 * mention grammar (shared with the @-picker, which inserts a bare `@<path> `
 * token) is boundary-checked on whitespace and cannot carry whitespace or `@`
 * in its body — so a path with either would look like a mention but never
 * parse into a chip or serialize to `[attached_file N]` on send. A bare slash
 * root carries no filename to reference at all. Those fall back to upload,
 * exactly like the folder case.
 */
export function isUntokenizableFilePath(p: string): boolean {
  return /[\s@]/.test(p) || /^[/\\]+$/.test(p) || /^[A-Za-z]:[/\\]*$/.test(p)
}

export interface ClassifyDropOptions {
  /** When true, a dropped regular file whose desktop path resolves and is
   *  tokenizable is routed to `filePaths` (composer `@`-mention insertion)
   *  instead of upload. Default false: a plain drop uploads, unchanged. */
  insertFilePaths?: boolean
}

export interface ClassifiedDrop {
  /** Regular files — and files/directories no usable path could be resolved
   *  for, or that the caller did not opt into inserting — routed to the
   *  existing upload path. */
  files: File[]
  /** Absolute filesystem paths of dropped directories, resolved by the
   *  desktop shell. Routed to composer text insertion. */
  dirPaths: string[]
  /** Absolute filesystem paths of dropped regular files to insert as
   *  `@`-mention references, resolved by the desktop shell. Only populated
   *  when `insertFilePaths` is set (issue #2355). */
  filePaths: string[]
}

export function classifyDrop(dt: DataTransfer, opts: ClassifyDropOptions = {}): ClassifiedDrop {
  const items = dt.items ? Array.from(dt.items) : []
  // No file-kind items to classify (synthetic events, exotic sources): keep
  // today's behaviour on whatever `files` carries rather than dropping the
  // payload on the floor.
  if (!items.some(it => it.kind === 'file')) {
    return { files: Array.from(dt.files || []), dirPaths: [], filePaths: [] }
  }
  const files: File[] = []
  const dirPaths: string[] = []
  const filePaths: string[] = []
  for (const item of items) {
    if (item.kind !== 'file') continue
    // Both reads must happen synchronously inside the drop handler — the
    // DataTransferItemList is neutered once the event yields.
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    const file = item.getAsFile()
    if (!file) continue
    if (entry?.isDirectory) {
      const p = pathForFile(file)
      // The composer's folder-token grammar (DIR_TOKEN_RE in fileTokens.ts,
      // shared with the @-picker) cannot carry whitespace or `@` in the body,
      // and parseDirTokens rejects slash-only bodies — so filesystem roots
      // (`/`, `C:\`) and such paths would LOOK like a folder reference but
      // never parse into a chip or serialize on send: a silent dead token.
      // Route those to the upload fallback (today's behaviour) instead,
      // exactly like the no-path browser case below.
      const untokenizable = !p || isUntokenizableDirPath(p)
      if (!untokenizable) {
        dirPaths.push(p)
        continue
      }
      // Browser (no real path visible) or untokenizable path — fall back to
      // the upload route.
      files.push(file)
    } else if (opts.insertFilePaths) {
      // Issue #2355: the user asked (via a modifier key on drop) for a path
      // reference instead of an upload. Same desktop-only / tokenizable gate
      // as a folder: a browser has no real path, and a path the mention
      // grammar cannot carry would be a dead token, so both fall back to the
      // existing upload route rather than inserting something misleading.
      const p = pathForFile(file)
      const untokenizable = !p || isUntokenizableFilePath(p)
      if (!untokenizable) {
        filePaths.push(p)
        continue
      }
      files.push(file)
    } else {
      files.push(file)
    }
  }
  return { files, dirPaths, filePaths }
}
