import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { api } from '../api/client'
import { i18nT } from '../i18n/t'
import { useListKeyboardNav } from '../hooks/useListKeyboardNav'
import { menuGeometry, bottomUpOrder } from '../lib/pickerMenu'
import type { SendMode } from '../pages/chat/ChatSettings'

interface SlashCommand {
  name: string
  /**
   * Description as the SERVER sent it (English). Only a fallback for display —
   * {@link commandDescription} prefers the catalog. Optional because the local
   * command lists below carry no copy of their own; the backend itself also
   * sends `""` for a command missing from its description map.
   */
  description?: string
  /**
   * What this row is and how selecting it feeds the composer.
   *
   * - `'command'` (default, omitted) — a slash command. Selecting inserts the
   *   literal token (`/compact `) and the backend/intercept layer acts on it.
   * - `'prompt'` — an Agent SOP / saved prompt discovered from `/api/prompts`.
   *   The composer has no `/`-grammar that invokes a prompt; the invocation
   *   path is the `@<fullName>` mention the submit path expands via
   *   `_expand_prompt_mention()` (the same token the Cmd-K palette and the
   *   PromptsTab insert). So selecting a prompt row inserts `@<fullName> `, NOT
   *   a slash token. These rows are surfaced in the `/` menu purely for
   *   discovery (issue #9924) and never touch `GET /api/slash-commands`.
   */
  kind?: 'command' | 'prompt'
  /**
   * For a `'prompt'` row only: the mention token to insert, e.g.
   * `agent-sop:pdd` for a package SOP or the bare stem for a user prompt. The
   * row both DISPLAYS and INSERTS `@<fullName>` (` ` appended on insert), while
   * it is FILTERED by the bare `fullName` so typing `/agent-sop:` finds it.
   */
  fullName?: string
}

/**
 * Catalog KEY for each command's description, keyed by the command's TRIGGER
 * TOKEN.
 *
 * The token (`/compact`) is the command itself — what the user types and what
 * `onSelect` inserts into the composer — so it is never translated; only the
 * description is copy.
 *
 * Keys, not strings: this table is evaluated at module load, so an `i18nT()`
 * call here would freeze the boot language and never re-resolve on a language
 * switch. The lookup happens in {@link commandDescription}, which runs during
 * render. Shaped as a flat `Record` of full literal keys, indexed inline at the
 * `i18nT()` call, because that is the form `scripts/check-i18n-keys.mjs` can
 * resolve statically.
 *
 * This is also what localises the LIVE path, not just the offline fallback. The
 * descriptions normally come from `GET /api/slash-commands` (backend
 * `SLASH_COMMAND_DESCRIPTIONS`), which is English-only and replaces the fallback
 * as soon as the query resolves — so translating the fallback array alone would
 * have shown localised text for a few milliseconds and English from then on.
 * Resolving by token covers both sources.
 *
 * `/q` and `/quit` are aliases and deliberately share one key rather than
 * duplicating the string.
 */
