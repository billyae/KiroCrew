import { useId, useState } from 'react'
import { Play, Trash2 } from 'lucide-react'
import { SettingsSection, SettingsCard } from '../../components/settings'
import { Btn, IconButton, Input } from '../../components/ui'
import ErrorNotice from '../../components/ErrorNotice'
import {
  CUSTOM_TONE_LIMITS, validateCustomTone, playPreset, customSoundId,
  type CustomTones, type ToneStep,
} from '../../hooks/useNotificationSound'
import { i18nT } from '../../i18n/t'

/** The example from the request, shown as the tones box placeholder. Built
 *  from data: it is code, not copy, so it is the same in every language. */
const EXAMPLE_TONES: ToneStep[] = [
  { freq: 523, start: 0, dur: 0.2, gain: 1 },
  { freq: 784, start: 0.2, dur: 0.3, gain: 0.9 },
]
const exampleText = JSON.stringify(EXAMPLE_TONES)

/**
 * Read the tones text as data, never as code. Accepts plain JSON and the
 * shorthand the built-in table is written in: bare keys (`freq:`) and numbers
 * with no leading zero (`.2`). Anything else fails to parse.
 */
export function parseToneText(text: string): unknown {
  const json = text
    .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')
    .replace(/([:[,\s-])\.(\d)/g, (_m, before: string, digit: string) => `${before}0.${digit}`)
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

/** Catalog keys for each problem code `validateCustomTone` returns, as full
 *  literals so the i18n key check can resolve them. */
const PROBLEM_KEY: Record<string, string> = {
  name: 'pages.settings.notificationsPanel.custom_sound_error_name',
  name_taken: 'pages.settings.notificationsPanel.custom_sound_error_name_taken',
  count: 'pages.settings.notificationsPanel.custom_sound_error_count',
  freq: 'pages.settings.notificationsPanel.custom_sound_error_freq',
  dur: 'pages.settings.notificationsPanel.custom_sound_error_dur',
  gain: 'pages.settings.notificationsPanel.custom_sound_error_gain',
  start: 'pages.settings.notificationsPanel.custom_sound_error_start',
  too_many: 'pages.settings.notificationsPanel.custom_sound_error_too_many',
}

const L = CUSTOM_TONE_LIMITS
const problemText = (code: string): string => i18nT(PROBLEM_KEY[code], {
  max: code === 'name' ? L.maxNameLength
    : code === 'count' ? L.maxTones
      : code === 'freq' ? L.maxFreq
        : code === 'dur' ? L.maxDur
          : code === 'start' ? L.maxLength
            : L.maxSounds,
  min: code === 'freq' ? L.minFreq : L.minDur,
})

/**
 * Add, audition and delete the user's own named sounds. A saved sound is
 * listed in every sound picker on this page beside the built-ins.
 */
export function CustomSoundsSection({ customTones, volume, enabled, onAdd, onRemove }: {
  customTones: CustomTones
  volume: number
  enabled: boolean
  /** Returns false when the settings could not be saved. */
  onAdd: (name: string, tones: ToneStep[]) => boolean
  onRemove: (name: string) => void
}) {
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const names = Object.keys(customTones)
  const nameId = useId()
  const tonesId = useId()
  const tonesHintId = useId()

  const add = () => {
    const trimmed = name.trim()
    const tones = parseToneText(text)
    if (tones === undefined) {
      setErrors([i18nT('pages.settings.notificationsPanel.custom_sound_error_parse')])
      return
    }
    const problems = validateCustomTone(trimmed, tones, customTones)
    if (problems.length > 0) {
      setErrors(problems.map(problemText))
      return
    }
    if (!onAdd(trimmed, tones as ToneStep[])) {
      setErrors([i18nT('pages.settings.notificationsPanel.custom_sound_error_save')])
      return
    }
    setErrors([])
    setName('')
    setText('')
  }

  return (
    <SettingsSection title={i18nT('pages.settings.notificationsPanel.custom_sounds')}>
      <SettingsCard>
        <div className="text-[12px] text-muted">{i18nT('pages.settings.notificationsPanel.custom_sounds_description')}</div>
        {names.length === 0 ? (
          <div className="text-[13px] text-muted py-1.5">{i18nT('pages.settings.notificationsPanel.custom_sound_none')}</div>
        ) : (
          <ul className="flex flex-col gap-1 py-1.5" aria-label={i18nT('pages.settings.notificationsPanel.custom_sounds')}>
            {names.map(n => (
              <li key={n} className="flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate text-[13px] text-text">{n}</span>
                <IconButton
                  aria-label={i18nT('pages.settings.notificationsPanel.custom_sound_play', { name: n })}
                  onClick={() => playPreset(customSoundId(n), volume, customTones)}
                  disabled={!enabled || volume === 0}
                >
                  <Play size={14} />
                </IconButton>
                <IconButton
                  variant="danger"
                  aria-label={i18nT('pages.settings.notificationsPanel.custom_sound_delete', { name: n })}
                  onClick={() => onRemove(n)}
                >
                  <Trash2 size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
      <SettingsCard index={1}>
        {/* Plain fields, not Settings* primitives: this is a form that creates
            an entry, so nothing here is a setting search should deep-link to. */}
        <div className="flex flex-col gap-1.5 py-1.5">
          <label htmlFor={nameId} className="text-[13px] font-semibold text-text">{i18nT('pages.settings.notificationsPanel.custom_sound_name')}</label>
          <Input id={nameId} value={name} maxLength={CUSTOM_TONE_LIMITS.maxNameLength} onChange={e => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5 py-1.5">
          <label htmlFor={tonesId} className="text-[13px] font-semibold text-text">{i18nT('pages.settings.notificationsPanel.custom_sound_tones')}</label>
          <div id={tonesHintId} className="text-[12px] text-muted">{i18nT('pages.settings.notificationsPanel.custom_sound_tones_hint')}</div>
          <textarea
            id={tonesId}
            aria-label={i18nT('pages.settings.notificationsPanel.custom_sound_tones')}
            aria-describedby={tonesHintId}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={exampleText}
            rows={4}
            spellCheck={false}
            className="w-full rounded border border-border bg-bg px-2 py-1 text-sm font-mono text-text focus-visible:border-accent focus:outline-hidden resize-y"
          />
        </div>
        {errors.length > 0 && (
          /* No hand-off: the name and tones typed above are an unsaved draft. */
          <ErrorNotice message={errors.join(' ')} />
        )}
        <div className="py-1.5">
          <Btn type="button" onClick={add} disabled={name.trim() === '' || text.trim() === ''}>
            {i18nT('pages.settings.notificationsPanel.custom_sound_add')}
          </Btn>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
