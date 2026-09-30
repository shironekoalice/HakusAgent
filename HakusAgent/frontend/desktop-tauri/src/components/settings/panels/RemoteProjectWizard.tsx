import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  Container,
  Folder,
  FolderOpen,
  KeyRound,
  Loader2,
  RefreshCw,
  Server,
  Terminal,
  XCircle,
} from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { remoteOs, type RemoteConnectionInput, type RemoteRuntimeProgress, type RemoteSshHost } from '@/api/tauriBridge'
import type { Project, RemoteConnectionType, RemoteRuntimeInstallMode } from '@/api/types'
import { REMOTE_RUNTIME_CONNECTED_EVENT, useProjectsStore } from '@/store/projects'
import { useToast } from '@/components/ui/toast'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { GlassSelect } from '@/components/ui/glass-select'

type Step = 0 | 1 | 2 | 3

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialProject?: Project | null
  onConnected?: (project: Project) => void
}

const stepNames = {
  'zh-CN': ['选择方式', '填写配置', '连接中', '选择目录'],
  'en-US': ['Connection', 'Configuration', 'Connecting', 'Directory'],
} as const

export function RemoteProjectWizard({ open: isOpen, onOpenChange, initialProject, onConnected }: Props) {
  const { locale } = useI18n()
  const zh = locale === 'zh-CN'
  const toast = useToast()
  const createRemote = useProjectsStore((state) => state.createRemote)
  const connectRemoteRuntime = useProjectsStore((state) => state.connectRemoteRuntime)
  const [step, setStep] = useState<Step>(0)
  const [kind, setKind] = useState<RemoteConnectionType>('ssh')
  const [alias, setAlias] = useState('')
  const [sshHosts, setSshHosts] = useState<RemoteSshHost[]>([])
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  const [authMethod, setAuthMethod] = useState<'password' | 'key'>('key')
  const [password, setPassword] = useState('')
  const [privateKeyPath, setPrivateKeyPath] = useState('')
  const [distro, setDistro] = useState('')
  const [container, setContainer] = useState('')
  const [installMode, setInstallMode] = useState<RemoteRuntimeInstallMode>('localUpload')
  const [targets, setTargets] = useState<string[]>([])
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<Array<{ name: string; path: string; isDir: boolean }>>([])
  const [logs, setLogs] = useState<string[]>([])
  const [runtimeLogs, setRuntimeLogs] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [trustHostKey, setTrustHostKey] = useState(false)

  const connection = useMemo<RemoteConnectionInput>(() => ({
    kind,
    alias: alias || undefined,
    host: host.trim(),
    port: Number(port) || 22,
    username: username.trim(),
    authMethod,
    password,
    trustHostKey,
    privateKeyPath,
    distro,
    container,
  }), [kind, alias, host, port, username, authMethod, password, privateKeyPath, distro, container, trustHostKey])

  const copy = (zhText: string, enText: string) => zh ? zhText : enText

  useEffect(() => {
    if (!isOpen) return
    setStep(initialProject ? 1 : 0)
    setKind(initialProject?.remote?.type || 'ssh')
    setAlias(initialProject?.remote?.alias || '')
    setHost(initialProject?.remote?.host || '')
    setPort(String(initialProject?.remote?.port || 22))
    setUsername(initialProject?.remote?.username || '')
    setAuthMethod(initialProject?.remote?.authMethod || 'key')
    setPrivateKeyPath(initialProject?.remote?.privateKeyPath || '')
    setInstallMode(initialProject?.remote?.installMode || 'localUpload')
    setDistro(initialProject?.remote?.distro || '')
    setContainer(initialProject?.remote?.container || '')
    setName(initialProject?.name || '')
    setPassword('')
    setTrustHostKey(false)
    setLogs([])
    setRuntimeLogs([])
    setError('')
    setBusy(false)
  }, [isOpen, initialProject])

  useEffect(() => {
    if (!isOpen || kind !== 'ssh') return
    void remoteOs.listSshHosts().then(setSshHosts).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [isOpen, kind])

  useEffect(() => {
    if (!isOpen || (kind !== 'wsl' && kind !== 'docker')) return
    void remoteOs.listTargets(kind).then((values) => {
      setTargets(values)
      if (kind === 'wsl' && !distro && values.length) setDistro(values[0])
      if (kind === 'docker' && !container && values.length) setContainer(values[0])
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [isOpen, kind])

  const pickPrivateKey = async () => {
    const selected = await open({ multiple: false, directory: false, title: copy('选择 SSH 私钥', 'Choose an SSH private key') })
    if (typeof selected === 'string') setPrivateKeyPath(selected)
  }

  const startConnection = async () => {
    setBusy(true)
    setError('')
    setStep(2)
    setLogs([copy('正在检查连接配置...', 'Checking connection configuration...')])
    try {
      const result = await remoteOs.connect(connection)
      setLogs((current) => [...current, ...result.logs])
      setPath(result.cwd)
      const listing = await remoteOs.listDir(connection, result.cwd)
      setEntries(listing)
      setStep(3)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (message.startsWith('SSH_HOST_KEY_CONFIRM:')) {
        const [, remoteHost, remotePort, algorithm, ...fingerprintParts] = message.split(':')
        const fingerprint = fingerprintParts.join(':')
        setError(copy(
          `首次连接此 SSH 主机。请核对主机密钥指纹后确认信任：\n${remoteHost}:${remotePort}\n${algorithm}:${fingerprint}`,
          `This SSH host is not trusted yet. Verify and accept its host key fingerprint:\n${remoteHost}:${remotePort}\n${algorithm}:${fingerprint}`,
        ))
        setTrustHostKey(true)
      } else {
        setError(message)
      }
      setLogs((current) => [...current, message])
    } finally {
      setBusy(false)
    }
  }

  const browse = async (nextPath: string) => {
    setBusy(true)
    setError('')
    try {
      setPath(nextPath)
      setEntries(await remoteOs.listDir(connection, nextPath))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const syncResource = async (resource: 'skill' | 'mcp' | 'plugin') => {
    setBusy(true)
    setError('')
    setLogs((current) => [...current, copy(`开始同步 ${resource.toUpperCase()}...`, `Syncing ${resource.toUpperCase()}...`)])
    try {
      const result = await remoteOs.sync(connection, path, resource)
      setLogs((current) => [...current, ...result.logs])
      if (!result.ok) setError(result.logs.join('\n'))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      setLogs((current) => [...current, message])
    } finally {
      setBusy(false)
    }
  }

  const saveProject = async () => {
    const projectName = name.trim() || host.trim() || container || distro || path.split('/').filter(Boolean).pop() || 'Remote project'
    const project: Project = {
      id: initialProject?.id || `remote_${crypto.randomUUID()}`,
      name: projectName,
      path,
      pinned: initialProject?.pinned || false,
      created_at: initialProject?.created_at || Date.now(),
      last_used_at: Date.now(),
      kind: 'remote',
      remote: {
        id: initialProject?.remote?.id || crypto.randomUUID(),
        type: kind,
        alias: kind === 'ssh' ? alias || undefined : undefined,
        host: host.trim() || undefined,
        port: Number(port) || undefined,
        username: username.trim() || undefined,
        authMethod: kind === 'ssh' ? authMethod : undefined,
        privateKeyPath: kind === 'ssh' && authMethod === 'key' ? privateKeyPath : undefined,
        installMode: kind === 'ssh' ? installMode : undefined,
        distro: kind === 'wsl' ? distro : undefined,
        container: kind === 'docker' ? container : undefined,
      },
    }
    let unlisten: (() => void) | undefined
    try {
      setBusy(true)
      setRuntimeLogs([])
      await createRemote(project)
      if (kind === 'ssh') {
        unlisten = await listen<RemoteRuntimeProgress>('remote-runtime-progress', ({ payload }) => {
          if (payload.projectId === project.id) {
            setRuntimeLogs((current) => [...current, payload.message])
          }
        })
        await connectRemoteRuntime(project, password)
        const { useSessionStore } = await import('@/store/session')
        await useSessionStore.getState().loadFromServer()
        if (onConnected) onConnected(project)
        else if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent(REMOTE_RUNTIME_CONNECTED_EVENT, { detail: project }))
        }
      } else if (initialProject?.id === useProjectsStore.getState().activeProjectId) {
        useProjectsStore.getState().setActive(null)
      }
      toast.success(copy(`已保存远程项目：${project.name}`, `Remote project saved: ${project.name}`))
      onOpenChange(false)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
    } finally {
      unlisten?.()
      setBusy(false)
    }
  }

  const stepLabel: string[] = [...stepNames[locale]]
  if (step === 2 && error) stepLabel[2] = copy('连接失败', 'Connection failed')
  const targetValue = kind === 'wsl' ? distro : container
  const setTargetValue = kind === 'wsl' ? setDistro : setContainer
  const supportsWsl = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)
  const connectionTypes = [
    { type: 'ssh' as const, title: 'SSH', detail: copy('远程主机', 'Remote host'), icon: Server },
    ...(supportsWsl ? [{ type: 'wsl' as const, title: 'WSL', detail: copy('Windows Linux 子系统', 'Linux on Windows'), icon: Terminal }] : []),
    { type: 'docker' as const, title: 'Docker', detail: copy('本地容器', 'Local container'), icon: Container },
  ]

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(760px,92vh)] w-[min(1040px,calc(100%-2rem))] max-w-none gap-0 overflow-hidden p-0 sm:rounded-lg">
        <div className="grid min-h-0 flex-1 grid-cols-[205px_minmax(0,1fr)] max-sm:grid-cols-1">
          <aside className="border-r border-border bg-muted/25 p-4 max-sm:hidden">
            <DialogHeader className="mb-7 text-left">
              <DialogTitle className="text-base">{copy('远程项目', 'Remote project')}</DialogTitle>
              <DialogDescription>{copy('连接并浏览工作目录', 'Connect and browse a workspace')}</DialogDescription>
            </DialogHeader>
            <ol className="space-y-1.5">
              {stepLabel.map((label, index) => {
                const current = step === index
                const complete = step > index
                return (
                  <li key={label} className={cn('flex h-10 items-center gap-2.5 rounded-md px-2.5 text-xs', current && 'bg-accent font-medium text-foreground', !current && !complete && 'text-muted-foreground')}>
                    <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]', current && 'border-primary bg-background text-foreground', complete && 'border-emerald-600 bg-emerald-600 text-white', !current && !complete && 'border-border')}>
                      {complete ? <Check className="h-3 w-3" /> : index + 1}
                    </span>
                    {label}
                  </li>
                )
              })}
            </ol>
          </aside>

          <main className="flex min-h-0 flex-col p-5 sm:p-7">
            <DialogHeader className="mb-5 pr-9 text-left">
              <DialogTitle className="text-lg">
                {step === 0 && copy('选择连接方式', 'Choose connection type')}
                {step === 1 && copy('填写连接配置', 'Configure connection')}
                {step === 2 && error
                  ? copy('连接失败', 'Connection failed')
                  : step === 2 && copy('正在建立连接', 'Connecting')}
                {step === 3 && copy('选择远程目录', 'Choose a remote directory')}
              </DialogTitle>
              <DialogDescription>
                {step === 0 && copy('选择要添加到项目管理的远程环境。', 'Choose a remote environment to add to project management.')}
                {step === 1 && copy('连接配置仅用于建立当前连接，密码不会保存。', 'Connection details are used for this connection only. Passwords are not saved.')}
                {step === 2 && (error
                  ? copy('连接未能完成。查看下方错误，修正配置后可重试。', 'The connection did not complete. Review the error below, then retry.')
                  : copy('检查连接并读取远程工作目录。', 'Checking the connection and reading the remote workspace.'))}
                {step === 3 && copy('浏览远程文件夹，选定后保存为项目。', 'Browse remote folders and save the selected directory as a project.')}
              </DialogDescription>
            </DialogHeader>

            {step === 0 && (
              <div className="grid flex-1 content-start grid-cols-2 gap-3 max-sm:grid-cols-1">
                {connectionTypes.map(({ type, title, detail, icon: Icon }) => (
                  <button key={type} type="button" onClick={() => setKind(type)} className={cn('min-h-32 rounded-md border p-4 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', kind === type ? 'border-primary bg-accent/35' : 'border-border')}>
                    <span className={cn('mb-4 flex h-9 w-9 items-center justify-center rounded-md border', kind === type ? 'border-primary/30 bg-background text-primary' : 'border-border text-muted-foreground')}><Icon className="h-4 w-4" /></span>
                    <span className="block text-sm font-medium">{title}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{detail}</span>
                  </button>
                ))}
              </div>
            )}

            {step === 1 && (
              <div className="min-h-0 flex-1 space-y-4 overflow-auto pr-1">
                {kind === 'ssh' ? <>
                  <Field label={copy('SSH 配置别名（可选）', 'SSH config alias (optional)')}>
                    <GlassSelect
                      value={alias}
                      onChange={(selected) => {
                        setAlias(selected)
                        const saved = sshHosts.find((item) => item.alias === selected)
                        if (!saved) return
                        setHost('')
                        setPort(String(saved.port || 22))
                        setUsername(saved.username || '')
                        setPrivateKeyPath(saved.privateKeyPath || '')
                        if (saved.privateKeyPath) {
                          setAuthMethod('key')
                        }
                      }}
                      ariaLabel={copy('SSH 配置别名', 'SSH config alias')}
                      options={[
                        { value: '', label: copy('不使用别名', 'No alias') },
                        ...(alias && !sshHosts.some((item) => item.alias === alias) ? [{ value: alias, label: alias }] : []),
                        ...sshHosts.map((item) => ({ value: item.alias, label: item.alias })),
                      ]}
                      triggerClassName="h-9 rounded-md border-input bg-background px-3 text-sm"
                    />
                  </Field>
                  <div className="grid grid-cols-[minmax(0,1fr)_116px] gap-3">
                    <Field label={copy('主机', 'Host')}><Input autoComplete="off" placeholder="server.example.com" value={host} onChange={(event) => { setAlias(''); setHost(event.target.value) }} /></Field>
                    <Field label={copy('端口', 'Port')}><Input autoComplete="off" inputMode="numeric" min={1} max={65535} value={port} onChange={(event) => setPort(event.target.value)} /></Field>
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(200px,0.75fr)] gap-3">
                    <Field label={copy('用户名', 'Username')}><Input autoComplete="off" placeholder="user" value={username} onChange={(event) => setUsername(event.target.value)} /></Field>
                    <Field label={copy('认证方式', 'Authentication')}>
                      <div className="grid h-9 grid-cols-2 rounded-md border border-input p-0.5">
                        <button type="button" onClick={() => setAuthMethod('password')} className={cn('rounded-sm text-xs', authMethod === 'password' ? 'bg-accent font-medium' : 'text-muted-foreground')}>{copy('密码', 'Password')}</button>
                        <button type="button" onClick={() => setAuthMethod('key')} className={cn('rounded-sm text-xs', authMethod === 'key' ? 'bg-accent font-medium' : 'text-muted-foreground')}>{copy('私钥', 'Private key')}</button>
                      </div>
                    </Field>
                  </div>
                  {authMethod === 'password' ? (
                    <>
                      <Field label={copy('密码', 'Password')}><Input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
                      <p className="text-[11px] text-muted-foreground">{copy('密码仅用于本次 SSH 连接，不会保存到项目配置。', 'The password is used only for this SSH connection and is not saved with the project.')}</p>
                    </>
                  ) : (
                    <Field label={copy('私钥文件', 'Private key file')}>
                      <div className="flex gap-2"><Input readOnly value={privateKeyPath} placeholder="~/.ssh/id_ed25519" /><Button type="button" variant="outline" size="sm" onClick={() => void pickPrivateKey()}><KeyRound className="h-3.5 w-3.5" />{copy('浏览', 'Browse')}</Button></div>
                    </Field>
                  )}
                  <Field label={copy('Runtime 获取方式', 'Runtime download source')}>
                    <div className="grid grid-cols-2 gap-2">
                      <button type="button" aria-pressed={installMode === 'localUpload'} onClick={() => setInstallMode('localUpload')} className={cn('min-h-16 rounded-md border px-3 py-2 text-left transition-colors', installMode === 'localUpload' ? 'border-primary bg-accent/35' : 'border-border hover:bg-accent/30')}>
                        <span className="block text-xs font-medium">{copy('本机下载后上传', 'Download here, then upload')}</span>
                        <span className="mt-1 block text-[11px] text-muted-foreground">{copy('适用于远端无法访问 GitHub 的情况', 'For hosts without direct access to GitHub')}</span>
                      </button>
                      <button type="button" aria-pressed={installMode === 'remoteDownload'} onClick={() => setInstallMode('remoteDownload')} className={cn('min-h-16 rounded-md border px-3 py-2 text-left transition-colors', installMode === 'remoteDownload' ? 'border-primary bg-accent/35' : 'border-border hover:bg-accent/30')}>
                        <span className="block text-xs font-medium">{copy('远端直接下载', 'Download on the remote host')}</span>
                        <span className="mt-1 block text-[11px] text-muted-foreground">{copy('需要网络、curl 或 wget，以及 SHA-256 工具', 'Requires network, curl or wget, and a SHA-256 utility')}</span>
                      </button>
                    </div>
                  </Field>
                  <Field label={copy('项目名称', 'Project name')}><Input autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} placeholder={host || copy('远程项目', 'Remote project')} /></Field>
                </> : <>
                  <Field label={kind === 'wsl' ? copy('WSL 发行版', 'WSL distribution') : copy('运行中的容器', 'Running container')}>
                    <div className="flex gap-2">
                      <GlassSelect
                        value={targetValue}
                        onChange={setTargetValue}
                        ariaLabel={kind === 'wsl' ? 'WSL distribution' : 'Docker container'}
                        options={[{ value: '', label: copy('请选择', 'Select one') }, ...targets.map((target) => ({ value: target, label: target }))]}
                        className="min-w-0 flex-1"
                        triggerClassName="h-9 rounded-md border-input bg-background px-3 text-sm"
                      />
                      <Button type="button" variant="outline" size="icon" title={copy('刷新列表', 'Refresh list')} onClick={() => void remoteOs.listTargets(kind).then(setTargets).catch((cause) => setError(String(cause)))}><RefreshCw className="h-4 w-4" /></Button>
                    </div>
                  </Field>
                  <Field label={copy('项目名称', 'Project name')}><Input autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} placeholder={targetValue || 'Remote project'} /></Field>
                </>}
                {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
              </div>
            )}

            {step === 2 && (
              <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-muted/20">
                <div className="flex h-10 items-center justify-between border-b border-border px-3 text-xs font-medium">
                  <span>{copy('连接日志', 'Connection log')}</span>
                  {busy
                    ? <span className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{copy('正在连接…', 'Connecting…')}</span>
                    : error && <span className="flex items-center gap-1.5 text-destructive"><XCircle className="h-3.5 w-3.5" />{copy('连接失败', 'Connection failed')}</span>}
                </div>
                {error && <div role="alert" className="mx-3 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
                  <p className="font-medium">{error}</p>
                </div>}
                <pre className={cn('h-full max-h-[390px] overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px] leading-5', error ? 'text-muted-foreground' : 'text-muted-foreground')}>{logs.filter((line) => line !== error).join('\n')}</pre>
              </div>
            )}

            {step === 3 && (
              <div className="flex min-h-0 flex-1 flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-700/25 bg-emerald-600/10 px-3 py-2.5">
                  <span className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300"><Check className="h-4 w-4" />{copy('连接成功', 'Connected')}</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button type="button" size="sm" variant="outline" disabled={busy} className="h-7 gap-1.5"><CloudUpload className="h-3.5 w-3.5" />{copy('同步资源', 'Sync resources')}<ChevronRight className="h-3.5 w-3.5 rotate-90" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => void syncResource('skill')}><CloudUpload className="h-4 w-4" />{copy('同步 Skill', 'Sync Skill')}</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void syncResource('mcp')}><CloudUpload className="h-4 w-4" />{copy('同步 MCP', 'Sync MCP')}</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void syncResource('plugin')}><CloudUpload className="h-4 w-4" />{copy('同步 Plugin', 'Sync Plugin')}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {runtimeLogs.length > 0 && <section className="overflow-hidden rounded-md border border-border bg-muted/20" aria-label={copy('Runtime 部署日志', 'Runtime deployment log')}>
                  <div className="border-b border-border px-3 py-2 text-xs font-medium">{copy('Runtime 部署', 'Runtime setup')}</div>
                  <pre role="log" aria-live="polite" className="max-h-28 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground">{runtimeLogs.join('\n')}</pre>
                </section>}
                <p className="text-[11px] text-muted-foreground">{copy('MCP 配置可能包含密钥；同步前请确认远程环境可信。', 'MCP configuration may contain secrets. Verify the remote environment is trusted before syncing.')}</p>
                <Field label={copy('远程路径', 'Remote path')}>
                  <div className="flex gap-2"><Input value={path} onChange={(event) => setPath(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void browse(path) }} /><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void browse(path)}>{copy('打开', 'Open')}</Button></div>
                </Field>
                <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-background" aria-busy={busy}>
                  {path !== '/' && <button type="button" onClick={() => void browse(parentPath(path))} className="flex h-10 w-full items-center gap-2 border-b border-border px-3 text-left text-xs text-muted-foreground hover:bg-accent/40"><Folder className="h-4 w-4" />..</button>}
                  {entries.map((entry) => <button type="button" key={entry.path} disabled={!entry.isDir || busy} onClick={() => entry.isDir && void browse(entry.path)} className="flex h-10 w-full items-center gap-2 border-b border-border/60 px-3 text-left text-xs hover:bg-accent/40 disabled:cursor-default disabled:opacity-60"><FolderOpen className={cn('h-4 w-4', entry.isDir ? 'text-primary' : 'text-muted-foreground')} /><span className="truncate">{entry.name}</span></button>)}
                  {!entries.length && <p className="px-3 py-6 text-center text-xs text-muted-foreground">{copy('此目录为空', 'This directory is empty')}</p>}
                </div>
                {error && <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p>}
              </div>
            )}

            <DialogFooter className="mt-5 flex-row items-center justify-between border-t border-border pt-4">
              <Button type="button" variant="ghost" size="sm" disabled={busy || step === 0 || step === 2} onClick={() => setStep((value) => Math.max(0, value - 1) as Step)}><ChevronLeft className="h-4 w-4" />{copy('上一步', 'Back')}</Button>
              {step === 0 && <Button type="button" size="sm" onClick={() => setStep(1)}>{copy('下一步', 'Next')}<ChevronRight className="h-4 w-4" /></Button>}
              {step === 1 && <Button type="button" size="sm" disabled={busy || (kind === 'ssh' ? (!host.trim() && !alias) || (authMethod === 'password' && !password) : !targetValue)} onClick={() => void startConnection()}>{copy('开始连接', 'Connect')}<ChevronRight className="h-4 w-4" /></Button>}
              {step === 2 && <div className="flex items-center gap-2">
                {error && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void startConnection()}>{copy('重试', 'Retry')}<RefreshCw className="h-3.5 w-3.5" /></Button>}
                <Button type="button" size="sm" disabled={busy} onClick={() => { setStep(1); setError('') }}>{copy('返回配置', 'Back to settings')}</Button>
              </div>}
              {step === 3 && <Button type="button" size="sm" disabled={busy || !path.trim()} aria-busy={busy} onClick={() => void saveProject()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {busy
                  ? kind === 'ssh'
                    ? copy('正在部署并连接 Runtime…', 'Deploying and connecting Runtime…')
                    : copy('正在保存项目…', 'Saving project…')
                  : copy('保存项目', 'Save project')}
              </Button>}
            </DialogFooter>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0 space-y-1.5"><Label className="text-xs text-muted-foreground">{label}</Label>{children}</div>
}

function parentPath(path: string): string {
  const normalized = path.replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}
