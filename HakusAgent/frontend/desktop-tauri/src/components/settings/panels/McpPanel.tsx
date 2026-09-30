/**
 * MCP (Model Context Protocol) Panel — Phase 2 round 3.
 *
 * Surfaces the MCP client in the Rust Runtime API from the settings UI. Lets users:
 *   - List configured MCP servers with their runtime status
 *   - Add / edit / delete server configs (stdio transport only for now)
 *   - Start / stop a server on demand
 *   - Test connection (spawns a fresh process, lists tools, then exits)
 *   - Inspect a running server's tool catalog
 *   - Tweak global MCP options (auto_start / fail_fast / tool_naming)
 *
 * All state is fetched fresh from the backend; we don't keep a local store.
 * The panel polls the server list every 5s while visible to reflect runtime
 * status changes (a server that was 'starting' transitions to 'running'
 * asynchronously).
 */

import { useEffect, useState, useCallback } from 'react'
import {
  Plug,
  Plus,
  Pencil,
  Trash2,
  Play,
  Square,
  FlaskConical,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Activity,
  Wrench,
  RefreshCw,
  Power,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { apiClient, BackendOutdatedError } from '@/api/client'
import { BackendOutdatedBanner } from '@/components/settings/BackendOutdatedBanner'
import { cn } from '@/lib/utils'
import type {
  McpServerInfo,
  McpServerConfig,
  McpGlobalConfig,
  McpToolInfo,
  McpTestResult,
} from '@/api/types'
import { useI18n } from '@/lib/i18n'

// ─── Status metadata ────────────────────────────────────────────────────────

type ServerStatus = McpServerInfo['status']

const STATUS_META: Record<ServerStatus, { labelZh: string; labelEn: string; tone: string; icon: typeof Activity }> = {
  stopped: { labelZh: '已停止', labelEn: 'Stopped', tone: 'text-muted-foreground bg-muted', icon: Square },
  starting: { labelZh: '启动中', labelEn: 'Starting', tone: 'text-primary bg-primary/15', icon: Loader2 },
  running: { labelZh: '运行中', labelEn: 'Running', tone: 'text-emerald-500 bg-emerald-500/15', icon: CheckCircle2 },
  failed: { labelZh: '失败', labelEn: 'Failed', tone: 'text-rose-500 bg-rose-500/15', icon: XCircle },
  disabled: { labelZh: '已禁用', labelEn: 'Disabled', tone: 'text-amber-500 bg-amber-500/15', icon: Power },
}

// ─── Default form values ────────────────────────────────────────────────────

const EMPTY_FORM: McpServerFormValues = {
  name: '',
  enabled: true,
  transport: 'stdio',
  command: '',
  args: '',
  env: '',
  cwd: '',
  startup_timeout: 15,
  tool_timeout: 60,
}

interface McpServerFormValues {
  name: string
  enabled: boolean
  transport: 'stdio' | 'sse' | 'http'
  command: string
  args: string
  env: string
  cwd: string
  startup_timeout: number
  tool_timeout: number
}

function formToConfig(v: McpServerFormValues): McpServerConfig {
  const args = v.args
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const env: Record<string, string> = {}
  for (const line of v.env.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.includes('=')) continue
    const idx = trimmed.indexOf('=')
    const k = trimmed.slice(0, idx).trim()
    const val = trimmed.slice(idx + 1).trim()
    if (k) env[k] = val
  }
  return {
    enabled: v.enabled,
    transport: v.transport,
    command: v.command.trim(),
    args,
    env,
    cwd: v.cwd.trim() || null,
    startup_timeout: v.startup_timeout,
    tool_timeout: v.tool_timeout,
  }
}

