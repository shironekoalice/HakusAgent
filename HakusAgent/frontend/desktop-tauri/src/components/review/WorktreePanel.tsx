/**
 * Worktree + handoff panel.
 */

import { useEffect, useState } from 'react'
import { FolderGit2, GitBranch, Loader2, Plus, RefreshCw, Waypoints } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSessionStore } from '@/store/session'
import { useReviewStore } from '@/store/review'
import { useToast } from '@/components/ui/toast'
import type { ChatMessage } from '@/api/types'
import {
  RpBody,
  RpChip,
  RpEmpty,
  RpHeader,
  RpIconButton,
  RpSection,
  RpShell,
  useRpCopy,
} from './PanelChrome'

const EMPTY_MESSAGES: ChatMessage[] = []

export function WorktreePanel() {
  const copy = useRpCopy()
  const toast = useToast()
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const messagesMap = useSessionStore((s) => s.messages)
  const messages = (activeSessionId && messagesMap[activeSessionId]) || EMPTY_MESSAGES
  const worktrees = useReviewStore((s) => s.worktrees)
  const worktreeLoading = useReviewStore((s) => s.worktreeLoading)
  const handoffs = useReviewStore((s) => s.handoffs)
  const loadWorktrees = useReviewStore((s) => s.loadWorktrees)
  const createWorktree = useReviewStore((s) => s.createWorktree)
  const extractHandoffs = useReviewStore((s) => s.extractHandoffs)

  const [workdir, setWorkdir] = useState('')
  const [newPath, setNewPath] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    extractHandoffs(messages)
  }, [messages, extractHandoffs])

  useEffect(() => {
    void (async () => {
      try {
        const status = await (await import('@/api/client')).apiClient.getGitStatus()
        setWorkdir(status.workdir || '')
        if (status.is_repo) void loadWorktrees(status.workdir)
      } catch {
        /* not a repo */
      }
    })()
  }, [loadWorktrees])

  const onCreate = async () => {
    if (!workdir || !newPath.trim()) return
    setCreating(true)
    try {
      await createWorktree(workdir, newPath.trim(), newBranch.trim() || undefined)
      toast.success(copy('Worktree 已创建', 'Worktree created'))
      setNewPath('')
      setNewBranch('')
    } catch (e: any) {
      toast.error(copy('创建失败：', 'Create failed: ') + (e?.message || e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <RpShell>
      <RpHeader
        icon={FolderGit2}
        title={copy('Worktree / 交接', 'Worktrees & handoffs')}
        actions={
          <RpIconButton
            icon={RefreshCw}
            title={copy('刷新', 'Refresh')}
            disabled={!workdir || worktreeLoading}
            onClick={() => workdir && void loadWorktrees(workdir)}
          />
        }
      />

      <RpBody>
        <RpSection label={copy('Git Worktrees', 'Git worktrees')} icon={GitBranch}>
          {!workdir ? (
            <RpEmpty
              icon={FolderGit2}
              title={copy('未绑定 Git 仓库', 'No Git repository bound')}
              desc={copy('在已初始化 git 的项目工作区中打开会话后可用。', 'Open a chat in a git-initialized project workspace.')}
            />
          ) : worktreeLoading && worktrees.length === 0 ? (
            <div className="flex items-center gap-2 py-3 text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {copy('加载中...', 'Loading...')}
            </div>
          ) : worktrees.length === 0 ? (
            <div className="rp-card text-center text-[11px] text-muted-foreground">
              {copy('未找到 worktree', 'No worktrees found')}
            </div>
          ) : (
            <div className="space-y-1.5">
              {worktrees.map((wt) => (
                <div key={wt.path} className="rp-card rp-card-tight">
                  <div className="flex items-center gap-1.5">
                    <GitBranch className="rp-row-icon text-primary/80" />
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                      {wt.branch || copy('(detached)', '(detached)')}
                    </span>
                    {wt.locked ? <RpChip tone="warn">{copy('锁定', 'locked')}</RpChip> : null}
                  </div>
                  <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={wt.path}>
                    {wt.path}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">{wt.head.slice(0, 10)}</div>
                </div>
              ))}
            </div>
          )}

          {workdir ? (
            <div className="mt-2 space-y-1.5 rounded-xl border border-dashed border-border/55 p-2.5">
              <div className="rp-section-label !mb-0">{copy('新建 worktree', 'New worktree')}</div>
              <input
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder={copy('路径，如 ../repo-feature-x', 'Path, e.g. ../repo-feature-x')}
                className="rp-input"
              />
              <input
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                placeholder={copy('新分支名（可选）', 'New branch name (optional)')}
                className="rp-input"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-7 rounded-lg px-2.5 text-[11px]"
                disabled={creating || !newPath.trim()}
                onClick={() => void onCreate()}
              >
                {creating ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Plus className="mr-1 h-3 w-3" />}
                {copy('创建', 'Create')}
              </Button>
            </div>
          ) : null}
        </RpSection>

        <RpSection label={copy('本会话交接', 'Handoffs in this chat')} icon={Waypoints}>
          {handoffs.length === 0 ? (
            <div className="rp-card text-center text-[11px] text-muted-foreground">
              {copy('暂无 handoff / 子线程调用', 'No handoff or sub-thread calls yet')}
            </div>
          ) : (
            <div className="space-y-1.5">
              {handoffs.map((h) => {
                const destLabel = /worktree/i.test(h.destination)
                  ? copy('worktree', 'worktree')
                  : /local/i.test(h.destination)
                    ? copy('本地', 'local')
                    : h.destination
                return (
                  <div key={h.id} className="rp-card rp-card-tight">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                        {h.status === 'done'
                          ? copy(`已交接至 ${destLabel}`, `Handed off to ${destLabel}`)
                          : h.status === 'failed'
                            ? copy(`交接至 ${destLabel} 失败`, `Failed to hand off to ${destLabel}`)
                            : copy(`正在交接至 ${destLabel}`, `Handing off to ${destLabel}`)}
                      </span>
                      <RpChip tone={h.status === 'done' ? 'ok' : h.status === 'failed' ? 'danger' : 'warn'}>
                        {h.status === 'done' ? copy('完成', 'done') : h.status === 'failed' ? copy('失败', 'failed') : copy('进行中', 'working')}
                      </RpChip>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-muted-foreground">{h.tool}</div>
                    {h.summary ? (
                      <div className="mt-0.5 truncate text-[10px] text-muted-foreground/80">{h.summary}</div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </RpSection>
      </RpBody>
    </RpShell>
  )
}
