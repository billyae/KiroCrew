import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, act } from '@testing-library/react'
import { renderWithProviders } from '../../test/helpers'
import { __resetPanelTabs } from '../../hooks/usePanelTabs'
import { memberProjectionStore } from '../../state/memberProjectionStore'

/* "New conversation" on a crewmate's DM. The model forgets; nothing is deleted.
 *
 * Three things have to hold for that to be honest, and each one fails quietly:
 *
 * `replay: false` must be SENT. The route defaults it to true, which replays the
 * discarded history straight back into the fresh context — so a call that omits
 * the flag answers 200 while changing nothing the user can see.
 *
 * The ask must come first, and it must say what survives. The context is gone
 * for good once the call lands.
 *
 * A refusal must be SHOWN. The route answers 409 for busy state the page cannot
 * see (an inbound channel message, a turn admitted between the render and the
 * press), and a swallowed 409 reads as "nothing happened" over a conversation
 * the model still remembers. */

/* Hoisted, because `vi.mock`'s factory is lifted above every top-level binding
 * and the mock has to hand back this class. */
const StubApiError = vi.hoisted(() => class StubApiError extends Error {
  status: number
  body: string
  constructor(status: number, message: string, body = '') {
    super(message)
    this.status = status
    this.body = body
  }
})

vi.mock('../../api/client', () => ({
  ApiError: StubApiError,
  api: {
    members: vi.fn(),
    teams: { list: vi.fn(() => Promise.resolve({ teams: [] })) },
    memberThread: vi.fn(),
    memberActivity: vi.fn(() => Promise.resolve({ slug: '', member: '', capped: false, entries: [] })),
    memberBriefing: vi.fn(() => Promise.resolve({ slug: '', member: '', supported: true, text: '', updated_ts: null, redacted: false, truncated: false })),
    sessionCrewLogProjections: vi.fn(() => Promise.resolve({ folds: {}, resolved: true, writesDrained: true })),
    memberPanel: vi.fn(() => Promise.resolve({ panel: null, html: null })),
    autonudgeList: vi.fn(() => Promise.resolve({ enabled: true, loops: [] })),
    chatSlotResetConversation: vi.fn(),
  },
}))

vi.mock('../chat/ActivityViewer', () => ({ default: () => null }))
vi.mock('../chat/FilesHomePanel', () => ({ default: () => null }))
vi.mock('../chat/FolderPanel', () => ({ default: () => null }))
vi.mock('../../components/DiffPanel', () => ({ default: () => null }))
vi.mock('../../components/MarkdownPanel', () => ({ default: () => null }))
vi.mock('../../components/ArtifactPanel', () => ({ default: () => null }))
vi.mock('../../components/WebPreviewPanel', () => ({ default: () => null }))
vi.mock('../../components/McpAppFrame', () => ({ default: () => null }))
vi.mock('../../components/CliPanel', () => ({
  default: () => null,
  disposeTerminalSession: vi.fn(),
  useDeleteTerminalSession: () => ({ mutate: vi.fn() }),
}))
vi.mock('../../utils/terminalRegistry', () => ({
  useTerminalEnabled: () => true,
  useTerminalTitle: () => 'Terminal',
}))
vi.mock('../../hooks/useDevMode', () => ({ useDevMode: () => false }))

/* The pane as a stub that echoes the boundary it was handed: whether the page
 * reads the projection is the page's half of the feature, and the drawing of it
 * is pinned in ChatPane.conversationBoundary.test.tsx. */
vi.mock('../../components/ChatPane', () => ({
  default: ({ slotKey, conversationStartTs }: { slotKey: string; conversationStartTs?: number }) => (
    <div data-testid="chat-pane-stub" data-boundary={conversationStartTs ?? ''}>{slotKey}</div>
  ),
}))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => vi.fn() }
})

import { api } from '../../api/client'
import MembersPage from './MembersPage'

function row(overrides: Record<string, unknown> = {}) {
  return {
    name: 'oncall', slug: 'oncall', bound: false, slot_key: '', running: false,
    kiro_agent: 'kirocrew', workspace: 'default', memory_store: 'default', model: '',
    ...overrides,
  }
}