function serverToForm(s: McpServerInfo): McpServerFormValues {
  return {
    name: s.name,
    enabled: s.enabled,
    transport: s.transport,
    command: s.command,
    args: s.args.join(' '),
    // We only have env keys server-side (values are masked). Reconstruct
    // KEY=*** placeholders so the user can see which keys are set; editing
    // any line will replace the value on save.
    env: s.env_keys.map((k) => `${k}=***`).join('\n'),
    cwd: s.cwd || '',
    startup_timeout: s.startup_timeout,
    tool_timeout: s.tool_timeout,
  }
}

// ─── Main panel ─────────────────────────────────────────────────────────────

export function McpPanel() {
  const toast = useToast()
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const [loading, setLoading] = useState(true)
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [globalCfg, setGlobalCfg] = useState<McpGlobalConfig>({
    auto_start: false,
    fail_fast: false,
    tool_naming: 'namespace',
  })
  const [outdatedError, setOutdatedError] = useState<BackendOutdatedError | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [toolsByServer, setToolsByServer] = useState<Record<string, McpToolInfo[]>>({})
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ mode: 'create' | 'edit'; initial: McpServerFormValues } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<McpServerInfo | null>(null)
  const [testing, setTesting] = useState<McpTestResult | null>(null)

  const refresh = useCallback(async () => {
    setOutdatedError(null)
    try {
      const resp = await apiClient.getMcpServers()
      setServers(resp.servers)
      setGlobalCfg(resp.global)
    } catch (e: any) {
      if (e instanceof BackendOutdatedError) {
        setOutdatedError(e)
      } else {
        // Silent on background polls — only toast on first load.
        if (loading) toast.error(copy(`加载 MCP 服务器列表失败：${e?.message || e}`, `Could not load MCP servers: ${e?.message || e}`))
      }
    } finally {
      setLoading(false)
    }
  }, [loading, toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Poll every 5s for runtime status updates. We don't poll while a dialog
  // is open to avoid clobbering form state in the middle of editing.
  useEffect(() => {
    if (editing || confirmDelete) return
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [refresh, editing, confirmDelete])

  const handleToggleEnabled = async (s: McpServerInfo, next: boolean) => {
    setBusyAction(`toggle-${s.name}`)
    try {
      await apiClient.updateMcpServer(s.name, { enabled: next })
      toast.success(copy(`${s.name} 已${next ? '启用' : '禁用'}`, `${s.name} ${next ? 'enabled' : 'disabled'}`))
      await refresh()
    } catch (e: any) {
      toast.error(copy(`切换失败：${e?.message || e}`, `Update failed: ${e?.message || e}`))
    } finally {
      setBusyAction(null)
    }
  }

  const handleStart = async (s: McpServerInfo) => {
    setBusyAction(`start-${s.name}`)
    try {
      const result = await apiClient.startMcpServer(s.name)
      if (result.ok) {
        toast.success(copy(`${s.name} 已启动，发现 ${result.tools.length} 个工具`, `${s.name} started with ${result.tools.length} tool${result.tools.length === 1 ? '' : 's'}`))
        if (result.tools.length > 0) {
          setToolsByServer((prev) => ({ ...prev, [s.name]: result.tools }))
          setExpanded((prev) => new Set(prev).add(s.name))
        }
      } else {
        toast.error(copy(`${s.name} 启动失败：${result.message}`, `${s.name} failed to start: ${result.message}`))
      }
      await refresh()
    } catch (e: any) {
      toast.error(copy(`启动失败：${e?.message || e}`, `Start failed: ${e?.message || e}`))
    } finally {
      setBusyAction(null)
    }
  }

  const handleStop = async (s: McpServerInfo) => {
    setBusyAction(`stop-${s.name}`)
    try {
      await apiClient.stopMcpServer(s.name)
      toast.success(copy(`${s.name} 已停止`, `${s.name} stopped`))
      await refresh()
    } catch (e: any) {
      toast.error(copy(`停止失败：${e?.message || e}`, `Stop failed: ${e?.message || e}`))
    } finally {
      setBusyAction(null)
    }
  }

  const handleTest = async (s: McpServerInfo) => {
    setBusyAction(`test-${s.name}`)
    try {
      const result = await apiClient.testMcpServer(s.name)
      setTesting(result)
      if (result.ok) {
        toast.success(copy(`${s.name} 测试成功，发现 ${result.tools.length} 个工具`, `${s.name} test passed with ${result.tools.length} tool${result.tools.length === 1 ? '' : 's'}`))
      } else {
        toast.error(copy(`${s.name} 测试失败：${result.message}`, `${s.name} test failed: ${result.message}`))
      }
    } catch (e: any) {
      toast.error(copy(`测试失败：${e?.message || e}`, `Test failed: ${e?.message || e}`))
    } finally {
      setBusyAction(null)
    }
  }

  const handleExpand = async (s: McpServerInfo) => {
    const next = new Set(expanded)
    if (next.has(s.name)) {
      next.delete(s.name)
    } else {
      next.add(s.name)
      // Lazy-load tools list if we don't have it cached.
      if (!toolsByServer[s.name] && s.status === 'running') {
        try {
          const resp = await apiClient.listMcpServerTools(s.name)
          if (resp.ok) {
            setToolsByServer((prev) => ({ ...prev, [s.name]: resp.tools }))
          }
        } catch (e: any) {
          toast.error(copy(`获取工具列表失败：${e?.message || e}`, `Could not load tool list: ${e?.message || e}`))
        }
      }
    }
    setExpanded(next)
  }

  const handleSaveServer = async (v: McpServerFormValues) => {
    if (!v.name.trim()) {
      toast.error(copy('服务器名称不能为空', 'Server name is required'))
      return
    }
    if (!v.command.trim()) {
      toast.error(copy('command 不能为空', 'Command is required'))
      return
    }
    const config = formToConfig(v)
    setBusyAction('save')
    try {
      if (editing?.mode === 'create') {
        await apiClient.saveMcpServer(v.name.trim(), config)
        toast.success(copy(`已添加 MCP server：${v.name}`, `MCP server added: ${v.name}`))
      } else if (editing?.mode === 'edit') {
        // Save under possibly-new name: delete + create (the backend PATCH
        // doesn't rename, only field updates).
        const originalName = editing.initial.name
        if (v.name.trim() !== originalName) {
          await apiClient.deleteMcpServer(originalName)
          await apiClient.saveMcpServer(v.name.trim(), config)
        } else {
          await apiClient.updateMcpServer(originalName, {
            enabled: config.enabled,
            transport: config.transport,
            command: config.command,
            args: config.args,
            env: config.env,
            cwd: config.cwd,
            startup_timeout: config.startup_timeout,
            tool_timeout: config.tool_timeout,
          })
        }
        toast.success(copy(`${v.name} 已更新`, `${v.name} updated`))
      }
      setEditing(null)
      await refresh()
    } catch (e: any) {
      toast.error(copy(`保存失败：${e?.message || e}`, `Save failed: ${e?.message || e}`))
    } finally {
      setBusyAction(null)
    }
  }

  const handleDelete = async (s: McpServerInfo) => {
    setBusyAction(`delete-${s.name}`)
    try {
      await apiClient.deleteMcpServer(s.name)
      toast.success(copy(`${s.name} 已删除`, `${s.name} deleted`))
      setConfirmDelete(null)
      await refresh()
    } catch (e: any) {
      toast.error(copy(`删除失败：${e?.message || e}`, `Delete failed: ${e?.message || e}`))
    } finally {
      setBusyAction(null)
    }
  }

  const handleUpdateGlobal = async (patch: Partial<McpGlobalConfig>) => {
    try {
      const resp = await apiClient.updateMcpGlobalConfig(patch)
      setGlobalCfg(resp.global)
      toast.success(copy('全局设置已更新', 'Global settings updated'))
    } catch (e: any) {
      toast.error(copy(`更新失败：${e?.message || e}`, `Update failed: ${e?.message || e}`))
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  if (outdatedError) {
    return (
      <div className="settings-section settings-mcp-section">
        <BackendOutdatedBanner
          message={outdatedError.message}
          backendVersion={outdatedError.backendVersion}
          onRetry={refresh}
        />
      </div>
    )
  }

  return (
    <section className="settings-section settings-mcp-section">
      <div className="settings-section-heading">
        <div>
          <h2>{copy('MCP 服务器', 'MCP servers')}</h2>
          <p>{copy('连接外部工具服务，并管理它们的启动和命名方式。', 'Connect external tool servers and manage startup and naming.')}</p>
        </div>
      </div>
      {/* Header */}
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditing({ mode: 'create', initial: EMPTY_FORM })}
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> {copy('添加', 'Add')}
        </Button>
      </div>

      {/* Server list */}
      <div className="space-y-3">
        {loading && servers.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> {copy('加载中…', 'Loading…')}
          </div>
        ) : servers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/30 p-8 text-center">
            <Plug className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">{copy('还没有配置任何 MCP server', 'No MCP servers configured')}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {copy('添加一个 stdio MCP server（如 npx -y @modelcontextprotocol/server-filesystem），让 HakusAI 调用其工具。', 'Add a stdio MCP server (for example, npx -y @modelcontextprotocol/server-filesystem) so HakusAI can call its tools.')}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setEditing({ mode: 'create', initial: EMPTY_FORM })}
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> {copy('添加第一个', 'Add your first')}
            </Button>
          </div>
        ) : (
          servers.map((s) => (
            <ServerCard
              key={s.name}
              server={s}
              expanded={expanded.has(s.name)}
              tools={toolsByServer[s.name]}
              busyAction={busyAction}
              onToggleEnabled={(next) => handleToggleEnabled(s, next)}
              onStart={() => handleStart(s)}
              onStop={() => handleStop(s)}
              onTest={() => handleTest(s)}
              onExpand={() => handleExpand(s)}
              onEdit={() => setEditing({ mode: 'edit', initial: serverToForm(s) })}
              onDelete={() => setConfirmDelete(s)}
              copy={copy}
            />
          ))
        )}
      </div>

      {/* Global MCP options */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Zap className="h-3.5 w-3.5" /> {copy('全局选项', 'Global options')}
        </div>

        <GlobalToggleRow
          id="mcp-auto-start"
          title={copy('打开应用时自动启动已启用的 MCP 服务', 'Start enabled MCP services when the app opens')}
          desc={copy('关闭则需在列表里手动点启动按钮。', 'When off, start servers manually from the list.')}
          checked={globalCfg.auto_start}
          onChange={(v) => handleUpdateGlobal({ auto_start: v })}
        />

        <GlobalToggleRow
          id="mcp-fail-fast"
          title={copy('快速失败（任一 server 启动失败则中止后续）', 'Fail fast (stop when a server fails to start)')}
          desc={copy('关闭则继续启动其它 server，失败的标记为“failed”。', 'When off, continue starting other servers and mark failures as “failed”.')}
          checked={globalCfg.fail_fast}
          onChange={(v) => handleUpdateGlobal({ fail_fast: v })}
        />

        <div className="flex items-center justify-between rounded-xl border border-border bg-card/40 p-4">
          <div className="flex-1 pr-4">
            <Label className="text-sm font-medium">{copy('工具命名方式', 'Tool naming')}</Label>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              <code className="rounded bg-muted px-1 py-0.5 text-[10px]">namespace</code>:
              {copy('servername__toolname（避免冲突，默认）；', 'servername__toolname (default, avoids collisions);')}
              <code className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px]">flat</code>: {copy('直接用 toolname。', 'use toolname directly.')}
            </p>
          </div>
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {(['namespace', 'flat'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => handleUpdateGlobal({ tool_naming: mode })}
                className={cn(
                  'rounded-md px-3 py-1.5 text-[11px] font-medium transition-all',
                  globalCfg.tool_naming === mode
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {copy('MCP 设置会随 HakusAI 一起保存。环境变量只会以脱敏形式显示。', 'MCP settings are saved with HakusAI. Environment variables are only shown in masked form.')}
      </p>

      {/* Edit / Create dialog */}
      {editing && (
        <McpServerDialog
          mode={editing.mode}
          initial={editing.initial}
          busy={busyAction === 'save'}
          onClose={() => setEditing(null)}
          onSave={handleSaveServer}
        />
      )}

      {/* Delete confirm dialog */}
      {confirmDelete && (
        <Dialog open onOpenChange={(o) => !o && setConfirmDelete(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-rose-500" /> {copy('删除 MCP server', 'Delete MCP server')}
              </DialogTitle>
              <DialogDescription>
                {copy('确认删除', 'Delete')} <span className="font-mono font-medium text-foreground">{confirmDelete.name}</span>?{' '}
                {copy('该 server 的所有配置将永久移除，运行中的实例会被立即停止。', 'All configuration for this server will be removed and running instances stopped.')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(null)}>
                {copy('取消', 'Cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => handleDelete(confirmDelete)}
                disabled={busyAction === `delete-${confirmDelete.name}`}
              >
                {busyAction === `delete-${confirmDelete.name}` ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                )}
                {copy('删除', 'Delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Test result dialog */}
      {testing && (
        <Dialog open onOpenChange={(o) => !o && setTesting(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {testing.ok ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                  <XCircle className="h-4 w-4 text-rose-500" />
                )}
                {copy('MCP 测试结果', 'MCP test result')}
              </DialogTitle>
              <DialogDescription className="font-mono text-[11px]">
                {testing.message}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {testing.detail && (
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {copy('详细信息', 'Details')}
                  </div>
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-foreground/80">
                    {testing.detail}
                  </pre>
                </div>
              )}
              <div>
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {copy(`发现的工具 (${testing.tools.length})`, `Tools found (${testing.tools.length})`)}
                </div>
                {testing.tools.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">{copy('无', 'None')}</p>
                ) : (
                  <ul className="space-y-1">
                    {testing.tools.map((t) => (
                      <li
                        key={t.name}
                        className="rounded-md border border-border bg-card/40 px-2 py-1.5"
                      >
                        <div className="flex items-center gap-2">
                          <code className="text-[11px] font-medium text-foreground">
                            {t.name}
                          </code>
                          {t.is_dangerous && (
                            <Badge className="bg-rose-500/15 text-[9px] text-rose-500">
                              {copy('危险', 'Risky')}
                            </Badge>
                          )}
                        </div>
                        {t.description && (
                          <p className="mt-0.5 text-[10px] text-muted-foreground line-clamp-2">
                            {t.description}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => setTesting(null)}>{copy('关闭', 'Close')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}

// ─── ServerCard ─────────────────────────────────────────────────────────────

interface ServerCardProps {
  server: McpServerInfo
  expanded: boolean
  tools?: McpToolInfo[]
  busyAction: string | null
  onToggleEnabled: (next: boolean) => void
  onStart: () => void
  onStop: () => void
  onTest: () => void
  onExpand: () => void
  onEdit: () => void
  onDelete: () => void
  copy: (zh: string, en: string) => string
}

function ServerCard({
  server,
  expanded,
  tools,
  busyAction,
  onToggleEnabled,
  onStart,
  onStop,
  onTest,
  onExpand,
  onEdit,
  onDelete,
  copy,
}: ServerCardProps) {
  const statusMeta = STATUS_META[server.status]
  const StatusIcon = statusMeta.icon
  const isRunning = server.status === 'running'
  const isBusy =
    busyAction === `start-${server.name}` ||
    busyAction === `stop-${server.name}` ||
    busyAction === `test-${server.name}` ||
    busyAction === `toggle-${server.name}` ||
    busyAction === `delete-${server.name}`

  return (
    <div className="rounded-xl border border-border bg-card/40 transition-colors hover:border-primary/30">
      {/* Header row */}
      <div className="flex items-center gap-3 p-3">
        <button
          onClick={onExpand}
          aria-expanded={expanded}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={expanded ? copy('收起', 'Collapse') : copy('展开', 'Expand')}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>

        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Plug className="h-4 w-4" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{server.name}</span>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                statusMeta.tone,
              )}
            >
              <StatusIcon
                className={cn('h-2.5 w-2.5', (server.status === 'starting' || isBusy) && 'animate-spin')}
              />
              {copy(statusMeta.labelZh, statusMeta.labelEn)}
            </span>
            {server.tool_count > 0 && isRunning && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">
                <Wrench className="h-2.5 w-2.5" /> {copy(`${server.tool_count} 工具`, `${server.tool_count} tool${server.tool_count === 1 ? '' : 's'}`)}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
            {server.transport} · {server.command} {server.args.join(' ')}
          </p>
          {server.last_error && (
            <p className="mt-0.5 line-clamp-1 text-[10px] text-rose-500">{server.last_error}</p>
          )}
        </div>

        {/* Quick actions */}
        <div className="flex items-center gap-1">
          <Switch
            checked={server.enabled}
            onCheckedChange={onToggleEnabled}
            disabled={isBusy}
            aria-label={copy('启用/禁用', 'Enable/disable')}
          />
          {isRunning ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onStop}
              disabled={isBusy}
              className="h-7 px-2"
            >
              {busyAction === `stop-${server.name}` ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Square className="h-3 w-3" />
              )}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={onStart}
              disabled={isBusy || !server.enabled}
              className="h-7 px-2"
            >
              {busyAction === `start-${server.name}` ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Play className="h-3 w-3" />
              )}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={onTest}
            disabled={isBusy}
            className="h-7 px-2"
            aria-label={copy('测试连接', 'Test connection')}
          >
            {busyAction === `test-${server.name}` ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <FlaskConical className="h-3 w-3" />
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onEdit}
            disabled={isBusy}
            className="h-7 px-2"
            aria-label={copy('编辑', 'Edit')}
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onDelete}
            disabled={isBusy}
            className="h-7 px-2 hover:border-rose-500/50 hover:text-rose-500"
            aria-label={copy('删除', 'Delete')}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="liquid-glass-disclosure mx-2 mb-2 border-t border-border p-3">
          <div className="grid grid-cols-2 gap-3 text-[11px]">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{copy('传输方式', 'Transport')}</div>
              <div className="mt-0.5 font-mono">{server.transport}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{copy('工作目录', 'Working directory')}</div>
              <div className="mt-0.5 font-mono">{server.cwd || '—'}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{copy('启动超时', 'Startup timeout')}</div>
              <div className="mt-0.5 font-mono">{server.startup_timeout}s</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{copy('工具超时', 'Tool timeout')}</div>
              <div className="mt-0.5 font-mono">{server.tool_timeout}s</div>
            </div>
            <div className="col-span-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{copy('环境变量', 'Environment')}</div>
              <div className="mt-0.5 flex flex-wrap gap-1">
                {server.env_keys.length === 0 ? (
                  <span className="text-muted-foreground">{copy('无', 'None')}</span>
                ) : (
                  server.env_keys.map((k) => (
                    <code
                      key={k}
                      className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/80"
                    >
                      {k}
                    </code>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Tool list (only if running) */}
          {isRunning && (
            <div className="mt-3">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                <Wrench className="h-3 w-3" /> {copy('已注册工具', 'Registered tools')}
              </div>
              {!tools ? (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> {copy('加载中…', 'Loading…')}
                </div>
              ) : tools.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">{copy('该 server 未注册任何工具', 'This server has no registered tools')}</p>
              ) : (
                <ul className="space-y-1">
                  {tools.map((t) => (
                    <li
                      key={t.name}
                      className="rounded-md border border-border bg-card/40 px-2 py-1.5"
                    >
                      <div className="flex items-center gap-2">
                        <code className="text-[11px] font-medium text-foreground">{t.name}</code>
                        {t.is_dangerous && (
                          <Badge className="bg-rose-500/15 text-[9px] text-rose-500">
                            {copy('危险', 'Risky')}
                          </Badge>
                        )}
                      </div>
                      {t.description && (
                        <p className="mt-0.5 text-[10px] text-muted-foreground line-clamp-2">
                          {t.description}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── GlobalToggleRow ────────────────────────────────────────────────────────

function GlobalToggleRow({
  id,
  title,
  desc,
  checked,
  onChange,
}: {
  id: string
  title: string
  desc: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-border bg-card/40 p-4 transition-colors hover:border-primary/30 hover:bg-accent/30">
      <div className="flex-1 pr-4">
        <Label htmlFor={id} className="text-sm font-medium">
          {title}
        </Label>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{desc}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

// ─── McpServerDialog (create/edit form) ─────────────────────────────────────

interface McpServerDialogProps {
  mode: 'create' | 'edit'
  initial: McpServerFormValues
  busy: boolean
  onClose: () => void
  onSave: (v: McpServerFormValues) => void
}

function McpServerDialog({ mode, initial, busy, onClose, onSave }: McpServerDialogProps) {
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const [form, setForm] = useState<McpServerFormValues>(initial)

  const update = <K extends keyof McpServerFormValues>(key: K, value: McpServerFormValues[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="h-4 w-4 text-primary" />
            {mode === 'create' ? copy('添加 MCP Server', 'Add MCP server') : copy(`编辑 ${initial.name}`, `Edit ${initial.name}`)}
          </DialogTitle>
          <DialogDescription>
            {copy('配置一个外部 MCP server。stdio 传输方式会启动子进程并通过 stdin/stdout 通信。', 'Configure an external MCP server. stdio transport starts a child process and communicates over stdin/stdout.')}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto py-2">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="mcp-name" className="text-xs">{copy('服务器名称 *', 'Server name *')}</Label>
            <Input
              id="mcp-name"
              autoComplete="off"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder="filesystem"
              disabled={mode === 'edit'}
              className="font-mono text-sm"
            />
            <p className="text-[10px] text-muted-foreground">
              {copy('唯一标识符，作为工具命名空间的前缀。命名后不可修改。', 'Unique identifier used as the tool namespace prefix. Cannot be changed later.')}
            </p>
          </div>

          {/* Enabled toggle */}
          <div className="flex items-center justify-between rounded-lg border border-border bg-card/40 p-3">
            <div>
              <Label htmlFor="mcp-enabled" className="text-sm font-medium">{copy('启用', 'Enabled')}</Label>
              <p className="text-[11px] text-muted-foreground">{copy('关闭则该 server 不会自动启动。', 'When off, this server will not start automatically.')}</p>
            </div>
            <Switch
              id="mcp-enabled"
              checked={form.enabled}
              onCheckedChange={(v) => update('enabled', v)}
            />
          </div>

          {/* Transport */}
          <div className="space-y-1.5">
            <Label className="text-xs">{copy('传输方式', 'Transport')}</Label>
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              {(['stdio', 'sse', 'http'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => update('transport', t)}
                  className={cn(
                    'flex-1 rounded-md px-3 py-1.5 text-[11px] font-medium transition-all',
                    form.transport === t
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
            {form.transport !== 'stdio' && (
              <p className="text-[10px] text-amber-500">
                {copy('当前仅 stdio 传输经过完整测试，sse/http 可用但可能不稳定。', 'Only stdio transport is fully tested; sse/http may be unstable.')}
              </p>
            )}
          </div>

          {/* Command */}
          <div className="space-y-1.5">
            <Label htmlFor="mcp-command" className="text-xs">
              {form.transport === 'stdio' ? 'Command *' : 'URL *'}
            </Label>
            <Input
              id="mcp-command"
              autoComplete="off"
              value={form.command}
              onChange={(e) => update('command', e.target.value)}
              placeholder={form.transport === 'stdio' ? 'npx' : 'http://localhost:8080/sse'}
              className="font-mono text-sm"
            />
            <p className="text-[10px] text-muted-foreground">
              {form.transport === 'stdio'
                ? copy('可执行文件名（需在 PATH 中）或绝对路径。', 'Executable name (must be on PATH) or absolute path.')
                : copy('远程 server 的 URL。', 'Remote server URL.')}
            </p>
          </div>

          {/* Args */}
          <div className="space-y-1.5">
            <Label htmlFor="mcp-args" className="text-xs">{copy('参数（空格分隔）', 'Arguments (space separated)')}</Label>
            <Input
              id="mcp-args"
              autoComplete="off"
              value={form.args}
              onChange={(e) => update('args', e.target.value)}
              placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
              className="font-mono text-sm"
            />
            <p className="text-[10px] text-muted-foreground">
              {copy('多个参数用空格分隔。如果参数本身包含空格，请用引号包裹。', 'Separate arguments with spaces. Quote arguments that contain spaces.')}
            </p>
          </div>

          {/* Env */}
          <div className="space-y-1.5">
            <Label htmlFor="mcp-env" className="text-xs">{copy('环境变量（每行 KEY=value）', 'Environment (one KEY=value per line)')}</Label>
            <textarea
              id="mcp-env"
              autoComplete="off"
              value={form.env}
              onChange={(e) => update('env', e.target.value)}
              placeholder={'API_KEY=sk-xxx\nNODE_ENV=production'}
              rows={3}
              className="flex w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            />
            <p className="text-[10px] text-muted-foreground">
              {mode === 'edit' && (
                <>{copy('现有值显示为', 'Existing values appear as')} <code className="rounded bg-muted px-1">***</code>{copy('。如需保留原值，请勿修改该行；如需覆盖，请输入新值。', '. Leave the line unchanged to keep it, or enter a new value to replace it.')}</>
              )}
              {' '}{copy('值会以明文保存到', 'Values are stored in plain text in')} <code className="rounded bg-muted px-1">~/.hakus/config.yaml</code>{copy('。', '.')}
            </p>
          </div>

          {/* cwd */}
          <div className="space-y-1.5">
            <Label htmlFor="mcp-cwd" className="text-xs">{copy('工作目录（可选）', 'Working directory (optional)')}</Label>
            <Input
              id="mcp-cwd"
              autoComplete="off"
              value={form.cwd}
              onChange={(e) => update('cwd', e.target.value)}
              placeholder="/home/user/project"
              className="font-mono text-sm"
            />
          </div>

          {/* Timeouts */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="mcp-startup-timeout" className="text-xs">{copy('启动超时（秒）', 'Startup timeout (seconds)')}</Label>
              <Input
                id="mcp-startup-timeout"
                autoComplete="off"
                type="number"
                min={1}
                max={120}
                value={form.startup_timeout}
                onChange={(e) => update('startup_timeout', Number(e.target.value) || 15)}
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-tool-timeout" className="text-xs">{copy('工具调用超时（秒）', 'Tool timeout (seconds)')}</Label>
              <Input
                id="mcp-tool-timeout"
                autoComplete="off"
                type="number"
                min={1}
                max={600}
                value={form.tool_timeout}
                onChange={(e) => update('tool_timeout', Number(e.target.value) || 60)}
                className="font-mono text-sm"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {copy('取消', 'Cancel')}
          </Button>
          <Button onClick={() => onSave(form)} disabled={busy || !form.name.trim() || !form.command.trim()}>
            {busy ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
            )}
            {mode === 'create' ? copy('添加', 'Add') : copy('保存', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
