import { useState, useEffect, useRef, useCallback, useId, RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useImeGuard } from '../hooks/useImeGuard'
import { createPortal } from 'react-dom'
import { FolderOpen, ChevronRight, ChevronLeft, Clock, Search } from 'lucide-react'
import { api } from '../api/client'
import { useListKeyboardNav } from '../hooks/useListKeyboardNav'
import ErrorNotice from './ErrorNotice'
import { reportForError, type ErrorReport } from '../utils/errorReport'
import { endsWithSeparator, isWindowsPath, lastSegment, parentIsDriveList, pathSeparator, stripTrailingSeparator } from '../utils/browsePath'
import { searchErrorCause, type SearchErrorCause } from '../lib/searchErrorCause'

import { i18nT } from '../i18n/t'

// Copy for a failed DIRECTORY listing, keyed on the same classifier WorkspacePicker and
// FolderPanel read, so one failure is named one way whichever picker the user is in. Three
// maps because the notice reads differently with a listing on screen (it names the path
// that failed and the one still shown), with a failed path but no listing (it names the
// path alone), and with neither (nothing to point at). The `failed` arm is the existing
// generic copy; the other arms name the cause and the remedy that fits it -- a timeout is
// retried, a refusal is not.
const LISTING_FAILED_KEYS: Record<SearchErrorCause, string> = {
  timed_out: 'components.projectPicker.listing_failed_timed_out',
  denied: 'components.projectPicker.listing_failed_denied',
  root_missing: 'components.projectPicker.listing_failed_root_missing',
  failed: 'components.projectPicker.listing_failed',
}
// "No listing" means no listing PATH to point at (`shownPath` is '' because `browsePath` is ''),
// not no path to name: the failed path is known and named. That is the drive list, whose rows are
// on screen but carry no path, and a drill before any listing landed, where nothing is on screen.
// The catalog keys keep their older `_no_path` names to avoid churning four keys in twelve catalogs.
const LISTING_FAILED_NO_LISTING_KEYS: Record<SearchErrorCause, string> = {
  timed_out: 'components.projectPicker.listing_failed_no_path_timed_out',
  denied: 'components.projectPicker.listing_failed_no_path_denied',
  root_missing: 'components.projectPicker.listing_failed_no_path_root_missing',
  failed: 'components.projectPicker.listing_failed_no_path',
}
// A failure with NO path of its own: the opening `browse()` with no argument, which the backend
// resolves to `$HOME`. `/api/browse-dirs` neither refuses nor reports `$HOME` missing, so
// `denied` / `root_missing` cannot be produced for it and take the generic copy rather than keys
// no request can reach -- the same argument RECENT_FAILED_KEYS records.
const LISTING_FAILED_UNKNOWN_KEYS: Record<SearchErrorCause, string> = {
  timed_out: 'components.projectPicker.listing_failed_unknown_timed_out',
  denied: 'components.projectPicker.listing_failed_unknown',
  root_missing: 'components.projectPicker.listing_failed_unknown',
  failed: 'components.projectPicker.listing_failed_unknown',
}
// A drive-list request has no failed path to name. Timeout and access-denied
// failures still have distinct, actionable copy; an unexpected missing-root
// response falls back to the existing generic drive-list notice.
const DRIVES_FAILED_KEYS: Record<SearchErrorCause, string> = {
  timed_out: 'components.projectPicker.drives_failed_timed_out',
  denied: 'components.projectPicker.drives_failed_denied',
  root_missing: 'components.projectPicker.drives_failed',
  failed: 'components.projectPicker.drives_failed',
}
// Only two arms have copy of their own: the recents endpoint answers any read error
// with 200 `{"dirs": []}` and never a coded body (`api_recent_projects` in
// chat_handlers.py), so `denied` / `root_missing` cannot be produced for it -- a 403
// carrying `authRequired` classifies as `failed` -- and both take the generic copy
// rather than keys no request can reach.
const RECENT_FAILED_KEYS: Record<SearchErrorCause, string> = {
  timed_out: 'components.projectPicker.recent_failed_timed_out',
  denied: 'components.projectPicker.recent_failed',
  root_missing: 'components.projectPicker.recent_failed',
  failed: 'components.projectPicker.recent_failed',
}
// The same failure told on the RECENT tab, whose pane has no path field and no folder
// list: the Browse copy's remedy ("type a path above, or pick a folder from the list")
// is false there, so this arm points at the Browse tab instead.
const RECENT_TAB_FAILED_KEYS: Record<SearchErrorCause, string> = {
  timed_out: 'components.projectPicker.recent_failed_recent_tab_timed_out',
  denied: 'components.projectPicker.recent_failed_recent_tab',
  root_missing: 'components.projectPicker.recent_failed_recent_tab',
  failed: 'components.projectPicker.recent_failed_recent_tab',
}
type ListFailureKind = 'dir' | 'drives'

/** One listing request. `gen` makes every user-initiated request a DISTINCT react-query key, so a
 *  superseded read is the one no observer holds and react-query never applies its result -- the
 *  guarantee the hand-rolled `listingSeq` ticket gave by hand. `kind` is a directory listing or
 *  the Windows drive list; `preserveInput` keeps the path field as typed; `homeOnGone` falls back
 *  to `$HOME` when the opening read of a caller's selection no longer lists; `carried` is a prior
 *  refusal re-shown over that fallback. */
