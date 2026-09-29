/**
 * Git review panel — fine-grained review chrome.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  FileEdit,
  FileMinus,
  FilePlus,
  FileQuestion,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Undo2,
} from 'lucide-react'
import { apiClient } from '@/api/client'
import type { GitFileChange } from '@/api/types'
import { parseDiff, buildHunkPatch, type ParsedHunk } from '@/lib/patch'
import { useReviewStore } from '@/store/review'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import { useI18n } from '@/lib/i18n'
import {
  RpBody,
  RpChip,
  RpEmpty,
  RpFooter,
  RpHeader,
  RpIconButton,
  RpShell,
  useRpCopy,
} from './PanelChrome'

type Scope = 'unstaged' | 'staged' | 'last_turn' | 'head1' | 'pr'

const SCOPE_OPTIONS: Array<{ id: Scope; zh: string; en: string }> = [
  { id: 'unstaged', zh: '未暂存', en: 'Unstaged' },
  { id: 'staged', zh: '已暂存', en: 'Staged' },
  { id: 'last_turn', zh: '上一轮', en: 'Last turn' },
  { id: 'head1', zh: 'HEAD~1', en: 'vs HEAD~1' },
  { id: 'pr', zh: 'PR', en: 'PRs' },
]

function statusIcon(s: GitFileChange['status']) {
  switch (s) {
    case 'added':
      return <FilePlus className="rp-row-icon text-emerald-500" />
    case 'deleted':
      return <FileMinus className="rp-row-icon text-rose-500" />
    case 'modified':
      return <FileEdit className="rp-row-icon text-amber-500" />
    default:
      return <FileQuestion className="rp-row-icon" />
  }
}

function statusLabel(s: GitFileChange['status']) {
  return { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: '?', unknown: '·' }[s]
}

export function DiffReview() {
  const { locale } = useI18n()
  const copy = useRpCopy()
  const toast = useToast()
  const scope = useReviewStore((s) => s.reviewScope as Scope)
  const setScope = useReviewStore((s) => s.setReviewScope)
  const viewedFiles = useReviewStore((s) => s.viewedFiles)
  const toggleViewed = useReviewStore((s) => s.toggleViewed)
  const branches = useReviewStore((s) => s.branches)
  const loadBranches = useReviewStore((s) => s.loadBranches)
  const pullRequests = useReviewStore((s) => s.pullRequests)
  const prLoading = useReviewStore((s) => s.prLoading)
  const loadPullRequests = useReviewStore((s) => s.loadPullRequests)

  const [status, setStatus] = useState<Awaited<ReturnType<typeof apiClient.getGitStatus>> | null>(null)
  const [diffText, setDiffText] = useState('')
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [busyHunk, setBusyHunk] = useState<string | null>(null)
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false)

  const scopeId: string = scope
  const scopeLabel =
    SCOPE_OPTIONS.find((o) => o.id === scopeId)?.[locale === 'zh-CN' ? 'zh' : 'en'] || scopeId

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const s = await apiClient.getGitStatus()
      setStatus(s)
      if (s.is_repo && s.workdir) {
        void loadBranches(s.workdir)
        if (scopeId === 'pr') void loadPullRequests(s.workdir)
      }
      if (scopeId === 'pr') {
        setDiffText('')
        setLoading(false)
        return
      }
      const d = await apiClient.getGitDiff(
        scopeId === 'staged'
          ? { staged: true }
          : scopeId === 'last_turn'
            ? { ref: 'HEAD' }
            : scopeId === 'head1'
              ? { ref: 'HEAD~1' }
              : { staged: false },
      )
      setDiffText(d.diff || '')
      const files = parseDiff(d.diff || '')
      if (files.length > 0 && expanded.size === 0) {
        setExpanded(new Set([files[0].path]))
      }
    } catch (e: any) {
      console.error('[DiffReview]', e)
      toast.error(`${copy('获取 git 状态失败：', 'Could not read git status: ')}${e?.message || e}`)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Close scope dropdown on outside click / Escape
  useEffect(() => {
    if (!scopeMenuOpen) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target && !target.closest('.rp-scope-btn') && !target.closest('.rp-scope-menu')) {
        setScopeMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setScopeMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [scopeMenuOpen])

  const fileDiffs = useMemo(() => parseDiff(diffText), [diffText])

  const allChanges: GitFileChange[] = useMemo(() => {
    if (!status) return []
    if (scopeId === 'staged') return status.staged
    if (scopeId === 'unstaged') return [...status.unstaged, ...status.untracked]
    if (scopeId === 'last_turn' || scopeId === 'head1') {
      return fileDiffs.map((f) => ({
        path: f.path,
        status: f.isNew ? ('added' as const) : f.isDeleted ? ('deleted' as const) : ('modified' as const),
        staged: false,
      }))
    }
    return []
  }, [status, scopeId, fileDiffs])

  const applyPatch = async (patch: string, opts: { reverse: boolean; cached: boolean; hunkId: string }) => {
    setBusyHunk(opts.hunkId)
    try {
      const { gitOs } = await import('@/api/tauriBridge')
      const workdir = status?.workdir
      if (!workdir) throw new Error(copy('缺少工作目录', 'Missing workdir'))
      await gitOs.applyPatch(workdir, patch, opts.reverse, opts.cached)
      toast.success(
        opts.reverse
          ? copy('已回滚该 hunk', 'Hunk reverted')
          : opts.cached
            ? copy('已暂存该 hunk', 'Hunk staged')
            : copy('已应用补丁', 'Patch applied'),
      )
      await refresh()
    } catch (e: any) {
      console.error('[DiffReview] patch', e)
      toast.error(copy('补丁操作失败：', 'Patch failed: ') + (e?.message || e))
    } finally {
      setBusyHunk(null)
    }
  }

  const handleStage = async (path: string, unstage: boolean) => {
    setBusyPath(path)
    try {
      await apiClient.stagePath(path, unstage)
      toast.success((unstage ? copy('已取消暂存', 'Unstaged') : copy('已暂存', 'Staged')) + ' · ' + path.split(/[\\/]/).pop())
      await refresh()
    } catch (e: any) {
      console.error('[DiffReview] stage', e)
      toast.error(copy('操作失败：', 'Failed: ') + (e?.message || e))
    } finally {
      setBusyPath(null)
    }
  }

  const toggleFile = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  if (!status) {
    return (
      <RpShell>
        <div className="rp-empty">
          <Loader2 className="rp-empty-icon animate-spin" />
          <div className="rp-empty-desc">{copy('加载中...', 'Loading...')}</div>
        </div>
      </RpShell>
    )
  }

  if (!status.is_repo) {
    return (
      <RpShell>
        <RpEmpty
          icon={FolderGit2}
          title={copy('非 Git 仓库', 'Not a Git repository')}
          desc={copy('工作目录不在 git 仓库内，无法查看差异。', 'The working directory is not inside a Git repository.')}
        />
      </RpShell>
    )
  }

  return (
    <RpShell>
      <RpHeader
        icon={GitBranch}
        title={status.branch || 'detached'}
        meta={branches.length > 1 ? `${branches.length}` : null}
        actions={
          <>
            <div className="relative">
              <button
                type="button"
                className="rp-scope-btn"
                onClick={() => setScopeMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={scopeMenuOpen}
              >
                {scopeLabel}
                <ChevronDown className="h-3 w-3 opacity-55" />
              </button>
              {scopeMenuOpen && (
                <div className="rp-scope-menu" role="menu">
                  {SCOPE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="menuitem"
                      data-active={scopeId === opt.id}
                      className="rp-scope-item"
                      onClick={() => {
                        setScope(opt.id as never)
                        setScopeMenuOpen(false)
                      }}
                    >
                      {copy(opt.zh, opt.en)}
                      {scopeId === opt.id && <Check className="h-3 w-3" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <RpIconButton icon={RefreshCw} title={copy('刷新', 'Refresh')} onClick={() => void refresh()} disabled={loading} />
          </>
        }
      />

      <RpBody pad={false}>
        {scopeId === 'pr' ? (
          <div className="rp-pad">
            <div className="rp-section-label">
              <GitPullRequest aria-hidden />
              {copy('Pull requests', 'Pull requests')}
              {prLoading ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : null}
            </div>
            {pullRequests.length === 0 ? (
              <RpEmpty
                icon={GitPullRequest}
                title={copy('没有开放的 PR', 'No open pull requests')}
                desc={copy('需安装 GitHub CLI（gh）并登录仓库远端。', 'Requires GitHub CLI (`gh`) authenticated to this remote.')}
              />
            ) : (
              <div className="space-y-1.5">
                {pullRequests.map((pr) => (
                  <div key={pr.number} className="rp-card rp-card-tight">
                    <div className="flex items-start gap-2">
                      <GitPullRequest className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/80" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] font-medium">
                          <span className="text-muted-foreground">#{pr.number}</span> {pr.title}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                          {pr.branch}
                          {pr.author ? ` · ${pr.author}` : ''}
                        </div>
                      </div>
                      <RpChip
                        tone={
                          pr.state === 'open' ? 'ok' : pr.state === 'draft' ? 'muted' : pr.state === 'merged' ? 'info' : 'muted'
                        }
                      >
                        {pr.state}
                      </RpChip>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : allChanges.length === 0 ? (
          <RpEmpty
            icon={Check}
            title={
              scopeId === 'staged'
                ? copy('没有已暂存的改动', 'No staged changes')
                : scopeId === 'last_turn'
                  ? copy('上一轮已提交或回滚', 'The last turn was committed or reverted')
                  : copy('工作区干净', 'Working tree clean')
            }
            desc={
              scopeId === 'staged'
                ? copy('接受编辑后它们会出现在这里。', 'Accept edits to stage them.')
                : scopeId === 'unstaged'
                  ? copy('代码变更会显示在这里。', 'Code changes will appear here.')
                  : undefined
            }
          />
        ) : (
          <div>
            {allChanges.map((f) => {
              const fd = fileDiffs.find((d) => d.path === f.path)
              const isOpen = expanded.has(f.path)
              const isViewed = Boolean(viewedFiles[f.path])
              return (
                <div key={f.path} className="border-b border-border/25 last:border-b-0">
                  <div className="rp-file-row group" data-viewed={isViewed}>
                    <button
                      type="button"
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground"
                      onClick={() => toggleFile(f.path)}
                      aria-label={isOpen ? copy('折叠', 'Collapse') : copy('展开', 'Expand')}
                    >
                      <ChevronDown className={cn('h-3 w-3 transition-transform', !isOpen && '-rotate-90')} />
                    </button>
                    <span className="w-3 shrink-0 text-center font-mono text-[10px] font-semibold text-muted-foreground">
                      {statusLabel(f.status)}
                    </span>
                    {statusIcon(f.status)}
                    <button type="button" className="rp-file-path text-left" onClick={() => toggleFile(f.path)} title={f.path}>
                      {f.path}
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        className="rp-icon-btn !h-5 !w-5"
                        onClick={() => toggleViewed(f.path)}
                        title={isViewed ? copy('标记未读', 'Mark unviewed') : copy('标记已读', 'Mark viewed')}
                      >
                        {isViewed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      </button>
                      {scopeId !== 'staged' && scopeId !== 'pr' && f.status !== 'untracked' && (
                        <button
                          type="button"
                          className="rp-icon-btn !h-5 !w-5"
                          onClick={() => handleStage(f.path, false)}
                          disabled={busyPath === f.path}
                          title={copy('暂存文件', 'Stage file')}
                        >
                          {busyPath === f.path ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        </button>
                      )}
                      {scopeId === 'staged' && (
                        <button
                          type="button"
                          className="rp-icon-btn !h-5 !w-5"
                          onClick={() => handleStage(f.path, true)}
                          disabled={busyPath === f.path}
                          title={copy('取消暂存', 'Unstage')}
                        >
                          {busyPath === f.path ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
                        </button>
                      )}
                    </div>
                  </div>

                  {isOpen && fd && (
                    <div className="overflow-x-auto border-t border-border/25 bg-background/30 py-1">
                      {fd.hunks.map((h: ParsedHunk, hi: number) => {
                        const hunkId = `${fd.path}:${hi}`
                        return (
                          <div key={hunkId} className="mb-1.5">
                            <div className="rp-hunk-bar">
                              <span className="min-w-0 flex-1 truncate">{h.header}</span>
                              <div className="rp-hunk-actions">
                                <button
                                  type="button"
                                  className="rp-hunk-btn"
                                  disabled={busyHunk === hunkId}
                                  title={copy('暂存此 hunk', 'Stage hunk')}
                                  onClick={() =>
                                    void applyPatch(buildHunkPatch(fd, h, false), {
                                      reverse: false,
                                      cached: true,
                                      hunkId,
                                    })
                                  }
                                >
                                  {busyHunk === hunkId ? (
                                    <Loader2 className="inline h-3 w-3 animate-spin" />
                                  ) : (
                                    copy('暂存', 'Stage')
                                  )}
                                </button>
                                <button
                                  type="button"
                                  className="rp-hunk-btn rp-hunk-btn-danger"
                                  disabled={busyHunk === hunkId}
                                  title={copy('回滚此 hunk', 'Revert hunk')}
                                  onClick={() =>
                                    void applyPatch(buildHunkPatch(fd, h, true), {
                                      reverse: true,
                                      cached: scopeId === 'staged',
                                      hunkId,
                                    })
                                  }
                                >
                                  <Undo2 className="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                            {h.lines.slice(1).map((ln, li) => (
                              <div
                                key={li}
                                className={cn(
                                  'diff-line',
                                  ln.type === 'add' && 'diff-line-add',
                                  ln.type === 'del' && 'diff-line-del',
                                  ln.type === 'context' && 'diff-line-context',
                                  ln.type === 'meta' && 'diff-line-meta',
                                )}
                              >
                                <span className="diff-line-no">
                                  {ln.type === 'add' ? ln.newNo : ln.type === 'del' ? ln.oldNo : ''}
                                </span>
                                <span className="w-3 shrink-0 select-none text-center text-muted-foreground/50">
                                  {ln.type === 'add' ? '+' : ln.type === 'del' ? '-' : ' '}
                                </span>
                                <span className="whitespace-pre-wrap break-all">{ln.content}</span>
                              </div>
                            ))}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {isOpen && !fd && (
                    <div className="px-3 py-2 text-[11px] text-muted-foreground">
                      {f.status === 'untracked'
                        ? copy('新文件，尚未跟踪', 'New file, not tracked yet')
                        : copy('无差异内容', 'No diff content')}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </RpBody>

      <RpFooter>
        <span>
          {allChanges.length} {copy('个文件', allChanges.length === 1 ? 'file' : 'files')}
          {Object.keys(viewedFiles).length > 0 ? ` · ${Object.keys(viewedFiles).length} ${copy('已读', 'viewed')}` : ''}
        </span>
        <span className="truncate">{status.workdir.split(/[\\/]/).pop()}</span>
      </RpFooter>
    </RpShell>
  )
}