const COMMAND_DESC_KEY: Record<string, string> = {
  '/agent': 'components.slashCommandMenu.desc_agent',
  // Alias of /side, so it shares the description key deliberately: the two
  // rows must never drift apart, and the locale catalogs stay untouched.
  '/btw': 'components.slashCommandMenu.desc_side',
  '/changelog': 'components.slashCommandMenu.desc_changelog',
  '/chat': 'components.slashCommandMenu.desc_chat',
  '/clear': 'components.slashCommandMenu.desc_clear',
  '/code': 'components.slashCommandMenu.desc_code',
  '/compact': 'components.slashCommandMenu.desc_compact',
  '/context': 'components.slashCommandMenu.desc_context',
  '/editor': 'components.slashCommandMenu.desc_editor',
  '/exit': 'components.slashCommandMenu.desc_exit',
  '/experiment': 'components.slashCommandMenu.desc_experiment',
  '/help': 'components.slashCommandMenu.desc_help',
  '/hooks': 'components.slashCommandMenu.desc_hooks',
  '/issue': 'components.slashCommandMenu.desc_issue',
  '/kb': 'components.slashCommandMenu.desc_kb',
  '/logdump': 'components.slashCommandMenu.desc_logdump',
  '/mcp': 'components.slashCommandMenu.desc_mcp',
  '/model': 'components.slashCommandMenu.desc_model',
  '/onboarding': 'components.slashCommandMenu.desc_onboarding',
  '/paste': 'components.slashCommandMenu.desc_paste',
  '/plain': 'components.slashCommandMenu.desc_plain',
  '/prompts': 'components.slashCommandMenu.desc_prompts',
  '/q': 'components.slashCommandMenu.desc_quit',
  '/quit': 'components.slashCommandMenu.desc_quit',
  '/reply': 'components.slashCommandMenu.desc_reply',
  '/side': 'components.slashCommandMenu.desc_side',
  '/tangent': 'components.slashCommandMenu.desc_tangent',
  '/todos': 'components.slashCommandMenu.desc_todos',
  '/tools': 'components.slashCommandMenu.desc_tools',
  '/usage': 'components.slashCommandMenu.desc_usage',
  '/workflow': 'components.slashCommandMenu.desc_workflow',
}

/**
 * Localised description for a command row, resolved per render.
 *
 * A command the backend reports that has no entry above (a new server-side
 * command this build has no key for) falls back to the server's own English
 * text rather than rendering a raw key.
 */
function commandDescription(cmd: SlashCommand): string {
  // Prompt rows (#9924) carry the SOP's own description from /api/prompts and
  // have no COMMAND_DESC_KEY entry, so use it directly rather than resolving a
  // catalog key that does not exist for them.
  if (cmd.kind === 'prompt') return cmd.description ?? ''
  // `hasOwnProperty`, not `in`: the names come from the API, so a backend
  // reporting `toString` or `constructor` would otherwise resolve to an
  // inherited Object.prototype member and hand a function to i18next.
  return Object.prototype.hasOwnProperty.call(COMMAND_DESC_KEY, cmd.name)
    ? i18nT(COMMAND_DESC_KEY[cmd.name])
    : cmd.description ?? ''
}

/** The token selecting a row inserts into the composer. A command inserts its
 *  own literal slash token; a prompt inserts the `@<fullName>` mention the
 *  submit path expands (`_expand_prompt_mention()`), matching the Cmd-K palette
 *  and PromptsTab — there is no `/`-grammar that invokes a prompt. Both get a
 *  trailing space so the caret lands ready for an argument. */
function insertionFor(cmd: SlashCommand): string {
  return cmd.kind === 'prompt' ? `@${cmd.fullName} ` : `${cmd.name} `
}

/** The text a row is FILTERED and SORTED by: for a prompt it is the fullName
 *  the user types after `/` (`agent-sop:pdd`), for a command the token minus
 *  its leading slash (`compact`). */
function filterToken(cmd: SlashCommand): string {
  return cmd.kind === 'prompt' ? (cmd.fullName ?? '') : cmd.name.slice(1)
}

// Offline fallback shown before the API query resolves (or if it fails).
// Kept in sync with the backend's GET /api/slash-commands payload — the
// _SLASH_COMMANDS set MINUS _BLOCKED_SLASH_COMMANDS — so the same commands
// appear whether they came from the live API or this fallback. Blocked
// commands (/quit, /exit, /q, /chat, /paste, /reply, /editor, /tangent) are
// terminal-only kiro-cli gestures the dashboard rejects, and /todos is one the
// ACP harness does not implement, so suggesting any of them anywhere is an
// inert affordance; the descriptions themselves come from COMMAND_DESC_KEY
// either way. /kb is a frontend-only command (also merged via
// FRONTEND_COMMANDS below).
const FALLBACK_COMMAND_NAMES = [
  '/agent', '/changelog', '/clear', '/code', '/compact', '/context',
  '/experiment', '/help', '/hooks', '/issue', '/kb', '/logdump',
  '/mcp', '/model', '/prompts', '/side', '/tools', '/usage', '/workflow',
] as const

