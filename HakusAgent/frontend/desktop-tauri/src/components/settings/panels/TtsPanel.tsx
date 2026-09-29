import { useEffect, useMemo, useRef, useState } from 'react'
import { GlassSelect } from '@/components/ui/glass-select'
import { Bell, Loader2, Phone, Play, Square, Upload, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/toast'
import { useSettingsStore } from '@/store/settings'
import { apiClient } from '@/api/client'
import { cn } from '@/lib/utils'
import { playVoiceNotification } from '@/lib/voiceNotifications'
import type { AppSettings } from '@/api/types'
import { useI18n } from '@/lib/i18n'

export function TtsPanel() {
  const toast = useToast()
  const settings = useSettingsStore()
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const [voices, setVoices] = useState<string[]>([])
  const [voicesLoading, setVoicesLoading] = useState(false)
  const [previewText, setPreviewText] = useState(locale === 'zh-CN' ? '你好，我是 HakusAI。任务完成时我可以用声音提醒你。' : "Hi, I'm HakusAI. I can notify you when a task is complete.")
  const [previewing, setPreviewing] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState<VoiceProcessStatus | null>(null)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [cloneStatus, setCloneStatus] = useState<'idle' | 'uploading' | 'cloning' | 'ok' | 'error'>('idle')
  const [cloneProgress, setCloneProgress] = useState('')
  const [cloneVoiceId, setCloneVoiceId] = useState<string | null>(null)
  const [cloneError, setCloneError] = useState('')
  const cloneFileRef = useRef<HTMLInputElement | null>(null)
  const clonePollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    if (!settings.ttsEnabled) return
    if (voices.length > 0) return
    setVoicesLoading(true)
    apiClient
      .getTtsVoices()
      .then((r) => setVoices(r.voices || []))
      .catch((e) => toast.error(copy(`获取语音列表失败：${e?.message || e}`, `Could not load voices: ${e?.message || e}`)))
      .finally(() => setVoicesLoading(false))
  }, [settings.ttsEnabled, voices.length, toast])

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const status = await window.electron?.voice?.status?.()
      if (!cancelled && status) setVoiceStatus(status)
    }
    void refresh()
    const id = setInterval(refresh, 3000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const refreshCloneStatus = async () => {
      try {
        const data = await apiClient.getVoiceCloneStatus()
        if (cancelled) return
        if (data.status === 'completed' || data.status === 'ok') {
          setCloneStatus('ok')
          setCloneVoiceId(data.voice_id || null)
          setCloneError('')
          setCloneProgress('')
        } else if (data.status === 'cloning' || data.status === 'uploading') {
          setCloneStatus('cloning')
          setCloneProgress(data.progress || copy('复刻中，请等待…', 'Cloning voice, please wait…'))
        } else if (data.status === 'failed' || data.status === 'error') {
          setCloneStatus('error')
          setCloneError(data.error || data.message || copy('复刻失败', 'Voice cloning failed'))
        }
      } catch {
        // Backend may still be starting; leave the panel usable and retry on reopen.
      }
    }
    void refreshCloneStatus()
    return () => { cancelled = true }
  }, [])

  const filteredVoices = useMemo(
    () =>
      voices.length > 0
        ? voices.filter((v) => /^zh-/i.test(v)).concat(
            voices.filter((v) => !/^zh-/i.test(v)).slice(0, 30),
          )
        : [],
    [voices],
  )

  const handlePreview = async () => {
    if (previewing) {
      audioRef.current?.pause()
      setPreviewing(false)
      return
    }
    if (!previewText.trim()) {
      toast.info(copy('请输入试听文本', 'Enter preview text first'))
      return
    }
    setPreviewing(true)
    try {
      const blob = await apiClient.textToSpeech(previewText, settings.ttsVoice, settings.ttsSpeed)
      const url = URL.createObjectURL(blob)
      audioRef.current?.pause()
      const audio = new Audio(url)
      audio.onended = () => {
        setPreviewing(false)
        URL.revokeObjectURL(url)
      }
      audio.onerror = () => {
        setPreviewing(false)
        URL.revokeObjectURL(url)
        toast.error(copy('音频播放失败', 'Audio playback failed'))
      }
      audioRef.current = audio
      await audio.play()
    } catch (e: any) {
      setPreviewing(false)
      toast.error(copy(`合成失败：${e?.message || e}`, `Synthesis failed: ${e?.message || e}`))
    }
  }

  const handleCloneUpload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.wav')) {
      toast.error(copy('请上传 WAV 格式的音频文件', 'Upload a WAV audio file'))
      return
    }
    setCloneStatus('uploading')
    setCloneProgress(copy('上传中...', 'Uploading...'))
    setCloneError('')
    setCloneVoiceId(null)
    // 停止旧的轮询
    if (clonePollRef.current) {
      clearInterval(clonePollRef.current)
      clonePollRef.current = null
    }
    try {
      const cloneResult = await apiClient.cloneVoice(file, file.name)
      if (cloneResult.status === 'completed' || cloneResult.status === 'ok') {
        setCloneStatus('ok')
        setCloneVoiceId(cloneResult.voice_id || null)
        if (cloneResult.voice_id) settings.update({ ttsVoice: cloneResult.voice_id })
        setCloneProgress('')
        return
      }
      setCloneStatus('cloning')
      setCloneProgress(cloneResult.message || copy('复刻中，请等待...', 'Cloning voice, please wait...'))
      // 开始轮询状态
      clonePollRef.current = setInterval(async () => {
        try {
          const data = await apiClient.getVoiceCloneStatus()
          if (data.status === 'completed' || data.status === 'ok') {
            setCloneStatus('ok')
            setCloneVoiceId(data.voice_id || '')
            setCloneProgress('')
            if (clonePollRef.current) {
              clearInterval(clonePollRef.current)
              clonePollRef.current = null
            }
          } else if (data.status === 'cloning') {
            setCloneProgress(data.progress || copy('复刻中，请等待...', 'Cloning voice, please wait...'))
          } else if (data.status === 'failed' || data.status === 'error') {
            setCloneStatus('error')
            setCloneError(data.error || data.message || copy('复刻失败', 'Voice cloning failed'))
            setCloneProgress('')
            if (clonePollRef.current) {
              clearInterval(clonePollRef.current)
              clonePollRef.current = null
            }
          }
        } catch {
          // 轮询失败不中断，下次重试
        }
      }, 5000)
    } catch (e: any) {
      setCloneStatus('error')
      setCloneError(e?.message || copy('上传失败', 'Upload failed'))
      setCloneProgress('')
    }
  }

  // 清理轮询
  useEffect(() => {
    return () => {
      if (clonePollRef.current) {
        clearInterval(clonePollRef.current)
      }
    }
  }, [])

  const toggleCelia = async () => {
    const voice = window.electron?.voice
    if (!voice) {
      toast.error(copy('当前环境不支持桌面语音进程控制', 'Voice process control is unavailable in this environment'))
      return
    }
    setVoiceBusy(true)
    try {
      const result = voiceStatus?.running
        ? await voice.stopCelia()
        : await voice.startCelia({
            celiaPath: settings.celiaPath,
            configPath: settings.celiaConfigPath,
            pythonCommand: settings.celiaPythonCommand,
            openInTerminal: settings.celiaOpenInTerminal,
          })
      if (!result.ok) {
        toast.error(result.error || copy('Celia 语音通话启动失败', 'Could not start Celia voice call'))
      } else {
        toast.success(result.running ? copy('Celia 语音通话已启动', 'Celia voice call started') : copy('Celia 语音通话已停止', 'Celia voice call stopped'))
      }
      const status = await voice.status()
      setVoiceStatus(status)
    } finally {
      setVoiceBusy(false)
    }
  }

  return (
    <section className="settings-section settings-voice-section">
      <div className="settings-section-heading">
        <div>
          <h2>{copy('语音与提示', 'Voice & alerts')}</h2>
          <p>{copy('把通话、播报和试听集中管理，按需开启即可。', 'Manage calls, alerts, and voice previews in one place.')}</p>
        </div>
      </div>

      <div className="settings-voice-groups">
      <section className="settings-subsection">
        <div className="settings-subsection-heading flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/12 text-primary">
              <Phone className="h-4 w-4" />
            </div>
            <div>
              <div className="text-sm font-semibold">{copy('语音通话', 'Voice calls')}</div>
              <p className="text-[11px] text-muted-foreground">
                {copy('用麦克风和 AI 直接对话。可选择 HakusAI VoiceAgent 引擎或外部 Celia。', 'Talk directly with the AI using your microphone. Choose the built-in HakusAI VoiceAgent or external Celia.')}
              </p>
            </div>
          </div>
          <Switch
            checked={settings.voiceCallEnabled}
            onCheckedChange={(v) => settings.update({ voiceCallEnabled: v })}
          />
        </div>

        {settings.voiceCallEnabled && (
          <div className="settings-subpanel">
            <div className="space-y-1.5">
              <Label htmlFor="voice-call-backend">{copy('通话引擎', 'Call engine')}</Label>
              <GlassSelect
                id="voice-call-backend"
                value={settings.voiceCallBackend}
                onChange={(value) => settings.update({ voiceCallBackend: value as 'celia' | 'builtin' })}
                options={[
                  { value: 'builtin', label: copy('HakusAI VoiceAgent 引擎', 'HakusAI VoiceAgent') },
                  { value: 'celia', label: copy('Celia 外部进程', 'External Celia process') },
                ]}
              />
            </div>

            {settings.voiceCallBackend === 'celia' && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="celia-path">{copy('Celia 项目路径', 'Celia project path')}</Label>
                  <input
                    id="celia-path"
                    value={settings.celiaPath}
                    onChange={(e) => settings.update({ celiaPath: e.target.value })}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="celia-config">{copy('配置文件', 'Config file')}</Label>
                  <input
                    id="celia-config"
                    value={settings.celiaConfigPath}
                    onChange={(e) => settings.update({ celiaConfigPath: e.target.value })}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="celia-python">{copy('Python 解释器', 'Python interpreter')}</Label>
                  <input
                    id="celia-python"
                    value={settings.celiaPythonCommand}
                    onChange={(e) => settings.update({ celiaPythonCommand: e.target.value })}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="celia-terminal"
                    type="checkbox"
                    checked={settings.celiaOpenInTerminal}
                    onChange={(e) => settings.update({ celiaOpenInTerminal: e.target.checked })}
                    className="rounded border-input"
                  />
                  <Label htmlFor="celia-terminal" className="text-xs font-normal">
                    {copy('在终端窗口中启动 Celia', 'Launch Celia in a terminal window')}
                  </Label>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <div className="flex items-center gap-2">
                    <Badge variant={voiceStatus?.running ? 'success' : 'outline'}>
                      {voiceStatus?.running ? copy(`通话中 PID ${voiceStatus.pid}`, `Call active, PID ${voiceStatus.pid}`) : copy('未启动', 'Not running')}
                    </Badge>
                    {voiceStatus?.lastError && (
                      <span className="text-[11px] text-destructive">{voiceStatus.lastError}</span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant={voiceStatus?.running ? 'destructive' : 'default'}
                    onClick={toggleCelia}
                    disabled={voiceBusy}
                  >
                    {voiceBusy ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : voiceStatus?.running ? (
                      <Square className="mr-2 h-3.5 w-3.5" />
                    ) : (
                      <Phone className="mr-2 h-3.5 w-3.5" />
                    )}
                    {voiceStatus?.running ? copy('结束 Celia 测试', 'Stop Celia test') : copy('测试 Celia 进程', 'Test Celia process')}
                  </Button>
                </div>
              </div>
            )}

            {settings.voiceCallBackend === 'builtin' && (
              <div className="space-y-4">
                {/* DashScope API Key（CosyVoice 语音复刻 / 实时 TTS 必需） */}
                <div className="space-y-1.5">
                  <Label htmlFor="dashscope-key">DashScope API Key</Label>
                  <input
                    id="dashscope-key"
                    type="password"
                    autoComplete="new-password"
                    value={settings.dashscopeApiKey}
                    onChange={(e) => settings.update({ dashscopeApiKey: e.target.value })}
                    placeholder="sk-..."
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-mono"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {copy('阿里云 DashScope 的 API Key，CosyVoice 语音复刻和实时 TTS 必需。在', 'An Alibaba Cloud DashScope API key is required for CosyVoice cloning and real-time TTS. Get it from the')}{' '}
                    <a href="https://dashscope.console.aliyun.com/apiKey" target="_blank" rel="noreferrer" className="text-primary underline">{copy('阿里云控制台', 'Alibaba Cloud Console')}</a>{copy('。', '.')}
                  </p>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="asr-provider">{copy('ASR 引擎', 'ASR engine')}</Label>
                    <GlassSelect
                      id="asr-provider"
                      value={settings.asrProvider}
                      onChange={(value) => settings.update({ asrProvider: value as AppSettings['asrProvider'] })}
                      options={[
                        { value: 'funasr', label: 'FunASR (SenseVoiceSmall)' },
                        { value: 'whisper', label: `Whisper ${copy('（API / 本地）', '(API / local)')}` },
                      ]}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="asr-language">{copy('识别语言', 'Recognition language')}</Label>
                    <GlassSelect
                      id="asr-language"
                      value={settings.asrLanguage}
                      onChange={(value) => settings.update({ asrLanguage: value })}
                      options={[
                        { value: 'zh', label: copy('中文', 'Chinese') },
                        { value: 'en', label: 'English' },
                        { value: 'auto', label: copy('自动', 'Auto') },
                      ]}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="vad-threshold">{copy('VAD 触发阈值', 'VAD trigger threshold')}</Label>
                    <span className="font-mono text-xs text-muted-foreground">
                      {settings.vadThreshold.toFixed(3)}
                    </span>
                  </div>
                  <input
                    id="vad-threshold"
                    type="range"
                    min={0.01}
                    max={0.1}
                    step={0.005}
                    value={settings.vadThreshold}
                    onChange={(e) => settings.update({ vadThreshold: Number(e.target.value) })}
                    className="w-full accent-primary"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {copy('越高越不容易被键盘/环境噪音误触发；越低对轻声越敏感。', 'Higher values resist keyboard and ambient noise; lower values detect quieter speech.')}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="vad-silence">{copy('静音结束帧数', 'Silence end frames')}</Label>
                    <span className="font-mono text-xs text-muted-foreground">
                      {settings.vadSilenceEndFrames}
                    </span>
                  </div>
                  <input
                    id="vad-silence"
                    type="range"
                    min={3}
                    max={30}
                    step={1}
                    value={settings.vadSilenceEndFrames}
                    onChange={(e) =>
                      settings.update({ vadSilenceEndFrames: Number(e.target.value) })
                    }
                    className="w-full accent-primary"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {copy('你停嘴后多少帧结束当前语音；数值小回话更快，数值大避免把说话停顿切断。', 'How many frames of silence end the utterance; lower is faster, higher avoids cutting off pauses.')}
                  </p>
                </div>

                {/* 语音复刻（声音定制） */}
                <div className="settings-subpanel settings-voice-clone">
                  <div className="text-sm font-semibold">{copy('语音复刻（声音定制）', 'Voice cloning')}</div>
                  <p className="text-[11px] text-muted-foreground">
                    {copy('上传 10–20 秒的 WAV 音频文件，即可生成与你声音相似的定制音色。', 'Upload a 10–20 second WAV file to create a custom voice similar to yours.')}
                  </p>
                  <div className="flex items-center gap-3">
                    <input
                      ref={cloneFileRef}
                      type="file"
                      accept=".wav"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void handleCloneUpload(file)
                        e.target.value = ''
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => cloneFileRef.current?.click()}
                      disabled={cloneStatus === 'uploading' || cloneStatus === 'cloning'}
                    >
                      {cloneStatus === 'uploading' ? (
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Upload className="mr-2 h-3.5 w-3.5" />
                      )}
                      {copy('选择 WAV 文件', 'Choose WAV file')}
                    </Button>
                    {cloneStatus === 'cloning' && (
                      <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {cloneProgress}
                      </span>
                    )}
                    {cloneStatus === 'ok' && (
                      <Badge variant="success">{copy('复刻完成', 'Voice ready')}</Badge>
                    )}
                    {cloneStatus === 'error' && (
                      <span className="text-xs text-destructive">{cloneError}</span>
                    )}
                  </div>
                  {cloneStatus === 'ok' && cloneVoiceId && (
                    <div className="text-[11px] text-muted-foreground">
                      {copy('当前音色 ID：', 'Current voice ID:')}<code className="rounded bg-muted px-1.5 py-0.5 font-mono">{cloneVoiceId}</code>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="settings-subsection">
        <div className="settings-subsection-heading flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/12 text-amber-500">
              <Bell className="h-4 w-4" />
            </div>
            <div>
              <div className="text-sm font-semibold">{copy('播报与提示音', 'Broadcasts and sounds')}</div>
              <p className="text-[11px] text-muted-foreground">
                {copy('任务完成、询问权限、向人提问时发出声音提醒。默认关闭。', 'Play a sound when tasks finish or the AI needs your attention. Off by default.')}
              </p>
            </div>
          </div>
          <Switch
            checked={settings.voiceBroadcastEnabled}
            onCheckedChange={(v) => settings.update({ voiceBroadcastEnabled: v })}
          />
        </div>

        {settings.voiceBroadcastEnabled && (
          <div className="settings-subpanel">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="broadcast-mode">{copy('提醒方式', 'Notification style')}</Label>
                <GlassSelect
                  id="broadcast-mode"
                  value={settings.voiceBroadcastMode}
                  onChange={(value) => settings.update({ voiceBroadcastMode: value as 'tts' | 'chime' })}
                  options={[
                    { value: 'chime', label: copy('咚咚提示音', 'Chime') },
                    { value: 'tts', label: copy('TTS 语音播报', 'TTS voice') },
                  ]}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="broadcast-chime">{copy('提示音', 'Chime')}</Label>
                <GlassSelect
                  id="broadcast-chime"
                  value={settings.voiceBroadcastChime}
                  onChange={(value) => settings.update({ voiceBroadcastChime: value as 'dingdong' | 'soft' })}
                  options={[
                    { value: 'dingdong', label: copy('咚咚，像手机铃声', 'Ding-dong') },
                    { value: 'soft', label: copy('轻提示', 'Soft') },
                  ]}
                />
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void playVoiceNotification('ask', settings)}
            >
              <Play className="mr-2 h-3.5 w-3.5" />
              {copy('试听提醒', 'Preview notification')}
            </Button>
          </div>
        )}
      </section>

      <section className="settings-subsection">
        <div className="settings-subsection-heading flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/12 text-primary">
              <Volume2 className="h-4 w-4" />
            </div>
            <div>
              <div className="text-sm font-semibold">{copy('TTS 引擎', 'TTS engine')}</div>
              <p className="text-[11px] text-muted-foreground">{copy('用于试听和语音播报。', 'Used for previews and voice playback.')}</p>
            </div>
          </div>
          <Switch checked={settings.ttsEnabled} onCheckedChange={(v) => settings.update({ ttsEnabled: v })} />
        </div>

        {settings.ttsEnabled && (
          <div className="settings-subpanel">
            <div className="space-y-1.5">
              <Label htmlFor="tts-provider">Provider</Label>
              <GlassSelect
                id="tts-provider"
                value={settings.ttsProvider}
                onChange={(value) => settings.update({ ttsProvider: value as AppSettings['ttsProvider'] })}
                options={[
                  { value: 'cosyvoice', label: `CosyVoice ${copy('（百炼 API）', '(Bailian API)')}` },
                  { value: 'gpt_sovits', label: `GPT-SoVITS ${copy('（本地）', '(local)')}` },
                  { value: 'elevenlabs', label: 'ElevenLabs (API)' },
                ]}
              />
              <p className="text-[11px] text-muted-foreground">
                {copy('CosyVoice 需要在上方配置 DashScope API Key。', 'CosyVoice requires a DashScope API key above.')}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="voice-mode">{copy('语音场景模式', 'Voice scene')}</Label>
              <GlassSelect
                id="voice-mode"
                value={settings.voiceMode}
                onChange={(value) => settings.update({ voiceMode: value as 'companion' | 'assistant' | 'balanced' })}
                options={[
                  { value: 'balanced', label: copy('均衡模式（推荐）', 'Balanced (recommended)') },
                  { value: 'companion', label: copy('陪伴模式（温暖耐心）', 'Companion (warm and patient)') },
                  { value: 'assistant', label: copy('助手模式（简洁高效）', 'Assistant (concise and efficient)') },
                ]}
              />
              <p className="text-[11px] text-muted-foreground">
                {settings.voiceMode === 'companion' && copy('更长静音等待、温暖语气、较慢语速', 'Longer silence wait, warm tone, slower speech')}
                {settings.voiceMode === 'assistant' && copy('快速响应、简洁回答、较快语速', 'Fast responses, concise answers, quicker speech')}
                {settings.voiceMode === 'balanced' && copy('自然均衡的对话体验', 'A natural, balanced conversation')}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tts-voice">Voice</Label>
              <GlassSelect
                id="tts-voice"
                value={settings.ttsVoice}
                onChange={(value) => settings.update({ ttsVoice: value })}
                disabled={voicesLoading}
                ariaLabel="Voice"
                options={voicesLoading
                  ? [{ value: settings.ttsVoice, label: copy('加载中...', 'Loading...') }]
                  : (filteredVoices.length > 0 ? filteredVoices : [settings.ttsVoice]).map((v) => ({ value: v, label: v }))}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="tts-speed">{copy('语速', 'Speech rate')}</Label>
                <span className="font-mono text-xs text-muted-foreground">{settings.ttsSpeed.toFixed(2)}x</span>
              </div>
              <input
                id="tts-speed"
                type="range"
                min={0.5}
                max={2.0}
                step={0.05}
                value={settings.ttsSpeed}
                onChange={(e) => settings.update({ ttsSpeed: Number(e.target.value) })}
                className="w-full accent-primary"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="tts-preview">{copy('试听文本', 'Preview text')}</Label>
              <input
                id="tts-preview"
                value={previewText}
                onChange={(e) => setPreviewText(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              />
              <Button
                size="sm"
                variant={previewing ? 'destructive' : 'default'}
                onClick={handlePreview}
                className={cn(previewing && 'bg-red-500 text-white hover:bg-red-600')}
              >
                {previewing ? <Square className="mr-2 h-3.5 w-3.5" /> : <Play className="mr-2 h-3.5 w-3.5" />}
                {previewing ? copy('停止', 'Stop') : copy('试听', 'Preview')}
              </Button>
            </div>
          </div>
        )}
      </section>
      </div>
    </section>
  )
}
