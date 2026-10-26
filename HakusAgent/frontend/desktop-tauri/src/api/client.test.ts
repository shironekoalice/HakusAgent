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

  it('keeps the Rust browser preview on the embedded Runtime port', () => {
    const previousWindow = (globalThis as any).window
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'http://127.0.0.1:1420', search: '?backend=rust' } },
    })

    try {
      const previewClient = new HakusAIClient('http://127.0.0.1:48082')
      previewClient.setBaseUrl('http://127.0.0.1:48081')
      expect(previewClient.getBaseUrl()).toBe('http://127.0.0.1:1420')
    } finally {
      if (previousWindow === undefined) {
        delete (globalThis as any).window
      } else {
        Object.defineProperty(globalThis, 'window', {
          configurable: true,
          value: previousWindow,
        })
      }
    }
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

describe('HakusAIClient Extensions (plugin inventory)', () => {
  let originalFetch: typeof fetch
  let originalTauriInternals: unknown

  beforeEach(() => {
    originalFetch = global.fetch
    originalTauriInternals = (globalThis as any).__TAURI_INTERNALS__
    ;(globalThis as any).__TAURI_INTERNALS__ = {}
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalTauriInternals === undefined) {
      delete (globalThis as any).__TAURI_INTERNALS__
    } else {
      ;(globalThis as any).__TAURI_INTERNALS__ = originalTauriInternals
    }
    vi.restoreAllMocks()
  })

  it('lists the redacted plugin inventory from the Runtime API', async () => {
    const payload = {
      plugins: [
        {
          id: 'demo',
          name: 'demo',
          version: '1.0.0',
          scope: 'user',
          origin: 'hakus-home',
          enabled: true,
          trust_status: 'trusted',
          applicable: true,
          staged: true,
          capabilities: { filesystem_roots: [], network_hosts: ['api.example.com'], lifecycle_mutation: false },
          content_hash: 'a'.repeat(64),
          capability_hash: 'b'.repeat(64),
          state_generation: 3,
          skill_count: 1,
          diagnostics: [],
        },
      ],
    }
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    })
    ;(global as any).fetch = mockFetch

    const client = new HakusAIClient('http://localhost:8080')
    const response = await client.listRuntimePlugins()

    expect(response.plugins).toHaveLength(1)
    expect(response.plugins[0].trust_status).toBe('trusted')
    expect(response.plugins[0]).not.toHaveProperty('base_path')
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/v1/plugins',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('posts the enabled flag to the enable/disable verb', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'demo',
        name: 'demo',
        enabled: false,
        trust_status: 'trusted',
        state_generation: 4,
      }),
      text: async () => JSON.stringify({
        id: 'demo',
        name: 'demo',
        enabled: false,
        trust_status: 'trusted',
        state_generation: 4,
      }),
    })
    ;(global as any).fetch = mockFetch

    const client = new HakusAIClient('http://localhost:8080')
    const receipt = await client.setPluginEnabled('demo plugin', false)

    expect(receipt.enabled).toBe(false)
    expect(receipt.state_generation).toBe(4)
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/v1/plugins/demo%20plugin/disable',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ enabled: false }),
      }),
    )
  })

  it('uses Runtime-owned plugin lifecycle routes and keeps review hashes', async () => {
    const payload = {
      name: 'demo',
      outcome: 'installed',
      content_hash: 'a'.repeat(64),
      installed_content_hash: 'b'.repeat(64),
    }
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    })
    ;(global as any).fetch = mockFetch

    const client = new HakusAIClient('http://localhost:8080')
    const receipt = await client.installRuntimePlugin('path:C:/reviewed/demo', 'a'.repeat(64))

    expect(receipt.outcome).toBe('installed')
    expect(receipt.installed_content_hash).toBe('b'.repeat(64))
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/v1/plugins/install',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ source: 'path:C:/reviewed/demo', expected_content_hash: 'a'.repeat(64) }),
      }),
    )

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ name: 'demo', outcome: 'uninstalled' }),
      text: async () => JSON.stringify({ name: 'demo', outcome: 'uninstalled' }),
    })
    await client.uninstallRuntimePlugin('demo')
    expect(mockFetch).toHaveBeenLastCalledWith(
      'http://localhost:8080/v1/plugins/demo',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

describe('HakusAIClient canonical Runtime projection', () => {
  let originalFetch: typeof fetch
  let originalTauriInternals: unknown

  beforeEach(() => {
    originalFetch = global.fetch
    originalTauriInternals = (globalThis as any).__TAURI_INTERNALS__
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalTauriInternals === undefined) {
      delete (globalThis as any).__TAURI_INTERNALS__
    } else {
      ;(globalThis as any).__TAURI_INTERNALS__ = originalTauriInternals
    }
    vi.restoreAllMocks()
  })

  it('replays messages and tool calls from the canonical ledger before detail fallback', async () => {
    ;(globalThis as any).__TAURI_INTERNALS__ = {}
    const threadId = 'thr-ledger'
    const userItem = {
      id: 'item-user',
      turn_id: 'turn-1',
      kind: 'user_message',
      status: 'completed',
      detail: 'inspect the project',
      started_at: '2026-10-03T00:00:00Z',
      ended_at: '2026-10-03T00:00:00Z',
    }
    const assistantItem = {
      id: 'item-assistant',
      turn_id: 'turn-1',
      kind: 'agent_message',
      status: 'completed',
      detail: 'done',
      started_at: '2026-10-03T00:00:01Z',
      ended_at: '2026-10-03T00:00:02Z',
    }
    const ledger = {
      session_id: threadId,
      after_seq: 0,
      events: [
        { event_id: 'e1', session_id: threadId, seq: 1, event_type: 'thread.started', actor: {}, visibility: 'model_and_ui', payload: { thread: {} }, timestamp: '2026-10-03T00:00:00Z' },
        { event_id: 'e2', session_id: threadId, seq: 2, event_type: 'turn.started', turn_id: 'turn-1', actor: {}, visibility: 'model_and_ui', payload: { turn: { id: 'turn-1' } }, timestamp: '2026-10-03T00:00:00Z' },
        { event_id: 'e3', session_id: threadId, seq: 3, event_type: 'item.started', turn_id: 'turn-1', actor: {}, visibility: 'model_and_ui', payload: { item: userItem }, timestamp: '2026-10-03T00:00:00Z' },
        { event_id: 'e4', session_id: threadId, seq: 4, event_type: 'item.completed', turn_id: 'turn-1', actor: {}, visibility: 'model_and_ui', payload: { item: userItem }, timestamp: '2026-10-03T00:00:00Z' },
        { event_id: 'e5', session_id: threadId, seq: 5, event_type: 'item.started', turn_id: 'turn-1', actor: {}, visibility: 'model_and_ui', payload: { item: { ...assistantItem, status: 'in_progress', detail: '' } }, timestamp: '2026-10-03T00:00:01Z' },
        { event_id: 'e6', session_id: threadId, seq: 6, event_type: 'item.delta', turn_id: 'turn-1', actor: {}, visibility: 'model_and_ui', payload: { delta: 'done', kind: 'agent_message' }, timestamp: '2026-10-03T00:00:02Z' },
        { event_id: 'e7', session_id: threadId, seq: 7, event_type: 'item.completed', turn_id: 'turn-1', actor: {}, visibility: 'model_and_ui', payload: { item: assistantItem }, timestamp: '2026-10-03T00:00:02Z' },
      ],
      verification: { session_id: threadId, event_count: 7, last_seq: 7, contiguous: true },
    }
    const mockFetch = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ledger?limit=5000')) return Promise.resolve(new Response(JSON.stringify(ledger), { status: 200 }))
      return Promise.resolve(new Response(JSON.stringify({
        thread: { id: threadId, title: 'Ledger thread', model: 'test-model', created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:02Z' },
        items: [],
      }), { status: 200 }))
    })
    ;(global as any).fetch = mockFetch

    const client = new HakusAIClient('http://127.0.0.1:48081')
    const session = await client.getSession(threadId)

    expect(session.messages).toHaveLength(2)
    expect(session.messages[0]).toMatchObject({ id: 'item-user', role: 'user', content: 'inspect the project' })
    expect(session.messages[1]).toMatchObject({ id: 'item-assistant', role: 'assistant', content: 'done' })
    expect(mockFetch.mock.calls.map(([input]) => String(input))).toEqual([
      `http://127.0.0.1:48081/v1/threads/${threadId}`,
      `http://127.0.0.1:48081/v1/threads/${threadId}/ledger?limit=5000`,
    ])
  })

  // The execution-plan card had no producer on the Runtime path: only the legacy
  // server emitted `task_progress`, while the Runtime publishes `task.progress`.
  // Without this translation the card stays empty for every Runtime session.
  it('maps a canonical task.progress event onto the execution-plan frame', async () => {
    ;(globalThis as any).__TAURI_INTERNALS__ = {}
    const threadId = 'thr-progress'
    const ledger = {
      session_id: threadId,
      after_seq: 0,
      events: [
        { event_id: 'p1', session_id: threadId, seq: 1, event_type: 'thread.started', actor: {}, visibility: 'model_and_ui', payload: { thread: {} }, timestamp: '2026-10-03T00:00:00Z' },
        {
          event_id: 'p2',
          session_id: threadId,
          seq: 2,
          event_type: 'task.progress',
          turn_id: 'turn-1',
          actor: {},
          visibility: 'model_and_ui',
          payload: {
            completed: 2,
            total: 4,
            current_task: 'wire the projection',
            completion_pct: 50,
            items: [
              { id: 1, content: 'read the contracts', status: 'completed' },
              { id: 2, content: 'map the frame', status: 'completed' },
              { id: 3, content: 'wire the projection', status: 'in_progress' },
              { id: 4, content: 'verify in the desktop', status: 'pending' },
            ],
          },
          timestamp: '2026-10-03T00:00:01Z',
        },
      ],
      verification: { session_id: threadId, event_count: 2, last_seq: 2, contiguous: true },
    }
    const mockFetch = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ledger?limit=5000')) return Promise.resolve(new Response(JSON.stringify(ledger), { status: 200 }))
      return Promise.resolve(new Response(JSON.stringify({
        thread: { id: threadId, title: 'Progress thread', model: 'test-model', created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:02Z' },
        items: [],
      }), { status: 200 }))
    })
    ;(global as any).fetch = mockFetch

    const client = new HakusAIClient('http://127.0.0.1:48081')
    // The translator is private; drive it through the same seam the stream uses.
    const mapped = (client as any).runtimeEventToAgentEvent('task.progress', ledger.events[1].payload)

    expect(mapped).not.toBeNull()
    expect(mapped.event_type).toBe('task_progress')
    expect(mapped.completed).toBe(2)
    expect(mapped.total).toBe(4)
    expect(mapped.current_task).toBe('wire the projection')
    // A client reading the legacy frame keys unconditionally must not get
    // `undefined`.
    expect(mapped.phase).toBe('')
    expect(mapped.detail).toBe('')
    // Per-row status survives, so the card does not have to guess completion
    // from a prefix count.
    expect(mapped.items).toHaveLength(4)
    expect(mapped.items[2]).toMatchObject({ content: 'wire the projection', status: 'in_progress' })
    expect(mapped.items[3]).toMatchObject({ status: 'pending' })
  })

  it('maps a Fleet SSH approval request to the secure-input event', () => {
    const client = new HakusAIClient('http://127.0.0.1:48081')
    const mapped = (client as any).runtimeEventToAgentEvent('approval_requested', {
      approval_id: 'ssh-password:run-1:worker-1',
      reason: 'ssh_password_required',
      run_id: 'run-1',
      worker_id: 'worker-1',
    })

    expect(mapped).toEqual({
      event_type: 'ssh_password_required',
      approval: {
        approvalId: 'ssh-password:run-1:worker-1',
        runId: 'run-1',
        workerId: 'worker-1',
      },
    })
  })

  it('posts the SSH password only to the Runtime provisioning endpoint', async () => {
    ;(globalThis as any).__TAURI_INTERNALS__ = {}
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ execution: 'resumed' }), { status: 200 }),
    )
    ;(global as any).fetch = mockFetch
    const client = new HakusAIClient('http://127.0.0.1:48081')

    await expect(client.provisionRuntimeFleetSshPassword('run-1', 'worker-1', 'secret')).resolves.toEqual({
      execution: 'resumed',
    })
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:48081/v1/fleet/runs/run-1/workers/worker-1/ssh-password',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ password: 'secret' }),
      }),
    )
  })

  it('consumes Fleet SSE approvals and stops at a terminal run status', async () => {
    ;(globalThis as any).__TAURI_INTERNALS__ = {}
    const mockFetch = vi.fn().mockResolvedValue(new Response([
      'event: approval_requested',
      'data: {"event":"approval_requested","payload":{"approval_id":"a1","reason":"ssh_password_required","run_id":"run-1","worker_id":"worker-1"}}',
      '',
      'event: fleet.run.status_changed',
      'data: {"event":"fleet.run.status_changed","payload":{"status":"completed"}}',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    ;(global as any).fetch = mockFetch
    const client = new HakusAIClient('http://127.0.0.1:48081')
    const received: any[] = []

    await client.streamRuntimeFleetEvents('run-1', (event, envelope) => received.push({ event, envelope }))

    expect(received).toHaveLength(2)
    expect(received[0].event.event_type).toBe('ssh_password_required')
    expect(received[0].envelope.payload.worker_id).toBe('worker-1')
    expect(received[1].event).toBeNull()
    expect(received[1].envelope.payload.status).toBe('completed')
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:48081/v1/fleet/runs/run-1/events',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
  })
})
