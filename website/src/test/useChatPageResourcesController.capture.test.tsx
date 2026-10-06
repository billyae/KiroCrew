import type { Dispatch, SetStateAction } from 'react'
import { useRef } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider, type QueryClientProviderProps } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppDispatch } from '../store'
import type { ResizeInfo } from '../utils/resizeImage'

const captureSeam = vi.hoisted(() => ({
  supported: false,
  captureScreen: vi.fn(),
  screenshot: vi.fn(),
  hold: vi.fn(),
}))
const panelTabs = vi.hoisted(() => ({
  tabs: [] as Array<{ kind: string }>,
  openView: vi.fn(),
  openFolder: vi.fn(),
  openDiff: vi.fn(),
}))
const closeSearch = vi.hoisted(() => vi.fn())
const dropSeam = vi.hoisted(() => ({ onDrop: null as null | ((dt: DataTransfer, intent: { insertPath: boolean }) => void) }))

vi.mock('../components/ChatDropOverlay', () => ({
  useChatFileDrop: (onDrop: (dt: DataTransfer, intent: { insertPath: boolean }) => void) => {
    dropSeam.onDrop = onDrop
    return { active: false, dropTargetProps: {} }
  },
}))
vi.mock('../components/WebPreviewPanel', () => ({ PREVIEW_SNIP_EVENT: 'kirocrew-web-preview-snip' }))
vi.mock('../utils/browserAnnotations', () => ({ PREVIEW_ANNOTATE_EVENT: 'kirocrew-preview-annotate' }))
vi.mock('../hooks/useMessageSearch', () => ({
  useMessageSearch: () => ({ isOpen: false, close: closeSearch }),
}))
vi.mock('../hooks/panelTabRegistry', () => ({ usePanelTabDescriptors: () => [] }))
vi.mock('../hooks/usePanelTabs', () => ({
  useAnyLiveAppTab: () => false,
  usePanelTabs: () => panelTabs,
}))
vi.mock('../hooks/usePanelDocumentActions', () => ({
  usePanelDocumentActions: () => ({ openFile: vi.fn(), openArtifact: vi.fn(), saveFile: vi.fn() }),
}))
vi.mock('../hooks/useTheme', () => ({ useTheme: () => ({ colorTheme: null }) }))
vi.mock('../hooks/useScreenSnip', () => ({
  get screenSnipSupported() { return captureSeam.supported },
  captureScreen: captureSeam.captureScreen,
  currentTabCaptureDeps: vi.fn(),
}))
vi.mock('../api/client', () => ({
  api: {
    dashboardConfig: vi.fn().mockResolvedValue({}),
    screenshot: captureSeam.screenshot,
    uploadFiles: vi.fn().mockResolvedValue({ paths: [] }),
  },
}))
vi.mock('../utils/composerSendHolds', () => ({
  cancelComposerUploads: vi.fn(),
  finishComposerAttachment: vi.fn(),
  holdComposerSend: captureSeam.hold,
  registerComposerUpload: vi.fn(),
  releaseComposerSend: vi.fn(),
  unregisterComposerUpload: vi.fn(),
  useComposerUploadCancellable: () => false,
}))

import { useChatPageResourcesController } from '../pages/chat/useChatPageResourcesController'
import { finishComposerAttachment } from '../utils/composerSendHolds'

function wrapper({ children }: QueryClientProviderProps) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
}

/** Install/remove the desktop shell's path bridge (same shape dropClassify reads). */
function stubBridge(impl: ((f: File) => string) | null) {
  const w = window as { kirocrew?: { getPathForFile?: (f: File) => string } }
  if (impl) w.kirocrew = { getPathForFile: impl }
  else delete w.kirocrew
}

/** A faithful stand-in for a drop payload carrying one regular file —
 *  classifyDrop reads only items[].kind / webkitGetAsEntry / getAsFile. */
function fileDrop(name: string): DataTransfer {
  const file = new File(['x'], name, { type: 'text/plain' })
  return {
    items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => file }],
    files: [file],
  } as unknown as DataTransfer
}


function useSlotlessController() {
  const activeSlotRef = useRef<string | null>(null)
  const inputRef = useRef('')
  const drafts = useRef<Record<string, string>>({})
  const currentProjectRef = useRef<string | undefined>(undefined)
  const voiceCaretRef = useRef<{ start: number; end: number } | null>(null)
  const voicePendingCaretRef = useRef<number | null>(null)
  const snipSlotRef = useRef<string | null>(null)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return useChatPageResourcesController({
    activeSlot: null,
    activeSlotRef,
    messages: [],
    slotLoading: false,
    dispatch: vi.fn() as unknown as AppDispatch,
    queryClient,
    showActionError: vi.fn(),
    composer: {
      inputRef,
      setInput: vi.fn() as Dispatch<SetStateAction<string>>,
      drafts,
      currentProjectRef,
      voiceCaretRef,
      voicePendingCaretRef,
      saveDrafts: vi.fn(),
    },
    capture: {
      setUploading: vi.fn() as Dispatch<SetStateAction<boolean>>,
      setUploadError: vi.fn() as Dispatch<SetStateAction<string>>,
      setUploadHint: vi.fn() as Dispatch<SetStateAction<string>>,
      setResizedInfo: vi.fn() as Dispatch<SetStateAction<Record<string, ResizeInfo>>>,
      snipSlotRef,
      setSnipFrame: vi.fn() as Dispatch<SetStateAction<HTMLCanvasElement | null>>,
    },
  })
}

