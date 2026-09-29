import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Copy, Loader2, QrCode, RefreshCw, Send, Unplug, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import { apiClient } from '@/api/client'
import { useI18n } from '@/lib/i18n'

type LoginStatus = 'not_configured' | 'disconnected' | 'qrcode' | 'waiting' | 'scanned' | 'expired' | 'connected' | 'checking'

const COMMANDS = [
  { command: '/帮助', zh: '查看命令列表', en: 'Show available commands' },
  { command: '/状态', zh: '查看工作区、模型和任务状态', en: 'Show workspace, model, and task status' },
  { command: '/新建', zh: '开始新的微信对话', en: 'Start a new WeChat conversation' },
  { command: '/clear', zh: '开始新的微信对话', en: 'Start a new WeChat conversation' },
  { command: '/项目', zh: '查看当前工作区和可用项目', en: 'Show the current workspace and projects' },
  { command: '/项目 <名称>', zh: '切换当前微信会话的工作区', en: 'Switch this conversation workspace' },
  { command: '/模型 [名称]', zh: '查看或切换当前模型', en: 'Show or change the model' },
  { command: '/模式 [工作|编码|计划]', zh: '查看或切换运行模式', en: 'Show or change the run mode' },
  { command: '/思考 [级别]', zh: '查看或切换思考级别', en: 'Show or change reasoning effort' },
  { command: '/回复 [normal|concise]', zh: '查看或切换回复详细程度', en: 'Show or change reply detail' },
  { command: '/bind', zh: '查看当前聊天关联状态', en: 'Show this chat binding status' },
]

const POLL_INTERVAL = 5000
const FAST_POLL_INTERVAL = 2500

