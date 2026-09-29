/**
 * HakusAIClient WebSocket 重连逻辑测试 — Phase 4
 *
 * 测试策略:
 *   - Mock global.WebSocket (含静态常量 OPEN/CONNECTING/CLOSING/CLOSED)
 *   - 验证 wsConnect 后, ws.onclose 触发时, 会调度重连
 *   - 验证服务端 ping 消息会触发客户端回 pong
 *   - 验证重连成功后会发 resume_session
 *   - 验证 wsDisconnect 不触发重连
 *   - 验证达到最大重连次数后放弃 (模拟重连失败: 不触发 onopen, 直接触发 onclose)
 *
 * 运行:
 *   cd frontend/client && npx vitest run src/api/client.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HakusAIClient, toRuntimeSkillMentions } from './client'

// ============================================================================
// Mock WebSocket — 收集实例, 模拟 readyState / send / close
// 关键: 必须有静态常量 OPEN/CONNECTING/CLOSING/CLOSED, 因为 client.ts 用
// WebSocket.OPEN 做状态比较。
// ============================================================================

const WS_OPEN = 1
const WS_CONNECTING = 0
const WS_CLOSING = 2
const WS_CLOSED = 3

class MockWebSocket {
  static instances: MockWebSocket[] = []
  // 控制新实例是否自动 open 成功; 默认 true。设为 false 后, 新实例会自动
  // 触发 onerror + onclose (模拟连接被拒绝), 用来测试重连放弃逻辑。
  static autoOpen: boolean = true

  static readonly CONNECTING = WS_CONNECTING
  static readonly OPEN = WS_OPEN
  static readonly CLOSING = WS_CLOSING
  static readonly CLOSED = WS_CLOSED

  readyState: number = WS_CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null

  sentMessages: string[] = []
  closed: boolean = false
  closeCode: number | null = null

  readonly url: string

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
    const autoOpen = MockWebSocket.autoOpen
    // 异步触发 onopen 或 onerror+onclose — 模拟真实 WebSocket 的连接过程
    setTimeout(() => {
      if (this.readyState === WS_CONNECTING && !this.closed) {
        if (autoOpen) {
          this.readyState = WS_OPEN
          this.onopen?.(new Event('open'))
        } else {
          // 模拟连接失败: 先 onerror, 然后关掉
          this.onerror?.(new Event('error'))
          this.readyState = WS_CLOSED
          this.onclose?.(new CloseEvent('close', { code: 1006, reason: 'connection refused' }))
        }
      }
    }, 0)
  }

  send(data: string): void {
    if (this.readyState !== WS_OPEN) {
      throw new Error('WebSocket is not in OPEN state')
    }
    this.sentMessages.push(data)
  }

  close(code: number = 1000, reason: string = ''): void {
    if (this.closed) return
    this.closed = true
    this.readyState = WS_CLOSED
    this.closeCode = code
    this.onclose?.(new CloseEvent('close', { code, reason }))
  }

  /** 模拟服务端发消息到客户端 */
  simulateMessage(data: any): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }

  /** 模拟服务端关闭连接 */
  simulateClose(code: number = 1001, reason: string = 'stale'): void {
    this.close(code, reason)
  }
}

