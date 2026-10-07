import { useSyncExternalStore } from 'react'
import { loadChatConfig } from '../pages/chat/ChatSettings'

// Single source for the "open editor links in your editor" opt-in (#3218), read
// the same way as useComposerInlineMarkdown: every markdown anchor reads it
// here, and it stays live because the Settings row dispatches `mc-config-changed`
// on save. Default false — handing an editor deep link to the OS is opt-in.
const sub = (cb: () => void) => { window.addEventListener('mc-config-changed', cb); return () => window.removeEventListener('mc-config-changed', cb) }
const get = () => loadChatConfig().openEditorLinks

export const useOpenEditorLinks = () => useSyncExternalStore(sub, get)
