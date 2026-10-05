/**
 * The offering agent's own words inside a guide: the guide's `intro` (offer
 * card, first step) or one action's `note` (under its final step).
 *
 * Always drawn BELOW the dashboard's own template line and attributed to
 * Captain, so the person can tell what the dashboard says (where, which
 * control) from what Captain adds (why it matters). Rendered as React text:
 * the gateway already refused links and markup, and nothing here interprets
 * the string. Used only by the guide offer card and the guide panel.
 */
import { useTranslation } from 'react-i18next'
import { useCaptainName } from '../lib/captainHandoff'

export default function GuideCaptainNote({ text, testId, className = '' }: { text: string | undefined | null; testId: string; className?: string }) {
  const { t } = useTranslation()
  const captainName = useCaptainName()
  const body = typeof text === 'string' ? text.trim() : ''
  if (!body) return null
  const name = captainName ?? t('components.assistantWelcome.default_name')
  return (
    <p className={`m-0 border-s-2 border-border ps-2 text-[12px] leading-4 text-muted break-words ${className}`} data-testid={testId}>
      <span className="block font-medium text-text" data-testid={`${testId}-from`}>{t('components.guideLayer.note_from', { name })}</span>
      <span className="block">{body}</span>
    </p>
  )
}
