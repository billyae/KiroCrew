import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/* ── Mock api/client BEFORE the component imports ── */
const mockApi = vi.hoisted(() => ({
  grantMcpProjectTrust: vi.fn(),
  mcpProjectTrust: vi.fn(),
}))
vi.mock('../api/client', () => ({ api: mockApi }))

import ProjectMcpTrustDialog from '../components/ProjectMcpTrustDialog'
import ProjectMcpTrustNotice from '../components/ProjectMcpTrustNotice'

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>
}

async function enabledTrustButton() {
  const btn = await screen.findByRole('button', { name: /Trust and run/ })
  await waitFor(() => expect(btn).not.toBeDisabled())
  return btn
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi.grantMcpProjectTrust.mockResolvedValue({ trusted: true })
  mockApi.mcpProjectTrust.mockResolvedValue({
    project: '/work/checkout-service',
    project_key: '/canonical/checkout-service',
    trusted: false,
    servers: [
      { agent: 'kirocrew', name: 'repo-db', command: '/opt/db', args: ['-v', 'x'], env_keys: ['DB_TOKEN'] },
      { agent: 'kirocrew', name: 'repo-lint', command: '', args: [], url: 'https://lint.invalid/mcp' },
    ],
    launch: { kirocrew: 'a'.repeat(64) },
  })
})