interface ListReq {
  gen: number
  kind: ListFailureKind
  path?: string
  preserveInput?: boolean
  homeOnGone?: boolean
  carried?: { path: string; err: unknown }
}

/**
 * Does `path` name the listing on screen (`shown`, the pane's `browsePath`)? One comparison for
 * every site that asks -- the Select / Ctrl+Enter commit gate, the auto-drill's "already here"
 * check and the empty-state gate -- so the three cannot drift: a trailing separator is ignored
 * (the field carries one for typing continuation), a Windows-shaped path compares
 * case-insensitively (the backend canonicalises `c:\` to `C:\`), a POSIX one exactly. Never
 * true while no listing is on screen.
 */
function namesListing(path: string, shown: string): boolean {
  if (!shown) return false
  const candidate = stripTrailingSeparator(path)
  return isWindowsPath(candidate) ? candidate.toLowerCase() === shown.toLowerCase() : candidate === shown
}

/** The recents read's own failure. One record per read family: `ListFailure` is the folder or
 *  drive listing, this is the recents read, and a rejection writes only its own. Precedence is a
 *  render rule -- Browse tells the listing failure if there is one, else this; the Recent pane
 *  tells only this -- so the order the two reads settle in cannot matter. */
interface RecentFailure {
  cause: SearchErrorCause
  report?: ErrorReport
}

interface ListFailure {
  kind: ListFailureKind
  path: string
  cause: SearchErrorCause
  report?: ErrorReport
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchorRef?: RefObject<HTMLElement | null>
  anchorRect?: DOMRect | null
  onSelect: (path: string) => void
  /**
   * Turn on the agent hand-off in the listing-failure notice. The hand-off
   * navigates to the chat and unmounts whatever this popover floats over, so
   * only a mount with nothing unsaved beneath it may set this: ChatPage's
   * project chooser does (its composer draft is persisted per slot by
   * `chatDrafts`). Off by default — the safe direction — for FolderConfigModal
   * (folder form), RepoSettings (repo form) and ProjectScaffolderPage (wizard).
   */
  errorHandoff?: boolean
  /**
   * The caller's current selection: the directory the Browse pane opens in.
   * Empty or absent opens at `$HOME`, the backend's default listing. Read once
   * per open, so editing the caller's field while the picker is up does not
   * move the listing under the user.
   */
  startPath?: string
}

