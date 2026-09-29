/**
 * Tools & Permission panel — 工具列表开关 + 权限模式三选一
 */

import { useEffect, useState } from 'react'
import { Shield, ShieldAlert, ShieldOff, Loader2, RefreshCw, AlertTriangle, Eye, Zap, SlidersHorizontal, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/toast'
import { apiClient, BackendOutdatedError } from '@/api/client'
import { BackendOutdatedBanner } from '@/components/settings/BackendOutdatedBanner'
import { cn } from '@/lib/utils'
import { GlassSelect } from '@/components/ui/glass-select'
import type { ToolInfo, PermissionMode, RuntimeConfigSnapshot, GranularRules } from '@/api/types'
import { useI18n } from '@/lib/i18n'

type PermMeta = { title: string; desc: string; tone: string; icon: typeof Shield }

// Five-level permission model: read_only → auto → granular → guardian → full_access
const PERMISSION_META: Record<string, PermMeta> = {
  read_only: {
    title: '只读',
    desc: '只允许读取类工具，拒绝一切写入与命令执行。',
    tone: 'border-sky-500/50 bg-sky-500/10 text-sky-500',
    icon: Eye,
  },
  auto: {
    title: '自动执行',
    desc: '所有工具调用直接执行，不询问。最快但风险最高。',
    tone: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-500',
    icon: Zap,
  },
  granular: {
    title: '细粒度规则',
    desc: '按规则放行：shell 级别、可写路径 glob、网络访问。',
    tone: 'border-violet-500/50 bg-violet-500/10 text-violet-500',
    icon: SlidersHorizontal,
  },
  guardian: {
    title: '守卫模式',
    desc: '危险操作弹出审批卡片，由你逐项放行。最稳妥。',
    tone: 'border-amber-500/50 bg-amber-500/10 text-amber-500',
    icon: Sparkles,
  },
  full_access: {
    title: '完全访问',
    desc: '跳过所有权限检查（包括 shell/browser）。仅用于受信环境。',
    tone: 'border-red-500/50 bg-red-500/10 text-red-500',
    icon: ShieldOff,
  },
  // Legacy embedded-runtime modes
  ask: {
    title: '询问确认',
    desc: '危险工具调用前询问用户，安全工具直接执行。推荐。',
    tone: 'border-amber-500/50 bg-amber-500/10 text-amber-500',
    icon: ShieldAlert,
  },
  bypass: {
    title: '跳过权限',
    desc: '跳过所有权限检查（包括 shell/browser）。仅用于受信环境。',
    tone: 'border-red-500/50 bg-red-500/10 text-red-500',
    icon: ShieldOff,
  },
}

const EN_PERMISSION_META: Record<string, { title: string; desc: string }> = {
  read_only: { title: 'Read only', desc: 'Read-only tools only; all writes and shell are denied.' },
  auto: { title: 'Run automatically', desc: 'Run every tool call without asking. Fastest, but highest risk.' },
  granular: { title: 'Granular rules', desc: 'Allow by rule: shell level, writable path globs, network access.' },
  guardian: { title: 'Guardian', desc: 'Risky operations pop an approval card for you to allow one by one. Safest.' },
  full_access: { title: 'Full access', desc: 'Skip all permission checks, including shell and browser. Use only in trusted environments.' },
  ask: { title: 'Ask for confirmation', desc: 'Ask before risky tools; run safe tools directly. Recommended.' },
  bypass: { title: 'Skip permissions', desc: 'Skip all permission checks, including shell and browser. Use only in trusted environments.' },
}

const FIVE_MODES: PermissionMode[] = ['read_only', 'auto', 'granular', 'guardian', 'full_access']
const LEGACY_MODES: PermissionMode[] = ['auto', 'ask', 'bypass']

export function ToolsPanel() {
  const toast = useToast()
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const usesEmbeddedRuntime = apiClient.usesEmbeddedRuntime
  const [loading, setLoading] = useState(true)
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [permission, setPermission] = useState<PermissionMode>('ask')
  const [availableModes, setAvailableModes] = useState<string[]>(['auto', 'ask', 'bypass'])
  const [granularRules, setGranularRules] = useState<GranularRules>({ shell: 'read_only', write_paths: [], network: false })
  const [granularPaths, setGranularPaths] = useState('')
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [settingPerm, setSettingPerm] = useState(false)
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfigSnapshot | null>(null)
  const [updatingSetting, setUpdatingSetting] = useState<string | null>(null)
  const [settingPreset, setSettingPreset] = useState<string | null>(null)
  const [outdatedError, setOutdatedError] = useState<BackendOutdatedError | null>(null)

  const refresh = async () => {
    setLoading(true)
    setOutdatedError(null)
    try {
      const [toolsResp, permResp, configResp] = await Promise.all([
        usesEmbeddedRuntime ? Promise.resolve({ tools: [] }) : apiClient.getTools(),
        apiClient.getPermission(),
        usesEmbeddedRuntime ? apiClient.getRuntimeConfig() : Promise.resolve(null),
      ])
      setTools(toolsResp.tools)
      setPermission(permResp.mode)
      setAvailableModes(permResp.available_modes)
      if (permResp.granular_rules) {
        setGranularRules(permResp.granular_rules)
        setGranularPaths((permResp.granular_rules.write_paths || []).join(', '))
      }
      setRuntimeConfig(configResp)
    } catch (e: any) {
      console.error('[ToolsPanel] load failed:', e)
      if (e instanceof BackendOutdatedError) {
        setOutdatedError(e)
      } else {
        toast.error(copy(`加载工具列表失败：${e?.message || e}`, `Could not load tools: ${e?.message || e}`))
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [usesEmbeddedRuntime])

  const handleToggle = async (tool: ToolInfo, next: boolean) => {
    setTogglingId(tool.id)
    // optimistic
    setTools((prev) => prev.map((t) => (t.id === tool.id ? { ...t, enabled: next } : t)))
    try {
      await apiClient.toggleTool(tool.id, next)
      toast.success(`${tool.name} ${next ? copy('已启用', 'enabled') : copy('已禁用', 'disabled')}`)
    } catch (e: any) {
      // rollback
      setTools((prev) => prev.map((t) => (t.id === tool.id ? { ...t, enabled: !next } : t)))
      toast.error(copy(`切换失败：${e?.message || e}`, `Update failed: ${e?.message || e}`))
    } finally {
      setTogglingId(null)
    }
  }

  const handleSetPermission = async (mode: PermissionMode) => {
    if (mode === permission) return
    setSettingPerm(true)
    const prev = permission
    setPermission(mode)
    try {
      await apiClient.setPermission(mode, mode === 'granular' ? granularRules : undefined)
      toast.success(copy(`权限模式已切换为「${PERMISSION_META[mode].title}」`, `Permission mode changed to “${EN_PERMISSION_META[mode].title}”`))
    } catch (e: any) {
      setPermission(prev)
      toast.error(copy(`切换失败：${e?.message || e}`, `Update failed: ${e?.message || e}`))
    } finally {
      setSettingPerm(false)
    }
  }

  const handleApplyGranular = async () => {
    setSettingPerm(true)
    const rules: GranularRules = {
      ...granularRules,
      write_paths: granularPaths.split(',').map((p) => p.trim()).filter(Boolean),
    }
    try {
      await apiClient.setPermission('granular', rules)
      setGranularRules(rules)
      toast.success(copy('细粒度规则已应用', 'Granular rules applied'))
    } catch (e: any) {
      toast.error(copy(`应用失败：${e?.message || e}`, `Apply failed: ${e?.message || e}`))
    } finally {
      setSettingPerm(false)
    }
  }

  const handleRuntimeSetting = async (
    key:
      | 'allow_shell' | 'strict_tool_mode' | 'sandbox_mode' | 'memory_enabled' | 'approval_mode'
      | 'retry_enabled' | 'retry_max_retries' | 'retry_initial_delay' | 'retry_max_delay'
      | 'subagents_max_concurrent',
    value: boolean | string | number,
  ) => {
    if (!runtimeConfig) return
    const previous = runtimeConfig[key]
    setRuntimeConfig((current) => current ? { ...current, [key]: value } : current)
    setUpdatingSetting(key)
    try {
      await apiClient.setRuntimeConfig(key, value)
      toast.success(key === 'allow_shell' ? (value ? copy('命令执行已允许', 'Command execution allowed') : copy('命令执行已关闭', 'Command execution disabled')) : copy('工具设置已更新', 'Tool settings updated'))
    } catch (e: any) {
      setRuntimeConfig((current) => current ? { ...current, [key]: previous } : current)
      toast.error(copy(`设置更新失败：${e?.message || e}`, `Could not update setting: ${e?.message || e}`))
    } finally {
      setUpdatingSetting(null)
    }
  }

  /**
   * 中转站/聚合路由的限流档位预设。一次点选同时写入重试次数、初始间隔和
   * 退避上限，避免用户逐个字段试错——限流断了却不知道该调哪个值，是这类
   * 路由最常见的困惑。
   */
  const applyRetryPreset = async (preset: 'default' | 'tolerant' | 'fast') => {
    if (!runtimeConfig) return
    const values = preset === 'tolerant'
      ? { retry_max_retries: 5, retry_initial_delay: 2, retry_max_delay: 120 }
      : preset === 'fast'
        ? { retry_max_retries: 1, retry_initial_delay: 0.5, retry_max_delay: 15 }
        : { retry_max_retries: 3, retry_initial_delay: 1, retry_max_delay: 60 }
    setSettingPreset(preset)
    try {
      for (const [key, value] of Object.entries(values)) {
        await apiClient.setRuntimeConfig(key, value)
      }
      setRuntimeConfig((current) => current ? { ...current, ...values } : current)
      toast.success(
        preset === 'tolerant'
          ? copy('已切换为「宽松」：适合中转站，重试更多、等待更久', 'Switched to Tolerant: more retries and longer waits, for aggregator routes')
          : preset === 'fast'
            ? copy('已切换为「快速失败」：重试少、等待短', 'Switched to Fast-fail: fewer retries, shorter waits')
            : copy('已恢复默认重试策略', 'Default retry policy restored'),
      )
    } catch (e: any) {
      toast.error(copy(`设置更新失败：${e?.message || e}`, `Could not update setting: ${e?.message || e}`))
    } finally {
      setSettingPreset(null)
    }
  }

  return (
    <section className="settings-section settings-tools-section">
      <div className="settings-section-heading">
        <div>
          <h2>{copy('工具与权限', 'Tools & permissions')}</h2>
          <p>{copy('管理可用工具、命令执行范围和调用确认策略。', 'Manage available tools, command access, and confirmation rules.')}</p>
        </div>
      </div>
      {outdatedError && (
        <BackendOutdatedBanner
          message={outdatedError.message}
          backendVersion={outdatedError.backendVersion}
          onRetry={refresh}
        />
      )}
      <div className="settings-actions settings-refresh-actions">
        <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          {copy('刷新', 'Refresh')}
        </Button>
      </div>

      {/* 工具列表 */}
      <div className="settings-field-group settings-tool-list">
        <div className="settings-field-group-heading">
          <h3>{copy('工具列表', 'Tools')}</h3>
        </div>
        {usesEmbeddedRuntime ? (
          <div className="space-y-3">
            <p className="text-[11px] text-muted-foreground">
              {copy('工具会按当前会话、工作模式和 MCP 服务动态提供。下面的选项控制本机执行权限。', 'Tools are provided dynamically by the session, work mode, and MCP services. The options below control local execution permissions.')}
            </p>
            {runtimeConfig ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/40 p-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{copy('允许执行命令', 'Allow command execution')}</div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{copy('关闭后，AI 仍可阅读文件和使用安全工具，但不能运行 shell 命令。', 'When off, the AI can still read files and use safe tools but cannot run shell commands.')}</p>
                  </div>
                  <Switch
                    checked={runtimeConfig.allow_shell}
                    onCheckedChange={(value) => void handleRuntimeSetting('allow_shell', value)}
                    disabled={updatingSetting === 'allow_shell'}
                    aria-label={copy('允许执行命令', 'Allow command execution')}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/40 p-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{copy('严格工具模式', 'Strict tool mode')}</div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{copy('只提供当前会话明确允许的工具，适合受控工作区。', 'Expose only tools explicitly allowed for this session, useful for controlled workspaces.')}</p>
                  </div>
                  <Switch
                    checked={runtimeConfig.strict_tool_mode}
                    onCheckedChange={(value) => void handleRuntimeSetting('strict_tool_mode', value)}
                    disabled={updatingSetting === 'strict_tool_mode'}
                    aria-label="严格工具模式"
                  />
                </div>
                <label className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/40 p-3">
                  <span className="min-w-0">
                  <span className="block text-sm font-medium">{copy('文件访问范围', 'File access scope')}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{copy('限制写入与命令工具可触及的位置。', 'Limits where write and command tools can operate.')}</span>
                  </span>
                  <GlassSelect
                    value={runtimeConfig.sandbox_mode}
                    onChange={(value) => void handleRuntimeSetting('sandbox_mode', value)}
                    disabled={updatingSetting === 'sandbox_mode'}
                    className="w-44"
                    ariaLabel={copy('文件访问范围', 'File access scope')}
                    options={[
                      { value: 'read-only', label: copy('只读', 'Read only') },
                      { value: 'workspace-write', label: copy('仅工作区', 'Workspace only') },
                      { value: 'danger-full-access', label: copy('全部文件', 'All files') },
                      { value: 'opensandbox', label: copy('外部沙箱', 'External sandbox') },
                    ]}
                  />
                </label>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/40 p-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{copy('审批策略', 'Approval policy')}</div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {copy('需要时询问，或直接阻断升级操作。', 'Ask when needed, or block escalations outright.')}
                    </p>
                  </div>
                  <GlassSelect
                    value={
                      runtimeConfig.approval_mode === 'auto' || runtimeConfig.approval_mode === 'never'
                        ? runtimeConfig.approval_mode
                        : 'on-request'
                    }
                    onChange={(value) => {
                      const mode = value === 'auto' ? 'auto' : value === 'never' ? 'bypass' : 'ask'
                      void handleSetPermission(mode)
                    }}
                    disabled={settingPerm}
                    className="w-44"
                    ariaLabel={copy('审批策略', 'Approval policy')}
                    options={[
                      { value: 'on-request', label: copy('请求时询问', 'Ask on request') },
                      { value: 'auto', label: copy('自动执行', 'Never ask') },
                      { value: 'never', label: copy('阻断并失败', 'Block and fail') },
                    ]}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/40 p-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{copy('记忆系统', 'Memory')}</div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {copy('关闭后新消息不会写入长期记忆（临时会话会自动关闭）。', 'When off, new turns are not written to long-term memory. Temporary chats turn this off.')}
                    </p>
                  </div>
                  <Switch
                    checked={Boolean(runtimeConfig.memory_enabled)}
                    onCheckedChange={(value) => void handleRuntimeSetting('memory_enabled', value)}
                    disabled={updatingSetting === 'memory_enabled'}
                    aria-label={copy('记忆系统', 'Memory')}
                  />
                </div>

                {/* 限流韧性：中转站/聚合路由常有速率限制，重试太快会持续断连。
                    预设一键写入三个值，避免用户逐个字段试错。 */}
                <div className="space-y-2 rounded-xl border border-border bg-card/40 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{copy('请求重试', 'Request retry')}</div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {copy('遇到限流或临时故障时自动重试。使用中转站时建议选「宽松」，避免触发速率限制而中断。', 'Retries on rate limits and transient failures. On aggregator routes choose Tolerant to avoid rate-limit drops.')}
                      </p>
                    </div>
                    <Switch
                      checked={Boolean(runtimeConfig.retry_enabled)}
                      onCheckedChange={(value) => void handleRuntimeSetting('retry_enabled', value)}
                      disabled={updatingSetting === 'retry_enabled'}
                      aria-label={copy('请求重试', 'Request retry')}
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {([
                      { id: 'default', label: copy('默认', 'Default') },
                      { id: 'tolerant', label: copy('宽松（中转站）', 'Tolerant (aggregator)') },
                      { id: 'fast', label: copy('快速失败', 'Fast-fail') },
                    ] as const).map((preset) => {
                      const active =
                        preset.id === 'default'
                          ? runtimeConfig.retry_max_retries === 3 && runtimeConfig.retry_initial_delay === 1 && runtimeConfig.retry_max_delay === 60
                          : preset.id === 'tolerant'
                            ? runtimeConfig.retry_max_retries === 5 && runtimeConfig.retry_initial_delay === 2 && runtimeConfig.retry_max_delay === 120
                            : runtimeConfig.retry_max_retries === 1 && runtimeConfig.retry_initial_delay === 0.5 && runtimeConfig.retry_max_delay === 15
                      return (
                        <Button
                          key={preset.id}
                          type="button"
                          size="sm"
                          variant={active ? 'default' : 'outline'}
                          className="h-7 text-[11px]"
                          disabled={settingPreset !== null || !runtimeConfig.retry_enabled}
                          onClick={() => void applyRetryPreset(preset.id)}
                        >
                          {settingPreset === preset.id && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                          {preset.label}
                        </Button>
                      )
                    })}
                  </div>
                  <div className="grid grid-cols-3 gap-2 pt-1">
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">{copy('重试次数', 'Max retries')}</Label>
                      <Input
                        type="number"
                        min={0}
                        max={20}
                        value={runtimeConfig.retry_max_retries}
                        disabled={updatingSetting !== null || !runtimeConfig.retry_enabled}
                        onChange={(e) => void handleRuntimeSetting('retry_max_retries', e.target.value)}
                        className="h-7 font-mono text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">{copy('初始间隔（秒）', 'Initial delay (s)')}</Label>
                      <Input
                        type="number"
                        min={0}
                        step={0.5}
                        value={runtimeConfig.retry_initial_delay}
                        disabled={updatingSetting !== null || !runtimeConfig.retry_enabled}
                        onChange={(e) => void handleRuntimeSetting('retry_initial_delay', e.target.value)}
                        className="h-7 font-mono text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">{copy('最大间隔（秒）', 'Max delay (s)')}</Label>
                      <Input
                        type="number"
                        min={1}
                        step={5}
                        value={runtimeConfig.retry_max_delay}
                        disabled={updatingSetting !== null || !runtimeConfig.retry_enabled}
                        onChange={(e) => void handleRuntimeSetting('retry_max_delay', e.target.value)}
                        className="h-7 font-mono text-xs"
                      />
                    </div>
                  </div>
                </div>

                {/* 子代理并发会共享同一个上游配额，并发越高越容易触发限流。 */}
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/40 p-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{copy('子代理并发数', 'Sub-agent concurrency')}</div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {copy('子代理共享同一份速率配额。中转站被限流时把它调低（如 2）通常比调重试更有效。', 'Sub-agents share one rate-limit quota. On a throttled aggregator, lowering this (e.g. 2) helps more than raising retries.')}
                    </p>
                  </div>
                  <Input
                    type="number"
                    min={1}
                    max={64}
                    value={runtimeConfig.subagents_max_concurrent}
                    disabled={updatingSetting !== null}
                    onChange={(e) => void handleRuntimeSetting('subagents_max_concurrent', e.target.value)}
                    className="h-8 w-20 font-mono text-xs"
                    aria-label={copy('子代理并发数', 'Sub-agent concurrency')}
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center py-6 text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {copy('加载中...', 'Loading...')}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">{copy('MCP 工具请在“MCP 服务器”中管理，模型只会看到当前已连接的工具。', 'Manage MCP tools under MCP servers; the model only sees tools that are currently connected.')}</p>
          </div>
        ) : loading ? (
          <div className="flex items-center py-6 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {copy('加载中...', 'Loading...')}
          </div>
        ) : (
          <div className="space-y-1.5">
            {tools.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-xl border border-border bg-card/40 p-3 transition-colors hover:border-primary/30"
              >
                <div className="min-w-0 flex-1 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{t.name}</span>
                    {t.dangerous && (
                      <Badge
                        variant="outline"
                        className="border-amber-500/50 bg-amber-500/10 px-1.5 py-0 text-[9px] text-amber-500"
                      >
                        <AlertTriangle className="mr-0.5 h-2.5 w-2.5" />
                        {copy('危险', 'Risky')}
                      </Badge>
                    )}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {t.id}
                    </code>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{t.desc}</p>
                </div>
                <Switch
                  checked={t.enabled}
                  onCheckedChange={(v) => handleToggle(t, v)}
                  disabled={togglingId === t.id}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 权限模式 */}
      <div className="settings-field-group settings-permission-group">
        <div className="settings-field-group-heading">
          <h3>{copy('权限模式', 'Permission mode')}</h3>
          <p>
          {copy('决定 AI 调用工具时是否需要用户确认。修改后立即生效。', 'Controls whether the AI needs confirmation before using tools. Changes apply immediately.')}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3 lg:grid-cols-5">
          {(usesEmbeddedRuntime ? LEGACY_MODES : FIVE_MODES)
            .filter((m) => usesEmbeddedRuntime ? availableModes.includes(m) : true)
            .map((m) => {
              const meta = PERMISSION_META[m]
              const localizedMeta = locale === 'zh-CN' ? meta : { ...meta, ...EN_PERMISSION_META[m] }
              const Icon = meta.icon
              const active = permission === m
              return (
                <button
                  key={m}
                  onClick={() => handleSetPermission(m)}
                  disabled={settingPerm}
                  className={cn(
                    'group relative flex flex-col items-start gap-1 rounded-xl border p-4 text-left transition-all duration-200',
                    active
                      ? cn(meta.tone, 'ring-1 ring-primary/50')
                      : 'border-border bg-card/40 hover:border-primary/30 hover:bg-accent/30',
                  )}
                >
                  <div className="flex w-full items-center justify-between">
                    <Icon className={cn('h-4 w-4', active ? '' : 'text-muted-foreground')} />
                    {active && (
                      <div className="h-2 w-2 rounded-full bg-current" />
                    )}
                  </div>
                  <div className="text-sm font-semibold">{localizedMeta.title}</div>
                  <p className="text-[11px] opacity-80">{localizedMeta.desc}</p>
                  <code className="mt-1 font-mono text-[10px] opacity-60">{m}</code>
                </button>
              )
            })}
        </div>
        {/* granular 子表单：shell 级别 / 可写路径 / 网络 */}
        {!usesEmbeddedRuntime && permission === 'granular' && (
          <div className="space-y-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-3">
            <div className="flex items-center gap-2 text-[12px] font-medium text-violet-500">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {copy('细粒度规则', 'Granular rules')}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground">{copy('命令执行', 'Shell commands')}</label>
                <GlassSelect
                  value={granularRules.shell}
                  onChange={(v) => setGranularRules((r) => ({ ...r, shell: v as GranularRules['shell'] }))}
                  ariaLabel={copy('命令执行', 'Shell commands')}
                  options={[
                    { value: 'none', label: copy('禁止', 'None') },
                    { value: 'read_only', label: copy('仅安全命令', 'Read-only only') },
                    { value: 'all', label: copy('全部允许', 'All') },
                  ]}
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground">{copy('可写路径（逗号分隔 glob）', 'Writable paths (comma-separated globs)')}</label>
                <input
                  value={granularPaths}
                  onChange={(e) => setGranularPaths(e.target.value)}
                  placeholder="D:/项目/**, ~/docs/*"
                  className="h-8 w-full rounded-md border border-input bg-background px-2.5 font-mono text-[12px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
              <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2">
                <span className="text-[12px]">{copy('允许网络访问', 'Allow network access')}</span>
                <Switch
                  checked={granularRules.network}
                  onCheckedChange={(v) => setGranularRules((r) => ({ ...r, network: v }))}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={() => void handleApplyGranular()} disabled={settingPerm}>
                {settingPerm && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {copy('应用规则', 'Apply rules')}
              </Button>
            </div>
          </div>
        )}
        {(permission === 'full_access' || permission === 'bypass') && (
          <div className="flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-[11px] text-red-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {copy('Bypass 模式将跳过所有权限检查，AI 可自由执行 shell 命令、文件写入与浏览器操作。仅在受信沙箱环境中使用。', 'Bypass skips every permission check, allowing shell commands, file writes, and browser actions. Use only in a trusted sandbox.')}
            </span>
          </div>
        )}
      </div>
    </section>
  )
}
