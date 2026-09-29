import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Loader2,
  RefreshCw,
  Search,
  Puzzle,
  Trash2,
  X,
} from 'lucide-react'
import { apiClient, BackendOutdatedError } from '@/api/client'
import type { SkillInfo } from '@/api/types'
import { BackendOutdatedBanner } from '@/components/settings/BackendOutdatedBanner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import { useProjectsStore } from '@/store/projects'
import { useI18n } from '@/lib/i18n'

type SkillScope = 'global' | 'project'

function inferredWritable(skill: SkillInfo): boolean {
  if (typeof skill.writable === 'boolean') return skill.writable
  const normalized = (skill.path || '').replace(/\\/g, '/')
  return skill.source === 'native' && normalized.includes('/.hakus/skills/') && !skill.is_bundled
}

export function SkillsPanel() {
  const toast = useToast()
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const activeProjectId = useProjectsStore((state) => state.activeProjectId)
  const activeProject = useProjectsStore((state) => state.activeProject)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [directory, setDirectory] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')
  const [scope, setScope] = useState<SkillScope>('global')
  const [installing, setInstalling] = useState(false)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [outdatedError, setOutdatedError] = useState<BackendOutdatedError | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setOutdatedError(null)
    try {
      const response = await apiClient.listSkills(activeProjectId || undefined)
      setSkills(response.skills)
      setDirectory(response.directory)
      setWarnings(response.warnings || [])
    } catch (error) {
      if (error instanceof BackendOutdatedError) {
        setOutdatedError(error)
      } else {
        toast.error(copy(`加载 Skills 失败：${error instanceof Error ? error.message : String(error)}`, `Could not load skills: ${error instanceof Error ? error.message : String(error)}`))
      }
    } finally {
      setLoading(false)
    }
  }, [activeProjectId, toast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!activeProjectId && scope === 'project') setScope('global')
  }, [activeProjectId, scope])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return skills
    return skills.filter((skill) =>
      `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(needle),
    )
  }, [query, skills])

  const enabledCount = skills.filter((skill) => skill.enabled).length

  const handleInstall = async () => {
    const value = source.trim()
    if (!value) {
      toast.error(copy('请输入 Skill 来源', 'Enter a Skill source'))
      return
    }
    setInstalling(true)
    try {
      const receipt = await apiClient.installSkill(value, scope, activeProjectId || undefined)
      toast.success(copy(`已安装 ${receipt.name}`, `Installed ${receipt.name}`))
      setSource('')
      await refresh()
    } catch (error) {
      toast.error(copy(`安装失败：${error instanceof Error ? error.message : String(error)}`, `Install failed: ${error instanceof Error ? error.message : String(error)}`))
    } finally {
      setInstalling(false)
    }
  }

  const handleToggle = async (skill: SkillInfo, enabled: boolean) => {
    setBusyName(skill.name)
    setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled } : item))
    try {
      await apiClient.setSkillEnabled(skill.name, enabled, activeProjectId || undefined)
      toast.success(copy(`${skill.name} 已${enabled ? '启用' : '停用'}`, `${skill.name} ${enabled ? 'enabled' : 'disabled'}`))
    } catch (error) {
      setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled: !enabled } : item))
      toast.error(copy(`更新失败：${error instanceof Error ? error.message : String(error)}`, `Update failed: ${error instanceof Error ? error.message : String(error)}`))
    } finally {
      setBusyName(null)
    }
  }

  const handleRemove = async (skill: SkillInfo) => {
    setBusyName(skill.name)
    try {
      const requestedScope = skill.scope === 'global' || skill.scope === 'project' ? skill.scope : undefined
      await apiClient.removeSkill(skill.name, requestedScope, activeProjectId || undefined)
      toast.success(copy(`已删除 ${skill.name}`, `Deleted ${skill.name}`))
      setConfirmRemove(null)
      await refresh()
    } catch (error) {
      toast.error(copy(`删除失败：${error instanceof Error ? error.message : String(error)}`, `Delete failed: ${error instanceof Error ? error.message : String(error)}`))
    } finally {
      setBusyName(null)
    }
  }

  const copyDirectory = async () => {
    try {
      await navigator.clipboard.writeText(directory)
      toast.success(copy('目录已复制', 'Directory copied'))
    } catch {
      toast.error(copy('复制失败', 'Copy failed'))
    }
  }

  return (
    <section className="settings-section settings-skills-section">
      <div className="settings-section-heading">
        <div>
          <h2>Skills</h2>
          <p>{copy('安装、启用和管理可复用的技能扩展。', 'Install, enable, and manage reusable skill extensions.')}</p>
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
          <h3 className="text-sm font-semibold">Skills</h3>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {copy(`${skills.length} 个已安装，${enabledCount} 个已启用`, `${skills.length} installed, ${enabledCount} enabled`)}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
          {copy('刷新', 'Refresh')}
        </Button>
      </div>

      <div className="settings-field-group settings-skill-install-group">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium">{copy('安装来源', 'Install source')}</span>
          <div className="inline-flex rounded-lg bg-muted p-0.5" aria-label={copy('安装范围', 'Install scope')}>
            <button
              type="button"
              onClick={() => setScope('global')}
              className={cn(
                'rounded-md px-2.5 py-1 text-[11px] transition-colors',
                scope === 'global' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground',
              )}
            >
              {copy('全局', 'Global')}
            </button>
            <button
              type="button"
              onClick={() => setScope('project')}
              disabled={!activeProjectId}
              title={activeProjectId ? activeProject?.name : copy('请先选择项目', 'Select a project first')}
              className={cn(
                'rounded-md px-2.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                scope === 'project' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground',
              )}
            >
              {copy('当前项目', 'Current project')}
            </button>
          </div>
        </div>
        <div className="flex min-w-0 gap-2 max-sm:flex-col">
          <Input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void handleInstall()
              }
            }}
            placeholder={copy('github:owner/repository 或本地目录', 'github:owner/repository or local directory')}
            disabled={installing}
            className="min-w-0 flex-1"
          />
          <Button onClick={() => void handleInstall()} disabled={installing || !source.trim()} className="gap-1.5">
            {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {copy('安装', 'Install')}
          </Button>
        </div>
        <div className="flex items-start gap-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{copy('第三方 Skill 可能包含脚本。安装前请检查来源和内容。', 'Third-party Skills may contain scripts. Review the source before installing.')}</span>
        </div>
      </div>

      <div className="settings-field-group settings-skill-search-group relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={copy('搜索 Skills', 'Search Skills')}
          className="pl-8"
        />
      </div>

      {warnings.length > 0 && (
        <div className="rounded-md bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          {warnings[0]}{warnings.length > 1 ? copy(`，另有 ${warnings.length - 1} 条扫描警告`, `; ${warnings.length - 1} more scan warning${warnings.length === 2 ? '' : 's'}`) : ''}
        </div>
      )}

      <div className="space-y-1.5">
        {loading && skills.length === 0 && Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="h-[74px] animate-pulse rounded-lg bg-muted/60" />
        ))}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center py-10 text-center text-muted-foreground">
            <Puzzle className="mb-2 h-6 w-6 opacity-60" strokeWidth={1.75} />
            <p className="text-xs">{skills.length === 0 ? copy('尚未安装 Skill', 'No Skills installed') : copy('没有匹配结果', 'No matches')}</p>
          </div>
        )}

        {filtered.map((skill) => {
          const removable = inferredWritable(skill)
          const confirming = confirmRemove === skill.name
          return (
            <div key={`${skill.source}:${skill.name}`} className="rounded-lg border border-border/75 bg-card/35 px-3 py-2.5">
              <div className="flex items-start gap-3">
                <Puzzle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{skill.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                      {skill.scope === 'project' ? copy('项目', 'Project') : skill.scope === 'global' ? copy('全局', 'Global') : skill.source}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                    {skill.description}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {removable && !confirming && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setConfirmRemove(skill.name)}
                      title={copy(`删除 ${skill.name}`, `Delete ${skill.name}`)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Switch
                    checked={skill.enabled}
                    onCheckedChange={(enabled) => void handleToggle(skill, enabled)}
                    disabled={busyName === skill.name}
                    aria-label={copy(`${skill.enabled ? '停用' : '启用'} ${skill.name}`, `${skill.enabled ? 'Disable' : 'Enable'} ${skill.name}`)}
                  />
                </div>
              </div>

              {confirming && (
                <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2 text-[11px] text-destructive">
                  <span className="min-w-0 flex-1">{copy(`删除 ${skill.name} 及其目录？`, `Delete ${skill.name} and its directory?`)}</span>
                  <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={() => setConfirmRemove(null)}>
                    <X className="h-3 w-3" />{copy('取消', 'Cancel')}
                  </Button>
                  <Button variant="destructive" size="sm" className="h-7 gap-1 px-2" onClick={() => void handleRemove(skill)}>
                    {busyName === skill.name ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    {copy('删除', 'Delete')}
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {directory && (
        <button
          type="button"
          onClick={() => void copyDirectory()}
          className="flex max-w-full items-center gap-1.5 text-left text-[10px] text-muted-foreground hover:text-foreground"
          title={copy('复制全局 Skills 目录', 'Copy global Skills directory')}
        >
          <Copy className="h-3 w-3 shrink-0" />
          <span className="truncate font-mono">{directory}</span>
        </button>
      )}
    </section>
  )
}