const reset = () => api.chatSlotResetConversation as ReturnType<typeof vi.fn>

async function openThread(overrides: Record<string, unknown> = {}) {
  ;(api.members as ReturnType<typeof vi.fn>).mockResolvedValue({ members: [row(overrides)], default_agent: 'kirocrew' })
  ;(api.memberThread as ReturnType<typeof vi.fn>).mockResolvedValue({ slot_key: 'member-oncall', slug: 'oncall', member: 'oncall', created: true })
  renderWithProviders(<MembersPage />)
  const rowButton = await screen.findByText('oncall')
  act(() => { fireEvent.click(rowButton) })
  await waitFor(() => expect(screen.getByTestId('chat-pane-stub')).toHaveTextContent('member-oncall'))
}

/** Press the header control and answer its dialog. */
async function pressAndConfirm() {
  const button = await screen.findByTestId('member-new-conversation')
  act(() => { fireEvent.click(button) })
  const confirm = await screen.findByRole('button', { name: 'Start a new conversation' })
  await act(async () => { fireEvent.click(confirm) })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  // The projection store is process-wide and seeded from each roster read, so a
  // boundary one case planted would otherwise still be there for the next.
  memberProjectionStore.clear()
  __resetPanelTabs()
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true, writable: true })
  reset().mockResolvedValue({ slot: 'member-oncall', reset: true, replay: false, boundary: 'recorded' })
})

