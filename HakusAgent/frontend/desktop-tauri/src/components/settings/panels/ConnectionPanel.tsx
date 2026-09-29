/**
 * Connection panel — serverUrl / timeout / useWebSocket / Test connection
 * 复用原有 Connection tab 逻辑
 */

import { useEffect, useState } from 'react'
import { Server, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/store/settings'
import { useConnectionStore } from '@/store/connection'
import { apiClient } from '@/api/client'
import { useI18n } from '@/lib/i18n'

export function ConnectionPanel() {
  const settings = useSettingsStore()
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const connCheck = useConnectionStore((s) => s.check)
  const connState = useConnectionStore((s) => s.state)
  const connError = useConnectionStore((s) => s.error)
  const connHealth = useConnectionStore((s) => s.health)

  const rustPreview = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('backend')?.toLowerCase() === 'rust'
  const initialServerUrl = rustPreview ? apiClient.getBaseUrl() : settings.connection.serverUrl
  const [serverUrl, setServerUrl] = useState(initialServerUrl)
  const [useWebSocket, setUseWebSocket] = useState(settings.connection.useWebSocket)
  const [timeout, setTimeoutValue] = useState(settings.connection.timeout)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    setServerUrl(rustPreview ? apiClient.getBaseUrl() : settings.connection.serverUrl)
    setUseWebSocket(settings.connection.useWebSocket)
    setTimeoutValue(settings.connection.timeout)
  }, [rustPreview, settings.connection.serverUrl, settings.connection.useWebSocket, settings.connection.timeout])

  const dirty =
    serverUrl !== settings.connection.serverUrl ||
    useWebSocket !== settings.connection.useWebSocket ||
    timeout !== settings.connection.timeout

  const handleSave = async () => {
    setSaving(true)
    try {
      await settings.update({
        connection: { serverUrl, useWebSocket, timeout },
      })
      apiClient.setBaseUrl(serverUrl)
      apiClient.setTimeout(timeout)
      await connCheck(serverUrl)
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    apiClient.setBaseUrl(serverUrl)
    await connCheck(serverUrl)
    setTesting(false)
  }

  return (
    <section className="settings-section settings-connection-section">
      <div className="settings-section-heading">
        <div>
          <h2>{copy('连接', 'Connection')}</h2>
          <p>{copy('管理 HakusAI 服务地址和实时连接选项。', 'Manage the HakusAI service address and live connection options.')}</p>
        </div>
      </div>

      <div className="settings-field-group">
        <div className="settings-field-group-heading">
          <h3>{copy('服务地址', 'Service address')}</h3>
          <p>{copy('桌面端通常连接本机服务，手机端可填写同一网络中的电脑地址。', 'Desktop usually connects locally; on mobile, use the computer address on the same network.')}</p>
        </div>
        <div className="settings-field">
          <Label htmlFor="server-url">{copy('HakusAI 服务 URL', 'HakusAI server URL')}</Label>
          <Input
            id="server-url"
            autoComplete="off"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="http://127.0.0.1:48081"
            className="font-mono"
          />
          <p className="settings-field-help">
            {rustPreview && (
              <>
                {copy(`当前预览已连接到 Rust 服务（${apiClient.getBaseUrl()}）。`, `This preview is connected to the Rust service (${apiClient.getBaseUrl()}).`)}
              </>
            )}
            {!rustPreview && (
              <>
                {copy('桌面版可使用本机服务；Android 版请填写运行 HakusAI 服务的电脑或服务器地址，例如', 'Desktop can use the local service. On Android, enter the computer or server running HakusAI, for example')} <code>http://192.168.1.20:48081</code>{copy('。', '.')}
              </>
            )}
          </p>
        </div>
      </div>

      <div className="settings-field-group settings-connection-options">
        <div className="settings-field-group-heading">
          <h3>{copy('连接选项', 'Connection options')}</h3>
        </div>
        <div className="settings-field">
          <Label htmlFor="timeout">{copy('请求超时 (ms)', 'Request timeout (ms)')}</Label>
          <Input
            id="timeout"
            autoComplete="off"
            type="number"
            value={timeout}
            onChange={(e) => setTimeoutValue(Number(e.target.value) || 30000)}
            min={5000}
            max={300000}
            step={1000}
          />
        </div>
        <div className="settings-option-row">
          <div className="settings-option-copy">
            <div>
              <Label className="settings-option-title">{copy('使用 WebSocket（实验性）', 'Use WebSocket (experimental)')}</Label>
              <p className="settings-option-description">
                {copy('改用全双工 WebSocket 而非 SSE，支持流式中断。', 'Use full-duplex WebSocket instead of SSE for interruptible streams.')}
              </p>
            </div>
          </div>
          <Switch checked={useWebSocket} onCheckedChange={setUseWebSocket} />
        </div>
      </div>

      {/* 连接状态 */}
      <div className="settings-connection-status">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {connState === 'connected' && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
            {connState === 'connecting' && <Loader2 className="h-4 w-4 animate-spin text-amber-500" />}
            {connState === 'error' && <AlertCircle className="h-4 w-4 text-red-500" />}
            {connState === 'disconnected' && <div className="h-2 w-2 rounded-full bg-muted-foreground" />}
            <span className="text-sm font-medium">
              {connState === 'connected'
                ? copy('已连接', 'Connected')
                : connState === 'connecting'
                  ? copy('连接中...', 'Connecting...')
                  : connState === 'error'
                    ? copy('连接失败', 'Connection failed')
                    : copy('未连接', 'Disconnected')}
            </span>
            {connHealth && (
              <span className="text-[11px] text-muted-foreground">
                v{connHealth.version} · status: {connHealth.status}
              </span>
            )}
          </div>
        </div>
        {connError && connState === 'error' && (
          <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-500">
            {connError}
          </div>
        )}
      </div>

      <div className="settings-actions">
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {copy('保存中...', 'Saving...')}
            </>
          ) : (
            copy('保存', 'Save')
          )}
        </Button>
        <Button variant="outline" size="sm" onClick={handleTest} disabled={testing}>
          {testing ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> {copy('测试中...', 'Testing...')}
            </>
          ) : (
            copy('测试连接', 'Test connection')
          )}
        </Button>
      </div>
    </section>
  )
}