export function WeChatPanel() {
  const toast = useToast()
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const [status, setStatus] = useState<LoginStatus>('checking')
  const [qrcode, setQrcode] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [autoReply, setAutoReply] = useState(false)
  const [savingAutoReply, setSavingAutoReply] = useState(false)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [testUserId, setTestUserId] = useState('')
  const [testText, setTestText] = useState('')
  const [sending, setSending] = useState(false)
  const prevStatusRef = useRef<LoginStatus>('checking')
  const refreshingRef = useRef(false)

  const refreshStatus = useCallback(async () => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    try {
      const data = await apiClient.getWeChatStatus()
      const nextStatus = (data.status ?? 'disconnected') as LoginStatus
      setAutoReply(Boolean(data.auto_reply))
      setStatus(nextStatus)
      setAccountId(data.account_id ?? null)
      if (data.qrcode_base64 && nextStatus !== 'connected') {
        setQrcode(data.qrcode_base64)
      }
      if (prevStatusRef.current !== 'connected' && nextStatus === 'connected') {
        toast.success(copy('微信已连接', 'WeChat connected'))
      }
      if (prevStatusRef.current === 'connected' && nextStatus === 'disconnected') {
        toast.error(copy('微信连接已断开', 'WeChat disconnected'))
      }
      if (nextStatus === 'connected' || nextStatus === 'expired' || nextStatus === 'disconnected') {
        setQrcode(null)
      }
      prevStatusRef.current = nextStatus
    } catch {
      setStatus('not_configured')
    } finally {
      refreshingRef.current = false
    }
  }, [toast, locale])

  useEffect(() => { void refreshStatus() }, [refreshStatus])

  useEffect(() => {
    const fast = status === 'waiting' || status === 'qrcode' || status === 'scanned' || status === 'checking'
    const interval = window.setInterval(() => { void refreshStatus() }, fast ? FAST_POLL_INTERVAL : POLL_INTERVAL)
    return () => window.clearInterval(interval)
  }, [status, refreshStatus])

  const handleLogin = async () => {
    setLoading(true)
    try {
      const result = await apiClient.weChatLogin()
      if (result.qrcode_base64) setQrcode(result.qrcode_base64)
      setStatus((result.status ?? 'waiting') as LoginStatus)
      prevStatusRef.current = (result.status ?? 'waiting') as LoginStatus
    } catch (error: any) {
      toast.error(copy(`登录失败：${error?.message || error}`, `Login failed: ${error?.message || error}`))
    } finally {
      setLoading(false)
    }
  }

  const handleDisconnect = async () => {
    setLoading(true)
    try {
      await apiClient.weChatDisconnect()
      setStatus('disconnected')
      prevStatusRef.current = 'disconnected'
      setQrcode(null)
      setAccountId(null)
      toast.success(copy('已断开微信连接', 'WeChat disconnected'))
    } catch (error: any) {
      toast.error(copy(`断开失败：${error?.message || error}`, `Disconnect failed: ${error?.message || error}`))
    } finally {
      setLoading(false)
    }
  }

  const handleAutoReplyChange = async (enabled: boolean) => {
    const previous = autoReply
    setAutoReply(enabled)
    setSavingAutoReply(true)
    try {
      await apiClient.weChatSetAutoReply(enabled)
      toast.success(copy(enabled ? '已启用自动回复' : '已停用自动回复', enabled ? 'Auto-replies enabled' : 'Auto-replies disabled'))
    } catch (error: any) {
      setAutoReply(previous)
      toast.error(copy(`保存失败：${error?.message || error}`, `Save failed: ${error?.message || error}`))
    } finally {
      setSavingAutoReply(false)
    }
  }

  const handleSend = async () => {
    if (!testUserId.trim() || !testText.trim()) return
    setSending(true)
    try {
      const result = await apiClient.weChatSend(testUserId.trim(), testText.trim())
      if (result.success) toast.success(copy('消息已发送', 'Message sent'))
      else toast.error(copy('发送失败', 'Send failed'))
    } catch (error: any) {
      toast.error(copy(`发送失败：${error?.message || error}`, `Send failed: ${error?.message || error}`))
    } finally {
      setSending(false)
    }
  }

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command.split(/\s+/, 1)[0])
      toast.success(copy('命令已复制', 'Command copied'))
    } catch {
      toast.error(copy('无法访问剪贴板', 'Clipboard access is unavailable'))
    }
  }

  const statusLabel: Record<LoginStatus, string> = {
    not_configured: copy('Runtime 不可用', 'Runtime unavailable'),
    disconnected: copy('未连接', 'Disconnected'),
    qrcode: copy('等待扫码', 'Waiting for scan'),
    waiting: copy('等待确认', 'Waiting for confirmation'),
    scanned: copy('已扫码，等待确认', 'Scanned, waiting for confirmation'),
    expired: copy('二维码已过期', 'QR code expired'),
    connected: copy('已连接', 'Connected'),
    checking: copy('检测中', 'Checking'),
  }
  const statusColor: Record<LoginStatus, string> = {
    not_configured: 'text-muted-foreground',
    disconnected: 'text-destructive',
    qrcode: 'text-amber-500',
    waiting: 'text-amber-500',
    scanned: 'text-amber-500',
    expired: 'text-destructive',
    connected: 'text-emerald-600 dark:text-emerald-400',
    checking: 'text-muted-foreground',
  }
  const StatusIcon = status === 'connected' ? CheckCircle2 : status === 'not_configured' || status === 'expired' ? XCircle : Loader2

  return (
    <section className="settings-section settings-wechat-section">
      <div className="settings-section-heading">
        <div>
          <h2>{copy('微信', 'WeChat')}</h2>
          <p>{copy('连接账号、管理自动回复并查看可用命令。', 'Connect an account, manage replies, and view available commands.')}</p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/20 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusIcon className={cn('h-4 w-4 shrink-0', statusColor[status], (status === 'waiting' || status === 'checking') && 'animate-spin')} />
            <span className={cn('text-sm font-medium', statusColor[status])}>{statusLabel[status]}</span>
          </div>
          {accountId && <span className="mt-1 block truncate pl-6 text-xs text-muted-foreground">{accountId}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {status !== 'connected' && status !== 'checking' && status !== 'waiting' && status !== 'scanned' && (
            <Button size="sm" onClick={handleLogin} disabled={loading}>
              {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <QrCode className="mr-1.5 h-3.5 w-3.5" />}
              {copy('扫码登录', 'Sign in with QR code')}
            </Button>
          )}
          {status === 'connected' && (
            <Button size="sm" variant="outline" onClick={handleDisconnect} disabled={loading}>
              <Unplug className="mr-1.5 h-3.5 w-3.5" />{copy('断开', 'Disconnect')}
            </Button>
          )}
          <Button size="icon" variant="ghost" className="h-8 w-8 rounded-md" onClick={() => void refreshStatus()} title={copy('刷新微信状态', 'Refresh WeChat status')} aria-label={copy('刷新微信状态', 'Refresh WeChat status')}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {qrcode && status !== 'connected' && (
        <div className="flex flex-col items-center gap-3 border-y border-border/50 py-5">
          <p className="text-sm text-muted-foreground">{copy('请用微信扫描二维码', 'Scan this QR code with WeChat')}</p>
          <img src={`data:image/png;base64,${qrcode}`} alt={copy('微信登录二维码', 'WeChat sign-in QR code')} className="h-48 w-48 rounded-md border border-border/50 bg-white p-1" />
          <p className="text-xs text-muted-foreground">{copy('扫码后会自动连接', 'The account connects after confirmation')}</p>
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor="wechat-auto-reply" className="text-sm font-medium">{copy('自动回复', 'Auto-replies')}</Label>
          <p className="mt-1 text-xs text-muted-foreground">{copy('普通消息交由当前运行时处理；机器人命令始终可用。', 'Route regular messages through the local runtime. Bot commands remain available.')}</p>
        </div>
        <Switch id="wechat-auto-reply" checked={autoReply} onCheckedChange={handleAutoReplyChange} disabled={savingAutoReply} aria-label={copy('启用自动回复', 'Enable auto-replies')} />
      </div>

      <div className="min-w-0">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-medium">{copy('机器人命令', 'Bot commands')}</h3>
          <span className="text-xs text-muted-foreground">{copy('点击复制', 'Select to copy')}</span>
        </div>
        <div className="divide-y divide-border/50 border-y border-border/50">
          {COMMANDS.map(({ command, zh, en }) => (
            <div key={command} className="flex min-h-10 items-center gap-3 py-1.5">
              <code className="w-32 shrink-0 truncate text-xs text-foreground">{command}</code>
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">{copy(zh, en)}</span>
              <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0 rounded-md" onClick={() => void copyCommand(command)} title={copy(`复制 ${command}`, `Copy ${command}`)} aria-label={copy(`复制 ${command}`, `Copy ${command}`)}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      {status === 'connected' && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">{copy('发送测试消息', 'Send a test message')}</h3>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <Input placeholder={copy('微信用户 ID', 'WeChat user ID')} value={testUserId} onChange={(event) => setTestUserId(event.target.value)} />
            <div className="flex gap-2">
              <Input placeholder={copy('消息内容', 'Message')} value={testText} onChange={(event) => setTestText(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void handleSend()} />
              <Button size="icon" className="h-9 w-9 shrink-0 rounded-md" onClick={() => void handleSend()} disabled={sending || !testUserId.trim() || !testText.trim()} title={copy('发送测试消息', 'Send test message')} aria-label={copy('发送测试消息', 'Send test message')}>
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
