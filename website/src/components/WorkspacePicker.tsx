import { useState, useEffect, useRef, useCallback, useId, RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { FolderOpen, ChevronRight, ChevronLeft } from 'lucide-react'
import { api } from '../api/client'
import ErrorNotice from './ErrorNotice'

import { i18nT } from '../i18n/t'
import { useImeGuard } from '../hooks/useImeGuard'
import { LISTING_FAILURE_KEYS, searchErrorCause, type SearchErrorCause } from '../lib/searchErrorCause'

// Copy for a failed listing that names the path the FAILED read asked for. After a failed drill
// the input and the rows still show the listing the drill left from, so the shared folder-panel
// copy ("No access to this folder", "Folder listing timed out") named the wrong folder: the one on
// screen, not the one that failed. Every arm is here: the permanent ones name the refused path
// and the next step, and the timed-out and failed ones name it because Retry re-asks that same
// path. Only a read with no path of its own -- the opening `browse()`, which the backend resolves
// to `$HOME` -- falls back to the shared pathless copy in `LISTING_FAILURE_KEYS`. Kept as this
// picker's own keys rather than ProjectPicker's: its copy also restates the listing still shown,
// and one key serving two pickers lets a rewording for one silently change the other.
const NAMED_PATH_KEYS: Record<SearchErrorCause, string> = {
  timed_out: 'components.workspacePicker.listing_timed_out',
  failed: 'components.workspacePicker.listing_failed',
  denied: 'components.workspacePicker.listing_denied',
  root_missing: 'components.workspacePicker.listing_root_missing',
}

/** One listing request. `path` is the directory to list (`undefined` = the opening read, which
 *  the backend resolves to `$HOME`); `seedField` seeds the path input from the response unless the
 *  user has since typed; `gen` makes every user-initiated request a DISTINCT react-query key, so a
 *  superseded read is abandoned by react-query (the latest key is the only observed one -- the
 *  guarantee the hand-rolled `listingSeq` ticket used to give), a same-path re-ask (Retry, reopen)
 *  still refetches, and a `null` request suspends the read while the create form or a closed
 *  popover is up. */
interface ListReq {
  gen: number
  path?: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchorRef: RefObject<HTMLElement | null>
  onCreated: (name: string) => void
}

export default function WorkspacePicker({ open, onOpenChange, anchorRef, onCreated }: Props) {
  // One instance covers both inputs; the binding's focus/blur reset makes sharing safe.
  const ime = useImeGuard()
  // Stable per-instance id, folded into the react-query keys so two mounts of this picker never
  // share a cache entry (the counters restart at 1 in every instance).
  const instanceId = useId()
  const [input, setInput] = useState('')
  const [selectedDir, setSelectedDir] = useState('')
  const [wsName, setWsName] = useState('')
  /** Client-side hint ("name is required"): not a failure, so not an ErrorNotice. */
  const [error, setError] = useState('')
  /** The create form's OWN request failure. The listing failure comes off `useQuery` below. */
  const [createError, setCreateError] = useState('')
  const [creating, setCreating] = useState(false)
  const btnRef = anchorRef
  const dropRef = useRef<HTMLDivElement>(null)

  // The listing request on screen. `gen` increments per user-initiated request so react-query
  // treats each as its own entry; a superseded read is the one no observer holds, so react-query
  // never applies its result (the guarantee the hand-rolled `listingSeq` ticket gave by hand).
  // `fieldOwned` records whether the user has typed since this request started, so a listing that
  // lands after a keystroke does not seed the field over what was typed.
  const [req, setReq] = useState<ListReq>({ gen: 0, path: undefined })
  const [fieldOwned, setFieldOwned] = useState(false)
  const genRef = useRef(0)
  // The generation RETIRED by leaving the browse pane (Select) or closing the popover (Escape,
  // click outside): its late result -- success OR failure -- must not land, exactly as the old
  // ticket bump abandoned the in-flight read at those sites. A late success would otherwise
  // commit rows the create form then returns to, and a late failure would raise a notice over a
  // closed/closing pane.
  const retiredGenRef = useRef(-1)
  // The generation whose late FAILURE must be dropped because the user typed a DIFFERENT path
  // over the read while it was in flight (the `inputEdits` guard this replaces): the notice would
  // otherwise name a path the user has replaced, and its Retry would re-ask it. A late SUCCESS
  // still lands its rows (the field is already the user's, so it is not re-seeded).
  const editedGenRef = useRef(-1)
  // A SYNCHRONOUS mirror of the listing read's in-flight state. react-query's `isFetching` is the
  // source of truth, but it notifies observers on a batched scheduler, a tick after the request
  // starts; this flag flips the instant a request is issued so the Retry control relabels to the
  // inert "Retrying…" on the very click, with no second press possible in between. Cleared when
  // the query settles. This is a UX mirror, not the staleness ticket the migration removed --
  // react-query's query key, not this boolean, decides which read wins.
  const [pending, setPending] = useState(false)
  // The last listing that SUCCEEDED, and the last failure, both COMMITTED from the query as it
  // settles -- rows, `browsePath` and the notice come from here, never straight from the query's
  // transient `data` / `isError`. The old code wrote these in the read's `.then` / `.catch` and
  // cleared them deliberately, so a Retry's re-ask (which react-query may briefly report as
  // neither error nor success) keeps the directory and the notice it is retrying on screen until
  // the re-ask actually lands.
  const [shown, setShown] = useState<{ path: string; parent: string; dirs: { name: string; path: string }[] } | null>(null)
  const [failure, setFailure] = useState<{ path?: string; cause: SearchErrorCause } | null>(null)

  const {
    data,
    error: listError,
    isError,
    isFetching,
  } = useQuery({
    // Per-instance id first so two WorkspacePicker mounts (e.g. one kept mounted elsewhere) cannot
    // collide on a shared `['ws-browse-dirs', gen, …]` key and serve each other's cached listing;
    // then `gen` so a same-path re-ask (reopen) is a new key; the path is carried for readable
    // devtools keys. Suspended on the create form (`selectedDir`), which owns the field and the
    // chosen directory -- the browse pane's landing is not for it.
    queryKey: ['ws-browse-dirs', instanceId, req.gen, req.path ?? ''],
    queryFn: () => api.browseDirs(req.path),
    // `req.gen > 0` holds the read until the open effect issues the real opening request: the
    // initial `{gen: 0}` is a placeholder, and firing on it would spend a listing the open
    // effect's own `browse(undefined)` immediately re-issues.
    enabled: open && !selectedDir && req.gen > 0,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  })

  // Commit the query's settled result ONCE per generation, synchronously as it lands. Keyed on
  // the request generation so a still-errored query does not re-commit a failure the user has
  // since cleared by typing, and a still-cached success does not re-commit after a dismissal. A
  // success replaces the shown listing and clears any failure; a failure records the path it
  // asked for and its cause, leaving the shown rows in place.
  const committedRef = useRef(-1)
  if (committedRef.current !== req.gen && !isFetching) {
    if (req.gen === retiredGenRef.current) {
      // Retired by an exit: abandon the late result, success or failure, but still clear the
      // in-flight mirror and mark it committed so it is not re-examined.
      committedRef.current = req.gen; if (pending) setPending(false)
    } else if (data && !isError) {
      committedRef.current = req.gen
      if (data !== shown) setShown(data)
      if (failure) setFailure(null)
      if (pending) setPending(false)
      // Seed the field with the listing's own path, here on the committed success (not in a
      // `fieldOwned`-keyed effect, which re-fired with the OLD listing the instant `browse` reset
      // `fieldOwned`). Skipped when the field is the user's: a listing asked for while typed text
      // stands lands its rows but leaves the field alone.
      if (!fieldOwned && input !== data.path) setInput(data.path)
    } else if (isError) {
      committedRef.current = req.gen; if (pending) setPending(false)
      // A late failure of a read the user has typed OVER names a path they are replacing, so drop
      // it (the removed `inputEdits` guard). The exemption is for a read that NAMED a path: the
      // pathless opening read names none, and with nothing listed its notice is the pane's only
      // remedy, so it is never dropped.
      if (!req.path || req.gen !== editedGenRef.current) setFailure({ path: req.path, cause: searchErrorCause(listError) })
    }
  }

  const browsePath = shown?.path ?? ''
  const browseParent = shown?.parent ?? ''
  const browseDirs = shown?.dirs ?? []
  // The path the FAILED read asked for. A failure always names the read it belongs to.
  const failedBrowsePath = failure?.path
  // Typing is the recovery: a notice that NAMES a path (a failed drill or Back) is about one the
  // user is replacing, so a keystroke drops it (`failure` cleared on edit). The pathless
  // opening-read notice names no path, so it stays -- with nothing listed it is the pane's only
  // remedy.
  const requestErrorCause = failure ? failure.cause : null
  const requestError = requestErrorCause
    ? (failedBrowsePath
      ? i18nT(NAMED_PATH_KEYS[requestErrorCause], { path: failedBrowsePath })
      : i18nT(LISTING_FAILURE_KEYS[requestErrorCause]))
    : ''

  const browse = useCallback((path?: string, keepField = false) => {
    genRef.current += 1
    setFieldOwned(keepField)
    setPending(true)
    setReq({ gen: genRef.current, path })
  }, [])

  // Open / reopen: run the opening read afresh. The mount outlives a close (the parent toggles
  // `open`), so a new generation re-asks `$HOME` each time the picker opens. The last open's rows
  // stay in `shown` until the reopen's read answers -- the failure gate hides them if it fails,
  // and a landing replaces them -- so an empty list never blinks over the round trip. The
  // create-form state (`selectedDir`, `wsName`) is NOT reset here: a parent-driven reopen while
  // the create form is up keeps the chosen directory and the typed name, as before this migration
  // (the opening read stays queued behind the form until Back leaves it).
  useEffect(() => {
    if (!open) return
    setError(''); setCreateError(''); setCreating(false)
    // A failure committed just before a close must not survive the reopen as a stale notice; the
    // opening read below re-populates it if the new read also fails.
    setFailure(null)
    browse(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      const handler = (e: MouseEvent) => {
        if (dropRef.current && !dropRef.current.contains(e.target as Node) &&
            btnRef.current && !btnRef.current.contains(e.target as Node)) {
          retiredGenRef.current = genRef.current; setFailure(null); setReq({ gen: 0, path: undefined })
          onOpenChange(false); setSelectedDir(''); setWsName(''); setError(''); setCreateError('')
        }
      }
      document.addEventListener('mousedown', handler)
      cleanup = () => document.removeEventListener('mousedown', handler)
    }, 0)
    let cleanup = () => {}
    return () => { clearTimeout(timer); cleanup() }
    // `btnRef` is a stable ref object and the handler reads `.current` fresh;
    // `onOpenChange` is a parent callback that may not be memoized, so we only
    // (re)attach the click-outside listener on `open` transitions to avoid
    // tearing it down on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const selectDir = (dir: string) => {
    // Leaving the browse pane for the create form retires the in-flight listing read: its late
    // result -- success or failure -- is abandoned, as the old ticket bump did, so Back re-reads
    // rather than inheriting a listing that landed after the user left.
    retiredGenRef.current = req.gen
    setSelectedDir(dir)
    setWsName(dir.split('/').filter(Boolean).pop() || '')
    setInput(dir)
    setError('')
    setCreateError('')
    // Clear any listing failure too (the old clearRequestFailure did): otherwise Back returns to
    // the browse pane with a stale notice whose Retry re-asks the retired generation and is
    // discarded, so the notice would never clear.
    setFailure(null)
  }

  // Every exit from the create form that RETURNS to the browse pane (its Back, the name input's
  // Escape) -- not the ones that close the popover. With a listing already landed (`shown`) the
  // pane comes back to it, so re-enabling the query on the same key is a cache hit -- no round
  // trip, no re-seed. With none landed (Select left before the opening read answered) re-run the
  // opening read, keeping the typed field.
  const leaveCreateForm = () => {
    setSelectedDir(''); setWsName(''); setCreateError('')
    if (!browsePath) browse(undefined, true)
  }

  const create = async () => {
    const name = wsName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    if (!name) { setError(i18nT('components.workspacePicker.name_required')); return }
    setCreating(true); setError(''); setCreateError('')
    try {
      const res = await api.createWorkspace({ name, dir: selectedDir }) as { ok?: boolean; error?: string }
      if (res.error) { setCreateError(res.error); setCreating(false); return }
      onCreated(name)
      onOpenChange(false); setSelectedDir(''); setWsName('')
    } catch { setCreateError(i18nT('components.workspacePicker.failed_to_create_workspace')) }
    setCreating(false)
  }

  if (!open || !btnRef.current) return null

  const q = input.toLowerCase()
  const filteredBrowse = q && q !== browsePath.toLowerCase() ? browseDirs.filter(d => d.name.toLowerCase().includes(q.split('/').pop() || '') || d.path.toLowerCase().includes(q)) : browseDirs
  const canRetryBrowse = requestErrorCause === 'timed_out' || requestErrorCause === 'failed'
  // The in-flight state the Retry control reads. `pending` flips synchronously on the request so
  // the inert "Retrying…" shows on the very click; `isFetching` keeps it true for any read
  // react-query still has out.
  const browsing = pending || isFetching
  // The "No subdirectories" empty-state and the notice for a failed read of the listing ON
  // SCREEN describe the same list, so those two never share the screen. Only that failure
  // hides it. `requestError` on this view is always a listing failure. The failed read was this
  // listing's when its path names `browsePath`, or when either side has no name -- the opening
  // read is `browse()` with no path, and a first open that never listed has nothing on screen
  // to be empty. A failed read of a DIFFERENT path -- Back from an empty directory whose parent
  // then fails -- leaves the shown listing intact, so its empty-state stays beside the notice
  // rather than a blank list region.
  const shownListingFailed = !!requestError
    && (!failedBrowsePath || !browsePath || failedBrowsePath === browsePath)

  return createPortal(
        <div ref={dropRef} className="fixed z-[9999] bg-card border border-border rounded-lg shadow-lg w-[400px] max-h-[460px] flex flex-col overflow-hidden animate-slide-up" style={(() => { const r = btnRef.current!.getBoundingClientRect(); const maxH = window.innerHeight - r.bottom - 8; return { top: r.bottom + 4, left: Math.max(8, r.right - 400), maxHeight: Math.max(200, maxH) } })()}>
          {selectedDir ? (
            <div className="p-3 flex flex-col gap-2">
              <div className="text-[12px] text-muted font-medium uppercase tracking-wider">{i18nT('components.workspacePicker.create_workspace')}</div>
              <div className="text-[13px] font-mono text-text truncate bg-bg-elevated rounded px-2 py-1.5 border border-border">{selectedDir}</div>
              <input autoFocus type="text" aria-label={i18nT('components.workspacePicker.workspace_name')} placeholder={i18nT('components.workspacePicker.workspace_name_2')} value={wsName} onChange={e => { setWsName(e.target.value); setError(''); setCreateError('') }} {...ime.bindEnter({ onEnter: create, onEscape: leaveCreateForm })} className="bg-bg-elevated border border-border rounded px-2 py-1.5 text-[13px] font-mono text-text placeholder:text-muted focus:outline-hidden focus-visible:border-accent" />
              {error && <div className="text-[11px] text-danger">{error}</div>}
              {/* No hand-off: the workspace name in `wsName` and the chosen directory are unsaved until Create. */}
              <ErrorNotice message={createError} />
              <div className="flex gap-2 justify-end">
                <button onClick={leaveCreateForm} className="px-3 py-1.5 text-[12px] text-muted hover:text-text rounded">{i18nT('components.workspacePicker.back')}</button>
                <button onClick={create} disabled={creating} className="px-3 py-1.5 text-[12px] bg-accent text-accent-fg rounded hover:bg-accent/80 disabled:opacity-50">{creating ? i18nT('components.workspacePicker.creating') : i18nT('components.workspacePicker.create')}</button>
              </div>
            </div>
          ) : (
            <>
              <div className="p-2 border-b border-border flex gap-1 items-center">
                {browseParent && browseParent !== browsePath && (
                  <button onClick={() => browse(browseParent)} className="p-1 text-muted hover:text-text rounded hover:bg-bg-hover shrink-0" title={i18nT('components.workspacePicker.back')} aria-label={i18nT('components.workspacePicker.back')}><ChevronLeft size={16} /></button>
                )}
                <input autoFocus type="text" aria-label={i18nT('components.workspacePicker.project_directory_path')} placeholder={i18nT('components.workspacePicker.path_to_project')} value={input} onChange={e => {
                  // Typing is the recovery, as in ProjectPicker: a notice that names a path
                  // (a failed drill or Back) names one the user is replacing, and its Retry
                  // re-asks that path, not the input. The pathless notice of the opening read
                  // stays: it names no path, and with nothing listed it is the pane's only
                  // remedy. The keystroke claims the FIELD, not the listing: whatever is in
                  // flight still lands its rows but will not seed over the typed text.
                  setInput(e.target.value); setFieldOwned(true)
                  // Typing is the recovery only for a notice that NAMES a path the user is
                  // replacing; the pathless opening-read notice stays (its remedy is the only one
                  // the pane has with nothing listed). The keystroke also marks the read in
                  // flight as typed-over, so its late FAILURE is dropped rather than naming the
                  // replaced path.
                  editedGenRef.current = req.gen
                  if (failedBrowsePath) setFailure(null)
                }} {...ime.bindEnter({ onEnter: () => { if (input.trim()) selectDir(input.trim()) }, onEscape: () => { retiredGenRef.current = req.gen; setFailure(null); onOpenChange(false) } })} className="flex-1 bg-bg-elevated border border-border rounded px-2 py-1.5 text-[13px] font-mono text-text placeholder:text-muted focus:outline-hidden focus-visible:border-accent" />
                {/* Nothing to select (a blank field and nothing listed yet) is a no-op, as Enter on a
                    blank field is. */}
                <button onClick={() => { const dir = input.trim() || browsePath; if (dir) selectDir(dir) }} className="px-2 py-1 text-[11px] bg-accent/20 text-accent rounded hover:bg-accent/30 shrink-0">{i18nT('components.workspacePicker.select')}</button>
              </div>
              {/* No hand-off: the path typed into `input` and the browse position
                  (`browsePath`) are unsaved until Select, and a hand-off would navigate
                  away from both. The remedy is local instead: Retry re-runs the listing
                  that failed, since the surface has no Refresh of its own. */}
              {requestError && (
                <div className="flex items-center gap-2 pr-2" aria-busy={browsing || undefined}>
                  <ErrorNotice className="flex-1 min-w-0" message={requestError} />
                  {canRetryBrowse && (
                    // Relabelled and inert while its request is in flight, so the wait is visible
                    // and a second press is impossible. Inert-but-focusable like FolderPanel's
                    // Refresh: `aria-disabled` plus the in-handler guard, NOT `disabled`, which
                    // leaves the tab order and so blurs the focused element in real browsers --
                    // a keyboard press would drop focus to <body> for the whole re-ask. Retry
                    // re-issues the failed read via `browse(failedBrowsePath)` (a fresh
                    // generation): the committed `failure` state keeps the notice up through the
                    // re-ask, and a success seeds the field with the listed path as any read does.
                    <button
                      type="button"
                      onClick={() => { if (browsing) return; browse(failedBrowsePath) }}
                      aria-disabled={browsing || undefined}
                      className="px-2 py-1 text-[11px] bg-accent/20 text-accent rounded hover:bg-accent/30 shrink-0 aria-disabled:opacity-50"
                    >
                      {browsing ? i18nT('components.workspacePicker.retrying') : i18nT('components.workspacePicker.retry')}
                    </button>
                  )}
                </div>
              )}
              <div className="overflow-y-auto flex-1 min-h-0">
                {browsePath && !shownListingFailed && filteredBrowse.length === 0 && <div className="px-3 py-4 text-[12px] text-muted text-center">{i18nT('components.workspacePicker.no_subdirectories')}</div>}
                {filteredBrowse.map(d => (
                  <button key={d.path} className="w-full text-left px-3 py-1.5 flex items-center gap-2 cursor-pointer hover:bg-bg-hover transition-colors" onClick={() => browse(d.path)}>
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
