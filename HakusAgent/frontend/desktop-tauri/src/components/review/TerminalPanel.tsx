import { useEffect, useRef, useState } from 'react'
import { TerminalSquare, Trash2, Loader2 } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { apiClient } from '@/api/client'
import { useProjectsStore } from '@/store/projects'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'

import '@xterm/xterm/css/xterm.css'

/**
 * Full PTY terminal — connects to the backend's /ws/terminal WebSocket,
 * which hosts a persistent shell (cmd.exe on Windows, bash elsewhere).
 *
 * Uses xterm.js for rendering, so interactive TUI apps (vim, less, top)
 * render correctly. Input keys are sent to the PTY, and resize events
 * are forwarded so the shell knows the terminal dimensions.
 */
export function TerminalPanel() {
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const workingDirectory = useProjectsStore((s) => s.activeProject?.path ?? null)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef(false)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(true)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: {
        background: '#0a0a0b',
        foreground: '#e4e4e7',
        cursor: '#e4e4e7',
        selectionBackground: '#3f3f46',
        black: '#18181b',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#c7a6f7',
        magenta: '#f1b7e7',
        cyan: '#8edac2',
        white: '#e4e4e7',
        brightBlack: '#52525b',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde047',
        brightBlue: '#d8c4ff',
        brightMagenta: '#f7cce9',
        brightCyan: '#b0f0d9',
        brightWhite: '#fafafa',
      },
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    terminalRef.current = term
    fitAddonRef.current = fitAddon

    term.focus()
    term.onData((data) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stdin', data }))
      }
    })
    term.attachCustomKeyEventHandler((event) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'l') {
        term.clear()
        return false
      }
      return true
    })
    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    })

    const handleResize = () => {
      try {
        fitAddon.fit()
      } catch {
        // ignore
      }
    }
    window.addEventListener('resize', handleResize)
    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(containerRef.current)

    return () => {
      window.removeEventListener('resize', handleResize)
      resizeObserver.disconnect()
      reconnectRef.current = false
      wsRef.current?.close()
      wsRef.current = null
      term.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  useEffect(() => {
    const connect = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return
      const url = apiClient.terminalWsUrl()
      let ws: WebSocket
      try {
        reconnectRef.current = true
        setConnecting(true)
        ws = new WebSocket(url)
      } catch (e: any) {
        terminalRef.current?.writeln(`\x1b[31m${copy('连接失败：', 'Connection failed: ')}${e?.message || e}\x1b[0m`)
        return
      }
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        setConnecting(false)
        reconnectRef.current = true
        // Start in the active local project when one is selected.
        try {
          const { cols, rows } = terminalRef.current ?? { cols: 80, rows: 24 }
          ws.send(JSON.stringify({ type: 'init', cwd: workingDirectory, cols, rows }))
          fitAddonRef.current?.fit()
        } catch {
          // ignore
        }
      }
      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          terminalRef.current?.write(new Uint8Array(e.data))
          return
        }
        if (typeof e.data === 'string') {
          // Fast path: raw terminal output is the common case.
          if (e.data.startsWith('{')) {
            try {
              const msg = JSON.parse(e.data)
              if (msg.type === 'error') {
                setConnecting(false)
                terminalRef.current?.writeln(`\x1b[31m${copy('错误：', 'Error: ')}${msg.message}\x1b[0m`)
                return
              }
              if (msg.type === 'ready') return
              if (msg.type === 'exit') {
                terminalRef.current?.writeln(`\r\n\x1b[90m${copy('终端进程已退出', 'Terminal process exited')}${msg.code == null ? '' : ` (${msg.code})`}\x1b[0m`)
                return
              }
            } catch {
              // fall through to write raw
            }
          }
          terminalRef.current?.write(e.data)
        }
      }
      ws.onerror = () => {
        setConnecting(false)
        terminalRef.current?.writeln(`\x1b[31m${copy('WebSocket 错误', 'WebSocket error')}\x1b[0m`)
      }
      ws.onclose = () => {
        setConnected(false)
        setConnecting(false)
        if (reconnectRef.current) {
          terminalRef.current?.writeln(`\x1b[33m${copy('连接已断开，3s 后重连...', 'Disconnected; reconnecting in 3s...')}\x1b[0m`)
          setTimeout(() => {
            if (reconnectRef.current) connect()
          }, 3000)
        }
      }
    }

    connect()
    return () => {
      reconnectRef.current = false
      wsRef.current?.close()
    }
  }, [workingDirectory])

  const handleClear = () => {
    terminalRef.current?.clear()
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0a0a0b]">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border/50 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs">
          <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="font-medium">{copy('内置终端', 'Built-in terminal')}</span>
          <span
            className={cn(
              'ml-1 inline-flex h-1.5 w-1.5 rounded-full',
              connected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse',
            )}
          />
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          onClick={handleClear}
          title={copy('清空 (Ctrl+L)', 'Clear (Ctrl+L)')}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>

      {/* Terminal */}
      <div className="relative min-h-0 flex-1 overflow-hidden p-2">
        {connecting && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0a0a0b]/80 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            {copy('连接中...', 'Connecting...')}
          </div>
        )}
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  )
}