describe('the New conversation control', () => {
  it('asks before it acts, and says what survives', async () => {
    await openThread()

    const button = await screen.findByTestId('member-new-conversation')
    act(() => { fireEvent.click(button) })

    expect(reset()).not.toHaveBeenCalled()
    const body = await screen.findByText(/starts over/)
    // Named, not templated: the copy carries `{{name}}`, and a body handed no
    // interpolation renders that placeholder to the user verbatim. Quoted,
    // because a crewmate named "Everything" would otherwise read as a sentence
    // about everything (destructiveConfirm.test.ts pins the glyph per locale).
    expect(body.textContent).toMatch(/^\u201concall\u201d starts over/)
    // "long-term memory" by its own name. A crewmate has two things a reader
    // could call memory -- this chat's context, which the reset drops, and the
    // store it writes to, which survives -- so the bare word names the thing
    // being dropped just as well as the thing being kept.
    expect(body.textContent).toMatch(/What it has saved to its long-term memory stays/)
    expect(body.textContent).toMatch(/Show earlier messages/)
  })

  it('does nothing when the ask is declined', async () => {
    await openThread()

    const button = await screen.findByTestId('member-new-conversation')
    act(() => { fireEvent.click(button) })
    const cancel = await screen.findByRole('button', { name: 'Cancel' })
    await act(async () => { fireEvent.click(cancel) })

    expect(reset()).not.toHaveBeenCalled()
  })

  it('posts the reset for the open slot with replay explicitly off', async () => {
    await openThread()

    await pressAndConfirm()

    await waitFor(() => expect(reset()).toHaveBeenCalledWith('member-oncall'))
  })

  it('is disabled while the crewmate is working, and says why', async () => {
    await openThread({ running: true })

    const button = await screen.findByTestId('member-new-conversation')
    expect(button).toBeDisabled()
    // The enabled tooltip would describe what it WOULD do and nothing about
    // why it will not.
    expect(button.getAttribute('title')).toBe('Available once oncall finishes working')
  })

  it('carries a visible label at every width, short below md and full from md', async () => {
    /* NEVER glyph-only. The one thing a reader needs before pressing this is
     * that it starts the conversation over, which a plus-on-a-bubble does not
     * say and a tooltip cannot say to a touch screen at all. The narrow header
     * pays for the word by dropping the identity pill's page-centring rather
     * than by dropping the word (see the header grid). */
    await openThread()

    const button = await screen.findByTestId('member-new-conversation')
    expect(button.getAttribute('aria-label')).toBe('New conversation')
    // ONE name for this action, so the short form is this label's own opening
    // word and not a second wording: "New" stands in for "New conversation",
    // which is what the `aria-label` above says at this very width.
    const short = button.querySelector('.md\\:hidden')
    expect(short?.textContent).toBe('New')
    // And it is not hidden at the narrow widths it exists for: a `hidden`
    // utility beside `md:hidden` would leave the phone with the glyph again.
    expect(short?.classList.contains('hidden')).toBe(false)
    expect(button.querySelector('.hidden.md\\:inline')?.textContent).toBe('New conversation')
  })

  it('says so when the reset landed but its boundary did not', async () => {
    /* The one outcome where a clean-looking success is a lie about what is on
     * screen: the crewmate has forgotten the messages still drawn above the
     * composer, and nothing marks them. */
    await openThread()
    reset().mockResolvedValueOnce({ slot: 'member-oncall', reset: true, replay: false, boundary: 'failed' })

    await pressAndConfirm()

    const notice = await screen.findByTestId('member-new-conversation-error')
    // Its OWN heading. The refusal heading over this body tells the reader the
    // reverse of what the body says: that the reset did not happen.
    expect(notice.textContent).toMatch(/New conversation started, line not saved/)
    // Opens on the ACTION that works, and the reassurance is the very next
    // sentence. A notice that opens on what the crewmate has forgotten reads as
    // a warning against the only step that repairs the state it is reporting.
    // A reload is NOT that step: it reads the same projection, which holds no
    // boundary, so telling the user to reload promises nothing.
    expect(notice.textContent).toMatch(
      /Press New conversation again to add the \u201cNew conversation starts here\u201d line\. No messages are lost\./,
    )
    expect(notice.textContent).not.toMatch(/Reload/)
    // The line is named with the words the pane prints on it, so the reader is
    // looking for the same thing in both places. "line", never "divider".
    expect(notice.textContent).not.toMatch(/crewmate|divider/)
    // The cost comes after the reassurance, and is still stated: pressing again
    // moves the boundary to now, so this turn's own messages go with it.
    expect(notice.textContent).toMatch(
      /messages oncall has already forgotten still look current, and pressing again forgets anything said since too/,
    )
    expect(notice.textContent).not.toMatch(/Couldn't start a new conversation/)
  })

  it('stays quiet when the slot has no member log to write into', async () => {
    await openThread()
    reset().mockResolvedValueOnce({ slot: 'member-oncall', reset: true, replay: false, boundary: 'not_owed' })

    await pressAndConfirm()

    expect(screen.queryByTestId('member-new-conversation-error')).toBeNull()
  })

  it('ignores a boundary past what a Date can hold', async () => {
    /* A hand-damaged member log. Unguarded, the pane's marker construction
     * raises and the whole DM becomes an error fallback. */
    await openThread({
      projections: {
        asOfSeq: 4,
        values: {
          roster: {
            name: 'oncall',
            slug: 'oncall',
            conversation_starts: { 'member-oncall': { ts: 9223372036854775807 } },
          },
        },
      },
    })

    expect(screen.getByTestId('chat-pane-stub').getAttribute('data-boundary')).toBe('')
  })

  describe('the evicted-boundary note', () => {
    /** A roster projection block, with whatever the case under test plants. */
    const roster = (values: Record<string, unknown>) => ({
      projections: { asOfSeq: 4, values: { roster: { name: 'oncall', slug: 'oncall', ...values } } },
    })

    it('says so when a boundary was dropped and this slot has none', async () => {
      /* The reader for the fold's eviction count. A dropped key reads exactly
       * like a slot nobody ever reset, so without this the pane draws a
       * discarded conversation as current and says nothing — the one state the
       * boundary exists to prevent. */
      await openThread(roster({ conversation_starts_evicted: 2 }))

      const note = await screen.findByTestId('member-boundary-evicted-notice')
      // "for this crewmate", never "for this thread": the count says how many
      // were dropped and never which, so naming this thread would assert
      // something nothing on this page knows.
      expect(note.textContent).toMatch(
        /An earlier \u201cNew conversation starts here\u201d line for this crewmate could not be kept/,
      )
    })

    it('stays quiet once this slot has a boundary of its own', async () => {
      /* With one, the pane is already drawing the right line and the dropped
       * boundaries belong to slots the user is not looking at. */
      await openThread(roster({
        conversation_starts_evicted: 2,
        conversation_starts: { 'member-oncall': { ts: 1_700_000_000_000 } },
      }))

      expect(await screen.findByTestId('chat-pane-stub')).toBeTruthy()
      expect(screen.queryByTestId('member-boundary-evicted-notice')).toBeNull()
    })

    it('stays quiet when nothing was evicted', async () => {
      await openThread(roster({ conversation_starts_evicted: 0 }))

      expect(await screen.findByTestId('chat-pane-stub')).toBeTruthy()
      expect(screen.queryByTestId('member-boundary-evicted-notice')).toBeNull()
    })

    it('stays quiet when the count is absent, which is the ordinary row', async () => {
      await openThread(roster({}))

      expect(await screen.findByTestId('chat-pane-stub')).toBeTruthy()
      expect(screen.queryByTestId('member-boundary-evicted-notice')).toBeNull()
    })

    it('can be closed, and closing it does not touch the thread', async () => {
      /* The condition does not clear by navigating — the fold's count only ever
       * rises — so a note with no close would stand over the thread until the
       * next reset. */
      await openThread(roster({ conversation_starts_evicted: 1 }))

      const dismiss = await screen.findByTestId('member-boundary-evicted-dismiss')
      act(() => { fireEvent.click(dismiss) })

      await waitFor(() =>
        expect(screen.queryByTestId('member-boundary-evicted-notice')).toBeNull(),
      )
      expect(screen.getByTestId('chat-pane-stub')).toHaveTextContent('member-oncall')
    })
  })

  it('puts the busy refusal in the user\'s words, not the gateway\'s', async () => {
    /* "a turn is in flight" is the code's term for a state the page already
     * renders as the crewmate working, and it offers no next step. */
    await openThread()
    reset().mockRejectedValueOnce(
      new StubApiError(409, 'a turn is in flight', '{"code":"turn_in_flight"}'),
    )

    await pressAndConfirm()

    const notice = await screen.findByTestId('member-new-conversation-error')
    // Says WHERE, not just WHY. "is handling a message" beside an "Idle" pill
    // reads as a contradiction the reader has to resolve; naming the other
    // place the message came from is what makes both true at once.
    expect(notice.textContent).toMatch(/oncall is handling a message from another place/)
    expect(notice.textContent).toMatch(/such as a channel/)
    expect(notice.textContent).toMatch(/this thread still looks idle/)
    expect(notice.textContent).not.toMatch(/turn is in flight/)
  })

  it('still shows an unrecognised failure verbatim', async () => {
    /* Only the ONE refusal the route defines is reworded; anything else keeps
     * the server's own text rather than being flattened into a guess. */
    await openThread()
    reset().mockRejectedValueOnce(new Error('the disk is full'))

    await pressAndConfirm()

    const notice = await screen.findByTestId('member-new-conversation-error')
    expect(notice.textContent).toMatch(/the disk is full/)
  })

  it('hands the pane the boundary the projection recorded', async () => {
    await openThread({
      projections: {
        asOfSeq: 4,
        values: {
          roster: {
            name: 'oncall',
            slug: 'oncall',
            conversation_starts: { 'member-oncall': { ts: 1_700_000_000_000 } },
          },
        },
      },
    })

    await waitFor(() =>
      expect(screen.getByTestId('chat-pane-stub').getAttribute('data-boundary')).toBe('1700000000000'),
    )
  })

  it('hands the pane no boundary for a slot that was never reset', async () => {
    await openThread({
      projections: {
        asOfSeq: 4,
        values: {
          roster: {
            name: 'oncall',
            slug: 'oncall',
            conversation_starts: { 'member-someone-else': { ts: 1_700_000_000_000 } },
          },
        },
      },
    })

    expect(screen.getByTestId('chat-pane-stub').getAttribute('data-boundary')).toBe('')
  })
})