describe('slotless capture entry points', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    captureSeam.supported = false
    captureSeam.screenshot.mockResolvedValue({ path: '/shots/should-not-exist.png' })
    captureSeam.captureScreen.mockResolvedValue(null)
  })

  it('does not start the native screenshot path or take a hold', async () => {
    const { result } = renderHook(() => useSlotlessController(), { wrapper })

    await act(async () => { await result.current.handleCapture() })

    expect(captureSeam.screenshot).not.toHaveBeenCalled()
    expect(captureSeam.captureScreen).not.toHaveBeenCalled()
    expect(captureSeam.hold).not.toHaveBeenCalled()
  })

  it('does not start preview snip capture or take a hold', async () => {
    captureSeam.supported = true
    renderHook(() => useSlotlessController(), { wrapper })

    await act(async () => { window.dispatchEvent(new Event('kirocrew-web-preview-snip')) })

    expect(captureSeam.captureScreen).not.toHaveBeenCalled()
    expect(captureSeam.screenshot).not.toHaveBeenCalled()
    expect(captureSeam.hold).not.toHaveBeenCalled()
  })
})

/** Controller bound to a live slot, so a staged attachment has a slot to land
 *  in — the slotless harness above cannot exercise the drop path (an empty slot
 *  short-circuits finishComposerAttachment). */
function useSlottedController() {
  const activeSlotRef = useRef<string | null>('slot-a')
  const inputRef = useRef('')
  const drafts = useRef<Record<string, string>>({})
  const currentProjectRef = useRef<string | undefined>('/Users/me/project')
  const voiceCaretRef = useRef<{ start: number; end: number } | null>(null)
  const voicePendingCaretRef = useRef<number | null>(null)
  const snipSlotRef = useRef<string | null>(null)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return useChatPageResourcesController({
    activeSlot: 'slot-a',
    activeSlotRef,
    messages: [],
    slotLoading: false,
    dispatch: vi.fn() as unknown as AppDispatch,
    queryClient,
    showActionError: vi.fn(),
    composer: {
      inputRef,
      setInput: vi.fn() as Dispatch<SetStateAction<string>>,
      drafts,
      currentProjectRef,
      voiceCaretRef,
      voicePendingCaretRef,
      saveDrafts: vi.fn(),
    },
    capture: {
      setUploading: vi.fn() as Dispatch<SetStateAction<boolean>>,
      setUploadError: vi.fn() as Dispatch<SetStateAction<string>>,
      setUploadHint: vi.fn() as Dispatch<SetStateAction<string>>,
      setResizedInfo: vi.fn() as Dispatch<SetStateAction<Record<string, ResizeInfo>>>,
      snipSlotRef,
      setSnipFrame: vi.fn() as Dispatch<SetStateAction<HTMLCanvasElement | null>>,
    },
  })
}

describe('handleDrop path insertion (#2355)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubBridge(null)
  })

  it('stages an Alt-dropped file by path through finishComposerAttachment, not an upload', () => {
    // Desktop shell: the bridge resolves the dropped file's absolute path.
    stubBridge(() => '/Users/me/project/docs/architecture.md')
    renderHook(() => useSlottedController(), { wrapper })

    // The modifier was held: insertPath=true routes the file to a path
    // reference. The old code called an undefined `setPendingFiles` here and
    // threw a ReferenceError; this asserts the drop both does not throw and
    // stages through the canonical attachment sink.
    act(() => { dropSeam.onDrop!(fileDrop('architecture.md'), { insertPath: true }) })

    expect(finishComposerAttachment).toHaveBeenCalledWith('slot-a', ['/Users/me/project/docs/architecture.md'])
    // finishComposerAttachment releases a send hold, so a matching hold must be
    // taken for the same slot — otherwise it decrements a concurrent upload's
    // hold and unlocks Send early (regression guard).
    expect(captureSeam.hold).toHaveBeenCalledWith('slot-a')
  })

  it('does not stage a path reference on a plain drop (no modifier)', () => {
    stubBridge(() => '/Users/me/project/docs/architecture.md')
    renderHook(() => useSlottedController(), { wrapper })

    act(() => { dropSeam.onDrop!(fileDrop('architecture.md'), { insertPath: false }) })

    // Plain drop keeps today's behaviour: the file takes the upload route, so
    // no path reference is staged through finishComposerAttachment.
    expect(finishComposerAttachment).not.toHaveBeenCalled()
  })
})