const FALLBACK_COMMANDS: SlashCommand[] = FALLBACK_COMMAND_NAMES.map(name => ({ name }))

interface Props {
  input: string
  anchorRef: React.RefObject<HTMLElement | null>
  onSelect: (command: string) => void
  onClose: () => void
  open?: boolean
  /**
   * The composer's effective send binding (see ChatInput's SendMode). Only
   * read by the settled-empty copy: in 'ctrl-enter' mode a released bare
   * Enter is a newline, so the announcement must name Ctrl+Enter instead.
   */
  sendOnEnter?: SendMode
  /**
   * Opt in to surfacing Agent SOP / saved-prompt rows in the `/` menu (#9924).
   *
   * Default `false`: adding SOP rows changes what EVERY user's `/` menu lists,
   * and that is a product-shape change the base carries no RFC for (First
   * Principles BLOCK on this PR). So the discovery rows are the user's call —
   * gated behind the `showSopPrompts` chat setting (default off), exactly like
   * `inlineMarkdown` / `doubleClickToEdit` and the other opt-ins that alter a
   * surface everyone sees. When this is false the `/api/prompts` query is left
   * disabled and the menu renders only the curated slash commands — byte-for-
   * byte the pre-#9924 default. Flipping the setting on is what asks for the
   * rows; nothing a client with no stored config inherits.
   */
  showPromptRows?: boolean
}

/**
 * Commands the backend's GET /api/slash-commands does not report, merged in so
 * the menu still offers them. Two different kinds live here, and the difference
 * matters when adding a row:
 *
 * - CLIENT-INTERCEPTED (`/btw`, `/kb`, `/onboarding`): the composer recognises
 *   the text and acts on it locally; the message is never sent. Those also need
 *   a branch in `interceptSlashCommand` (`/btw` rides `/side`'s — it is a pure
 *   alias, matched by the same SIDE_RE).
 * - QUICK PROMPT (`/plain`): a backend MACRO. The message IS sent, unchanged, and
 *   `ContextBuilder.build_message` swaps the token for the instruction it stands
 *   for (`src/kiro_crew/quick_prompts.py`). It must therefore stay OUT of
 *   `interceptSlashCommand` — intercepting it would stop it ever reaching the
 *   expansion — and out of the kiro-cli passthrough set, which would forward it
 *   to a harness that has no such command.
 */
const FRONTEND_COMMAND_NAMES = ['/btw', '/kb', '/onboarding', '/plain'] as const

const FRONTEND_COMMANDS: SlashCommand[] = FRONTEND_COMMAND_NAMES.map(name => ({ name }))

/**
 * Stable fallback for the `/api/prompts` query (GPT 6.1 F2, upheld).
 *
 * A `useQuery(... )` default written inline as `= []` mints a FRESH array on
 * every render while `promptData` is undefined — the initial load, a failed
 * load, or a disabled query. That new reference invalidates the `promptCommands`
 * / `commands` / `filtered` memos each render, so the ordering effect calls
 * `setDisplayed` with another new array and schedules yet another render — an
 * unbounded update loop that fires on every composer mount, even while the menu
 * is closed. Pointing the default at this ONE frozen module-level value keeps
 * the reference stable across renders, so the memos settle. `readonly []`
 * widens cleanly to the `unknown[]` the query is typed as.
 */
const EMPTY_PROMPTS: readonly unknown[] = Object.freeze([])

