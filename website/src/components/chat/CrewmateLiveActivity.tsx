/**
 * CrewmateLiveActivity — the one status line a crewmate's chat shows while its
 * turn runs: what the crewmate is doing right now (#18238).
 *
 * It sits in the footer column directly above the working indicator (the
 * ghost-pose carousel in `ChatFooter`), not in the transcript. That placement
 * is the point: a transcript row mounting and unmounting on every tool step
 * hopped the indicator up and down by a row each time. This line is ONE
 * fixed-height row, mounted for the WHOLE live turn (empty until the first
 * tool call, empty again after a `nothing_to_do` call), whose text swaps in
 * place — so the indicator under it never moves while the crewmate works.
 *
 * States: `current` (spinner + label), `done` (a check + the same label: a
 * thinking burst followed the call, so the step is over and the indicator
 * itself says "thinking" — shape, not a faded label, tells the two apart),
 * `empty` (nothing to name yet, or nothing to name at all).
 *
 * The label is the same one the ordinary transcript's tool pill shows for the
 * row (`deriveToolCallTitle` + `pickToolLabel`: simplified title / verbatim
 * command / the agent's purpose, under the same language guard), read from
 * the persisted row alone so a replayed and a live row agree. No details, no
 * disclosure — the Work log holds those; this is a status line, not a pill.
 */
import { useMemo } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Check, LoaderCircle } from 'lucide-react'
import { useAppSelector } from '../../store'
import { useSimplifiedToolNames } from '../../hooks/useSimplifiedToolNames'
import { useLanguage } from '../../i18n/LanguageProvider'
import { useLanguageGeneration } from '../../i18n/useLanguageGeneration'
import { deriveToolCallTitle } from '../../utils/toolCallTitle'
import { pickToolLabel } from '../../utils/toolLabel'
import type { CrewmateLiveActivity as Activity } from './crewmateBubbles'

export default function CrewmateLiveActivity({ activity, slot }: { activity: Activity | null; slot: string }) {
  const row = activity?.row
  const current = !!activity?.current
  const simplified = useSimplifiedToolNames()
  const uiLang = useLanguage().resolved
  const langGen = useLanguageGeneration()
  const reduce = useReducedMotion()
  // The slot's project directory, so native-tool titles show paths relative
  // to it — the same read ToolCallLine makes for its pill.
  const projectDir = useAppSelector(s => s.dashboard.slots.find(sl => sl.key === slot)?.project || undefined)
  const meta = (row?.meta ?? {}) as { tool_call_id?: unknown; purpose?: unknown; input?: unknown; kind?: unknown; tool_name?: unknown; mcp_server?: unknown }
  const rawLabel = row ? row.content.replace(/^🔧\s*/, '') : ''
  const label = useMemo(() => {
    void langGen // the localized title is a function of the catalog generation too
    if (!rawLabel) return ''
    const derived = deriveToolCallTitle({
      title: rawLabel,
      kind: typeof meta.kind === 'string' ? meta.kind : undefined,
      rawInput: meta.input,
      toolName: typeof meta.tool_name === 'string' ? meta.tool_name : undefined,
      mcpServer: typeof meta.mcp_server === 'string' ? meta.mcp_server : undefined,
      cwd: projectDir,
    })
    return pickToolLabel({
      simplified,
      purpose: typeof meta.purpose === 'string' ? meta.purpose : undefined,
      rawLabel,
      derivedTitle: derived.title,
      uiLang,
    })
  }, [rawLabel, meta.kind, meta.input, meta.tool_name, meta.mcp_server, meta.purpose, projectDir, simplified, uiLang, langGen])
  const id = typeof meta.tool_call_id === 'string' ? meta.tool_call_id : row?.ts
  const state = !row ? 'empty' : current ? 'current' : 'done'
  return (
    <div
      data-testid="crewmate-live-activity"
      data-state={state}
      className="px-4 mx-auto w-full py-1"
      style={{ maxWidth: 'var(--mc-content-width, 900px)' }}
    >
      {/* One line, pinned: `h-5` + `truncate` so a long label can never add a
          second line and move the indicator below; the empty state keeps the
          same height for the same reason. */}
      <div
        className="flex items-center gap-2 h-5 min-w-0 text-[13px] text-muted"
        role="status"
        aria-label={label || undefined}
        aria-hidden={row ? undefined : 'true'}
      >
        {row && (current
          ? <LoaderCircle size={12} className={`shrink-0 ${reduce ? '' : 'animate-spin'}`} aria-hidden="true" />
          : <Check size={12} className="shrink-0" aria-hidden="true" />)}
        {/* Keyed by the call so a new step fades in over the old text's place;
            the old span simply leaves — no exit animation, nothing to shift. */}
        {row && (
          <motion.span
            key={id}
            className="min-w-0 truncate leading-5"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25 }}
          >
            {label}
          </motion.span>
        )}
      </div>
    </div>
  )
}