export default function ProjectPicker({ open, onOpenChange, anchorRef, anchorRect, onSelect, errorHandoff = false, startPath = '' }: Props) {
  const [tab, setTab] = useState<'recent' | 'browse'>('recent')
  const [input, setInput] = useState('')
  const ime = useImeGuard()
  // Stable per-instance id, folded into both react-query keys so two mounts of this picker (the
  // always-mounted ChatPage chooser plus a modal's own) never share a cache entry -- the gen
  // counters restart at 1 in every instance, so without this a fresh mount's gen-1 key would hit
  // the other instance's cached gen-1 entry (CI Opus review on #14731).
  const instanceId = useId()
  const [recentQuery, setRecentQuery] = useState('')
  const [browseSel, setBrowseSel] = useState(0)
  // The listing shown on screen, committed from the query's data -- rows and `browsePath` come
  // from here, never straight from the query, so a failed or in-flight read keeps the directory
  // already on screen (the old code only overwrote these on success). `null` until the first
  // read lands.
  const [shown, setShown] = useState<{ path: string; parent: string; dirs: { name: string; path: string }[]; listing: 'dir' | 'drives' } | null>(null)
  const browsePath = shown?.path ?? ''
  const browseParent = shown?.parent ?? ''
  const browseDirs = shown?.dirs ?? []
  const listing = shown?.listing ?? 'dir'
  const [recentDirs, setRecentDirs] = useState<string[]>([])
  // Set once the user picks a tab by hand, so the recents read's auto-selection (which under
  // react-query can commit a tick after a quick manual click) never yanks the tab back.
  const userPickedTabRef = useRef(false)
  // The listing read that failed last, committed from the query. The path, cause and report live
  // in one object so the notice and its hand-off always describe one failure.
  const [listFailure, setListFailure] = useState<ListFailure | null>(null)
  const [recentFailure, setRecentFailure] = useState<RecentFailure | null>(null)
  // SYNCHRONOUS mirror of the listing read's in-flight state: react-query's `isFetching` notifies
  // on a batched scheduler a tick late, but the Retry control must relabel to the inert
  // "Retrying…" on the very click. A UX mirror, not the staleness ticket the migration removed --
  // the query key decides which read wins.
  const [listingInFlight, setListingInFlight] = useState(false)
  // Records whether the user has typed since the current listing request started; a listing that
  // lands after a keystroke still lands its rows but must not seed the field over what was typed
  // (the `inputEdits` guard this replaces).
  const [fieldOwned, setFieldOwned] = useState(false)
  const listFailed = listFailure?.kind ?? null
  const listGenRef = useRef(0)
  // The generation RETIRED by leaving the pane (Select commits + closes, Escape, click-outside):
  // its late result is abandoned so it cannot commit into a closed/left pane. The open effect
  // clears `listFailure` on reopen, so the main hazard this guards is a late read landing between
  // the exit and the next open.
  const retiredGenRef = useRef(-1)
  // The generation whose late FAILURE must be dropped because the user typed a different path
  // over the read while it was in flight (the `inputEdits` guard this replaces): the notice would
  // otherwise name a path the user replaced, flip `canCommit` false, and make Retry re-ask it. A
  // late SUCCESS still lands its rows (the field is already the user's, so it is not re-seeded).
  const editedGenRef = useRef(-1)
  const recentGenRef = useRef(0)
  const [listReq, setListReq] = useState<ListReq>({ gen: 0, kind: 'dir' })
  const [recentGen, setRecentGen] = useState(0)
  // Read by the open effect only, so a caller whose field changes while the picker is up does
  // not re-run the open (which would also re-read recents and reset the tab).
  const startPathRef = useRef(startPath)
  startPathRef.current = startPath
  const btnRef = anchorRef
  const dropRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const recentSearchRef = useRef<HTMLInputElement>(null)
  const browseItemRefs = useRef<(HTMLElement | null)[]>([])
  const anchorRectRef = useRef<DOMRect | null>(anchorRect ?? null)
  anchorRectRef.current = anchorRect ?? null
  const getAnchorRect = useCallback((): DOMRect | null => {
    if (btnRef?.current && typeof btnRef.current.getBoundingClientRect === 'function') {
      return btnRef.current.getBoundingClientRect()
    }
    return anchorRectRef.current
  }, [btnRef])

  const listQuery = useQuery({
    queryKey: ['pp-listing', instanceId, listReq.gen, listReq.kind, listReq.path ?? ''],
    queryFn: () => (listReq.kind === 'drives' ? api.browseDrives() : api.browseDirs(listReq.path)),
    // `gen > 0` holds the read until the open effect issues the real opening request.
    enabled: open && listReq.gen > 0,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  })
  const recentQ = useQuery({
    queryKey: ['pp-recents', instanceId, recentGen],
    queryFn: () => api.recentProjects(),
    enabled: open && recentGen > 0,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  })

  // Each listing request takes a fresh generation; a superseded read's result is applied to a
  // cache entry no observer holds, so it cannot replace the live listing (the `listingSeq`
  // ticket's job). `preserveInput` keeps the field; `homeOnGone` / `carried` carry the opening
  // read's deleted-selection fallback.
  const browse = useCallback((path?: string, preserveInput = false, homeOnGone = false, carried?: { path: string; err: unknown }) => {
    listGenRef.current += 1
    setFieldOwned(preserveInput)
    setListingInFlight(true)
    setListReq({ gen: listGenRef.current, kind: 'dir', path, preserveInput, homeOnGone, carried })
  }, [])
  const browseDrives = useCallback(() => {
    listGenRef.current += 1
    setFieldOwned(false)
    setListingInFlight(true)
    setListReq({ gen: listGenRef.current, kind: 'drives' })
  }, [])

  // Commit the listing query's settled result ONCE per generation, synchronously as it lands. A
  // superseded read belongs to a cache entry no observer holds, so it never reaches this; a new
  // request takes a fresh generation and starts pending (`isFetching`), so no transient inter-key
  // reading commits. A `dir` success replaces the shown listing, seeds the field with a trailing
  // separator (#1196) unless the field is the user's, and refocuses the combobox; `drives`
  // likewise. A `root_missing` / `denied` failure of a `homeOnGone` opening read re-issues the
  // `$HOME` read carrying the refusal; any other failure is noted against the read's path.
  const committedRef = useRef(-1)
  if (committedRef.current !== listReq.gen && !listQuery.isFetching && listReq.gen > 0) {
    const d = listQuery.data
    if (listReq.gen === retiredGenRef.current) {
      // Retired by an exit: abandon the late result, success or failure.
      committedRef.current = listReq.gen
      setListingInFlight(false)
    } else if (d && !listQuery.isError) {
      committedRef.current = listReq.gen
      setListingInFlight(false)
      setShown({ path: d.path, parent: d.parent, dirs: d.dirs, listing: listReq.kind })
      setBrowseSel(0)
      if (listReq.kind === 'dir') {
        // The carried refusal (a deleted startPath that fell back to $HOME) is shown only if the
        // user has NOT typed over this fallback read; otherwise it would disable Select for the
        // path they just typed (editedGenRef marks the typed-over generation).
        if (listReq.carried && listReq.gen !== editedGenRef.current) setListFailure({ kind: 'dir', path: listReq.carried.path, cause: searchErrorCause(listReq.carried.err), report: reportForError(listReq.carried.err) })
        else if (listFailure) setListFailure(null)
        if (!listReq.preserveInput && !fieldOwned) {
          const sep = pathSeparator(d.path)
          setInput(d.path.endsWith(sep) ? d.path : d.path + sep)
        }
      } else {
        if (listFailure) setListFailure(null)
        if (!fieldOwned) setInput('')
      }
      requestAnimationFrame(() => inputRef.current?.focus())
    } else if (listQuery.isError) {
      const err = listQuery.error
      const cause = searchErrorCause(err)
      if (listReq.kind === 'dir' && listReq.homeOnGone && listReq.path && (cause === 'root_missing' || cause === 'denied')) {
        committedRef.current = listReq.gen
        // The opening read of a deleted selection fell back to $HOME. If the user typed over that
        // opening read while it was in flight, the fallback must NOT re-seed the field or carry
        // the refusal (both would undo the keystroke): preserve the typed field and drop the
        // carried notice. Otherwise the fallback seeds $HOME and names the gone selection.
        const typed = listReq.gen === editedGenRef.current
        browse(undefined, typed, false, typed ? undefined : { path: listReq.path, err })
      } else {
        committedRef.current = listReq.gen
        setListingInFlight(false)
        // A late failure of a read the user has typed OVER names a path they are replacing: drop
        // it rather than resurface the notice and refuse the typed path (the `inputEdits` guard).
        if (listReq.gen !== editedGenRef.current) {
          setListFailure({ kind: listReq.kind, path: listReq.kind === 'drives' ? '' : (listReq.path ?? ''), cause, report: reportForError(err) })
        }
      }
    }
  }

  // Commit the recents read once per generation. The reopen keeps the last open's rows until this
  // lands (so "No recent projects" never blinks over the round trip); a rejection clears the rows
  // under the same commit, so no old rows show under the notice.
  const recentCommittedRef = useRef(-1)
  if (recentCommittedRef.current !== recentGen && !recentQ.isFetching && recentGen > 0) {
    if (recentQ.data && !recentQ.isError) {
      recentCommittedRef.current = recentGen
      const dirs = recentQ.data.dirs || []
      setRecentDirs(dirs)
      setRecentFailure(null)
      if (!userPickedTabRef.current) setTab(dirs.length ? 'recent' : 'browse')
    } else if (recentQ.isError) {
      recentCommittedRef.current = recentGen
      setRecentDirs([])
      setRecentFailure({ cause: searchErrorCause(recentQ.error), report: reportForError(recentQ.error) })
      if (!userPickedTabRef.current) setTab('browse')
    }
  }


  // Retry re-asks EXACTLY the read that failed. The notice lives in committed `listFailure` state,
  // not in the query, so it stays up through the re-ask; the fresh generation re-issues the same
  // path or the drive list, and its success commit clears the notice. Only offered for a cause
  // re-asking can fix.
  const canRetryListing = listFailure?.cause === 'timed_out' || listFailure?.cause === 'failed'
  const retryListing = () => {
    if (listingInFlight || !listFailure) return
    if (listFailure.kind === 'drives') browseDrives()
    else browse(listFailure.path || undefined)
  }

  // "Back" has a target when the parent is a different directory, or when the
  // level above is the drive list. Every Back affordance (button, ArrowLeft at
  // the caret start) routes through goUp so the two cannot drift apart.
  // The failure notice names a drive the user is NOT on, so the example never
  // points back at the listing already on screen.
  const otherDriveExample = (current: string) => i18nT(/^[Dd]:/.test(current) ? 'components.projectPicker.drive_example_e' : 'components.projectPicker.drive_example_d')
  // The notices name the listing the way the path field shows it (with its
  // trailing separator), so the two read as the same place (UX review on #11424).
  const shownPath = browsePath && !browsePath.endsWith(pathSeparator(browsePath)) ? browsePath + pathSeparator(browsePath) : browsePath
  // Nothing to commit on the drive list; and after a failed folder listing,
  // nothing to commit while the field still names the path that failed — the
  // folder form would inherit that broken path (UX review on #11424). When the
  // field names the listing that IS on screen (a failed drill by click leaves
  // `D:\work\` in the field and D:\work's rows below), or when only the drive
  // list failed, the directory shown is intact and stays committable. Both the
  // Select button and Ctrl+Enter read this one predicate.
  const fieldNamesShownListing = namesListing(input.trim(), browsePath)
  const canCommit = (!!input.trim() || !!browsePath) && (listFailed !== 'dir' || fieldNamesShownListing)
  // The "No subdirectories" empty-state and the notice for a failed read of the listing ON
  // SCREEN describe the same list, so those two never share the screen: the notice says the
  // rows could not be read, the empty-state claims they were read and there are none. Only
  // that failure hides it -- a `dir` read that failed and was this listing's: by name (the
  // same comparison the commit gate and the auto-drill use), or with no name on either side.
  // The opening read is `browse()` with no path and records `path: ''` while a reopen still
  // holds the last open's rows; a typed drill that fails before any listing landed leaves
  // `browsePath` '' (on the drive list too), with nothing read to be empty. A failure of some
  // OTHER read leaves the shown listing intact, so a directory that listed successfully empty
  // keeps its empty-state beside that notice rather than a list region that says nothing at
  // all: the drive list, a different typed path (whose notice says the list below still shows
  // this directory), or the recents read, which is not a listing.
  const shownListingFailed = listFailure?.kind === 'dir'
    && (!listFailure.path || !browsePath || namesListing(listFailure.path, browsePath))
  const atDriveRoot = parentIsDriveList(browsePath, browseParent)
  const canGoUp = atDriveRoot || (!!browseParent && browseParent !== browsePath)
  const goUp = () => { if (atDriveRoot) browseDrives(); else browse(browseParent) }

  useEffect(() => {
    if (!open) return
    setRecentQuery('')
    userPickedTabRef.current = false
    // The mount outlives a close (ChatPage toggles `open`), so the last open's rows are
    // still in state here and stay on screen until this open's read answers. Recents rows and
    // the recents notice still move together: the commit above clears the rows under the same
    // generation that sets the notice, so a rejected reopen never shows old rows under it.
    setListFailure(null)
    setRecentFailure(null)
    recentGenRef.current += 1
    setRecentGen(recentGenRef.current)
    const start = startPathRef.current.trim()
    if (start) browse(start, false, true)
    else browse()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    let cleanup = () => {}
    const timer = setTimeout(() => {
      const handler = (e: MouseEvent) => {
        if (dropRef.current && dropRef.current.contains(e.target as Node)) return
        const target = e.target as Node | null
        const live = btnRef?.current
        if (live && typeof (live as Element).contains === 'function' && (live as Element).contains(target)) return
        const r = getAnchorRect()
        if (r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return
        retiredGenRef.current = listGenRef.current
        onOpenChange(false)
      }
      document.addEventListener('mousedown', handler)
      cleanup = () => document.removeEventListener('mousedown', handler)
    }, 0)
    return () => { clearTimeout(timer); cleanup() }
  }, [open, onOpenChange, btnRef, getAnchorRect])

  const select = (path: string) => {
    // The browse input carries a trailing delimiter for typing continuation
    // (#1196); the committed project path must stay clean. `\` is a separator
    // ONLY on a Windows-shaped path (drive-letter `C:...` or UNC `\\...`); on
    // POSIX it is a legal filename char, so only `/` is stripped there and a real
    // trailing `\` is preserved (GPT 5.6). Bare roots stay intact: POSIX `/` and a
    // Windows drive root `C:\` / `C:/` (stripping `C:/` to `C:` would yield a
    // drive-RELATIVE path, not the drive root).
    retiredGenRef.current = listGenRef.current
    onSelect(stripTrailingSeparator(path)); onOpenChange(false)
  }
  const rq = recentQuery.trim().toLowerCase()
  const filteredRecent = rq ? recentDirs.filter(d => d.toLowerCase().includes(rq)) : recentDirs

  // Recent tab uses the shared selected-index keyboard nav (same model as the
  // Skill/File pickers). The Browse tab has its own combobox input handler
  // below, so the hook is only armed on Recent to avoid double-handling keys.
  const recentNav = useListKeyboardNav({
    open: open && tab === 'recent',
    count: filteredRecent.length,
    onChoose: i => { const d = filteredRecent[i]; if (d) select(d) },
    onClose: () => onOpenChange(false),
  })

  // Reset the Recent highlight whenever the filtered list changes.
  useEffect(() => { recentNav.setSelected(0) }, [recentQuery]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset the Browse highlight whenever the visible list changes (tab switch,
  // drill into a new dir, or filter edit).
  useEffect(() => { setBrowseSel(0) }, [tab, input, browsePath])

  // Auto-drill on a typed trailing separator. Without this, typing "/foo/bar/"
  // only filters the *current* directory's children by the last segment — the
  // list never descends into the typed subdirectory. When the input ends with
  // its shape's separator (`/`, or also `\` on a Windows-shaped path such as
  // `D:\`) and differs from the dir we've already loaded, browse into it.
  // Debounced so intermediate keystrokes before the separator don't each fire
  // a request. A bare drive root keeps its separator: `D:` alone is a
  // drive-RELATIVE path the backend would resolve to that drive's cwd.
  useEffect(() => {
    if (!open || tab !== 'browse') return
    const trimmed = input.trim()
    if (!endsWithSeparator(trimmed) || trimmed.length <= 1) return
    const target = stripTrailingSeparator(trimmed)
    if (!target) return
    if (namesListing(target, browsePath)) return
    const t = setTimeout(() => browse(target, true), 250)
    return () => clearTimeout(t)
  }, [input, open, tab, browsePath, browse])

  // Keep the highlighted Browse subdir scrolled into view.
  useEffect(() => {
    if (!open || tab !== 'browse') return
    const el = browseItemRefs.current[browseSel]
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  }, [browseSel, open, tab])

  const anchorR = getAnchorRect()
  if (!open || !anchorR) return null

  const q = input.toLowerCase()
  const filteredBrowse = q && q !== browsePath.toLowerCase() ? browseDirs.filter(d => d.name.toLowerCase().includes(lastSegment(q)) || d.path.toLowerCase().includes(q)) : browseDirs

  // Browse carries one notice. The listing failure is about the list on THIS pane, so it is
  // told first; the recents failure is told here only while no listing failure is, because the
  // user was sent to Browse by it and needs the remedy this pane offers. Neither record
  // overwrote the other, so which read settled first cannot change what is shown.
  const browseNotice = listFailure
    ? {
      report: listFailure.report,
      testId: listFailure.kind === 'drives' ? 'pp-drives-error' : 'pp-listing-error',
      message: listFailure.kind === 'drives'
        ? i18nT(DRIVES_FAILED_KEYS[listFailure.cause], { path: shownPath, example: otherDriveExample(browsePath) })
        // Never select copy that names a value the picker does not have. The path-naming
        // arm interpolates BOTH the path that failed and the one still shown, and either
        // can be '' on its own, so select on the failed path first.
        : !listFailure.path
          // The opening read is `browse()` with no path, so its rejection records `path: ''`
          // while a reopen still holds the last open's `browsePath`: nothing to name.
          ? i18nT(LISTING_FAILED_UNKNOWN_KEYS[listFailure.cause])
          : browsePath
            ? i18nT(LISTING_FAILED_KEYS[listFailure.cause], { failed: listFailure.path, path: shownPath })
            // The drive list (`browsePath` is ''), or a drill before any listing landed: the
            // failed path is known, but `shownPath` is '' -- the drive rows on screen carry no
            // path for `{{path}}` to name, and in the early drill nothing is on screen at all.
            : i18nT(LISTING_FAILED_NO_LISTING_KEYS[listFailure.cause], { failed: listFailure.path }),
    }
    : recentFailure
      ? { report: recentFailure.report, testId: 'pp-recent-error', message: i18nT(RECENT_FAILED_KEYS[recentFailure.cause]) }
      : null

  // Keyboard isolation for the popover, matching the boundary `Modal` carries on
  // its own panel (see Modal.tsx's ModalDialog). It is needed SEPARATELY here
  // because this popover portals as a React SIBLING of the `<Modal>` it paints
  // above (FolderConfigModal renders it after `</Modal>`), and React routes
  // synthetic events along the REACT tree — so Modal's panel handler is not an
  // ancestor on this dispatch path and never sees these keystrokes. Sharing the
  // modal's stacking context is a PAINT-order fact and implies nothing about
  // event routing; conflating the two is what left this open (#6833).
  //
  // Unguarded, a global chord typed in either field here (the Ctrl+digit session
  // jumps and the Settings chord deliberately fire while an input has focus)
  // reaches `useKeyboardShortcuts`' bubble-phase `document` listener, navigates
  // away, and unmounts the dialog underneath with its part-filled draft.
  //
  // Escape is excepted. Both dismissal paths that exist today already consume it
  // before this handler runs — the Recent list at document CAPTURE
  // (useListKeyboardNav), the Browse field as the event's own target — so the
  // exception changes nothing observable today. What it protects is the
  // CONTRACT: `stopPropagation()` on a synthetic event stops the native event
  // too, and bubble-phase `window` is exactly where Modal's own dismissal
  // listens, so a blanket stop here would break any dismissal wired that way the
  // moment one appears. Measured, not assumed — a blanket-stop mutant passes
  // every OTHER assertion in ProjectPicker.keyboardIsolation.test.tsx, which is
  // why that file pins the window-bubble property on its own.
  //
  // One exception to the exception: an Escape the IME owns is cancelling a
  // candidate list, not the popover. This reuses the component's EXISTING
  // `ime` guard rather than mounting a second document-tracked latch, since a
  // third latch instance is the very cost flagged against this fix shape.
  // Bubble phase on purpose: the capture-phase listeners this surface depends
  // on (useListKeyboardNav's document capture, Modal's window-capture Tab trap)
  // run before the event reaches the target, so the boundary cannot starve them.
  const isolateKeys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Consumes the native event AND React's propagation flag when the IME
      // owns it; leaves an accepted Escape entirely untouched for the handlers
      // above. See `claimSyntheticKey`'s contract in useImeGuard.ts.
      ime.claimKey(e)
      return
    }
    e.stopPropagation()
  }

  return createPortal(
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- keyboard-isolation barrier (see above), not an activatable control; there is no behaviour for a keyboard to be given, and every control inside here is a real input or button. Adding a role/tab stop would advertise an interaction this element does not have.
    <div ref={dropRef} onKeyDown={isolateKeys} className="fixed z-[9999] bg-bg-elevated border border-border rounded-xl shadow-xl w-[400px] max-w-[calc(100vw-16px)] flex flex-col overflow-hidden animate-slide-up" style={(() => {
      const dropMinH = 200
      const spaceBelow = window.innerHeight - anchorR.bottom - 8
      const flipUp = spaceBelow < dropMinH || anchorR.bottom > window.innerHeight / 2
      const left = Math.max(8, Math.min(anchorR.right - 400, window.innerWidth - 408))
      if (flipUp) {
        const spaceAbove = anchorR.top - 8
        return { bottom: window.innerHeight - anchorR.top + 4, left, height: Math.min(460, Math.max(200, spaceAbove)) }
      }
      return { top: anchorR.bottom + 4, left, height: Math.min(460, Math.max(200, spaceBelow)) }
    })()}>
      {/* Tabs */}
      <div className="flex border-b border-border">
        <button className={`flex-1 px-3 py-2 text-[12px] font-medium flex items-center justify-center gap-1.5 transition-colors ${tab === 'recent' ? 'text-accent border-b-2 border-accent' : 'text-muted hover:text-text'}`} onMouseDown={e => { e.preventDefault(); userPickedTabRef.current = true; setTab('recent') }}>
          <Clock size={12} /> {i18nT('components.projectPicker.recent')}
        </button>
        <button className={`flex-1 px-3 py-2 text-[12px] font-medium flex items-center justify-center gap-1.5 transition-colors ${tab === 'browse' ? 'text-accent border-b-2 border-accent' : 'text-muted hover:text-text'}`} onMouseDown={e => { e.preventDefault(); userPickedTabRef.current = true; setTab('browse') }}>
          <FolderOpen size={12} /> {i18nT('components.projectPicker.browse')}
        </button>
      </div>

      {tab === 'recent' ? (
        <>
          {recentDirs.length > 0 && (
            <div className="p-2 border-b border-border">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted pointer-events-none" />
                <input
                  ref={recentSearchRef}
                  autoFocus
                  type="text"
                  aria-label={i18nT('components.projectPicker.search_recent_projects')}
                  aria-controls="pp-recent-list"
                  placeholder={i18nT('components.projectPicker.search_recent_projects_2')}
                  value={recentQuery}
                  onChange={e => setRecentQuery(e.target.value)}
                  className="w-full bg-bg-elevated border border-border rounded pl-7 pr-3 py-1.5 text-[13px] text-text placeholder:text-muted focus:outline-hidden focus-visible:border-accent"
                />
              </div>
            </div>
          )}
          {recentFailure && (
            <div className="px-3 py-2 border-b border-border">
              {/* Same hand-off contract as the Browse notice below: off unless the mount
                  opts in, and the popover closes itself when it hands off. */}
              <ErrorNotice
                variant="inline"
                className="whitespace-normal"
                askAgent={errorHandoff}
                onHandoff={() => onOpenChange(false)}
                report={recentFailure.report}
                message={i18nT(RECENT_TAB_FAILED_KEYS[recentFailure.cause])}
                testId="pp-recent-tab-error"
              />
            </div>
          )}
          <div id="pp-recent-list" role="listbox" aria-label={i18nT('components.projectPicker.recent_projects')} className="overflow-y-auto flex-1 min-h-0">
            {recentDirs.length === 0 ? (
              // Silent under the notice above: an empty list after a FAILED read is not an
              // empty result, and "No recent projects" would claim one.
              recentFailure ? null : (
                <div className="px-3 py-6 text-[12px] text-muted text-center">{i18nT('components.projectPicker.no_recent_projects')}</div>
              )
            ) : filteredRecent.length === 0 ? (
              <div className="px-3 py-6 text-[12px] text-muted text-center">{i18nT('components.projectPicker.no_matching_projects')}</div>
            ) : filteredRecent.map((d, i) => (
              <button
                key={d}
                role="option"
                aria-selected={i === recentNav.selected}
                id={`pp-recent-${i}`}
                tabIndex={-1}
                ref={el => { recentNav.itemRefs.current[i] = el }}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 cursor-pointer transition-colors ${i === recentNav.selected ? 'bg-bg-hover' : 'hover:bg-bg-hover'}`}
                onMouseEnter={() => recentNav.setSelected(i)}
                onMouseDown={e => { e.preventDefault(); select(d) }}
              >
                <FolderOpen size={12} className="text-accent shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-mono font-semibold text-text truncate">{d.split('/').pop()}</div>
                  <div className="text-[11px] text-muted truncate">{d}</div>
                </div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="p-2 border-b border-border flex gap-1 items-center">
            {canGoUp && (
              /* One control, one shape: chevron plus a visible name. The name is
                 "Back" inside a drive and "All drives" at its root, where "back"
                 would read as a guess (there is no folder above C:\) — UX review
                 on #11424 asked for the destination, and for the label not to
                 appear and vanish between the two states. */
              <button aria-label={atDriveRoot ? i18nT('components.projectPicker.all_drives') : i18nT('components.projectPicker.back')} onClick={goUp} className="p-1 text-muted hover:text-text rounded hover:bg-bg-hover shrink-0 flex items-center gap-0.5" title={atDriveRoot ? i18nT('components.projectPicker.all_drives') : i18nT('components.projectPicker.back_to', { path: browseParent })}>
                <ChevronLeft size={16} />
                <span className="text-[11px] font-medium pr-1">{atDriveRoot ? i18nT('components.projectPicker.all_drives') : i18nT('components.projectPicker.back')}</span>
              </button>
            )}
            <input
              ref={inputRef}
              autoFocus
              type="text"
              role="combobox"
              aria-expanded={true}
              aria-label={i18nT('components.projectPicker.project_directory_path')}
              aria-controls="pp-browse-list"
              aria-activedescendant={filteredBrowse.length ? `pp-dir-${browseSel}` : undefined}
              placeholder={listing === 'drives' ? i18nT('components.projectPicker.path_to_project_drive') : i18nT('components.projectPicker.path_to_project')}
              value={input}
              onChange={e => {
                setInput(e.target.value); setListFailure(null)
                // A keystroke claims the FIELD: a listing (a drive list, a slow drill) that lands
                // after it still lands its rows but must not run `setInput` over what was typed
                // (the `inputEdits` guard this replaces). It also drops the listing notice, since
                // typing is the recovery, and marks the read in flight as typed-over so its late
                // FAILURE is dropped rather than naming the replaced path.
                setFieldOwned(true)
                editedGenRef.current = listReq.gen
              }}
              {...ime.bindComposition()}
              onKeyDown={e => {
                const n = filteredBrowse.length
                const commit = () => { if (!canCommit) return; const p = input.trim() || browsePath; if (p) select(p) }
                if (e.key === 'ArrowDown') { e.preventDefault(); setBrowseSel(s => (n ? Math.min(s + 1, n - 1) : 0)) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setBrowseSel(s => Math.max(s - 1, 0)) }
                else if (e.key === 'Enter') {
                  // Rule 2: the handler also carries the arrow keys, so only the
                  // Enter path is claimed — arrow navigation stays untouched.
                  if (!ime.claimEnter(e)) return
                  if (e.metaKey || e.ctrlKey) commit()                               // ⌘/Ctrl+Enter commits the current dir
                  else if (n > 0 && filteredBrowse[browseSel]) browse(filteredBrowse[browseSel].path)  // Enter drills into the highlighted folder
                  else commit()                                                       // nothing to drill into -> commit typed path
                }
                else if (e.key === 'ArrowLeft' && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0 && canGoUp) {
                  e.preventDefault(); goUp()                                          // caret at start -> go to parent (or the drive list)
                }
                else if (e.key === 'Escape' || e.key === 'Tab') {
                  // This input is a composable free-text path field. An Escape
                  // or Tab the IME owns is cancelling or cycling the candidate
                  // list, not leaving the picker — acting on it would close the
                  // popover and yank focus mid-composition. `claimKey` claims
                  // through this input's own tracked latch (the
                  // `bindComposition` spread above feeds it) and owns the
                  // whole decline: native consumption per the latch contract,
                  // and the synthetic propagation stop React ancestors read.
                  if (!ime.claimKey(e)) return
                  e.preventDefault(); retiredGenRef.current = listGenRef.current; onOpenChange(false); btnRef?.current?.focus()
                }
              }}
              className="flex-1 min-w-0 bg-bg-elevated border border-border rounded px-2 py-1.5 text-[13px] font-mono text-text placeholder:text-muted focus:outline-hidden focus-visible:border-accent"
            />
            <button disabled={!canCommit} onMouseDown={e => { e.preventDefault(); if (canCommit) select(input.trim() || browsePath) }} className="px-2 py-1 text-[11px] bg-accent/20 text-accent rounded hover:bg-accent/30 disabled:opacity-40 disabled:cursor-not-allowed shrink-0">{i18nT('components.projectPicker.select')}</button>
          </div>
          {browseNotice && (
            <div className="px-3 py-2 border-b border-border flex items-center gap-2" aria-busy={(canRetryListing && listingInFlight) || undefined}>
              {/* No hand-off unless the mount opts in (`errorHandoff`): three
                  of the four callers float this popover over an unsaved draft —
                  FolderConfigModal's folder form (name, colour, tags,
                  directory), RepoSettings' repo form, ProjectScaffolderPage's
                  wizard — and the hand-off would navigate away from it. ChatPage
                  opts in; its composer draft is persisted. When on, the popover
                  closes itself so it does not float over the chat it hands to. */}
              <ErrorNotice
                variant="inline"
                className="whitespace-normal flex-1 min-w-0"
                askAgent={errorHandoff}
                onHandoff={() => onOpenChange(false)}
                report={browseNotice.report}
                message={browseNotice.message}
                testId={browseNotice.testId}
              />
              {canRetryListing && (
                // Inert-but-focusable while its re-ask is out, like WorkspacePicker's Retry:
                // `aria-disabled` plus the in-handler guard, NOT `disabled`, which blurs it.
                <button
                  type="button"
                  onClick={retryListing}
                  aria-disabled={listingInFlight || undefined}
                  className="px-2 py-1 text-[11px] bg-accent/20 text-accent rounded hover:bg-accent/30 shrink-0 aria-disabled:opacity-50"
                >
                  {listingInFlight ? i18nT('components.projectPicker.retrying') : i18nT('components.projectPicker.retry')}
                </button>
              )}
            </div>
          )}
          <div id="pp-browse-list" role="listbox" aria-label={i18nT('components.projectPicker.subdirectories')} className="overflow-y-auto flex-1 min-h-0">
            {!shownListingFailed && filteredBrowse.length === 0 && <div className="px-3 py-4 text-[12px] text-muted text-center">{i18nT('components.projectPicker.no_subdirectories')}</div>}
            {filteredBrowse.map((d, i) => (
              <button
                key={d.path}
                role="option"
                aria-selected={i === browseSel}
                id={`pp-dir-${i}`}
                tabIndex={-1}
                ref={el => { browseItemRefs.current[i] = el }}
                className={`w-full text-left px-3 py-1.5 flex items-center gap-2 cursor-pointer transition-colors ${i === browseSel ? 'bg-bg-hover' : 'hover:bg-bg-hover'}`}
                onMouseEnter={() => setBrowseSel(i)}
                onClick={() => browse(d.path)}
              >
                <FolderOpen size={12} className="text-accent shrink-0" />
                <span className="text-[13px] font-mono text-text truncate">{d.name}</span>
                <ChevronRight size={12} className="text-muted ml-auto shrink-0" />
              </button>
            ))}
          </div>
        </>
      )}
    </div>,
    document.body
  )
}
