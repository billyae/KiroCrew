import { useSyncExternalStore } from 'react'
import { loadChatConfig } from '../pages/chat/ChatSettings'

// Single source for the composer's "list Agent SOPs in the `/` menu" opt-in
// (#9924), read the same way as useComposerInlineMarkdown: every composer reads
// it here, and it stays live because the Settings row dispatches
// `mc-config-changed` on save. Default off (see ChatConfig.showSopPrompts) — a
// user with no stored config gets the pre-#9924 `/` menu.
const sub = (cb: () => void) => { window.addEventListener('mc-config-changed', cb); return () => window.removeEventListener('mc-config-changed', cb) }
const get = () => loadChatConfig().showSopPrompts

export const useComposerShowSopPrompts = () => useSyncExternalStore(sub, get)
