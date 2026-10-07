import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useRef } from 'react'

/* Mock api/client BEFORE the component imports. #9924 surfaces Agent SOPs from
 * GET /api/prompts in the `/` menu, so the mock carries BOTH endpoints. */
const mockApi = vi.hoisted(() => ({ slashCommands: vi.fn(), prompts: vi.fn() }))
vi.mock('../api/client', () => ({ api: mockApi }))

import SlashCommandMenu from '../components/SlashCommandMenu'

const CMDS = [
  { name: '/aa', description: 'Alpha command' },
  { name: '/kb', description: 'Search knowledge library' },
]

// Shapes mirror /api/prompts: a package SOP keyed agent-sop:<stem>, and a bare
// user prompt whose fullName is just its stem.
const PROMPTS = [
  { name: 'pdd', fullName: 'agent-sop:pdd', description: 'Plan-driven development SOP' },
  { name: 'standup', fullName: 'standup', description: 'Daily standup prompt' },
]

function Harness({ input, onSelect = vi.fn(), onClose = vi.fn(), showPromptRows = true }: {
  input: string; onSelect?: (c: string) => void; onClose?: () => void; showPromptRows?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <div>
        <div ref={ref} data-testid="anchor">anchor</div>
        <SlashCommandMenu input={input} anchorRef={ref} onSelect={onSelect} onClose={onClose} showPromptRows={showPromptRows} />
      </div>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
  mockApi.slashCommands.mockResolvedValue(CMDS)
  mockApi.prompts.mockResolvedValue(PROMPTS)
})

describe('SlashCommandMenu — Agent SOP discovery (#9924)', () => {
  it('does NOT surface SOP rows unless opted in (default off)', async () => {
    // showPromptRows defaults to false in the real app (the showSopPrompts chat
    // setting is off by default), so a user who never opted in sees only the
    // curated slash commands and no /api/prompts request fires from the menu.
    render(<Harness input="/" showPromptRows={false} />)
    expect(await screen.findByText('/aa')).toBeInTheDocument()
    expect(screen.queryByText('@agent-sop:pdd')).not.toBeInTheDocument()
    expect(screen.queryByText('@standup')).not.toBeInTheDocument()
    // The disabled query never calls api.prompts().
    expect(mockApi.prompts).not.toHaveBeenCalled()
  })

  it('surfaces SOP rows alongside slash commands when opted in', async () => {
    render(<Harness input="/" />)
    // Displayed as @<fullName> — the SAME token selecting the row inserts.
    expect(await screen.findByText('@agent-sop:pdd')).toBeInTheDocument()
    expect(screen.getByText('@standup')).toBeInTheDocument()
    // Slash commands still present.
    expect(screen.getByText('/aa')).toBeInTheDocument()
  })

  it('does NOT surface cached SOP rows when opted out, even if the shared query is warm', async () => {
    // GPT 6.1 F2: `enabled:false` stops a fetch but does not clear a cache entry
    // a sibling surface (PromptsTab, Cmd-K) warmed under the shared ['prompts']
    // key. Pre-seed that cache, then render opted OUT: no SOP rows may leak in.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(['prompts'], PROMPTS)
    function Ref() {
      const ref = useRef<HTMLDivElement>(null)
      return (
        <div>
          <div ref={ref} data-testid="anchor">anchor</div>
          <SlashCommandMenu input="/" anchorRef={ref} onSelect={vi.fn()} onClose={vi.fn()} showPromptRows={false} />
        </div>
      )
    }
    render(<QueryClientProvider client={qc}><Ref /></QueryClientProvider>)
    expect(await screen.findByText('/aa')).toBeInTheDocument()
    // The cache is warm, but opted out => no prompt rows.
    expect(screen.queryByText('@agent-sop:pdd')).not.toBeInTheDocument()
    expect(screen.queryByText('@standup')).not.toBeInTheDocument()
  })

  it('tags each SOP row with a badge naming the kind and what picking does', async () => {
    render(<Harness input="/" />)
    await screen.findByText('@agent-sop:pdd')
    // The badge reads "Prompt · inserts @mention" (reused translated "Prompt"
    // label + the action), one per SOP row (two SOPs in the fixture).
    const badges = screen.getAllByText((_t, node) =>
      node?.textContent === 'Prompt · inserts @mention')
    expect(badges.length).toBeGreaterThanOrEqual(2)
  })

  it('renders each SOP’s own description from /api/prompts', async () => {
    render(<Harness input="/" />)
    expect(await screen.findByText('Plan-driven development SOP')).toBeInTheDocument()
    expect(screen.getByText('Daily standup prompt')).toBeInTheDocument()
  })

  it('the widened trigger keeps the menu open through a `:`-bearing SOP name', async () => {
    // Old regex /^\/([a-z]*)$/ dropped the menu at the first `-` or `:`.
    render(<Harness input="/agent-sop:p" />)
    expect(await screen.findByText('@agent-sop:pdd')).toBeInTheDocument()
    // A command whose token does not match the prefix is filtered out.
    expect(screen.queryByText('/aa')).not.toBeInTheDocument()
  })

  it('selecting an SOP inserts the @<fullName> invocation mention, not a slash token', async () => {
    const onSelect = vi.fn()
    render(<Harness input="/agent-sop:pdd" onSelect={onSelect} />)
    await screen.findByText('@agent-sop:pdd')
    // Index 0 is the only match; Enter picks it.
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('@agent-sop:pdd ')
  })

  it('selecting a plain slash command still inserts its slash token', async () => {
    const onSelect = vi.fn()
    render(<Harness input="/aa" onSelect={onSelect} />)
    await screen.findByText('/aa')
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('/aa ')
  })

  it('skips a malformed /api/prompts entry with a missing or empty fullName', async () => {
    // /api/prompts is loosely typed at the client layer; a row with no usable
    // fullName must be dropped rather than rendered as a bare `@` with no token.
    mockApi.prompts.mockResolvedValue([
      { name: 'pdd', fullName: 'agent-sop:pdd', description: 'Plan-driven development SOP' },
      { name: 'broken', description: 'no fullName' },
      { name: 'empty', fullName: '', description: 'empty fullName' },
    ])
    render(<Harness input="/" />)
    // The well-formed row renders...
    expect(await screen.findByText('@agent-sop:pdd')).toBeInTheDocument()
    // ...and neither malformed entry does (no row for its description).
    expect(screen.queryByText('no fullName')).not.toBeInTheDocument()
    expect(screen.queryByText('empty fullName')).not.toBeInTheDocument()
  })
})