describe('HakusAIClient WebSocket reconnect (Phase 4)', () => {
  let originalWebSocket: typeof WebSocket
  let client: HakusAIClient

  beforeEach(() => {
    originalWebSocket = global.WebSocket
    MockWebSocket.instances = []
    MockWebSocket.autoOpen = true
    ;(global as any).WebSocket = MockWebSocket
    client = new HakusAIClient('http://localhost:8080')
    // 用假 timer, 避免测试真的等几秒
    vi.useFakeTimers()
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps an active remote Runtime when the local server URL changes', () => {
    client.setRemoteRuntime('http://127.0.0.1:41001', 'remote-token')
    client.setBaseUrl('http://127.0.0.1:48081')

    expect(client.terminalWsUrl()).toBe('ws://127.0.0.1:41001/ws/terminal')

    client.useLocalRuntime()
    expect(client.terminalWsUrl()).toBe('ws://127.0.0.1:48081/ws/terminal')
  })

  it('wsConnect creates a WebSocket to /ws/chat', async () => {
    const onMessage = vi.fn()
    client.wsConnect(onMessage)
    await vi.advanceTimersByTimeAsync(10)  // 触发 onopen

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0].url).toBe('ws://localhost:8080/ws/chat')
    expect(client.wsConnected).toBe(true)
  })

  it('responds to server ping with pong', async () => {
    const onMessage = vi.fn()
    client.wsConnect(onMessage)
    await vi.advanceTimersByTimeAsync(10)

    const ws = MockWebSocket.instances[0]
    // 模拟服务端发 ping
    ws.simulateMessage({ type: 'ping', ts: 1234567890 })

    // 应该回 pong
    expect(ws.sentMessages).toHaveLength(1)
    const pong = JSON.parse(ws.sentMessages[0])
    expect(pong.type).toBe('pong')

    // onMessage 也应该收到 ping (调用方可记录 RTT)
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ping', ts: 1234567890 })
    )
  })

  it('schedules reconnect with exponential backoff on close', async () => {
    const onMessage = vi.fn()
    const onClose = vi.fn()
    client.wsConnect(onMessage, undefined, onClose)

    await vi.advanceTimersByTimeAsync(10)
    expect(client.wsConnected).toBe(true)

    // 模拟连接断开
    const ws1 = MockWebSocket.instances[0]
    ws1.simulateClose(1001, 'stale')

    expect(onClose).toHaveBeenCalled()
    expect(client.wsConnected).toBe(false)
    expect(client.wsReconnectAttempts).toBe(1)

    // 还没重连 (1s 延迟)
    expect(MockWebSocket.instances).toHaveLength(1)

    // 推进 1s, 应该触发第一次重连
    await vi.advanceTimersByTimeAsync(1000)
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('does not reconnect after manual wsDisconnect', async () => {
    const onMessage = vi.fn()
    client.wsConnect(onMessage)
    await vi.advanceTimersByTimeAsync(10)
    expect(client.wsConnected).toBe(true)

    // 手动断开
    client.wsDisconnect()

    // 推进 10s, 不应该有重连
    await vi.advanceTimersByTimeAsync(10000)
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(client.wsReconnectAttempts).toBe(0)
  })

  it('sends resume_session after reconnect if active session was set', async () => {
    const onMessage = vi.fn()
    const onReconnect = vi.fn()
    client.wsConnect(onMessage, undefined, undefined, onReconnect)
    await vi.advanceTimersByTimeAsync(10)

    // 设当前 session, 然后发个消息 (也会更新 active session)
    client.wsSetActiveSession('sess-123')

    // 模拟断开
    const ws1 = MockWebSocket.instances[0]
    ws1.simulateClose(1001, 'stale')

    // 推进时间触发重连
    await vi.advanceTimersByTimeAsync(1000)
    expect(MockWebSocket.instances).toHaveLength(2)

    // 等 onopen 触发
    await vi.advanceTimersByTimeAsync(10)

    // 重连后应该发 resume_session
    const ws2 = MockWebSocket.instances[1]
    const resumeMsg = ws2.sentMessages.find((m) => {
      try {
        const parsed = JSON.parse(m)
        return parsed.type === 'resume_session'
      } catch {
        return false
      }
    })
    expect(resumeMsg).toBeDefined()
    const parsed = JSON.parse(resumeMsg!)
    expect(parsed.session_id).toBe('sess-123')

    // onReconnect 应该被调
    expect(onReconnect).toHaveBeenCalled()
  })

  it('gives up after max reconnect attempts when connection keeps failing', async () => {
    // 模拟重连全部失败: 第一个连接成功, 之后所有重连都失败 (autoOpen=false)
    const onMessage = vi.fn()
    client.wsConnect(onMessage)
    await vi.advanceTimersByTimeAsync(10)  // 首次连接成功
    expect(client.wsConnected).toBe(true)

    // 切换到失败模式 — 之后所有重连尝试都会 auto-fail
    MockWebSocket.autoOpen = false

    // 模拟连接断开
    MockWebSocket.instances[0].simulateClose(1001, 'stale')
    expect(client.wsReconnectAttempts).toBe(1)

    // 默认 max=10, 每次延迟 1s, 2s, 4s... 30s (封顶)
    // 推进足够长的时间 (30s * 15 = 450s 足以跑完 10 次)
    // 每次重连: setTimeout(0) 触发 onerror+onclose → _scheduleReconnect → setTimeout(delay)
    // 我们推进 600s, 应该跑完所有 10 次重连然后放弃
    await vi.advanceTimersByTimeAsync(600000)

    // 重连次数不应该超过 max (10)
    // 第一个 ws 是初始连接, 之后最多 10 个重连 = 11 个实例
    expect(MockWebSocket.instances.length).toBeLessThanOrEqual(11)
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2)  // 至少有 1 次重连
  })

  it('tracks active session when sending message', async () => {
    const onMessage = vi.fn()
    client.wsConnect(onMessage)
    await vi.advanceTimersByTimeAsync(10)

    // 发个消息带 session_id
    client.wsSend({
      type: 'message',
      content: 'hello',
      session_id: 'track-test',
    } as any)

    // wsSetActiveSession 应该能读到这个值 (通过 wsSend 隐式设置)
    // 我们没法直接读 private field, 但通过断开 + 重连验证
    const ws1 = MockWebSocket.instances[0]
    ws1.simulateClose(1001, 'stale')

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(10)

    const ws2 = MockWebSocket.instances[1]
    const resumeMsg = ws2.sentMessages.find((m) => {
      try {
        return JSON.parse(m).type === 'resume_session'
      } catch {
        return false
      }
    })
    expect(resumeMsg).toBeDefined()
    expect(JSON.parse(resumeMsg!).session_id).toBe('track-test')
  })

  it('wsInterrupt records session_id and sends interrupt message', async () => {
    const onMessage = vi.fn()
    client.wsConnect(onMessage)
    await vi.advanceTimersByTimeAsync(10)

    client.wsInterrupt('interrupt-test-session')

    const ws = MockWebSocket.instances[0]
    const interruptMsg = ws.sentMessages.find((m) => {
      try {
        return JSON.parse(m).type === 'interrupt'
      } catch {
        return false
      }
    })
    expect(interruptMsg).toBeDefined()
    const parsed = JSON.parse(interruptMsg!)
    expect(parsed.session_id).toBe('interrupt-test-session')
  })

  it('wsReconnectAttempts is 0 on fresh connect', async () => {
    client.wsConnect(vi.fn())
    await vi.advanceTimersByTimeAsync(10)
    expect(client.wsReconnectAttempts).toBe(0)
  })

  it('wsConnect stores callbacks for reconnect', async () => {
    const onMessage = vi.fn()
    const onClose = vi.fn()
    client.wsConnect(onMessage, undefined, onClose)
    await vi.advanceTimersByTimeAsync(10)

    // 断开后重连, onMessage 应该仍然被调用 (来自新 ws 的消息)
    MockWebSocket.instances[0].simulateClose(1001, 'stale')
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(10)

    const ws2 = MockWebSocket.instances[1]
    ws2.simulateMessage({ type: 'text_delta', content: 'hi' })
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text_delta', content: 'hi' })
    )
  })
})

