import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Blocks, RefreshCw, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { apiClient, BackendOutdatedError } from '@/api/client'
import type { RuntimeExtensionStatus, RuntimePluginInfo } from '@/api/types'
import { BackendOutdatedBanner } from '@/components/settings/BackendOutdatedBanner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { projectRuntimeExtensionStatus } from '@/lib/runtimeExtensionStatus'

function trustBadgeVariant(status: RuntimePluginInfo['trust_status']): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'trusted':
      return 'default'
    case 'not-reviewed':
      return 'outline'
    default:
      // content-changed / capabilities-changed: the reviewed contract drifted.
      return 'destructive'
  }
}

function extensionStatusBadgeVariant(status: RuntimeExtensionStatus): 'default' | 'destructive' | 'outline' {
  if (status.state === 'crashed' || status.state === 'rejected') return 'destructive'
  if (status.state === 'started') return 'default'
  return 'outline'
}

export function ExtensionsPanel() {
  const toast = useToast()
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const [plugins, setPlugins] = useState<RuntimePluginInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [outdatedError, setOutdatedError] = useState<BackendOutdatedError | null>(null)
  const [extensionStatuses, setExtensionStatuses] = useState<Record<string, RuntimeExtensionStatus>>({})

  const refresh = useCallback(async () => {
    setLoading(true)
    setOutdatedError(null)
    try {
      const response = await apiClient.listRuntimePlugins()
      setPlugins(response.plugins)
    } catch (error) {
      if (error instanceof BackendOutdatedError) {
        setOutdatedError(error)
      } else {
        toast.error(copy(`加载扩展失败：${error instanceof Error ? error.message : String(error)}`, `Could not load extensions: ${error instanceof Error ? error.message : String(error)}`))
      }
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const extensionIds = Array.from(new Set(
      plugins.flatMap((plugin) => plugin.extension ? [plugin.extension.id] : []),
    ))
    if (extensionIds.length === 0) {
      setExtensionStatuses({})
      return
    }

    let cancelled = false
    const unavailableError = locale === 'zh-CN' ? 'Runtime 扩展不可用' : 'Runtime extension unavailable'
    const refreshStatuses = async () => {
      const entries = await Promise.all(extensionIds.map(async (extensionId) => {
        try {
          const value = await apiClient.getRuntimeExtensionStatus(extensionId)
          return [extensionId, projectRuntimeExtensionStatus(value, extensionId, unavailableError)] as const
        } catch {
          return [extensionId, projectRuntimeExtensionStatus(undefined, extensionId, unavailableError)] as const
        }
      }))
      if (!cancelled) setExtensionStatuses(Object.fromEntries(entries))
    }

    void refreshStatuses()
    const timer = setInterval(() => void refreshStatuses(), 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [plugins, locale])

  const handleToggle = async (plugin: RuntimePluginInfo, enabled: boolean) => {
    setBusyName(plugin.name)
    setPlugins((current) => current.map((item) => item.name === plugin.name ? { ...item, enabled } : item))
    try {
      const receipt = await apiClient.setPluginEnabled(plugin.name, enabled)
      setPlugins((current) => current.map((item) => item.name === plugin.name ? { ...item, enabled: receipt.enabled, state_generation: receipt.state_generation } : item))
      toast.success(copy(`${plugin.name} 已${enabled ? '启用' : '停用'}`, `${plugin.name} ${enabled ? 'enabled' : 'disabled'}`))
    } catch (error) {
      setPlugins((current) => current.map((item) => item.name === plugin.name ? { ...item, enabled: !enabled } : item))
      toast.error(copy(`更新失败：${error instanceof Error ? error.message : String(error)}`, `Update failed: ${error instanceof Error ? error.message : String(error)}`))
    } finally {
      setBusyName(null)
    }
  }

  const describeCapabilities = (plugin: RuntimePluginInfo): string[] => {
    const parts: string[] = []
    if (plugin.extension) {
      parts.push(copy(`扩展协议：${plugin.extension.protocol}`, `Extension protocol: ${plugin.extension.protocol}`))
      if (plugin.extension.permissions.length > 0) {
        parts.push(copy(`扩展权限：${plugin.extension.permissions.join(', ')}`, `Extension permissions: ${plugin.extension.permissions.join(', ')}`))
      }
      if (plugin.extension.supported_platforms.length > 0) {
        parts.push(copy(`平台：${plugin.extension.supported_platforms.join(', ')}`, `Platforms: ${plugin.extension.supported_platforms.join(', ')}`))
      }
    }
    if (plugin.capabilities.filesystem_roots.length > 0) {
      parts.push(copy(`文件系统：${plugin.capabilities.filesystem_roots.join(', ')}`, `Filesystem: ${plugin.capabilities.filesystem_roots.join(', ')}`))
    }
    if (plugin.capabilities.network_hosts.length > 0) {
      parts.push(copy(`网络：${plugin.capabilities.network_hosts.join(', ')}`, `Network: ${plugin.capabilities.network_hosts.join(', ')}`))
    }
    if (plugin.capabilities.lifecycle_mutation) {
      parts.push(copy('生命周期变更', 'Lifecycle mutation'))
    }
    return parts
  }

  const errorCount = plugins.reduce((sum, plugin) => sum + plugin.diagnostics.filter((d) => d.level === 'error').length, 0)

  return (
    <section className="settings-section settings-extensions-section">
      <div className="settings-section-heading">
        <div>
          <h2>{copy('扩展', 'Extensions')}</h2>
          <p>{copy('已安装扩展的权限声明与信任状态。信任授予需在命令层完成人工审查。', 'Declared permissions and trust state of installed extensions. Trust granting requires a human review at the command layer.')}</p>
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
        <div>
          <h3 className="text-sm font-semibold">{copy('已安装扩展', 'Installed extensions')}</h3>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {copy(`${plugins.length} 个已安装，${plugins.filter((p) => p.enabled).length} 个已启用`, `${plugins.length} installed, ${plugins.filter((p) => p.enabled).length} enabled`)}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
          {copy('刷新', 'Refresh')}
        </Button>
      </div>

      {errorCount > 0 && (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{copy(`有 ${errorCount} 条扩展诊断错误，请检查下方条目。`, `${errorCount} extension diagnostic error${errorCount === 1 ? '' : 's'} — see the entries below.`)}</span>
        </div>
      )}

      <div className="space-y-1.5">
        {loading && plugins.length === 0 && Array.from({ length: 2 }).map((_, index) => (
          <div key={index} className="h-[74px] animate-pulse rounded-lg bg-muted/60" />
        ))}

        {!loading && plugins.length === 0 && (
          <div className="flex flex-col items-center py-10 text-center text-muted-foreground">
            <Blocks className="mb-2 h-6 w-6 opacity-60" strokeWidth={1.75} />
            <p className="text-xs">{copy('尚未安装扩展', 'No extensions installed')}</p>
          </div>
        )}

        {plugins.map((plugin) => {
          const capabilities = describeCapabilities(plugin)
          const untrusted = plugin.trust_status !== 'trusted'
          const undrivable = !plugin.staged || !plugin.applicable
          const runtimeStatus = plugin.extension ? extensionStatuses[plugin.extension.id] : undefined
          return (
            <div key={plugin.id} className="rounded-lg border border-border/75 bg-card/35 px-3 py-2.5">
              <div className="flex items-start gap-3">
                {plugin.trust_status === 'trusted' ? (
                  <ShieldCheck className={cn('mt-0.5 h-4 w-4 shrink-0', plugin.enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')} strokeWidth={1.75} />
                ) : (
                  <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" strokeWidth={1.75} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{plugin.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                      v{plugin.version}
                    </span>
                    <Badge variant={trustBadgeVariant(plugin.trust_status)} className="text-[9px] px-1.5 py-0">
                      {plugin.trust_status === 'trusted'
                        ? copy('已信任', 'Trusted')
                        : plugin.trust_status === 'not-reviewed'
                          ? copy('未审查', 'Not reviewed')
                          : plugin.trust_status === 'content-changed'
                            ? copy('内容已变化', 'Content changed')
                            : copy('能力已变化', 'Capabilities changed')}
                    </Badge>
                    {!plugin.staged && (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0">{copy('未暂存', 'Not staged')}</Badge>
                    )}
                    {!plugin.applicable && (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0">{copy('不适用于本机', 'Not applicable')}</Badge>
                    )}
                  </div>
                  {capabilities.length > 0 ? (
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                      {capabilities.join(copy(' · ', ' · '))}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                      {copy('未声明特殊权限', 'No special permissions declared')}
                    </p>
                  )}
                  {plugin.diagnostics.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {plugin.diagnostics.map((diagnostic, index) => (
                        <p
                          key={index}
                          className={cn('text-[10px]', diagnostic.level === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-300')}
                        >
                          {diagnostic.code}: {diagnostic.message}
                        </p>
                      ))}
                    </div>
                  )}
                  {runtimeStatus && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge variant={extensionStatusBadgeVariant(runtimeStatus)} className="text-[9px] px-1.5 py-0">
                        {runtimeStatus.state === 'started'
                          ? runtimeStatus.running
                            ? copy('运行中', 'Running')
                            : copy('已响应', 'Responded')
                          : runtimeStatus.state === 'crashed'
                            ? copy('已崩溃', 'Crashed')
                            : runtimeStatus.state === 'rejected'
                              ? copy('已拒绝', 'Rejected')
                              : copy('不可用', 'Unavailable')}
                      </Badge>
                      {runtimeStatus.running && runtimeStatus.pid !== null && (
                        <span className="text-[10px] text-muted-foreground">PID {runtimeStatus.pid}</span>
                      )}
                      {runtimeStatus.error && (
                        <span className="text-[10px] text-destructive">{runtimeStatus.error}</span>
                      )}
                    </div>
                  )}
                </div>
                <Switch
                  checked={plugin.enabled}
                  onCheckedChange={(enabled) => void handleToggle(plugin, enabled)}
                  disabled={busyName === plugin.name || untrusted || undrivable}
                  aria-label={copy(`${plugin.enabled ? '停用' : '启用'} ${plugin.name}`, `${plugin.enabled ? 'Disable' : 'Enable'} ${plugin.name}`)}
                />
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
