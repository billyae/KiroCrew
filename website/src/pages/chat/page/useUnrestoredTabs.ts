import { useCallback, useEffect, useState } from 'react'

import { api } from '../../../api/client'

/** Where a dismissal is remembered, keyed on the count so a LATER, larger loss
 *  still speaks up instead of inheriting the earlier dismissal. */
const DISMISSED_KEY = 'kc.unrestoredTabs.dismissed'

function alreadyDismissed(count: number): boolean {
  try { return sessionStorage.getItem(DISMISSED_KEY) === String(count) }
  catch { return false }
}

/**
 * How many tabs this gateway's startup restore listed but could not show.
 *
 * Asked ONCE on arrival. The answer is settled during startup and never changes
 * for the life of the gateway process, so polling it would re-ask a fixed
 * question — and the browser usually connects minutes after the restore ran,
 * which is why the gateway cannot simply broadcast it.
 *
 * `0` covers both "nothing was dropped" and "the restore has not reported yet".
 * They are different facts on the wire (`reported`) and deliberately collapse
 * here: the only consumer is a notice, and a notice has nothing to say in either
 * case. A surface that must tell them apart should read the endpoint directly.
 *
 * Dismissal lives in `sessionStorage`: a reload inside the same tab must not
 * re-raise a notice the user already answered, while a genuinely new browser
 * session is a new arrival and asks again.
 */
export function useUnrestoredTabs(): { count: number; dismiss: () => void } {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let live = true
    // Started inside a resolved promise so a SYNCHRONOUS throw lands in the same
    // `catch` as a rejected request. The read sits on the chat pane's render path,
    // where an escaping error takes the transcript down with it -- and the reasons
    // it can throw rather than reject are real: a cached bundle whose `api` predates
    // this method, or an embedding host that supplies its own narrower one.
    Promise.resolve()
      .then(() => api.chatSlotsUnrestored())
      .then(res => {
        if (!live) return
        const n = res && res.reported && typeof res.count === 'number' ? res.count : 0
        setCount(n > 0 && !alreadyDismissed(n) ? n : 0)
      })
      // Silent: the notice is a courtesy, and a failed read of it must not become
      // a second error on a page that may already be showing one.
      .catch(() => {})
    return () => { live = false }
  }, [])
  const dismiss = useCallback(() => {
    setCount(current => {
      try { sessionStorage.setItem(DISMISSED_KEY, String(current)) } catch { /* private mode */ }
      return 0
    })
  }, [])
  return { count, dismiss }
}