export default function SlashCommandMenu({ input, anchorRef, onSelect, onClose, open = true, sendOnEnter = 'enter', showPromptRows = false }: Props) {
  const { data: apiCommands = FALLBACK_COMMANDS, isFetching, isError } = useQuery<SlashCommand[]>({
    queryKey: ['slash-commands'],
    queryFn: ({ signal }) => api.slashCommands(signal),
    enabled: typeof api.slashCommands === 'function',
  })

  // Agent SOPs / saved prompts, surfaced in the `/` menu for discovery (#9924).
  // Reuses the SAME ['prompts'] react-query entry the Cmd-K palette and the
  // PromptsTab share, so it is usually already warm and reopening the menu is
  // free. These rows are a DISCOVERY surface only: they are never sent to or
  // merged into GET /api/slash-commands (whose curated/blocked-list invariants
  // stay untouched), and selecting one inserts the existing `@<fullName>`
  // invocation mention rather than a new slash grammar.
  //
  // Gated on `showPromptRows` (the opt-in chat setting, default off): when the
  // user has not opted in the query is DISABLED, so no `/api/prompts` request
  // fires and the menu lists only curated commands — the pre-#9924 default for
  // every user. The `= EMPTY_PROMPTS` default is the ONE frozen module-level
  // array (not an inline `[]`), so a disabled or not-yet-resolved query hands a
  // stable reference to the memos below and never re-triggers the ordering
  // effect in a loop (GPT 6.1 F2).
  const { data: promptData = EMPTY_PROMPTS, isError: promptError } = useQuery<unknown[]>({
    queryKey: ['prompts'],
    queryFn: () => api.prompts(),
    enabled: showPromptRows && typeof api.prompts === 'function',
    staleTime: 30_000,
  })
  const promptCommands = useMemo<SlashCommand[]>(() => {
    // Gate on `showPromptRows`, not only on the query's `enabled` (GPT 6.1 F2):
    // `enabled: false` stops a FETCH but does not clear a CACHE entry a sibling
    // surface (PromptsTab, the Cmd-K palette) already warmed under the shared
    // `['prompts']` key. Reading `promptData` unconditionally would then leak
    // those cached SOPs into the `/` menu of a user who never opted in. Returning
    // early when the setting is off keeps the opt-in honest regardless of cache.
    if (!showPromptRows) return []
    const rows: SlashCommand[] = []
    for (const p of promptData) {
      // /api/prompts is loosely typed at the client layer; pin the two fields
      // this reads and skip any entry missing a usable fullName.
      const fullName = (p as { fullName?: unknown }).fullName
      if (typeof fullName !== 'string' || fullName === '') continue
      const description = (p as { description?: unknown }).description
      rows.push({
        // DISPLAY token: `@<fullName>` — the SAME string insertionFor() inserts,
        // so the row shows exactly what lands in the composer (UX BLOCK: a row
        // must not label one token and insert another). The leading `@` also
        // visually sets a prompt mention apart from a `/command`; the badge
        // rendered on the row names the kind and what selecting it does. `name`
        // is only the row's display label and dedup/`key`; filtering and sorting
        // use filterToken() (the bare fullName), so typing `/agent-sop:` finds it.
        name: `@${fullName}`,
        kind: 'prompt',
        fullName,
        description: typeof description === 'string' ? description : '',
      })
    }
    return rows
  }, [promptData, showPromptRows])

  const commands = useMemo(() => {
    const names = new Set(apiCommands.map(c => c.name))
    const base = [...apiCommands, ...FRONTEND_COMMANDS.filter(c => !names.has(c.name))]
    // Prompt rows last in the base list; the final sort below is on the filter
    // token, which interleaves them deterministically with commands anyway.
    // Explicit 'en-US' locale (not host locale): these are ASCII command/prompt
    // tokens and the order must be the same for every user, independent of the
    // browser's language (the i18n host-locale gate).
    return [...base, ...promptCommands].sort((a, b) => filterToken(a).localeCompare(filterToken(b), 'en-US'))
  }, [apiCommands, promptCommands])

  // Trigger: widened from /^\/([a-z]*)$/ to admit the `:`, `-`, `_` and digits
  // that appear in SOP fullNames (`agent-sop:pdd`), so typing `/agent-sop:`
  // keeps the menu open and narrows to prompts (#9924). Still anchored to a
  // bare `/`-prefixed single token with no whitespace, so it never fires on a
  // sentence that merely contains a slash.
  const match = input.match(/^\/([a-z0-9:_-]*)$/)
  const visible = open && !!match
  const filter = match?.[1] ?? ''

  // Displayed order (bottom-up when the menu opens above); resultsRef mirrors it
  // so the keyboard-nav choose() indexes the same list the user sees.
  const [displayed, setDisplayed] = useState<SlashCommand[]>([])
  const resultsRef = useRef<SlashCommand[]>([])

  const choose = useCallback((idx: number) => {
    const r = resultsRef.current
    const c = r[idx >= r.length ? 0 : idx]
    if (c) onSelect(insertionFor(c))
  }, [onSelect])

  // Filter computed synchronously (not inside the ordering effect) so the
  // keyboard-release gate below reads the SAME render's match set — a gate
  // derived from the `displayed` state would lag one effect flush behind and
  // could release Enter while matches exist.
  const filtered = useMemo(
    () => (visible ? commands.filter(c => filterToken(c).startsWith(filter)) : []),
    [visible, filter, commands]
  )

  // Zero matches while `visible` is still true: the nav hook's document
  // listener stays attached, and an invisible surface must not swallow Enter
  // on unmatched slash input like "/xyz" (the #5029 trap, deferred to the
  // sibling pickers by #5041). Releasing (rather than auto-closing on empty)
  // keeps the composer's input-derived reopen path working when the user
  // backspaces to a matching prefix. `!isFetching` guards the one in-flight
  // window: a server-only command typed before the remote list replaces the
  // synchronous fallback is transiently a zero-match, and releasing there
  // would send the half-typed command as a chat message.
  const releaseKeysWhenEmpty = !isFetching && filtered.length === 0

  // Uses the SAME nav hook as the $skill / @file pickers, which gives the slash
  // menu arrow-scroll and consistent Enter/Tab/Escape.
  const { selected, setSelected, selectedRef, itemRefs } = useListKeyboardNav({
    open: visible,
    count: displayed.length,
    onChoose: choose,
    onClose,
    releaseKeysWhenEmpty,
  })

  // Order + initial selection: bottom-up when the menu opens above the input
  // (shared helper — identical to the other pickers). Keyed on the memoized
  // `filtered` so unrelated re-renders (e.g. arrow-key selection changes)
  // don't reset the selection.
  useEffect(() => {
    if (!visible) { setDisplayed([]); resultsRef.current = []; return }
    const above = anchorRef.current ? menuGeometry(anchorRef.current, filtered.length, 40).above : false
    const { ordered, initialIndex } = bottomUpOrder(filtered, above)
    setDisplayed(ordered); resultsRef.current = ordered
    setSelected(initialIndex)
  }, [visible, filtered, anchorRef, setSelected])

  // Scroll the selected row into view once it renders (open + filter change),
  // matching the $skill / @file pickers.
  useEffect(() => {
    if (!visible) return
    itemRefs.current[selectedRef.current]?.scrollIntoView({ block: 'nearest' })
  }, [displayed, visible, itemRefs, selectedRef])

  if (!visible || !anchorRef.current) return null
  // Rows are ordered by an effect, so a matching list is briefly empty here.
  // Render nothing until it lands, whether or not a refetch is in flight.
  if (displayed.length === 0 && filtered.length > 0) return null

  const { above, top, bottom, left, width, maxHeight } =
    menuGeometry(anchorRef.current, Math.max(displayed.length, 1), 40)

  /** Copy for the zero-row state. A settled ERROR is not a zero-match: both
   *  release Enter, but "No matching commands" asserts the live list was read
   *  and did not hold the typed prefix. On a failed load it was never read —
   *  the rows are the offline fallback, and the served list is provider-aware,
   *  so a command it would have offered may simply never have arrived. Named
   *  per the send binding on both paths, for the reason given below. */
  const emptyKey = isError
    ? (sendOnEnter === 'ctrl-enter'
        ? 'components.slashCommandMenu.commands_load_failed_ctrl_enter_sends'
        : 'components.slashCommandMenu.commands_load_failed_enter_sends')
    : (sendOnEnter === 'ctrl-enter'
        ? 'components.slashCommandMenu.no_matching_commands_ctrl_enter_sends'
        : 'components.slashCommandMenu.no_matching_commands_enter_sends')

  // While the fetch is in flight the release gate is still closed, so the send
  // key is swallowed here — name that hold instead of leaving it mute.
  const loadingKey = sendOnEnter === 'ctrl-enter'
    ? 'components.slashCommandMenu.loading_commands_ctrl_enter_held'
    : 'components.slashCommandMenu.loading_commands_enter_held'

  return createPortal(
    <div
      className="fixed z-[9999] bg-card border border-border rounded-lg shadow-lg overflow-y-auto py-1 animate-slide-up"
      role="listbox"
      style={{ ...(above ? { bottom } : { top }), left, width: Math.min(width, 480), maxHeight }}
    >
      {/* Surface a failed SOP/prompt load instead of letting it read as "no
          matches" (GPT 6.1 F1, errors-use-error-notice). Only when the user
          opted in AND the prompt query errored. This is a NON-interactive status
          row: it never hands off focus and never touches the composer draft, so
          a failed side-fetch cannot cost the user their typed message. The
          curated commands below still render; only the SOP rows are missing. */}
      {showPromptRows && promptError && (
        <div role="status" className="px-3 py-2 text-[12px] text-danger border-b border-border">
          {i18nT('components.slashCommandMenu.prompts_load_failed')}
        </div>
      )}
      {displayed.length === 0
        // Settled zero-match: Enter's meaning flips (pick → send), and the
        // menu vanishing on its own would leave that flip invisible — announce
        // it at the point of action, mirroring the $skill picker's empty state.
        // Named per the composer's send binding ('ctrl-enter' → bare Enter is
        // a newline); role="status" so screen-reader users hear the flip too.
        ? (isFetching
            ? <div role="status" className="px-3 py-3 text-[12px] text-muted">{i18nT(loadingKey)}</div>
            : <div role="status" className="px-3 py-3 text-[12px] text-muted">{i18nT(emptyKey)}</div>)
        : displayed.map((cmd, i) => (
        <button
          role="option"
          aria-selected={i === selected}
          tabIndex={-1}
          key={cmd.name}
          ref={el => { itemRefs.current[i] = el }}
          className={`w-full text-left px-3 py-2 flex items-start gap-3 cursor-pointer transition-colors ${i === selected ? 'bg-accent-subtle text-text' : 'text-muted hover:bg-bg-hover hover:text-text'}`}
          onMouseEnter={() => setSelected(i)}
          onMouseDown={e => { e.preventDefault(); onSelect(insertionFor(cmd)) }}
        >
          <span className="text-[13px] font-mono font-semibold text-accent shrink-0 leading-5">{cmd.name}</span>
          <span className="min-w-0 flex flex-col gap-0.5">
            {cmd.kind === 'prompt' && (
              // Say what the row IS and what picking it DOES, not just "Prompt"
              // (UX BLOCK: the reader could not tell whether picking runs the SOP
              // or only inserts text). This badge reads "SOP · inserts @mention",
              // so the row's action is explicit. Built from an existing
              // translated label + a short new key, so no cryptic tag is left.
              <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-bg-hover text-muted self-start">
                {i18nT('pages.overview.agentTemplatesTab.prompt')} · {i18nT('components.slashCommandMenu.prompt_inserts_mention')}
              </span>
            )}
            {/* Description wraps to a second line rather than truncating, so the
                only explanation a reader gets for an SOP is not cut off mid-word
                (UX BLOCK). `break-words` guards a long unbroken token. */}
            <span className="text-[12px] leading-5 break-words">{commandDescription(cmd)}</span>
          </span>
        </button>
      ))}
    </div>,
    document.body
  )
}