describe('HakusAIClient getMetrics (Phase 5)', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('returns parsed MetricsResponse on success', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        uptime_seconds: 123.45,
        total_turns: 10,
        total_errors: 1,
        active_websockets: 2,
        checkpoints_saved: 5,
        llm_calls: 20,
        llm_retries: 2,
        by_provider: {
          deepseek: { turns: 10, errors: 1, llm_calls: 20 },
        },
      }),
    }
    const mockFetch = vi.fn().mockResolvedValue(mockResponse)
    ;(global as any).fetch = mockFetch

    // 也要 mock AbortSignal.timeout
    const originalAbortSignal = global.AbortSignal
    if (!AbortSignal.timeout) {
      ;(global as any).AbortSignal = {
        ...AbortSignal,
        timeout: () => ({ aborted: false, addEventListener: () => {} }),
      }
    }

    const client = new HakusAIClient('http://localhost:8080')
    const metrics = await client.getMetrics()

    expect(metrics).not.toBeNull()
    expect(metrics!.total_turns).toBe(10)
    expect(metrics!.total_errors).toBe(1)
    expect(metrics!.active_websockets).toBe(2)
    expect(metrics!.checkpoints_saved).toBe(5)
    expect(metrics!.by_provider?.deepseek.turns).toBe(10)
  })

  it('returns null on fetch failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'))
    ;(global as any).fetch = mockFetch

    const client = new HakusAIClient('http://localhost:8080')
    const metrics = await client.getMetrics()

    expect(metrics).toBeNull()
  })

  it('returns null on non-200 response', async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal' }),
    }
    const mockFetch = vi.fn().mockResolvedValue(mockResponse)
    ;(global as any).fetch = mockFetch

    const client = new HakusAIClient('http://localhost:8080')
    const metrics = await client.getMetrics()

    expect(metrics).toBeNull()
  })
})

describe('HakusAIClient Skills', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('lists Skills for the selected project', async () => {
    const payload = {
      directory: 'C:/Users/test/.hakus/skills',
      directories: [],
      warnings: [],
      skills: [],
    }
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    })
    ;(global as any).fetch = mockFetch

    const client = new HakusAIClient('http://localhost:8080')
    await expect(client.listSkills('project one')).resolves.toEqual(payload)
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/api/skills?project_id=project%20one',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('converts only explicit Skill mentions for the embedded Runtime', () => {
    expect(toRuntimeSkillMentions('Use @skill:review-code and @skill:test_2.')).toBe(
      'Use $review-code and $test_2.',
    )
    expect(toRuntimeSkillMentions('mail@example.com x@skill:no @@skill:no')).toBe(
      'mail@example.com x@skill:no @@skill:no',
    )
  })
})