describe('ProjectMcpTrustDialog', () => {
  it('renders nothing when closed', () => {
    render(wrap(<ProjectMcpTrustDialog open={false} slotKey="dashboard:chat-7" onClose={vi.fn()} />))
    expect(screen.queryByText(/Run this project's MCP servers and hooks\?/)).not.toBeInTheDocument()
  })

  it('names the folder and the servers it would start', async () => {
    render(wrap(<ProjectMcpTrustDialog open slotKey="dashboard:chat-7" onClose={vi.fn()} />))
    expect(await screen.findByText('/work/checkout-service')).toBeInTheDocument()
    expect(await screen.findByText('repo-db')).toBeInTheDocument()
    expect(screen.getByText('/opt/db -v x')).toBeInTheDocument()
    expect(screen.getByText('https://lint.invalid/mcp')).toBeInTheDocument()
    // Env names are shown, never values.
    expect(screen.getByText(/values hidden\): DB_TOKEN/)).toBeInTheDocument()
  })

  it('says plainly the servers run as you, outside the tool sandbox', async () => {
    render(wrap(<ProjectMcpTrustDialog open slotKey="dashboard:chat-7" onClose={vi.fn()} />))
    expect(await screen.findByText(/run as you, outside the tool sandbox/)).toBeInTheDocument()
    expect(screen.getByText(/separate from trusting the project's skills/)).toBeInTheDocument()
  })

  it('grants with the reviewed key for the requesting slot', async () => {
    const onTrusted = vi.fn()
    const onClose = vi.fn()
    render(wrap(
      <ProjectMcpTrustDialog open slotKey="dashboard:chat-7" onClose={onClose} onTrusted={onTrusted} />,
    ))
    fireEvent.click(await enabledTrustButton())
    await waitFor(() => expect(onTrusted).toHaveBeenCalled())
    expect(mockApi.grantMcpProjectTrust).toHaveBeenCalledWith(
      'dashboard:chat-7', '/canonical/checkout-service', { kirocrew: 'a'.repeat(64) },
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('reports failure when the response is not trusted', async () => {
    mockApi.grantMcpProjectTrust.mockResolvedValue({ trusted: false })
    const onTrusted = vi.fn()
    render(wrap(<ProjectMcpTrustDialog open slotKey="dashboard:chat-7" onClose={vi.fn()} onTrusted={onTrusted} />))
    fireEvent.click(await enabledTrustButton())
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(onTrusted).not.toHaveBeenCalled()
  })

  it('shows an error when the trust state cannot be read', async () => {
    mockApi.mcpProjectTrust.mockRejectedValue(new Error('boom'))
    render(wrap(<ProjectMcpTrustDialog open slotKey="dashboard:chat-7" onClose={vi.fn()} />))
    expect(await screen.findByText(/Couldn't read this project's MCP trust state/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Trust and run/ })).toBeDisabled()
  })

  it('shows the server error from a JSON string body', async () => {
    mockApi.grantMcpProjectTrust.mockRejectedValue({ body: JSON.stringify({ error: 'servers changed' }) })
    render(wrap(<ProjectMcpTrustDialog open slotKey="dashboard:chat-7" onClose={vi.fn()} />))
    fireEvent.click(await enabledTrustButton())
    expect(await screen.findByText('servers changed')).toBeInTheDocument()
  })

  it('shows the server error from an object body', async () => {
    mockApi.grantMcpProjectTrust.mockRejectedValue({ body: { error: 'store unreadable' } })
    render(wrap(<ProjectMcpTrustDialog open slotKey="dashboard:chat-7" onClose={vi.fn()} />))
    fireEvent.click(await enabledTrustButton())
    expect(await screen.findByText('store unreadable')).toBeInTheDocument()
  })

  it('falls back to a generic error when the body is not JSON', async () => {
    mockApi.grantMcpProjectTrust.mockRejectedValue({ body: 'not json' })
    render(wrap(<ProjectMcpTrustDialog open slotKey="dashboard:chat-7" onClose={vi.fn()} />))
    fireEvent.click(await enabledTrustButton())
    expect(await screen.findByText(/Couldn't record trust for this folder/)).toBeInTheDocument()
  })

  it('cannot consent before the folder is known', async () => {
    mockApi.mcpProjectTrust.mockResolvedValue({ servers: [] })
    render(wrap(<ProjectMcpTrustDialog open slotKey="dashboard:chat-7" onClose={vi.fn()} />))
    const btn = await screen.findByRole('button', { name: /Trust and run/ })
    await waitFor(() => expect(mockApi.mcpProjectTrust).toHaveBeenCalled())
    expect(btn).toBeDisabled()
  })
})

describe('ProjectMcpTrustDialog hooks', () => {
  it('lists hooks with an off hook marked', async () => {
    mockApi.mcpProjectTrust.mockResolvedValue({
      project: '/p', project_key: '/p', trusted: false, servers: [],
      hooks: [
        { agent: 'a', event: 'preToolUse', command: './check.sh', matcher: 'execute_bash', enabled: true },
        { agent: 'a', event: 'agentSpawn', command: './off.sh', enabled: false },
      ],
      launch: { a: 'b'.repeat(64) },
    })
    render(wrap(<ProjectMcpTrustDialog open slotKey="dashboard:chat-7" onClose={vi.fn()} />))
    expect(await screen.findByText('./check.sh')).toBeInTheDocument()
    expect(screen.getByText(/agentSpawn \(off\)/)).toBeInTheDocument()
  })

  it('warns plainly that an agent can change the trusted code', async () => {
    render(wrap(<ProjectMcpTrustDialog open slotKey="dashboard:chat-7" onClose={vi.fn()} />))
    expect(await screen.findByText(/An agent working here can change that code/)).toBeInTheDocument()
  })

  it('refuses consent and explains when the project has too many specs', async () => {
    mockApi.mcpProjectTrust.mockResolvedValue({ project: '/p', project_key: '/p', trusted: false, too_many_specs: true, launch: {} })
    render(wrap(<ProjectMcpTrustDialog open slotKey="dashboard:chat-7" onClose={vi.fn()} />))
    expect(await screen.findByText(/more than 64 agent specs/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Trust and run/ })).toBeDisabled()
  })
})

describe('ProjectMcpTrustDialog preview', () => {
  it('refuses consent when launch text is too long to show whole', async () => {
    mockApi.mcpProjectTrust.mockResolvedValue({
      project: '/p', project_key: '/p', trusted: false, preview_complete: false,
      servers: [{ agent: 'a', name: 's', command: 'sh', args: ['-c', 'echo…'] }],
      launch: { a: 'c'.repeat(64) },
    })
    render(wrap(<ProjectMcpTrustDialog open slotKey="dashboard:chat-7" onClose={vi.fn()} />))
    expect(await screen.findByText(/too long or contain hidden characters/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Trust and run/ })).toBeDisabled()
  })

  it('shows the run-as-you risk on its own line', async () => {
    render(wrap(<ProjectMcpTrustDialog open slotKey="dashboard:chat-7" onClose={vi.fn()} />))
    expect(await screen.findByText(/run as you, outside the tool sandbox/)).toBeInTheDocument()
  })
})

describe('ProjectMcpTrustNotice', () => {
  it('counts servers and hooks apart', async () => {
    mockApi.mcpProjectTrust.mockResolvedValue({
      trusted: false,
      servers: [{ agent: 'a', name: 's', command: '/x', args: [] }, { agent: 'a', name: 't', command: '/y', args: [] }],
      hooks: [{ agent: 'a', event: 'preToolUse', command: './h.sh' }],
    })
    render(wrap(<ProjectMcpTrustNotice slotKey="dashboard:chat-7" project="/work/checkout-service" />))
    expect(await screen.findByText(/declares 2 MCP servers and 1 hook\./)).toBeInTheDocument()
  })

  it('names an agent declared twice in the dialog', async () => {
    mockApi.mcpProjectTrust.mockResolvedValue({
      project: '/p', project_key: '/p', trusted: false, servers: [], duplicate_agents: ['kirocrew'],
      launch: { other: 'd'.repeat(64) },
    })
    render(wrap(<ProjectMcpTrustDialog open slotKey="dashboard:chat-7" onClose={vi.fn()} />))
    expect(await screen.findByText(/kirocrew is declared by more than one spec/)).toBeInTheDocument()
  })

  it('stays hidden when the default backend reads the checkout itself', async () => {
    mockApi.mcpProjectTrust.mockResolvedValue({
      trusted: false, backend_applies: false,
      servers: [{ agent: 'a', name: 's', command: '/x', args: [] }],
    })
    const { container } = render(wrap(
      <ProjectMcpTrustNotice slotKey="dashboard:chat-7" project="/work/checkout-service" />,
    ))
    await waitFor(() => expect(mockApi.mcpProjectTrust).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a review button when the project has untrusted servers', async () => {
    render(wrap(<ProjectMcpTrustNotice slotKey="dashboard:chat-7" project="/work/checkout-service" />))
    expect(await screen.findByText(/declares 2 MCP servers\./)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review servers and hooks' }))
    expect(await screen.findByText(/Run this project's MCP servers and hooks\?/)).toBeInTheDocument()
  })

  it('shows for a project that declares only hooks', async () => {
    mockApi.mcpProjectTrust.mockResolvedValue({
      trusted: false, servers: [], hooks: [{ agent: 'a', event: 'preToolUse', command: './x.sh' }],
    })
    render(wrap(<ProjectMcpTrustNotice slotKey="dashboard:chat-7" project="/work/checkout-service" />))
    expect(await screen.findByText(/declares 1 hook\./)).toBeInTheDocument()
  })

  it('shows an error, not nothing, when the project has too many specs', async () => {
    mockApi.mcpProjectTrust.mockResolvedValue({ trusted: false, servers: [], too_many_specs: true })
    render(wrap(<ProjectMcpTrustNotice slotKey="dashboard:chat-7" project="/work/checkout-service" />))
    expect(await screen.findByText(/more than 64 agent specs/)).toBeInTheDocument()
  })

  it('renders nothing once the project is trusted', async () => {
    mockApi.mcpProjectTrust.mockResolvedValue({
      trusted: true,
      servers: [{ agent: 'kirocrew', name: 'repo-db', command: '/opt/db', args: [] }],
    })
    const { container } = render(wrap(
      <ProjectMcpTrustNotice slotKey="dashboard:chat-7" project="/work/checkout-service" />,
    ))
    await waitFor(() => expect(mockApi.mcpProjectTrust).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('shows an error when the read fails for another reason', async () => {
    mockApi.mcpProjectTrust.mockRejectedValue(Object.assign(new Error('boom'), { status: 500, body: '' }))
    render(wrap(<ProjectMcpTrustNotice slotKey="dashboard:chat-7" project="/work/checkout-service" />))
    expect(await screen.findByText(/Couldn't check whether this project's MCP servers/)).toBeInTheDocument()
  })

  it('names omitted servers and refuses consent without a launch set', async () => {
    mockApi.mcpProjectTrust.mockResolvedValue({
      project: '/p', project_key: '/p', trusted: false,
      servers: [{ agent: 'a', name: 's', command: '/x', args: [] }], servers_omitted: 3,
    })
    render(wrap(<ProjectMcpTrustDialog open slotKey="dashboard:chat-7" onClose={vi.fn()} />))
    expect(await screen.findByText(/3 more servers are not shown/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Trust and run/ })).toBeDisabled()
  })

  it('renders nothing when the owner gate refuses the read', async () => {
    mockApi.mcpProjectTrust.mockRejectedValue(
      Object.assign(new Error('403'), { status: 403, body: '{"code":"owner_only"}' }),
    )
    const { container } = render(wrap(
      <ProjectMcpTrustNotice slotKey="dashboard:chat-7" project="/work/checkout-service" />,
    ))
    await waitFor(() => expect(mockApi.mcpProjectTrust).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
