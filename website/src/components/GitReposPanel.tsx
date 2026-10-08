import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import GitPanel from './GitPanel'
import ErrorNotice from './ErrorNotice'
import { errMessage } from '../utils/thunkError'
import { findReport } from '../utils/errorReport'
import { i18nT } from '../i18n/t'

interface GitReposPanelProps {
  /** The chat whose repositories are listed. */
  slotKey: string
  onFileOpen?: (path: string) => void
  onClose: () => void
}

/**
 * The Git tab: one collapsible section per repository this chat works in.
 *
 * Most chats start in the shared workspace, which is not a repository, and then
 * edit files or run commands in repositories elsewhere. The gateway notices
 * those from the chat's own tool calls (`GET /api/project/git/repos`), so the
 * tab lists them without the user picking a project folder first. The chat's
 * project, when it is in a repository, comes first.
 */
export default function GitReposPanel({ slotKey, onFileOpen, onClose }: GitReposPanelProps) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['git-repos', slotKey],
    queryFn: () => api.projectGitRepos(slotKey),
    enabled: !!slotKey,
    // A repository joins the list mid-turn, as soon as the agent touches it.
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    retry: 1,
  })
  const repos = data?.repos ?? []
  const message = errMessage(error)

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto" data-testid="git-repos-panel">
      {error ? (
        <div className="p-3">
          <ErrorNotice
            message={message || i18nT('components.gitPanel.repos_failed')}
            report={findReport(message)}
            askAgent
            testId="git-repos-error"
          />
        </div>
      ) : !isLoading && repos.length === 0 ? (
        <div role="status" className="px-6 pt-8 text-center text-muted text-[13px]">
          {i18nT('components.gitPanel.repos_empty')}
        </div>
      ) : (
        repos.map((repo, index) => (
          <GitPanel
            key={repo.path}
            projectDir={repo.path}
            onFileOpen={onFileOpen}
            onClose={onClose}
            section={{
              label: repo.path,
              badge: repo.source === 'project' ? i18nT('components.gitPanel.source_project') : undefined,
              defaultOpen: index === 0,
            }}
          />
        ))
      )}
    </div>
  )
}
