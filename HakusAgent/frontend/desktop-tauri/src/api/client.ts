/**
 * HakusAI API Client
 *
 * 与 HakusAI Runtime API 通信。Tauri 桌面端和 Android 使用进程内 Rust Runtime。
 *
 * 支持三种通信模式:
 *   1. REST     — POST /api/chat (非流式)
 *   2. SSE      — POST /api/chat/stream (Server-Sent Events, 推荐)
 *   3. WebSocket — ws://host/ws/chat (全双工, 支持中断)
 *
 * 同时解析两种流式数据格式:
 *   - 兼容流格式: { content, emotion, actions, done }
 *   - AgentEvent 格式 (hakus/protocol): { event_type, ... }
 *     当服务端升级为发送 AgentEvent 时, 本客户端已就绪
 */

import type {
  AgentEvent,
  AgentMode,
  AppConfig,
  ChatRequest,
  ChatResponse,
  CharacterInfo,
  ChatStreamChunk,
  HealthResponse,
  WSIncomingMessage,
  WSOutgoingMessage,
  ProvidersResponse,
  ProviderInfo,
  UpdateProviderBody,
  CreateCustomProviderBody,
  ProviderMutationResponse,
  ProviderMeta,
  ProvidersMetaResponse,
  ConnectionTestResult,
  FetchModelsResult,
  ProviderKeyEntry,
  UpdateCharacterBody,
  ToolsResponse,
  RuntimeConfigSnapshot,
  PermissionInfo,
  PermissionMode,
  ApprovalRecord,
  MemoryDetails,
  DiagnosticsInfo,
  MetricsResponse,
  TtsVoicesResponse,
  ExportConfigResponse,
  BackendVersionInfo,
  ServerSession,
  ServerMessage,
  SessionCreateBody,
  SessionUpdateBody,
  MessageCreateBody,
  MessageUpdateBody,
  BulkImportBody,
  McpServersResponse,
  McpServerInfo,
  McpServerConfig,
  McpGlobalConfig,
  McpStartResult,
  McpTestResult,
  McpServerToolsResponse,
  McpInvokeResult,
  UploadedFile,
  GitStatusResponse,
  GitDiffResponse,
  LogsResponse,
  Project,
  ProjectsListResponse,
  ProjectCreateBody,
  ProjectUpdateBody,
  SessionLogEvent,
  SessionLogStats,
  SkillsResponse,
  SkillMutationReceipt,
  ThreadGoal,
  WeChatStatus,
} from './types'
import { BROWSER_DYNAMIC_TOOL, embeddedBrowserAvailable } from '@/lib/agentBrowser'
import { EXPECTED_BACKEND_API_VERSION_INT } from './types'
import { refreshProjectFolder, syncProjectFolder } from './tauriBridge'

export type StreamHandler = (chunk: ChatStreamChunk, event?: AgentEvent) => void

export function toRuntimeSkillMentions(message: string): string {
  return message.replace(
    /(?<![\w@])@skill:([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g,
    (_match, name: string) => `$${name}`,
  )
}

/**
 * UI agent modes (swift = Work, deep = Code) map onto the Runtime's
 * plan/act/operate vocabulary. swift -> act, deep -> operate.
 */
function runtimeModeFromAgentMode(mode: string): string {
  if (mode === 'deep') return 'operate'
  return 'act'
}

export class HakusAIError extends Error {
  constructor(message: string, public code?: string, public status?: number) {
    super(message)
    this.name = 'HakusAIError'
  }
}

/**
 * True when the Runtime answered 404 for a thread/item it no longer has.
 *
 * A session's `remote_session_id` is a client-side pointer into the Runtime's
 * thread store; it goes stale when the Runtime restarts onto a fresh store or
 * the thread is deleted elsewhere. Callers heal the mapping and retry rather
 * than surfacing "Thread not found" to the user.
 */
export function isRuntimeMissingThreadError(error: unknown): boolean {
  if (!(error instanceof HakusAIError)) return false
  if (error.status !== 404) return false
  return /thread not found|message item not found|message not found/i.test(error.message)
}

/**
 * Error thrown when the running backend is too old to support the endpoint
 * the client just called (HTTP 404 with backend_api_version_int < expected).
 *
 * The user-visible message should tell the user to update the connected
 * Runtime. Tauri packages embed the Rust Runtime in the application process.
 */
export class BackendOutdatedError extends Error {
  public readonly backendVersion: number | null
  public readonly path: string

  constructor(message: string, opts: { backendVersion?: number | null; path?: string } = {}) {
    super(message)
    this.name = 'BackendOutdatedError'
    this.backendVersion = opts.backendVersion ?? null
    this.path = opts.path ?? ''
  }
}

/**
 * Older runtimes exposed API dialects and plan variants as separate provider
 * ids. Keep that response usable while a desktop/mobile shell is upgraded by
 * collapsing those ids into the same vendor row the current Rust catalog uses.
 */
const LEGACY_PROVIDER_CANONICAL_IDS: Record<string, string> = {
  'deepseek-anthropic': 'deepseek',
  'deepseek-cn': 'deepseek',
  'minimax-anthropic': 'minimax',
  'modelstudio-token-plan-anthropic': 'modelstudio-token-plan',
  'modelstudio-coding-plan': 'modelstudio-token-plan',
  'modelstudio-coding-plan-anthropic': 'modelstudio-token-plan',
}

const CANONICAL_PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  minimax: 'MiniMax',
  'modelstudio-token-plan': 'Alibaba Cloud Model Studio',
}

function canonicalProviderId(id: string): string {
  const normalized = id.trim().toLowerCase().replace(/_/g, '-')
  return LEGACY_PROVIDER_CANONICAL_IDS[normalized] || normalized
}

function mergeProviderCatalog(entries: ProviderInfo[], current: string): ProviderInfo[] {
  const groups = new Map<string, ProviderInfo[]>()
  for (const entry of entries) {
    const key = canonicalProviderId(entry.id)
    const group = groups.get(key) || []
    group.push(entry)
    groups.set(key, group)
  }

  const merged: ProviderInfo[] = []
  for (const [id, group] of groups) {
    // Prefer the canonical row when present; otherwise keep the first legacy
    // row as the persistence target and rewrite its visible id below.
    const primary = group.find((entry) => entry.id.trim().toLowerCase() === id) || group[0]
    const hasCanonicalRow = primary.id.trim().toLowerCase() === id
    const credential = group.find((entry) => entry.has_api_key) || primary
    const models = Array.from(new Set(group.flatMap((entry) => entry.models || [])))
    const configuredModels = Array.from(new Set(group.flatMap((entry) => entry.configured_models || [])))
    const variantWire = !hasCanonicalRow ? group.find((entry) => entry.wire)?.wire : undefined
    const inferredWire = !hasCanonicalRow && group.some((entry) => /anthropic/i.test(entry.id)) ? 'anthropic' : undefined
    merged.push({
      ...primary,
      id,
      display_name: CANONICAL_PROVIDER_LABELS[id] || primary.display_name.replace(/\s+·\s+(Anthropic API|Token Plan \/ (?:OpenAI|Anthropic)|Coding Plan \/ (?:OpenAI|Anthropic))$/i, ''),
      has_api_key: credential.has_api_key,
      masked_api_key: credential.masked_api_key || primary.masked_api_key,
      enabled: hasCanonicalRow ? primary.enabled !== false : group.some((entry) => entry.enabled !== false),
      wire: primary.wire || variantWire || inferredWire,
      models,
      configured_models: configuredModels,
      is_default: canonicalProviderId(current) === id,
    })
  }
  return merged
}

export class HakusAIClient {
  private baseUrl: string = 'http://127.0.0.1:48081'
  private localBaseUrl: string = 'http://127.0.0.1:48081'
  private wsBaseUrl: string = 'ws://127.0.0.1:48081'
  private runtimeToken: string | null = null
  private remoteRuntimeActive = false
  private runtimeProjectPaths = new Map<string, string>()
  private ws: WebSocket | null = null
  private timeout: number = 30000

  // ============ Phase 4: WebSocket 自动重连 + ping/pong ============
  //
  // 5h SWE 任务期间, 客户端网络可能短暂抖动 (Wi-Fi 切换 / 系统休眠唤醒 /
  // 笔记本盖子合上)。没有自动重连的话, 用户回来一看 — WebSocket 已断 30 分钟,
  // 任务卡死, 只能手动刷新。Phase 4 加上指数退避重连 + session resume。
  //
  // 重连策略:
  //   - 最多 10 次 (WS_MAX_RECONNECT_ATTEMPTS)
  //   - 第 1 次 1s, 第 2 次 2s, ... 第 5 次 16s, 之后封顶 30s (WS_MAX_RECONNECT_DELAY_MS)
  //   - 用户主动调 wsDisconnect() 时, _wsManualClose = true, 不重连
  //   - 重连成功后, 自动发 resume_session 恢复上次 session
  //
  // ping/pong:
  //   - 服务端每 30s 主动发 {"type":"ping"}, 客户端收到后立刻回 {"type":"pong"}
  //   - 客户端不再主动 ping (服务端有 cleanup_loop 兜底)
  private _wsReconnectAttempts = 0
  private _wsMaxReconnectAttempts = 10
  private _wsBaseReconnectDelayMs = 1000
  private _wsMaxReconnectDelayMs = 30000
  private _wsManualClose = false
  private _wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
  // 当前活跃的 session_id — 重连后用这个发 resume_session
  private _wsActiveSessionId: string | null = null
  // 持有上次的 onMessage/onError/onClose 回调, 重连后重新绑定
  private _wsOnMessage: ((msg: WSIncomingMessage) => void) | null = null
  private _wsOnError: ((e: Event) => void) | null = null
  private _wsOnClose: ((e: CloseEvent) => void) | null = null
  private _wsOnReconnect: ((attempt: number, sessionId: string | null) => void) | null = null

  constructor(baseUrl: string = 'http://127.0.0.1:48081', timeout = 30000) {
    this.setBaseUrl(baseUrl)
    this.timeout = timeout
  }

  /**
   * The Tauri desktop and Android clients embed the Rust Runtime API. A
   * browser preview can opt into the same path with `?backend=rust`.
   */
  get usesEmbeddedRuntime(): boolean {
    const isTauri = typeof __TAURI_INTERNALS__ !== 'undefined'
    const isRustPreview = typeof window !== 'undefined'
      && new URLSearchParams(window.location.search).get('backend')?.toLowerCase() === 'rust'
    return isTauri || isRustPreview
  }

  private get rustPreviewUrl(): string | null {
    if (typeof window === 'undefined') return null
    const params = new URLSearchParams(window.location.search)
    if (params.get('backend')?.toLowerCase() !== 'rust') return null
    const configured = params.get('backendUrl')
    if (configured) return configured.replace(/\/$/, '')
    return 'http://127.0.0.1:48082'
  }

  private async runtimeFetch(path: string, init: RequestInit = {}, timeoutMs = 12000): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.runtimeToken) headers.set('Authorization', `Bearer ${this.runtimeToken}`)
    const request = { ...init, headers }
    if (timeoutMs === 0) return fetch(`${this.baseUrl}/v1${path}`, request)
    return this.fetchWithHardTimeout(`${this.baseUrl}/v1${path}`, request, timeoutMs)
  }

  setRuntimeToken(token: string | null) {
    this.runtimeToken = token?.trim() || null
  }

  setLocalBaseUrl(url: string) {
    this.localBaseUrl = url.replace(/\/$/, '')
  }

  getLocalBaseUrl(): string {
    return this.localBaseUrl
  }

  setRemoteRuntime(url: string, token: string) {
    this.baseUrl = url.replace(/\/$/, '')
    this.wsBaseUrl = this.baseUrl.replace(/^http/, 'ws')
    this.runtimeToken = token.trim() || null
    this.remoteRuntimeActive = true
  }

  useLocalRuntime() {
    this.baseUrl = this.localBaseUrl
    this.wsBaseUrl = this.localBaseUrl.replace(/^http/, 'ws')
    this.runtimeToken = null
    this.remoteRuntimeActive = false
  }

  setRuntimeProjectPath(projectId: string, path: string) {
    if (projectId.trim() && path.trim()) this.runtimeProjectPaths.set(projectId, path)
  }

  private runtimeUnsupported(feature: string): never {
    throw new HakusAIError(`Rust Runtime 暂不支持${feature}，未调用旧版 API。`, 'UNSUPPORTED')
  }

  /**
   * Typed escape hatch for the Rust Runtime surface. Keeping this in one
   * place gives every advanced CLI capability the same timeout, error and
   * auth handling while allowing the UI to evolve without another API shim.
   */
  private async runtimeJson<T = unknown>(
    path: string,
    method: string = 'GET',
    body?: unknown,
    label: string = 'Runtime request failed',
  ): Promise<T> {
    if (!this.usesEmbeddedRuntime) this.runtimeUnsupported('该 Rust Runtime 功能')
    const init: RequestInit = { method, headers: {} }
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const res = await this.runtimeFetch(path, init, 30000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, label)
    if (res.status === 204) return undefined as T
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  /** Sidecar (Python FastAPI) JSON call — /api/* surface. */
  private async sidecarJson<T>(path: string, method: string, body: unknown, label: string): Promise<T> {
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, 30000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}${path}`, label)
    if (res.status === 204) return undefined as T
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  // ============ Rust Runtime / HakusCLI parity surface ============

  getRuntimeInfo<T = unknown>(): Promise<T> { return this.runtimeJson('/runtime/info', 'GET', undefined, 'Get Runtime info failed') }

  listRuntimeAgentRuns<T = unknown>(): Promise<T> { return this.runtimeJson('/agent-runs', 'GET', undefined, 'List agent runs failed') }
  getRuntimeAgentRun<T = unknown>(runId: string): Promise<T> { return this.runtimeJson(`/agent-runs/${encodeURIComponent(runId)}`, 'GET', undefined, 'Get agent run failed') }

  listRuntimeFleetRuns<T = unknown>(): Promise<T> { return this.runtimeJson('/fleet/runs', 'GET', undefined, 'List fleet runs failed') }
  createRuntimeFleetRun<T = unknown>(body: unknown): Promise<T> { return this.runtimeJson('/fleet/runs', 'POST', body, 'Create fleet run failed') }
  getRuntimeFleetRun<T = unknown>(runId: string): Promise<T> { return this.runtimeJson(`/fleet/runs/${encodeURIComponent(runId)}`, 'GET', undefined, 'Get fleet run failed') }
  listRuntimeFleetWorkers<T = unknown>(runId: string): Promise<T> { return this.runtimeJson(`/fleet/runs/${encodeURIComponent(runId)}/workers`, 'GET', undefined, 'List fleet workers failed') }
  startRuntimeFleetRun<T = unknown>(runId: string): Promise<T> { return this.runtimeJson(`/fleet/runs/${encodeURIComponent(runId)}/start`, 'POST', {}, 'Start fleet run failed') }
  stopRuntimeFleetRun<T = unknown>(runId: string): Promise<T> { return this.runtimeJson(`/fleet/runs/${encodeURIComponent(runId)}/stop`, 'POST', {}, 'Stop fleet run failed') }
  listRuntimeFleetReceipts<T = unknown>(runId: string): Promise<T> { return this.runtimeJson(`/fleet/runs/${encodeURIComponent(runId)}/receipts`, 'GET', undefined, 'List fleet receipts failed') }
  getRuntimeFleetReceipt<T = unknown>(runId: string, taskId: string): Promise<T> { return this.runtimeJson(`/fleet/runs/${encodeURIComponent(runId)}/receipts/${encodeURIComponent(taskId)}`, 'GET', undefined, 'Get fleet receipt failed') }
  getRuntimeFleetEvidence<T = unknown>(runId: string, taskId: string): Promise<T> { return this.runtimeJson(`/fleet/runs/${encodeURIComponent(runId)}/receipts/${encodeURIComponent(taskId)}/evidence`, 'GET', undefined, 'Get fleet evidence failed') }
  getRuntimeFleetWorker<T = unknown>(workerId: string): Promise<T> { return this.runtimeJson(`/fleet/workers/${encodeURIComponent(workerId)}`, 'GET', undefined, 'Get fleet worker failed') }
  interruptRuntimeFleetWorker<T = unknown>(workerId: string): Promise<T> { return this.runtimeJson(`/fleet/workers/${encodeURIComponent(workerId)}/interrupt`, 'POST', {}, 'Interrupt fleet worker failed') }
  stopRuntimeFleetWorker<T = unknown>(workerId: string): Promise<T> { return this.runtimeJson(`/fleet/workers/${encodeURIComponent(workerId)}/stop`, 'POST', {}, 'Stop fleet worker failed') }
  restartRuntimeFleetWorker<T = unknown>(workerId: string): Promise<T> { return this.runtimeJson(`/fleet/workers/${encodeURIComponent(workerId)}/restart`, 'POST', {}, 'Restart fleet worker failed') }

  listRuntimeTasks<T = unknown>(): Promise<T> { return this.runtimeJson('/tasks', 'GET', undefined, 'List tasks failed') }
  createRuntimeTask<T = unknown>(body: unknown): Promise<T> { return this.runtimeJson('/tasks', 'POST', body, 'Create task failed') }
  getRuntimeTask<T = unknown>(taskId: string): Promise<T> { return this.runtimeJson(`/tasks/${encodeURIComponent(taskId)}`, 'GET', undefined, 'Get task failed') }
  cancelRuntimeTask<T = unknown>(taskId: string): Promise<T> { return this.runtimeJson(`/tasks/${encodeURIComponent(taskId)}/cancel`, 'POST', {}, 'Cancel task failed') }

  listRuntimeAutomations<T = unknown>(): Promise<T> {
    if (!this.usesEmbeddedRuntime) return this.sidecarJson('/api/automations', 'GET', undefined, 'List automations failed').then(d => (d as any)?.automations ?? [])
    return this.runtimeJson('/automations', 'GET', undefined, 'List automations failed')
  }
  createRuntimeAutomation<T = unknown>(body: unknown): Promise<T> {
    if (!this.usesEmbeddedRuntime) return this.sidecarJson('/api/automations', 'POST', body, 'Create automation failed')
    return this.runtimeJson('/automations', 'POST', body, 'Create automation failed')
  }
  getRuntimeAutomation<T = unknown>(id: string): Promise<T> {
    if (!this.usesEmbeddedRuntime) return this.sidecarJson(`/api/automations/${encodeURIComponent(id)}`, 'GET', undefined, 'Get automation failed')
    return this.runtimeJson(`/automations/${encodeURIComponent(id)}`, 'GET', undefined, 'Get automation failed')
  }
  updateRuntimeAutomation<T = unknown>(id: string, body: unknown): Promise<T> {
    if (!this.usesEmbeddedRuntime) return this.sidecarJson(`/api/automations/${encodeURIComponent(id)}`, 'PATCH', body, 'Update automation failed')
    return this.runtimeJson(`/automations/${encodeURIComponent(id)}`, 'PATCH', body, 'Update automation failed')
  }
  deleteRuntimeAutomation<T = unknown>(id: string): Promise<T> {
    if (!this.usesEmbeddedRuntime) return this.sidecarJson(`/api/automations/${encodeURIComponent(id)}`, 'DELETE', undefined, 'Delete automation failed')
    return this.runtimeJson(`/automations/${encodeURIComponent(id)}`, 'DELETE', undefined, 'Delete automation failed')
  }
  runRuntimeAutomation<T = unknown>(id: string): Promise<T> {
    if (!this.usesEmbeddedRuntime) return this.sidecarJson(`/api/automations/${encodeURIComponent(id)}/run`, 'POST', {}, 'Run automation failed')
    return this.runtimeJson(`/automations/${encodeURIComponent(id)}/run`, 'POST', {}, 'Run automation failed')
  }
  pauseRuntimeAutomation<T = unknown>(id: string): Promise<T> {
    if (!this.usesEmbeddedRuntime) return this.sidecarJson(`/api/automations/${encodeURIComponent(id)}/pause`, 'POST', {}, 'Pause automation failed')
    return this.runtimeJson(`/automations/${encodeURIComponent(id)}/pause`, 'POST', {}, 'Pause automation failed')
  }
  resumeRuntimeAutomation<T = unknown>(id: string): Promise<T> {
    if (!this.usesEmbeddedRuntime) return this.sidecarJson(`/api/automations/${encodeURIComponent(id)}/resume`, 'POST', {}, 'Resume automation failed')
    return this.runtimeJson(`/automations/${encodeURIComponent(id)}/resume`, 'POST', {}, 'Resume automation failed')
  }
  listRuntimeAutomationRuns<T = unknown>(id: string): Promise<T> {
    if (!this.usesEmbeddedRuntime) return this.sidecarJson(`/api/automations/${encodeURIComponent(id)}/runs`, 'GET', undefined, 'List automation runs failed').then(d => (d as any)?.runs ?? [])
    return this.runtimeJson(`/automations/${encodeURIComponent(id)}/runs`, 'GET', undefined, 'List automation runs failed')
  }

  getRuntimeUsage<T = unknown>(): Promise<T> { return this.runtimeJson('/usage', 'GET', undefined, 'Get usage failed') }
  listRuntimeSnapshots<T = unknown>(): Promise<T> { return this.runtimeJson('/snapshots', 'GET', undefined, 'List snapshots failed') }
  restoreRuntimeSnapshot<T = unknown>(id: string): Promise<T> { return this.runtimeJson(`/snapshots/${encodeURIComponent(id)}/restore`, 'POST', {}, 'Restore snapshot failed') }
  decideRuntimeApproval<T = unknown>(approvalId: string, body: unknown): Promise<T> { return this.runtimeJson(`/approvals/${encodeURIComponent(approvalId)}`, 'POST', body, 'Decide approval failed') }

  sendRuntimeAgentMail<T = unknown>(body: unknown): Promise<T> { return this.runtimeJson('/agent-mail', 'POST', body, 'Send agent mail failed') }
  listRuntimeAgentMail<T = unknown>(threadId: string): Promise<T> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/agent-mail`, 'GET', undefined, 'List agent mail failed') }
  deliverRuntimeAgentMail<T = unknown>(threadId: string, messageId: string, body: unknown = {}): Promise<T> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/agent-mail/${encodeURIComponent(messageId)}/deliver`, 'POST', body, 'Deliver agent mail failed') }
  markRuntimeAgentMailRead<T = unknown>(threadId: string, messageId: string): Promise<T> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/agent-mail/${encodeURIComponent(messageId)}/read`, 'POST', {}, 'Mark agent mail failed') }

  forkRuntimeThread<T = unknown>(threadId: string, body: unknown = {}): Promise<T> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/fork`, 'POST', body, 'Fork thread failed') }
  retryRuntimeThread<T = unknown>(threadId: string, body: unknown = {}): Promise<T> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/retry`, 'POST', body, 'Retry thread failed') }
  undoRuntimeThread<T = unknown>(threadId: string, body: unknown = {}): Promise<T> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/undo`, 'POST', body, 'Undo thread failed') }
  patchUndoRuntimeThread<T = unknown>(threadId: string, body: unknown = {}): Promise<T> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/patch-undo`, 'POST', body, 'Patch undo failed') }
  steerRuntimeThread<T = unknown>(threadId: string, turnId: string, body: unknown): Promise<T> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/steer`, 'POST', body, 'Steer turn failed') }
  interruptRuntimeThread<T = unknown>(threadId: string, turnId: string): Promise<T> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`, 'POST', {}, 'Interrupt turn failed') }
  compactRuntimeThread<T = unknown>(threadId: string, body: unknown = {}): Promise<T> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/compact`, 'POST', body, 'Compact thread failed') }
  submitRuntimeToolCallResult<T = unknown>(threadId: string, turnId: string, callId: string, body: unknown): Promise<T> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/tool-calls/${encodeURIComponent(callId)}/result`, 'POST', body, 'Submit tool result failed') }
  getRuntimeThreadGoal(threadId: string): Promise<ThreadGoal> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/goal`, 'GET', undefined, 'Get thread goal failed') }
  upsertRuntimeThreadGoal(threadId: string, body: { objective: string; token_budget?: number | null }): Promise<ThreadGoal> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/goal`, 'PUT', body, 'Save thread goal failed') }
  deleteRuntimeThreadGoal(threadId: string): Promise<void> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/goal`, 'DELETE', undefined, 'Delete thread goal failed') }
  completeRuntimeThreadGoal(threadId: string): Promise<ThreadGoal> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/goal/complete`, 'POST', {}, 'Complete thread goal failed') }
  blockRuntimeThreadGoal(threadId: string): Promise<ThreadGoal> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/goal/block`, 'POST', {}, 'Block thread goal failed') }
  pauseRuntimeThreadGoal(threadId: string): Promise<ThreadGoal> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/goal/pause`, 'POST', {}, 'Pause thread goal failed') }
  resumeRuntimeThreadGoal(threadId: string): Promise<ThreadGoal> { return this.runtimeJson(`/threads/${encodeURIComponent(threadId)}/goal/resume`, 'POST', {}, 'Resume thread goal failed') }

  updateRuntimeSkill<T = unknown>(name: string, body: unknown = {}): Promise<T> { return this.runtimeJson(`/skills/${encodeURIComponent(name)}/update`, 'POST', body, 'Update skill failed') }
  trustRuntimeSkill<T = unknown>(name: string, body: unknown = {}): Promise<T> { return this.runtimeJson(`/skills/${encodeURIComponent(name)}/trust`, 'POST', body, 'Trust skill failed') }
  auditRuntimeSkill<T = unknown>(name: string): Promise<T> { return this.runtimeJson(`/skills/${encodeURIComponent(name)}/audit`, 'GET', undefined, 'Audit skill failed') }
  createRuntimeMemory<T = unknown>(body: unknown): Promise<T> { return this.runtimeJson('/memory', 'POST', body, 'Create memory failed') }
  getRuntimeMemory<T = unknown>(id: string): Promise<T> { return this.runtimeJson(`/memory/${encodeURIComponent(id)}`, 'GET', undefined, 'Get memory failed') }
  listRuntimeMemory<T = unknown>(scope: string = 'all'): Promise<T> { return this.runtimeJson(`/memory?scope=${encodeURIComponent(scope)}&limit=200`, 'GET', undefined, 'List memory failed') }
  clearRuntimeMemory<T = unknown>(scope: string = 'all'): Promise<T> { return this.runtimeJson(`/memory?scope=${encodeURIComponent(scope)}`, 'DELETE', undefined, 'Clear memory failed') }
  searchRuntimeMemory<T = unknown>(query: string, scope: string = 'all'): Promise<T> { return this.runtimeJson(`/memory?scope=${encodeURIComponent(scope)}&q=${encodeURIComponent(query)}`, 'GET', undefined, 'Search memory failed') }

  private runtimeSession(thread: any): ServerSession {
    const toMillis = (value: unknown) => {
      if (typeof value === 'number') return value
      const parsed = Date.parse(String(value || ''))
      return Number.isFinite(parsed) ? parsed : Date.now()
    }
    return {
      id: String(thread.id),
      title: String(thread.title || 'New Chat'),
      remote_session_id: null,
      provider: thread.model_provider || null,
      pinned: false,
      created_at: toMillis(thread.created_at),
      updated_at: toMillis(thread.updated_at),
    }
  }

  private runtimeMessage(sessionId: string, item: any): ServerMessage | null {
    const kind = String(item?.kind || '')
    if (kind !== 'user_message' && kind !== 'agent_message') return null
    const timestamp = Date.parse(String(item.ended_at || item.started_at || ''))
    return {
      id: String(item.id),
      session_id: sessionId,
      role: kind === 'user_message' ? 'user' : 'assistant',
      content: String(item.detail || item.summary || ''),
      reasoning: null,
      tool_calls: [],
      input_tokens: null,
      output_tokens: null,
      error: null,
      streaming: false,
      created_at: Number.isFinite(timestamp) ? timestamp : Date.now(),
      updated_at: Number.isFinite(timestamp) ? timestamp : Date.now(),
    }
  }

  setBaseUrl(url: string) {
    // Remove trailing slash
    const previewUrl = this.rustPreviewUrl
    const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?\/?$/i.test(url)
    this.localBaseUrl = previewUrl && isLoopback ? previewUrl : url.replace(/\/$/, '')
    if (!this.remoteRuntimeActive) {
      this.baseUrl = this.localBaseUrl
      this.wsBaseUrl = this.baseUrl.replace(/^http/, 'ws')
    }
  }

  setTimeout(timeout: number) {
    this.timeout = timeout
  }

  /**
   * 带硬超时的 fetch — 即使 AbortSignal.timeout 因平台 bug 不触发，
   * Promise.race 也会在 hardTimeoutMs 后强制 reject。
   *
   * 这解决了 Windows 上 fetch 到 localhost（可能解析到 IPv6 ::1）被
   * 防火墙 stealth-drop 导致无限挂起的问题。
   */
  private async fetchWithHardTimeout(
    url: string,
    init: RequestInit = {},
    hardTimeoutMs: number = 12000,
  ): Promise<Response> {
    const abortCtrl = new AbortController()
    const callerSignal = init.signal
    let timedOut = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    // Keep the caller's signal (for stop/rewind) distinct from the request
    // timeout. Previously the timeout signal was always replaced onto fetch,
    // and a timeout surfaced as the raw WebView error
    // "signal is aborted without reason". That string leaked into user-facing
    // toasts and made an ordinary network timeout look like a broken session.
    const onCallerAbort = () => abortCtrl.abort()
    if (callerSignal?.aborted) abortCtrl.abort()
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

    const hardTimeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true
        abortCtrl.abort()
        reject(new HakusAIError(`Request timed out after ${hardTimeoutMs}ms: ${url}`, 'TIMEOUT'))
      }, hardTimeoutMs)
    })

    const fetchPromise = fetch(url, {
      ...init,
      signal: abortCtrl.signal,
    })

    try {
      return await Promise.race([fetchPromise, hardTimeoutPromise])
    } catch (error) {
      // Normalize platform-specific AbortError messages. A caller abort is
      // intentionally preserved as AbortError so the chat view treats it as
      // a user stop; only an internal timeout becomes a visible timeout.
      if (timedOut) {
        throw new HakusAIError(`Request timed out after ${hardTimeoutMs}ms: ${url}`, 'TIMEOUT')
      }
      if (callerSignal?.aborted) {
        const abortError = new DOMException('The request was aborted', 'AbortError')
        throw abortError
      }
      throw error
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
  }

  /**
   * 当 fetch 收到非 2xx 响应时调用。如果响应是 404 + 端点是 v0.1.0-beta.3 之后新加的，
   * 抛出 BackendOutdatedError 让上层 UI 给出"重新安装客户端"的明确提示，而不是
   * 让用户对着 "Get providers failed: 404" 一头雾水。
   */
  private async _throwForResponse(res: Response, url: string, fallbackMsg: string): Promise<never> {
    let body: any = null
    try {
      const text = await res.text()
      try { body = JSON.parse(text) } catch { body = { detail: text } }
    } catch {
      body = {}
    }

    if (res.status === 404) {
      const path = (() => {
        try { return new URL(url).pathname } catch { return url }
      })()
      // 这些端点都是 v0.1.0-beta.3 (commit 16bd779) 之后新加的。
      // 如果 backend 是 beta.2 或更早，所有这些端点都会 404。
      const knownNewEndpoints = [
        '/api/config/providers',
        '/api/config/default-model',
        '/api/character',
        '/api/character/update',
        '/api/memory/details',
        '/api/tools',
        '/api/tools/toggle',
        '/api/skills',
        '/api/permission',
        '/api/config/export',
        '/api/config/import',
        '/api/version',
      ]
      const isNewEndpoint = knownNewEndpoints.some((p) => path.endsWith(p))
      const backendVersion = typeof body?.backend_api_version_int === 'number'
        ? body.backend_api_version_int
        : null

      if (isNewEndpoint || backendVersion !== null) {
        throw new BackendOutdatedError(
          `Runtime 版本过旧：端点 ${path} 不存在 (HTTP 404)。` +
          `请更新或重启当前连接的 Rust Runtime。` +
          (backendVersion !== null ? ` (backend API v${backendVersion})` : ''),
          { backendVersion, path },
        )
      }
    }

    // Rust Runtime returns `{ error: { message, status } }`; the Python
    // backend returns `{ detail }` (string or FastAPI validation list).
    // Flatten every shape to a readable string — a bare object here is what
    // produced "[object Object]" toasts.
    const rawDetail = body?.detail ?? body?.error ?? body?.message ?? ''
    const detail =
      typeof rawDetail === 'string'
        ? rawDetail
        : rawDetail && typeof rawDetail === 'object'
          ? String((rawDetail as { message?: unknown }).message ?? JSON.stringify(rawDetail))
          : String(rawDetail)
    throw new HakusAIError(`${fallbackMsg}: ${res.status} ${detail}`.trim(), undefined, res.status)
  }

  // ============ REST endpoints ============

  async health(): Promise<HealthResponse> {
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/health`, {}, 8000)
    if (!res.ok) throw new HakusAIError(`Health check failed: ${res.status}`)
    const health = await res.json()
    if (this.usesEmbeddedRuntime) {
      return {
        status: health.status || 'ok',
        version: 'rust-runtime',
        model_loaded: true,
        agent_ready: true,
      }
    }
    return health
  }

  /**
   * 查询 backend 的 API 版本。客户端启动时调用一次，检测 backend 是否过旧。
   * - 如果端点本身 404（backend 是 v0.1.0-beta.2 或更早），返回 null。
   * - 如果 fetch 失败（backend 没启动），返回 null。
   * 调用方应该把 null 视为"版本未知"，不阻塞 UI 启动。
   */
  async getBackendVersion(): Promise<BackendVersionInfo | null> {
    if (this.usesEmbeddedRuntime) {
      return {
        backend_api_version: 'runtime-api',
        backend_api_version_int: EXPECTED_BACKEND_API_VERSION_INT,
        server_version: 'hakus-tui',
        endpoints: ['/v1/threads', '/v1/stream', '/v1/user-input'],
      }
    }
    try {
      const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/version`, {}, 5000)
      if (!res.ok) return null
      return await res.json() as BackendVersionInfo
    } catch {
      return null
    }
  }

  async getConfig(): Promise<AppConfig> {
    if (this.usesEmbeddedRuntime) {
      const [configRes, characterRes] = await Promise.all([
        this.runtimeFetch('/config'),
        this.runtimeFetch('/character'),
      ])
      if (!configRes.ok) await this._throwForResponse(configRes, `${this.baseUrl}/v1/config`, 'Get config failed')
      if (!characterRes.ok) await this._throwForResponse(characterRes, `${this.baseUrl}/v1/character`, 'Get character failed')
      const config = await configRes.json()
      const character = await characterRes.json()
      return {
        version: 'runtime-api',
        character: {
          name: String(character.name || 'HakusAI'),
          personality: String(character.personality || ''),
        },
        model: {
          provider: String(config.provider || 'deepseek'),
          model_name: String(config.model || config.default_model || 'auto'),
        },
        voice: { enabled: false, asr_provider: '', tts_provider: '' },
        avatar: {
          enabled: character.avatar_type !== 'none',
          type: String(character.avatar_type || 'none'),
          name: String(character.name || 'HakusAI'),
        },
      }
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/config`, {}, 10000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/config`, 'Get config failed')
    return res.json()
  }

  async getCharacter(): Promise<CharacterInfo> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/character`
      const res = await this.runtimeFetch('/character')
      if (!res.ok) await this._throwForResponse(res, url, 'Get Runtime character failed')
      return res.json()
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/character`, {}, 10000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/character`, 'Get character failed')
    return res.json()
  }

  async updateCharacter(body: UpdateCharacterBody): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/character`
      const res = await this.runtimeFetch('/character', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) await this._throwForResponse(res, url, 'Update Runtime character failed')
      return
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/character/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 10000)
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/character/update`, 'Update character failed')
    }
  }

  // ============ Provider / Model 配置 ============

  async getProviders(): Promise<ProvidersResponse> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/providers')
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/providers`, 'Get providers failed')
      const data = await res.json()
      const current = String(data.current || '')
      const providers: ProviderInfo[] = (data.providers || []).map((provider: any) => ({
        id: String(provider.id),
        display_name: String(provider.display_name || provider.id),
        has_url: Boolean(provider.has_url ?? provider.default_base_url),
        has_api_key: Boolean(provider.has_api_key),
        masked_api_key: String(provider.masked_api_key || ''),
        model_name: String(provider.model || ''),
        base_url: String(provider.base_url || ''),
        is_default: provider.id === current,
        default_base_url: String(provider.default_base_url || ''),
        default_model: String(provider.default_model || ''),
        has_model_catalog: Boolean(provider.has_model_catalog),
        env_vars: Array.isArray(provider.env_vars) ? provider.env_vars.map(String) : [],
        has_custom_headers: Boolean(provider.has_custom_headers),
        group: String(provider.group || '其他'),
        auth_mode: String(provider.auth_mode || ''),
        wire: provider.wire ? String(provider.wire) : undefined,
        supports_connection_test: Boolean(provider.supports_connection_test),
        supports_live_models: Boolean(provider.supports_live_models),
        supports_headers: Boolean(provider.supports_headers),
        supports_multi_key: Boolean(provider.supports_multi_key),
        is_custom: Boolean(provider.is_custom),
        description: provider.description ? String(provider.description) : undefined,
        enabled: provider.enabled !== false,
        models: Array.isArray(provider.models) ? provider.models.map(String) : [],
        configured_models: Array.isArray(provider.configured_models) ? provider.configured_models.map(String) : [],
      }))
      return {
        default_model: current || 'deepseek',
        providers: mergeProviderCatalog(providers, current),
      }
    }
      const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/config/providers`, {}, 10000)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/config/providers`, 'Get providers failed')
      const data = await res.json()
      const providers = Array.isArray(data.providers) ? data.providers as ProviderInfo[] : []
      const current = String(data.current || providers.find((provider) => provider.is_default)?.id || '')
      return {
        ...data,
        default_model: String(data.default_model || current || 'deepseek'),
        providers: mergeProviderCatalog(providers, current),
      }
  }

  async updateProvider(body: UpdateProviderBody): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch(`/providers/${encodeURIComponent(body.provider)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_name: body.model_name,
          base_url: body.base_url,
          api_key: body.api_key,
          set_as_default: body.set_as_default ?? false,
          enabled: body.enabled,
          models: body.models,
          wire: body.wire,
          // Only forward when the caller actually decided about it: omitting
          // the key leaves the saved value alone, explicit null clears it.
          ...(body.context_window !== undefined ? { context_window: body.context_window } : {}),
        }),
      }, 10000)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/providers/${body.provider}`, 'Update Runtime provider failed')
      return
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/config/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 10000)
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/config/providers`, 'Update provider failed')
    }
  }

  async setDefaultModel(provider: string, model?: string): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch(`/providers/${encodeURIComponent(provider)}/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model ? { model } : {}),
      })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/providers/${provider}/switch`, 'Set Runtime provider failed')
      return
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/config/default-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    }, 10000)
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/config/default-model`, 'Set default model failed')
    }
  }

  // ============ Provider 运维操作 (测试连接 / 获取模型 / 多 Key / 自定义 Header) ============

  /**
   * 获取所有 provider 的静态元数据 + 分组信息.
   * 前端用这个渲染分组列表 + 默认 URL/模型提示.
   */
  async getProvidersMeta(): Promise<ProvidersMetaResponse> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/providers')
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/providers`, 'Get providers meta failed')
      const data = await res.json()
      const providers = (data.providers || []).map((provider: any) => ({
        id: String(provider.id),
        display_name: String(provider.display_name || provider.id),
        has_url: Boolean(provider.has_url ?? provider.default_base_url),
        group: String(provider.group || '其他'),
        default_url: String(provider.default_base_url || ''),
        default_model: String(provider.default_model || ''),
      }))
      return { providers, groups: Array.from(new Set(providers.map((provider: ProviderMeta) => provider.group))) }
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/providers/meta`, {}, 10000)
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/providers/meta`, 'Get providers meta failed')
    }
    return res.json()
  }

  /**
   * 测试 provider 连接. 可以传 override_api_key/base_url/model 临时测试
   * (不写回 config), 也可以留空使用 config 里的当前值.
   */
  async testProviderConnection(
    providerId: string,
    overrides?: { api_key?: string; base_url?: string; model?: string; timeout?: number },
  ): Promise<ConnectionTestResult> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/providers/${encodeURIComponent(providerId)}/test`
      const res = await this.runtimeFetch(`/providers/${encodeURIComponent(providerId)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(overrides ?? {}),
      }, Math.max(30000, (overrides?.timeout ?? 20) * 1000 + 5000))
      if (!res.ok) await this._throwForResponse(res, url, 'Test Runtime provider failed')
      return res.json()
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/providers/${encodeURIComponent(providerId)}/test`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(overrides ?? {}),
      },
      // 给后端 timeout + 5s 缓冲
      Math.max(20000, (overrides?.timeout ?? 15) * 1000 + 5000),
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/providers/${providerId}/test`, 'Test provider failed')
    }
    return res.json()
  }

  /**
   * 从 provider 的 /models 端点拉取可用模型列表.
   * 用于「获取模型列表」按钮 — 用户不用再手抄 model_name.
   */
  async fetchProviderModels(
    providerId: string,
    overrides?: { api_key?: string; base_url?: string; timeout?: number },
  ): Promise<FetchModelsResult> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/providers/${encodeURIComponent(providerId)}/models`
      const res = await this.runtimeFetch(`/providers/${encodeURIComponent(providerId)}/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(overrides ?? {}),
      }, Math.max(30000, (overrides?.timeout ?? 20) * 1000 + 5000))
      if (!res.ok) await this._throwForResponse(res, url, 'Fetch Runtime models failed')
      const data = await res.json()
      const models = (data.models || []).map((model: any) => {
        const id = String(model.id || model)
        return {
          id,
          name: id,
          owned_by: null,
          reasoning_options: Array.isArray(model.reasoning_options) ? model.reasoning_options : [],
          supports_reasoning: typeof model.supports_reasoning === 'boolean' ? model.supports_reasoning : null,
          context_window: typeof model.context_window === 'number' ? model.context_window : null,
        }
      })
      return {
        ok: true,
        models,
        message: models.length > 0 ? `已从 Rust Runtime 获取 ${models.length} 个模型` : '该 provider 没有内置模型目录',
      }
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/providers/${encodeURIComponent(providerId)}/fetch-models`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(overrides ?? {}),
      },
      Math.max(30000, (overrides?.timeout ?? 20) * 1000 + 5000),
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/providers/${providerId}/fetch-models`, 'Fetch models failed')
    }
    return res.json()
  }

  /** Read the Rust catalog for a provider without calling the provider. */
  async listProviderModels(providerId: string): Promise<FetchModelsResult> {
    if (this.usesEmbeddedRuntime) {
      const path = `/providers/${encodeURIComponent(providerId)}/models`
      const res = await this.runtimeFetch(path)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, 'List Runtime models failed')
      const data = await res.json()
      const models = (data.models || []).map((model: any) => {
        const id = String(model.id || model)
        return {
          id,
          name: id,
          owned_by: null,
          reasoning_options: Array.isArray(model.reasoning_options) ? model.reasoning_options : [],
          supports_reasoning: typeof model.supports_reasoning === 'boolean' ? model.supports_reasoning : null,
          context_window: typeof model.context_window === 'number' ? model.context_window : null,
        }
      })
      return {
        ok: true,
        models,
        message: models.length > 0 ? `已从 Rust Runtime 读取 ${models.length} 个模型` : '该 provider 未声明模型',
      }
    }
    return { ok: true, models: [], message: '当前后端没有本地模型目录' }
  }

  /** 列出某 provider 的所有 API Key (masked). */
  async listProviderKeys(providerId: string): Promise<ProviderKeyEntry[]> {
    if (this.usesEmbeddedRuntime) {
      const path = `/providers/${encodeURIComponent(providerId)}/keys`
      const res = await this.runtimeFetch(path)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, 'List Runtime provider keys failed')
      const data = await res.json()
      return data.keys ?? []
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/providers/${encodeURIComponent(providerId)}/keys`,
      {},
      10000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/providers/${providerId}/keys`, 'List provider keys failed')
    }
    const data = await res.json()
    return data.keys ?? []
  }

  /** 给某 provider 添加一个额外的 API Key. */
  async addProviderKey(providerId: string, key: string, label: string = ''): Promise<ProviderKeyEntry> {
    if (this.usesEmbeddedRuntime) {
      const path = `/providers/${encodeURIComponent(providerId)}/keys`
      const res = await this.runtimeFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, label }),
      })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, 'Add Runtime provider key failed')
      return res.json()
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/providers/${encodeURIComponent(providerId)}/keys`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, label }),
      },
      10000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/providers/${providerId}/keys`, 'Add provider key failed')
    }
    return res.json()
  }

  /** 删除某 provider 的一个额外 Key (不能删主 Key). */
  async deleteProviderKey(providerId: string, keyId: string): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const path = `/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}`
      const res = await this.runtimeFetch(path, { method: 'DELETE' })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, 'Delete Runtime provider key failed')
      return
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}`,
      { method: 'DELETE' },
      10000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/providers/${providerId}/keys/${keyId}`, 'Delete provider key failed')
    }
  }

  /** Clear the primary key for a provider during first-run re-authentication. */
  async clearProviderApiKey(providerId: string): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const path = `/providers/${encodeURIComponent(providerId)}/key`
      const res = await this.runtimeFetch(path, { method: 'DELETE' })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, 'Clear Runtime provider key failed')
      return
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/providers/${encodeURIComponent(providerId)}/key`,
      { method: 'DELETE' },
      10000,
    )
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/providers/${providerId}/key`, 'Clear provider key failed')
  }

  /** 获取某 provider 的自定义 HTTP Headers. */
  async getProviderHeaders(providerId: string): Promise<Record<string, string>> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/providers/${encodeURIComponent(providerId)}/headers`
      const res = await this.runtimeFetch(`/providers/${encodeURIComponent(providerId)}/headers`)
      if (!res.ok) await this._throwForResponse(res, url, 'Get Runtime provider headers failed')
      const data = await res.json()
      return data.headers ?? {}
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/providers/${encodeURIComponent(providerId)}/headers`,
      {},
      10000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/providers/${providerId}/headers`, 'Get provider headers failed')
    }
    const data = await res.json()
    return data.headers ?? {}
  }

  /** 设置某 provider 的自定义 HTTP Headers (传空字典清除). */
  async setProviderHeaders(providerId: string, headers: Record<string, string>): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/providers/${encodeURIComponent(providerId)}/headers`
      const res = await this.runtimeFetch(`/providers/${encodeURIComponent(providerId)}/headers`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headers }),
      })
      if (!res.ok) await this._throwForResponse(res, url, 'Set Runtime provider headers failed')
      return
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/providers/${encodeURIComponent(providerId)}/headers`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headers }),
      },
      10000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/providers/${providerId}/headers`, 'Set provider headers failed')
    }
  }

  // ============ MCP (Model Context Protocol) 服务器 ============
  // Phase 2 round 2 — external stdio MCP servers.
  // All methods mirror /api/config/mcp-servers* and /api/mcp/servers/* endpoints.

  async getMcpServers(): Promise<McpServersResponse> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/apps/mcp/servers')
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/apps/mcp/servers`, 'Get MCP servers failed')
      const data = await res.json()
      const servers = await Promise.all((data.servers || []).map(async (entry: any) => {
        // The list endpoint intentionally exposes only a redacted summary.
        // Fetch the redacted detail so the existing editor can retain args and
        // transport without ever receiving secret values.
        let detail: any = null
        try {
          const detailResponse = await this.runtimeFetch(`/apps/mcp/servers/${encodeURIComponent(entry.name)}`)
          if (detailResponse.ok) detail = await detailResponse.json()
        } catch {
          // Keep the summary usable when a single server disappears during a refresh.
        }
        const source = { ...entry, ...(detail || {}) }
        const transport = source.transport === 'streamable_http'
          ? 'http'
          : (source.transport || (source.url ? 'sse' : 'stdio'))
        return {
          name: String(source.name),
          enabled: Boolean(source.enabled),
          transport: transport as McpServerInfo['transport'],
          command: String(source.command || ''),
          args: Array.isArray(source.args) ? source.args.map(String) : [],
          env_keys: Array.isArray(source.env_keys) ? source.env_keys.map(String) : [],
          has_env: Array.isArray(source.env_keys) && source.env_keys.length > 0,
          cwd: source.cwd || null,
          startup_timeout: Number(source.connect_timeout || 15),
          tool_timeout: Number(source.execute_timeout || 60),
          status: source.connected ? 'running' : (source.enabled ? 'stopped' : 'disabled'),
          last_error: null,
          started_at: null,
          tool_count: 0,
        }
      }))
      return {
        servers,
        global: {
          auto_start: Boolean(data.global?.auto_start),
          fail_fast: Boolean(data.global?.fail_fast),
          tool_naming: data.global?.tool_naming === 'flat' ? 'flat' : 'namespace',
        },
      }
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/config/mcp-servers`,
      {},
      10000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/config/mcp-servers`, 'Get MCP servers failed')
    }
    return res.json()
  }

  async saveMcpServer(name: string, config: McpServerConfig): Promise<{ name: string; config: Record<string, unknown> }> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/apps/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          enabled: config.enabled,
          command: config.command || null,
          args: config.args,
          env: config.env,
          cwd: config.cwd || null,
          connect_timeout: config.startup_timeout,
          execute_timeout: config.tool_timeout,
          transport: config.transport === 'stdio'
            ? null
            : config.transport === 'http'
              ? 'streamable_http'
              : config.transport,
        }),
      })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/apps/mcp/servers`, 'Save MCP server failed')
      return { name, config: await res.json() }
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/config/mcp-servers`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, config }),
      },
      10000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/config/mcp-servers`, 'Save MCP server failed')
    }
    return res.json()
  }

  async updateMcpServer(name: string, patch: Partial<McpServerConfig> & { enabled?: boolean }): Promise<{ name: string; config: Record<string, unknown> }> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch(`/apps/mcp/servers/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.command !== undefined ? { command: patch.command || null } : {}),
          ...(patch.args !== undefined ? { args: patch.args } : {}),
          ...(patch.env !== undefined ? { env: patch.env } : {}),
          ...(patch.cwd !== undefined ? { cwd: patch.cwd || null } : {}),
          ...(patch.startup_timeout !== undefined ? { connect_timeout: patch.startup_timeout } : {}),
          ...(patch.tool_timeout !== undefined ? { execute_timeout: patch.tool_timeout } : {}),
          ...(patch.transport && patch.transport !== 'stdio'
            ? { transport: patch.transport === 'http' ? 'streamable_http' : patch.transport }
            : {}),
        }),
      })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/apps/mcp/servers/${name}`, 'Update MCP server failed')
      return { name, config: await res.json() }
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/config/mcp-servers/${encodeURIComponent(name)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
      10000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/config/mcp-servers/${name}`, 'Update MCP server failed')
    }
    return res.json()
  }

  async deleteMcpServer(name: string): Promise<{ name: string; deleted: boolean }> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch(`/apps/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/apps/mcp/servers/${name}`, 'Delete MCP server failed')
      const data = await res.json()
      return { name: String(data.name || name), deleted: Boolean(data.ok ?? true) }
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/config/mcp-servers/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
      10000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/config/mcp-servers/${name}`, 'Delete MCP server failed')
    }
    return res.json()
  }

  async updateMcpGlobalConfig(patch: Partial<McpGlobalConfig>): Promise<{ global: McpGlobalConfig }> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/apps/mcp/config`
      const res = await this.runtimeFetch('/apps/mcp/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) await this._throwForResponse(res, url, 'Update Runtime MCP global config failed')
      const data = await res.json()
      return {
        global: {
          auto_start: Boolean(data.global?.auto_start),
          fail_fast: Boolean(data.global?.fail_fast),
          tool_naming: data.global?.tool_naming === 'flat' ? 'flat' : 'namespace',
        },
      }
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/config/mcp`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
      10000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/config/mcp`, 'Update MCP global config failed')
    }
    return res.json()
  }

  async startMcpServer(name: string): Promise<McpStartResult> {
    if (this.usesEmbeddedRuntime) {
      const reconnect = await this.runtimeFetch(`/apps/mcp/servers/${encodeURIComponent(name)}/reconnect`, { method: 'POST' }, 30000)
      if (!reconnect.ok) await this._throwForResponse(reconnect, `${this.baseUrl}/v1/apps/mcp/servers/${name}/reconnect`, 'Start MCP server failed')
      const tools = await this.listMcpServerTools(name)
      return {
        ok: true,
        message: `${name} 已请求 Rust Runtime 连接，发现 ${tools.tools.length} 个工具`,
        status: { name, status: 'running', last_error: null, started_at: Date.now(), tool_count: tools.tools.length },
        tools: tools.tools,
      }
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/mcp/servers/${encodeURIComponent(name)}/start`,
      { method: 'POST' },
      30000, // generous timeout — spawn + initialize can take a few seconds
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/mcp/servers/${name}/start`, 'Start MCP server failed')
    }
    return res.json()
  }

  async stopMcpServer(name: string): Promise<{ ok: boolean; message: string }> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/apps/mcp/servers/${encodeURIComponent(name)}/stop`
      const res = await this.runtimeFetch(`/apps/mcp/servers/${encodeURIComponent(name)}/stop`, { method: 'POST' })
      if (!res.ok) await this._throwForResponse(res, url, 'Stop Runtime MCP server failed')
      const data = await res.json()
      return { ok: Boolean(data.ok), message: String(data.action || 'stopped') }
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/mcp/servers/${encodeURIComponent(name)}/stop`,
      { method: 'POST' },
      10000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/mcp/servers/${name}/stop`, 'Stop MCP server failed')
    }
    return res.json()
  }

  async testMcpServer(
    name: string,
    overrides?: { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string },
  ): Promise<McpTestResult> {
    if (this.usesEmbeddedRuntime) {
      const tools = await this.listMcpServerTools(name)
      return {
        ok: true,
        message: `${name} 的 Rust Runtime MCP 连接检查完成`,
        detail: `发现 ${tools.tools.length} 个工具`,
        tools: tools.tools,
      }
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/mcp/servers/${encodeURIComponent(name)}/test`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(overrides ?? {}),
      },
      30000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/mcp/servers/${name}/test`, 'Test MCP server failed')
    }
    return res.json()
  }

  async listMcpServerTools(name: string): Promise<McpServerToolsResponse> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch(`/apps/mcp/tools?server=${encodeURIComponent(name)}&connect=true`, {}, 30000)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/apps/mcp/tools`, 'List MCP server tools failed')
      const data = await res.json()
      const tools = (data.tools || []).map((tool: any) => ({
        name: String(tool.name || tool.prefixed_name || ''),
        description: String(tool.description || ''),
        input_schema: tool.input_schema || {},
        is_dangerous: false,
      }))
      return { ok: true, message: `发现 ${tools.length} 个工具`, tools }
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/mcp/servers/${encodeURIComponent(name)}/tools`,
      {},
      10000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/mcp/servers/${name}/tools`, 'List MCP server tools failed')
    }
    return res.json()
  }

  async invokeMcpTool(name: string, toolName: string, args: Record<string, unknown>): Promise<McpInvokeResult> {
    if (this.usesEmbeddedRuntime) {
      const path = `/apps/mcp/servers/${encodeURIComponent(name)}/tools/${encodeURIComponent(toolName)}/invoke`
      const url = `${this.baseUrl}/v1${path}`
      const res = await this.runtimeFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arguments: args }),
      }, 60000)
      if (!res.ok) await this._throwForResponse(res, url, 'Invoke Runtime MCP tool failed')
      return res.json()
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/mcp/servers/${encodeURIComponent(name)}/tools/${encodeURIComponent(toolName)}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arguments: args }),
      },
      60000, // generous — tool execution can be slow
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/mcp/servers/${name}/tools/${toolName}/invoke`, 'Invoke MCP tool failed')
    }
    return res.json()
  }

  // ============ 记忆系统 ============

  async getMemoryDetails(): Promise<MemoryDetails> {
    if (this.usesEmbeddedRuntime) {
      const [configRes, memoryRes] = await Promise.all([
        this.runtimeFetch('/config'),
        this.runtimeFetch('/memory?limit=200'),
      ])
      if (!configRes.ok) await this._throwForResponse(configRes, `${this.baseUrl}/v1/config`, 'Get memory config failed')
      if (!memoryRes.ok) await this._throwForResponse(memoryRes, `${this.baseUrl}/v1/memory`, 'Get memory entries failed')
      const config = await configRes.json()
      const memory = await memoryRes.json()
      return {
        enabled: Boolean(config.memory_enabled),
        long_term_enabled: Boolean(config.memory_enabled),
        short_term_max: 0,
        auto_summary: false,
        summary_interval: 0,
        stats: { total: Number(memory.total || 0), entries: memory.entries || [] },
      }
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/memory/details`, {}, 10000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/memory/details`, 'Get memory details failed')
    return res.json()
  }

  async clearMemory(): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/memory?scope=all', { method: 'DELETE' })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/memory?scope=all`, 'Clear Runtime memory failed')
      return
    }
    await this.fetchWithHardTimeout(`${this.baseUrl}/api/memory/clear`, { method: 'POST' }, 10000)
  }

  /** Read the editable Rust Runtime configuration projection. */
  async getRuntimeConfig(): Promise<RuntimeConfigSnapshot> {
    if (!this.usesEmbeddedRuntime) this.runtimeUnsupported('读取服务设置')
    const res = await this.runtimeFetch('/config')
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/config`, 'Get Runtime config failed')
    return res.json()
  }

  /** Persist one Rust Runtime setting and apply it to active sessions. */
  async setRuntimeConfig(key: string, value: string | boolean | number): Promise<void> {
    if (!this.usesEmbeddedRuntime) this.runtimeUnsupported('修改服务设置')
    const res = await this.runtimeFetch('/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: String(value), persist: true }),
    })
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/config`, 'Set Runtime config failed')
    await this.reloadConfig()
  }

  /** Clear Rust-owned provider routes, models, credentials and TUI settings. */
  async clearRuntimeCredentials(): Promise<void> {
    if (!this.usesEmbeddedRuntime) this.runtimeUnsupported('清除 Rust Runtime 凭据')
    const res = await this.runtimeFetch('/config/credentials', { method: 'DELETE' }, 30000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/config/credentials`, 'Clear Runtime credentials failed')
  }

  /** Clear Rust-owned provider routes, models, credentials and TUI settings. */
  async clearRuntimeUserData(): Promise<void> {
    if (!this.usesEmbeddedRuntime) this.runtimeUnsupported('清除 Rust Runtime 用户配置')
    const res = await this.runtimeFetch('/config/user-data', { method: 'DELETE' }, 30000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/config/user-data`, 'Clear Runtime user data failed')
  }

  async updateCustomProviderMetadata(providerId: string, body: { display_name?: string; group?: string }): Promise<ProviderMutationResponse> {
    if (!this.usesEmbeddedRuntime) return this.runtimeUnsupported('编辑自定义模型商')
    const path = `/providers/${encodeURIComponent(providerId)}`
    const res = await this.runtimeFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, 'Update custom provider failed')
    return res.json()
  }

  /** Create a durable named OpenAI-compatible provider in Rust Runtime. */
  async createCustomProvider(body: CreateCustomProviderBody): Promise<ProviderMutationResponse> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 30000)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/providers`, 'Create Runtime provider failed')
      return res.json()
    }
    return this.runtimeUnsupported('创建自定义模型商')
  }

  /** Remove a named custom provider. Built-in providers are rejected by Runtime. */
  async deleteCustomProvider(providerId: string): Promise<ProviderMutationResponse> {
    if (this.usesEmbeddedRuntime) {
      const path = `/providers/${encodeURIComponent(providerId)}`
      const res = await this.runtimeFetch(path, { method: 'DELETE' })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, 'Delete Runtime provider failed')
      return res.json()
    }
    return this.runtimeUnsupported('删除自定义模型商')
  }

  async getMemoryStats(): Promise<Record<string, any>> {
    if (this.usesEmbeddedRuntime) {
      const memory = await this.getMemoryDetails()
      return memory.stats
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/memory/stats`, {}, 10000)
    return res.json()
  }

  // ============ 工具与权限 ============

  async getTools(): Promise<ToolsResponse> {
    if (this.usesEmbeddedRuntime) {
      // The Rust engine owns the tool catalog per thread and does not expose
      // the old global enable/disable list. Returning an empty list keeps the
      // Keep the settings view honest instead of querying a removed endpoint.
      return { tools: [] }
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/tools`, {}, 10000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/tools`, 'Get tools failed')
    return res.json()
  }

  async toggleTool(tool_id: string, enabled: boolean): Promise<void> {
    if (this.usesEmbeddedRuntime) return this.runtimeUnsupported(' 工具全局开关')
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/tools/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_id, enabled }),
    }, 10000)
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/tools/toggle`, 'Toggle tool failed')
    }
  }

  // ============ Skills ============

  async listSkills(projectId?: string): Promise<SkillsResponse> {
    const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''
    const path = this.usesEmbeddedRuntime ? `/skills${query}` : `/api/skills${query}`
    const url = this.usesEmbeddedRuntime ? `${this.baseUrl}/v1${path}` : `${this.baseUrl}${path}`
    const res = this.usesEmbeddedRuntime
      ? await this.runtimeFetch(path)
      : await this.fetchWithHardTimeout(url, {}, 10000)
    if (!res.ok) await this._throwForResponse(res, url, 'List Skills failed')
    return res.json()
  }

  async setSkillEnabled(name: string, enabled: boolean, projectId?: string): Promise<void> {
    const encoded = encodeURIComponent(name)
    const path = this.usesEmbeddedRuntime ? `/skills/${encoded}` : `/api/skills/${encoded}`
    const url = this.usesEmbeddedRuntime ? `${this.baseUrl}/v1${path}` : `${this.baseUrl}${path}`
    const body = this.usesEmbeddedRuntime
      ? { enabled }
      : { enabled, ...(projectId ? { project_id: projectId } : {}) }
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
    const res = this.usesEmbeddedRuntime
      ? await this.runtimeFetch(path, init)
      : await this.fetchWithHardTimeout(url, init, 10000)
    if (!res.ok) await this._throwForResponse(res, url, 'Toggle Skill failed')
  }

  async installSkill(
    source: string,
    scope: 'global' | 'project',
    projectId?: string,
  ): Promise<SkillMutationReceipt> {
    const path = this.usesEmbeddedRuntime ? '/skills/install' : '/api/skills/install'
    const url = this.usesEmbeddedRuntime ? `${this.baseUrl}/v1${path}` : `${this.baseUrl}${path}`
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source,
        scope,
        ...(!this.usesEmbeddedRuntime && projectId ? { project_id: projectId } : {}),
      }),
    }
    const res = this.usesEmbeddedRuntime
      ? await this.runtimeFetch(path, init, 60000)
      : await this.fetchWithHardTimeout(url, init, 60000)
    if (!res.ok) await this._throwForResponse(res, url, 'Install Skill failed')
    return res.json()
  }

  async removeSkill(
    name: string,
    scope?: 'global' | 'project',
    projectId?: string,
  ): Promise<SkillMutationReceipt> {
    const params = new URLSearchParams()
    if (scope) params.set('scope', scope)
    if (!this.usesEmbeddedRuntime && projectId) params.set('project_id', projectId)
    const suffix = params.toString() ? `?${params.toString()}` : ''
    const path = `${this.usesEmbeddedRuntime ? '/skills' : '/api/skills'}/${encodeURIComponent(name)}${suffix}`
    const url = this.usesEmbeddedRuntime ? `${this.baseUrl}/v1${path}` : `${this.baseUrl}${path}`
    const res = this.usesEmbeddedRuntime
      ? await this.runtimeFetch(path, { method: 'DELETE' })
      : await this.fetchWithHardTimeout(url, { method: 'DELETE' }, 10000)
    if (!res.ok) await this._throwForResponse(res, url, 'Remove Skill failed')
    return res.json()
  }

  async getPermission(): Promise<PermissionInfo> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/config')
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/config`, 'Get Runtime permission failed')
      const config = await res.json()
      const policy = String(config.approval_mode || '').toLowerCase()
      const mode: PermissionMode = policy === 'auto'
        ? 'auto'
        : policy === 'never' || policy === 'bypass'
          ? 'bypass'
          : 'ask'
      return { mode, available_modes: ['auto', 'ask', 'bypass'] }
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/permission`, {}, 10000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/permission`, 'Get permission failed')
    return res.json()
  }

  async setPermission(mode: PermissionMode, granularRules?: unknown): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const approval_mode = mode === 'auto' ? 'auto' : (mode === 'full_access' || mode === 'bypass') ? 'never' : mode === 'read_only' ? 'never' : 'on-request'
      const res = await this.runtimeFetch('/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'approval_mode', value: approval_mode, persist: true }),
      })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/config`, 'Set Runtime permission failed')
      await this.reloadConfig()
      return
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        granularRules
          ? { mode, granular_rules: granularRules }
          : { mode },
      ),
    }, 10000)
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/permission`, 'Set permission failed')
    }
  }

  // ============ 五档权限 / 审批流（sidecar P1/P2） ============

  /** Pending approvals for a session (sidecar only). */
  async listPendingApprovals(sessionId?: string): Promise<ApprovalRecord[]> {
    if (this.usesEmbeddedRuntime) return []
    const qs = new URLSearchParams({ pending: '1' })
    if (sessionId) qs.set('session_id', sessionId)
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/approvals?${qs.toString()}`, {}, 10000,
    )
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/approvals`, 'List approvals failed')
    const data = await res.json()
    return (data.approvals || []) as ApprovalRecord[]
  }

  /** Approve or deny an approval. decision: 'once' | 'session' | 'deny'. */
  async decideApproval(approvalId: string, decision: 'once' | 'session' | 'deny'): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      // The Runtime API expects "allow" | "deny" (DecideApprovalBody) — the
      // legacy server used "approve". "本会话允许" maps to remember=true.
      await this.decideRuntimeApproval(approvalId, {
        decision: decision === 'deny' ? 'deny' : 'allow',
        remember: decision === 'session',
      })
      return
    }
    const path = decision === 'deny'
      ? `/api/approvals/${encodeURIComponent(approvalId)}/deny`
      : `/api/approvals/${encodeURIComponent(approvalId)}/approve`
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(decision === 'session' ? { scope: 'session' } : {}),
    }, 10000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}${path}`, 'Decide approval failed')
  }

  // ============ 配置导出/导入 / 重载 ============

  async reloadConfig(): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/config/reload', { method: 'POST' })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/config/reload`, 'Reload Runtime config failed')
      return
    }
    await this.fetchWithHardTimeout(`${this.baseUrl}/api/config/reload`, { method: 'POST' }, 10000)
  }

  async exportConfig(): Promise<ExportConfigResponse> {
    if (this.usesEmbeddedRuntime) {
      return { config: await this.getConfig() as unknown as Record<string, any> }
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/config/export`, {}, 10000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/config/export`, 'Export config failed')
    return res.json()
  }

  async importConfig(config: Record<string, any>): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/config/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      }, 30000)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/config/import`, 'Import Runtime config failed')
      return
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/config/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    }, 10000)
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/config/import`, 'Import config failed')
    }
  }

  // ============ 诊断 ============

  async getDiagnostics(): Promise<DiagnosticsInfo> {
    if (this.usesEmbeddedRuntime) {
      const [health, config, providers] = await Promise.all([
        this.health(),
        this.getConfig(),
        this.getProviders(),
      ])
      return {
        status: health.status,
        version: 'rust-runtime',
        ready: health.agent_ready ?? true,
        components: { runtime: 'ok', providers: `${providers.providers.length} registered` },
        registered_providers: providers.providers.map((provider) => provider.id),
        configured_provider: config.model.provider,
        configured_model_name: config.model.model_name,
        model_loaded: true,
        agent_ready: true,
      }
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/diagnostics`, {}, 10000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/diagnostics`, 'Get diagnostics failed')
    return res.json()
  }

  // ============ Phase 5: Metrics ============

  /**
   * 拉取服务端 metrics 快照。失败时返回 null (调用方可显示占位 UI)。
   *
   * 用于 AdvancedPanel 显示 uptime / turns / errors / checkpoints /
   * active websockets / llm_calls 等指标。
   */
  async getMetrics(): Promise<MetricsResponse | null> {
    if (this.usesEmbeddedRuntime) {
      try {
        const res = await this.runtimeFetch('/metrics', {}, 5000)
        if (!res.ok) return null
        const data = await res.json()
        const counters = data.counters || {}
        const errors = data.errors || {}
        return {
          uptime_seconds: Number(data.uptime_seconds || 0),
          total_turns: Number(data.total_turns ?? counters.turns ?? 0),
          total_errors: Number(data.total_errors ?? Object.values(errors).reduce((sum: number, value: any) => sum + Number(value || 0), 0)),
          active_websockets: Number(data.active_websockets || 0),
          // Rust Runtime does not expose the retired Python-only counters.
          checkpoints_saved: Number(data.checkpoints_saved || 0),
          llm_calls: Number(data.llm_calls || 0),
          llm_retries: Number(data.llm_retries || 0),
          by_provider: data.by_provider && typeof data.by_provider === 'object' ? data.by_provider : undefined,
        }
      } catch {
        return null
      }
    }
    try {
      const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/metrics`, {}, 5000)
      if (!res.ok) return null
      return await res.json() as MetricsResponse
    } catch {
      return null
    }
  }

  // ============ TTS ============

  async cloneVoice(audio: Blob, filename = 'voice.wav'): Promise<{ status: string; voice_id?: string; message?: string }> {
    if (this.usesEmbeddedRuntime) {
      const bytes = new Uint8Array(await audio.arrayBuffer())
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
      }
      const path = '/voice/clone'
      const res = await this.runtimeFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_base64: btoa(binary), filename }),
      }, 60000)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, 'Runtime voice clone failed')
      return res.json()
    }
    const form = new FormData()
    form.append('audio', audio, filename)
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/voice/clone`, { method: 'POST', body: form }, 60000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/voice/clone`, 'Voice clone failed')
    return res.json()
  }

  async getVoiceCloneStatus(): Promise<{ status: string; voice_id?: string | null; error?: string; message?: string; progress?: string }> {
    if (this.usesEmbeddedRuntime) {
      const path = '/voice/clone/status'
      const res = await this.runtimeFetch(path)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, 'Get Runtime voice clone status failed')
      return res.json()
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/voice/clone/status`, {}, 10000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/voice/clone/status`, 'Get voice clone status failed')
    return res.json()
  }

  async textToSpeech(text: string, voice?: string, speed?: number): Promise<Blob> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, speed }),
      }, 120000)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/tts`, 'Runtime TTS failed')
      return res.blob()
    }
    const res = await fetch(`${this.baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, speed }),
    })
    if (!res.ok) throw new HakusAIError(`TTS failed: ${res.status}`)
    return res.blob()
  }

  async getTtsVoices(): Promise<TtsVoicesResponse> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/tts/voices')
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/tts/voices`, 'Get Runtime TTS voices failed')
      return res.json()
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/tts/voices`, {}, 10000)
    if (!res.ok) throw new HakusAIError(`Get TTS voices failed: ${res.status}`)
    return res.json()
  }

  async transcribeVoice(
    audio: Blob,
    options?: { provider?: string; language?: string },
  ): Promise<{ text: string }> {
    if (this.usesEmbeddedRuntime) {
      const bytes = new Uint8Array(await audio.arrayBuffer())
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
      }
      const res = await this.runtimeFetch('/voice/asr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_base64: btoa(binary), language: options?.language }),
      }, 120000)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/voice/asr`, 'Runtime voice transcription failed')
      return res.json()
    }
    const form = new FormData()
    form.append('audio', audio, 'voice.wav')
    if (options?.provider) form.append('provider', options.provider)
    if (options?.language) form.append('language', options.language)
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/voice/asr`,
      { method: 'POST', body: form },
      120000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/voice/asr`, 'Voice transcription failed')
    }
    return res.json()
  }

  // ============ 文件上传 ============

  /**
   * 上传文件到 /api/upload (multipart/form-data)。
   * 返回每个文件的元信息 (file_id / filename / size / content_type / is_text)，
   * 文本文件还会带 text_preview。
   *
   * 注意: FormData 由浏览器自动设置 Content-Type + boundary, 这里不能手动设置。
   */
  async uploadFiles(files: File[]): Promise<UploadedFile[]> {
    if (files.length === 0) return []
    if (this.usesEmbeddedRuntime) {
      const payload = await Promise.all(files.map(async (file) => {
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
        }
        return { filename: file.name, content_type: file.type || undefined, data_base64: btoa(binary) }
      }))
      const res = await this.runtimeFetch('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: payload }),
      }, 60000)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/upload`, 'Runtime upload failed')
      const data = await res.json()
      return data.files as UploadedFile[]
    }
    const formData = new FormData()
    files.forEach((f) => formData.append('files', f))
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/upload`,
      { method: 'POST', body: formData },
      60000, // generous — large file uploads can take a while
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/upload`, 'Upload failed')
    }
    const data = await res.json()
    return data.files as UploadedFile[]
  }

  /** 列出已上传的文件 (GET /api/files)。供 @ 提及菜单使用。 */
  async listFiles(): Promise<UploadedFile[]> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/files')
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/files`, 'List Runtime files failed')
      const data = await res.json()
      return data.files as UploadedFile[]
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/files`, {}, 10000)
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/files`, 'List files failed')
    }
    const data = await res.json()
    return data.files as UploadedFile[]
  }

  // ============ Non-streaming chat ============

  async chat(message: string, sessionId = 'default', provider?: string): Promise<ChatResponse> {
    if (this.usesEmbeddedRuntime) {
      // The Rust Runtime intentionally exposes one replayable streaming
      // primitive. Preserve the legacy promise-based API by consuming that
      // stream internally and returning the accumulated assistant text.
      let content = ''
      await this.chatStreamEmbedded(
        message,
        sessionId,
        (chunk) => { if (chunk.content) content += chunk.content },
        undefined,
        provider,
      )
      return { content, session_id: sessionId }
    }
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        session_id: sessionId,
        stream: false,
        ...(provider ? { provider } : {}),
      } satisfies ChatRequest),
      signal: AbortSignal.timeout(this.timeout * 4),
    })
    if (!res.ok) {
      throw new HakusAIError(`Chat failed: ${res.status} ${await res.text()}`)
    }
    return res.json()
  }

  // ============ SSE streaming chat (recommended) ============

  /**
   * 使用 fetch + ReadableStream 解析 SSE.
   *
   * Runtime 服务端发送的数据格式:
   *   data: {"content":"...","emotion":"happy","done":false}\n\n
   *   data: {"done":true}\n\n
   *
   * 本客户端同时支持未来扩展为 AgentEvent 格式:
   *   data: {"event_type":"text_delta","text":"..."}\n\n
   *   data: {"event_type":"tool_call_started",...}\n\n
   *   data: {"event_type":"turn_completed",...}\n\n
   */
  async chatStream(
    message: string,
    sessionId: string,
    onChunk: StreamHandler,
    signal?: AbortSignal,
    provider?: string,
    runMode?: AgentMode,
    reasoningEffort?: string,
    projectId?: string,
    model?: string,
    longRunningGoal = false,
    providerId?: string,
  ): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      await this.chatStreamEmbedded(message, sessionId, onChunk, signal, model || provider, runMode, projectId, reasoningEffort, longRunningGoal, providerId ?? provider)
      return
    }
    const res = await fetch(`${this.baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        message,
        session_id: sessionId,
        stream: true,
        ...(provider ? { provider } : {}),
        ...(runMode ? { run_mode: runMode } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(projectId ? { project_id: projectId } : {}),
      } satisfies ChatRequest),
      signal,
    })

    if (!res.ok || !res.body) {
      throw new HakusAIError(`Stream failed: ${res.status} ${await res.text()}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // Keep incomplete last line in buffer
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6).trim()
          if (!payload) continue

          try {
            const parsed = JSON.parse(payload)
            // Detect AgentEvent format
            if (parsed.event_type) {
              const event = parsed as AgentEvent
              onChunk(this.eventToChunk(event), event)
            } else {
              onChunk(parsed as ChatStreamChunk)
            }
          } catch (e) {
            console.warn('Failed to parse SSE chunk:', payload, e)
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /** Start a turn on the existing Runtime thread and consume its replayable SSE stream. */
  private async chatStreamEmbedded(
    message: string,
    threadId: string,
    onChunk: StreamHandler,
    signal?: AbortSignal,
    provider?: string,
    runMode?: AgentMode,
    projectId?: string,
    reasoningEffort?: string,
    longRunningGoal = false,
    providerId?: string,
  ): Promise<void> {
    const project = projectId
      ? (await this.listProjects()).find((candidate) => candidate.id === projectId) || null
      : null
    const workspace = project?.path || (projectId ? this.runtimeProjectPaths.get(projectId) : undefined)
    if (workspace) {
      await refreshProjectFolder({ path: workspace, sourceUri: project?.source_uri })
      const workspaceUrl = `${this.baseUrl}/v1/threads/${encodeURIComponent(threadId)}`
      const workspaceResponse = await this.runtimeFetch(`/threads/${encodeURIComponent(threadId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace }),
        signal,
      })
      if (!workspaceResponse.ok) {
        await this._throwForResponse(workspaceResponse, workspaceUrl, 'Set Runtime project workspace failed')
      }
    }
    // The GUI sends its CURRENT model + provider with every turn. Re-point
    // the thread's pinned route first, so route resolution follows the
    // user's latest provider choice instead of failing with "model X is not
    // served by direct provider Y" on threads that already have turn history.
    if (provider) {
      try {
        await this.runtimeFetch(`/threads/${encodeURIComponent(threadId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: provider,
            ...(providerId ? { model_provider: providerId, model_provider_id: providerId } : {}),
          }),
          signal,
        })
      } catch (error) {
        // Best-effort on older runtimes without model PATCH support.
        console.warn('[runtime] thread model re-point failed:', error)
      }
    }
    // The shared Runtime already treats `$skill-name` as an explicit Skill
    // invocation. Keep the desktop UI's @ mention syntax while translating
    // only the wire prompt on Android.
    const runtimePrompt = toRuntimeSkillMentions(message)
    const start = await this.runtimeFetch(`/threads/${encodeURIComponent(threadId)}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: runtimePrompt,
        ...(provider ? { model: provider } : {}),
        // Explicit provider identity: makes this turn's route authoritative
        // (and heals the thread's pinned provider) instead of falling back
        // to the runtime's default provider.
        ...(providerId ? { model_provider: providerId, model_provider_id: providerId } : {}),
        // The Runtime speaks plan/act/operate — the UI's swift/deep map onto
        // act (daily work) and operate (full power) respectively.
        ...(runMode ? { mode: runtimeModeFromAgentMode(runMode) } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(runMode === 'deep' && embeddedBrowserAvailable()
          ? { dynamic_tools: [BROWSER_DYNAMIC_TOOL] }
          : {}),
      }),
      signal,
    })
    if (!start.ok) {
      await this._throwForResponse(start, `${this.baseUrl}/v1/threads/${threadId}/turns`, 'Start Runtime turn failed')
    }
    const started = await start.json()
    const turnId = started?.turn?.id
    if (!turnId) throw new HakusAIError('Runtime did not return a turn id')

    // Aborting the SSE fetch only disconnects the reader — the Runtime keeps
    // executing the turn server-side. Fire the interrupt endpoint when the
    // UI aborts (stop button, rewind, voice interruption) so the turn is
    // actually cancelled. Best-effort: errors are swallowed.
    const interruptOnAbort = () => {
      void this.runtimeFetch(
        `/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      ).catch((error) => {
        console.warn('[runtime] turn interrupt failed:', error)
      })
    }
    signal?.addEventListener('abort', interruptOnAbort, { once: true })

    const res = await this.runtimeFetch(
      `/threads/${encodeURIComponent(threadId)}/events?since_seq=0`,
      { headers: { Accept: 'text/event-stream' }, signal },
      0,
    )
    if (!res.ok || !res.body) {
      throw new HakusAIError(`Runtime event stream failed: ${res.status} ${await res.text()}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let eventName = ''
    let activeGoalStatus = longRunningGoal ? 'active' : 'none'
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim()
            continue
          }
          if (!line.startsWith('data:')) continue
          const envelope = JSON.parse(line.slice(5).trim())
          if (!longRunningGoal && envelope.turn_id && envelope.turn_id !== turnId) continue
          const event = this.runtimeEventToAgentEvent(eventName || envelope.event, envelope.payload || envelope)
          if (event) onChunk(this.eventToChunk(event), event)
          if (eventName === 'thread_goal_updated') {
            activeGoalStatus = String((envelope.payload || envelope).goal?.status || 'active')
          } else if (eventName === 'thread_goal_cleared') {
            activeGoalStatus = 'cleared'
          }
          if (eventName === 'turn.completed') {
            if (longRunningGoal && !['complete', 'blocked', 'paused', 'usage_limited', 'budget_limited', 'cleared'].includes(activeGoalStatus)) {
              continue
            }
            onChunk({ done: true })
            if (project) {
              try {
                await syncProjectFolder({ path: project.path, sourceUri: project.source_uri })
              } catch (error) {
                // A completed turn remains visible if the user revoked the
                // SAF grant while the stream was running.
                console.warn('[runtime] project sync failed:', error)
              }
            }
            return
          }
          if (eventName === 'turn.failed' || eventName === 'turn.canceled' || eventName === 'turn.interrupted') {
            return
          }
        }
      }
    } finally {
      signal?.removeEventListener('abort', interruptOnAbort)
      reader.releaseLock()
    }
  }

  private runtimeEventToAgentEvent(name: string, payload: any): AgentEvent | null {
    switch (name) {
      case 'tool_call.requested':
        if (payload.namespace !== 'browser' || payload.tool !== 'control') return null
        return {
          event_type: 'browser_tool_requested',
          thread_id: String(payload.thread_id || ''),
          turn_id: String(payload.turn_id || ''),
          call_id: String(payload.call_id || ''),
          arguments: payload.arguments || {},
        } as AgentEvent
      case 'item.delta':
        if (payload.kind === 'agent_message') return { event_type: 'text_delta', text: String(payload.delta || '') }
        if (payload.kind === 'agent_reasoning') return { event_type: 'reasoning_delta', text: String(payload.delta || '') }
        return null
      case 'item.started': {
        // The user-message item carries the runtime's durable item id. The
        // UI creates its local message with a client-generated id (`m_…`)
        // before the turn starts; rewinding needs the runtime item id, so
        // surface it for the UI to bind to its local user message.
        if (payload.kind === 'user_message' || payload.item?.kind === 'user_message') {
          const item = payload.item || payload
          return { event_type: 'remote_message_id', remote_id: String(item.id || '') } as any
        }
        const tool = payload.tool || payload
        return {
          event_type: 'tool_call_started',
          call_id: String(tool.id || tool.call_id || ''),
          name: String(tool.name || ''),
          arguments: tool.input || tool.arguments || {},
        }
      }
      case 'item.completed':
      case 'item.failed': {
        const item = payload.item || payload
        // A failed error item IS the turn's error surface — dropping it left
        // the chat showing an empty assistant bubble on provider failures.
        if (item.kind === 'error') {
          return {
            event_type: 'turn_failed',
            code: 'RUNTIME_ERROR',
            error: String(item.summary || item.detail || 'Turn failed'),
          }
        }
        if (item.kind !== 'tool_call' && item.kind !== 'command_execution' && item.kind !== 'file_change') return null
        // The tool name must come from item.metadata.tool_name (or the nested
        // tool envelope on item.started). item.summary is a human receipt like
        // "tool_search: {...}" — falling back to it made the whole JSON blob
        // render as the tool name.
        const toolName = String(
          item.tool?.name
            || item.metadata?.tool_name
            || item.name
            || '',
        )
        return {
          event_type: 'tool_call_finished',
          call_id: String(item.tool?.id || item.id || ''),
          name: toolName,
          result: String(item.detail || item.summary || ''),
          success: name === 'item.completed',
          duration: 0,
          arguments: item.tool?.input || item.input || {},
        }
      }
      case 'approval.required': {
        // The Runtime gates dangerous tool calls behind an approval request.
        // Without this mapping the card never renders and the request times
        // out (300s) into an automatic deny.
        return {
          event_type: 'approval_required',
          approval: {
            id: String(payload.approval_id || payload.id || ''),
            session_id: String(payload.thread_id || ''),
            tool: String(payload.tool_name || 'tool'),
            action_key: String(payload.intent_summary || payload.tool_name || ''),
            reason: String(payload.description || ''),
            approver: 'runtime',
            status: 'pending',
          } as ApprovalRecord,
        } as AgentEvent
      }
      case 'user_input.required': {
        const request = payload.request || {}
        const question = request.questions?.[0]
        if (!question) return null
        return {
          event_type: 'question_asked',
          question_id: String(payload.input_id || payload.id || question.id),
          question: String(question.question || ''),
          options: (question.options || []).map((option: any) => String(option.label || option)),
          allow_free_text: Boolean(question.allow_free_text),
        }
      }
      case 'user_input.answered':
        return { event_type: 'question_answered', question_id: String(payload.input_id || payload.id || ''), choice: String(payload.choice || '') }
      case 'turn.completed': {
        const turnRecord = payload.turn || {}
        if (turnRecord.status === 'failed' || turnRecord.error) {
          return {
            event_type: 'turn_failed',
            code: 'RUNTIME_ERROR',
            error: String(turnRecord.error || 'Turn failed'),
          }
        }
        const usage = payload.usage || payload.turn?.usage || {}
        return {
          event_type: 'turn_completed',
          content: '',
          tool_calls: [],
          iterations: 0,
          total_time: 0,
          input_tokens: Number(usage.input_tokens || 0),
          output_tokens: Number(usage.output_tokens || 0),
          compressed: false,
        }
      }
      case 'turn.failed':
        return { event_type: 'turn_failed', code: 'RUNTIME_ERROR', error: String(payload.error || payload.message || 'Runtime turn failed') }
      case 'thread_goal_updated':
        return { event_type: 'goal_updated', goal: payload.goal || null } as AgentEvent
      case 'thread_goal_cleared':
        return { event_type: 'goal_updated', goal: null, cleared: true } as AgentEvent
      default:
        return null
    }
  }

  /**
   * 把 AgentEvent 转换为简单的 ChatStreamChunk,
   * 这样上层 UI 可以同时处理两种格式.
   */
  private eventToChunk(event: AgentEvent): ChatStreamChunk {
    switch (event.event_type) {
      case 'text_delta':
        return { content: (event as any).text || (event as any).content, done: false }
      case 'turn_completed':
        return { content: event.content, done: true }
      case 'turn_failed':
        return { error: event.error, done: true }
      case 'cancelled':
        return { content: event.partial_content, done: true }
      case 'token_usage':
        // Token usage is metadata, no direct chunk content
        return { done: false }
      case 'question_asked':
      case 'question_answered':
        // Interactive questions are surfaced via the event parameter
        return { done: false }
      default:
        // Other events (tool_call_*, orchestrator_phase_changed, etc.)
        // are surfaced via the event parameter to onChunk
        return { done: false }
    }
  }

  // ============ Interactive question (ask_user tool) ============

  async answerQuestion(sessionId: string, questionId: string, choice: string): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch(`/user-input/${encodeURIComponent(sessionId)}/${encodeURIComponent(questionId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: [{ id: questionId, label: choice, value: choice }] }),
      })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/user-input/${sessionId}/${questionId}`, 'Answer Runtime question failed')
      return
    }
    const res = await this.fetchWithHardTimeout(
      `${this.baseUrl}/api/question/answer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, question_id: questionId, choice }),
      },
      10000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/question/answer`, 'Answer question failed')
    }
  }

  // ============ WebSocket chat (full-duplex, supports interrupt) ============
  //
  // Phase 4: 增强版 — 自动重连 + 响应服务端 ping + resume session

  /**
   * 连接 WebSocket, 带自动重连。
   *
   * 调用方传的 onMessage/onError/onClose 会被客户端持有, 重连时重新绑定到
   * 新的 WebSocket 实例上 — 调用方无需感知重连。
   *
   * 可选 onReconnect: 每次重连成功后调一次, 通知调用方 "刚才断过线, 已恢复"
   * (调用方可以用来刷新 UI 状态 / 显示 toast)。
   */
  wsConnect(
    onMessage: (msg: WSIncomingMessage) => void,
    onError?: (e: Event) => void,
    onClose?: (e: CloseEvent) => void,
    onReconnect?: (attempt: number, sessionId: string | null) => void,
  ): void {
    // 持有回调供重连时重新绑定
    this._wsOnMessage = onMessage
    this._wsOnError = onError ?? null
    this._wsOnClose = onClose ?? null
    this._wsOnReconnect = onReconnect ?? null
    this._wsManualClose = false
    this._wsReconnectAttempts = 0
    this._wsConnectInternal()
  }

  /**
   * 内部: 创建一个 WebSocket 实例并绑定事件处理器。
   * 不直接调, 走 wsConnect 或 _scheduleReconnect。
   */
  private _wsConnectInternal(): void {
    if (this.ws && this.ws.readyState <= 1) {
      this.ws.onclose = null  // 防止触发旧 ws 的 onclose 重连
      this.ws.close()
    }
    this.ws = new WebSocket(`${this.wsBaseUrl}/ws/chat`)

    this.ws.onopen = () => {
      // 重连成功 (attempts > 0 说明不是首次连接)
      const wasReconnect = this._wsReconnectAttempts > 0
      this._wsReconnectAttempts = 0
      if (wasReconnect && this._wsActiveSessionId) {
        // Phase 4: 重连后发 resume_session, 让服务端确认 session 仍可恢复
        try {
          this.ws!.send(JSON.stringify({
            type: 'resume_session',
            session_id: this._wsActiveSessionId,
          }))
        } catch (err) {
          console.warn('[WS] resume_session send failed:', err)
        }
        this._wsOnReconnect?.(0, this._wsActiveSessionId)
      } else if (wasReconnect) {
        this._wsOnReconnect?.(0, null)
      }
    }

    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as WSIncomingMessage
        // Phase 4: 服务端主动 ping → 客户端立刻回 pong
        if (data.type === 'ping') {
          try {
            this.ws?.send(JSON.stringify({ type: 'pong' }))
          } catch (err) {
            // 连接可能已关闭, 忽略
          }
          // ping 也是个 "连接还活着" 的信号, 不再继续走 onMessage
          // (但仍然交给 onMessage, 让调用方可以记录 RTT)
        }
        this._wsOnMessage?.(data)
      } catch (err) {
        console.error('Failed to parse WS message:', err)
      }
    }

    this.ws.onerror = (e) => {
      this._wsOnError?.(e)
    }

    this.ws.onclose = (e) => {
      this._wsOnClose?.(e)
      // 手动 close 不重连
      if (this._wsManualClose) return
      this._scheduleReconnect()
    }
  }

  /**
   * 指数退避重连。第 N 次重连延迟 = min(baseDelay * 2^(N-1), maxDelay)。
   * 第 1 次 1s, 2 次 2s, 3 次 4s, 4 次 8s, 5 次 16s, 6+ 次 30s。
   */
  private _scheduleReconnect(): void {
    if (this._wsReconnectAttempts >= this._wsMaxReconnectAttempts) {
      console.error(
        `[WS] Max reconnect attempts (${this._wsMaxReconnectAttempts}) reached, giving up. ` +
        `Call wsConnect() again to retry.`
      )
      return
    }
    this._wsReconnectAttempts += 1
    const attempt = this._wsReconnectAttempts
    const delay = Math.min(
      this._wsBaseReconnectDelayMs * Math.pow(2, attempt - 1),
      this._wsMaxReconnectDelayMs,
    )
    console.warn(
      `[WS] scheduling reconnect attempt ${attempt}/${this._wsMaxReconnectAttempts} in ${delay}ms`
    )
    if (this._wsReconnectTimer) clearTimeout(this._wsReconnectTimer)
    this._wsReconnectTimer = setTimeout(() => {
      this._wsReconnectTimer = null
      this._wsConnectInternal()
    }, delay)
  }

  /**
   * 立即取消任何待重连 (用于 wsDisconnect / setBaseUrl)。
   */
  private _wsCancelReconnect(): void {
    if (this._wsReconnectTimer) {
      clearTimeout(this._wsReconnectTimer)
      this._wsReconnectTimer = null
    }
    this._wsReconnectAttempts = 0
  }

  wsSend(msg: WSOutgoingMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      // 记录当前 session_id 供重连后 resume
      if (msg.type === 'message' && msg.session_id) {
        this._wsActiveSessionId = msg.session_id
      }
    } else {
      throw new HakusAIError('WebSocket is not connected')
    }
  }

  wsInterrupt(sessionId?: string): void {
    // 记录 session_id 供重连后 resume
    if (sessionId) this._wsActiveSessionId = sessionId
    this.wsSend({ type: 'interrupt', session_id: sessionId })
  }

  /**
   * 主动断开, 不再重连。如需重连, 调用方需重新调 wsConnect()。
   */
  wsDisconnect(): void {
    this._wsManualClose = true
    this._wsCancelReconnect()
    if (this.ws) {
      this.ws.onclose = null  // 防止触发自动重连
      try { this.ws.close() } catch {}
      this.ws = null
    }
  }

  get wsConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /**
   * 当前重连尝试次数 (0 = 已连接或未连接过)。
   * 调用方可以用来在 UI 上显示 "重连中 (3/10)"。
   */
  get wsReconnectAttempts(): number {
    return this._wsReconnectAttempts
  }

  /**
   * 设置当前活跃 session_id — 重连后会自动 resume 这个 session。
   * ChatView 应在切换 session 时调这个。
   */
  wsSetActiveSession(sessionId: string | null): void {
    this._wsActiveSessionId = sessionId
  }

  // ============ Session persistence (SQLite) ============
  //
  // Sessions + messages live in ~/.hakus/sessions.db on the backend.
  // The frontend uses these endpoints instead of localStorage so that:
  //   1. Chat history survives browser cache clears
  //   2. No 5-10 MB localStorage cap
  //   3. Backup story is "copy ~/.hakus"
  //
  // During SSE streaming, the frontend keeps incoming text_delta chunks
  // in-memory only; when the stream finishes (turn_completed /
  // turn_failed / aborted), it PATCHes the final message once with the
  // complete content + reasoning + tool_calls + tokens.

  /** List all sessions (no messages), newest first. */
  async listSessions(): Promise<ServerSession[]> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/threads/summary?limit=500')
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/threads/summary`, 'List Runtime threads failed')
      const threads = await res.json()
      return (threads || []).map((thread: any) => this.runtimeSession(thread))
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/sessions`, {}, 10000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/sessions`, 'List sessions failed')
    const data = await res.json()
    return data.sessions as ServerSession[]
  }

  /** Get one session with all its messages. */
  async getSession(sessionId: string): Promise<ServerSession & { messages: ServerMessage[] }> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/threads/${encodeURIComponent(sessionId)}`
      const res = await this.runtimeFetch(`/threads/${encodeURIComponent(sessionId)}`)
      if (!res.ok) await this._throwForResponse(res, url, 'Get Runtime thread failed')
      const detail = await res.json()
      return {
        ...this.runtimeSession(detail.thread),
        messages: (detail.items || [])
          .map((item: any) => this.runtimeMessage(sessionId, item))
          .filter((item: ServerMessage | null): item is ServerMessage => item !== null),
      }
    }
    const url = `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`
    const res = await this.fetchWithHardTimeout(url, {}, 10000)
    if (!res.ok) await this._throwForResponse(res, url, 'Get session failed')
    return res.json()
  }

  /** Create a new session. */
  async createSession(body: SessionCreateBody): Promise<ServerSession> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: body.title || 'New Chat',
          mode: 'agent',
          archived: false,
        }),
      })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/threads`, 'Create Runtime thread failed')
      const runtimeSession = this.runtimeSession(await res.json())
      return {
        ...runtimeSession,
        id: body.id,
        remote_session_id: runtimeSession.id,
      }
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 10000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/sessions`, 'Create session failed')
    return res.json()
  }

  /** Patch a session's title / pinned / provider / remote_session_id. */
  async updateSession(sessionId: string, body: SessionUpdateBody): Promise<ServerSession> {
    if (this.usesEmbeddedRuntime) {
      if (body.title === undefined) return (await this.getSession(sessionId))
      const url = `${this.baseUrl}/v1/threads/${encodeURIComponent(sessionId)}`
      const res = await this.runtimeFetch(`/threads/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(body.title !== undefined ? { title: body.title } : {}),
        }),
      })
      if (!res.ok) await this._throwForResponse(res, url, 'Update Runtime thread failed')
      return this.runtimeSession(await res.json())
    }
    const url = `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`
    const res = await this.fetchWithHardTimeout(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 10000)
    if (!res.ok) await this._throwForResponse(res, url, 'Update session failed')
    return res.json()
  }

  /**
   * Interrupt a Runtime thread's still-running turn so deletion can proceed.
   *
   * `DELETE /v1/threads/{id}` answers 409 "has an active turn" while an engine
   * turn is in flight. A turn can outlive the UI that started it (reload,
   * second device, crash), so the delete flow resolves the conflict itself:
   * find the active turn in the thread's durable snapshot, fire the interrupt
   * endpoint, poll until the turn lands in a terminal state, then let the
   * caller retry the delete. Returns true when no active turn remains.
   */
  private async interruptActiveRuntimeTurn(threadId: string): Promise<boolean> {
    const isActiveStatus = (status: unknown) => status === 'queued' || status === 'in_progress'
    const listTurns = async () => {
      const detailRes = await this.runtimeFetch(`/threads/${encodeURIComponent(threadId)}`)
      // 404 here means the thread disappeared mid-flow — deletable by definition.
      if (detailRes.status === 404) return null
      if (!detailRes.ok) throw new HakusAIError(`Get Runtime thread failed: ${detailRes.status}`)
      const detail = await detailRes.json()
      return Array.isArray(detail?.turns) ? (detail.turns as Array<{ id?: string; status?: string }>) : []
    }
    try {
      const turns = await listTurns()
      if (turns === null) return true
      const active = [...turns].reverse().find((turn) => isActiveStatus(turn?.status))
      if (!active?.id) return true
      // Best-effort: if the turn finished between the snapshot and this call,
      // the Runtime answers 409 "No active turn" — the thread is deletable
      // either way, so swallow the outcome.
      await this.runtimeFetch(
        `/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(active.id)}/interrupt`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      ).catch(() => undefined)
      // The interrupt request returns before the engine settles its status;
      // wait for the durable projection to leave queued/in_progress. Bounded
      // so a wedged engine cannot hang the delete forever.
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        const pollTurns = await listTurns()
        if (pollTurns === null) return true
        if (!pollTurns.some((turn) => isActiveStatus(turn?.status))) return true
      }
      return false
    } catch {
      return false
    }
  }

  /** Delete a session + cascade its messages. */
  async deleteSession(sessionId: string): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/threads/${encodeURIComponent(sessionId)}`
      const requestDelete = () => this.runtimeFetch(`/threads/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      })
      let res = await requestDelete()
      // Deletion is intentionally idempotent from the UI's perspective. A
      // stale local row may outlive a Runtime thread after a restart or a
      // second device removed it; that state is already the desired result.
      if (res.status === 404) return
      // The Runtime refuses to delete a thread whose turn is still running.
      // Interrupt the turn, wait for it to settle, then retry once.
      if (res.status === 409 && await this.interruptActiveRuntimeTurn(sessionId)) {
        res = await requestDelete()
        if (res.status === 404) return
      }
      if (!res.ok) await this._throwForResponse(res, url, 'Delete Runtime thread failed')
      return
    }
    const url = `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`
    const res = await this.fetchWithHardTimeout(url, { method: 'DELETE' }, 10000)
    if (res.status === 404) return
    if (!res.ok) await this._throwForResponse(res, url, 'Delete session failed')
  }

  /** Add a message (user msg, or assistant placeholder before stream starts). */
  async addMessage(sessionId: string, body: MessageCreateBody): Promise<ServerMessage> {
    if (this.usesEmbeddedRuntime) {
      // Runtime threads durably record user and assistant items as part of a
      // turn. The UI still calls this for its optimistic local transcript.
      return {
        id: body.id,
        session_id: sessionId,
        role: body.role || 'user',
        content: body.content || '',
        reasoning: body.reasoning || null,
        tool_calls: body.tool_calls || [],
        input_tokens: body.input_tokens ?? null,
        output_tokens: body.output_tokens ?? null,
        error: body.error ?? null,
        streaming: body.streaming ?? false,
        created_at: body.created_at || Date.now(),
        updated_at: body.updated_at || Date.now(),
      }
    }
    const url = `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`
    const res = await this.fetchWithHardTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 10000)
    if (!res.ok) await this._throwForResponse(res, url, 'Add message failed')
    return res.json()
  }

  /** Patch a message (used at stream end to write the final content). */
  async updateMessage(sessionId: string, messageId: string, body: MessageUpdateBody): Promise<ServerMessage> {
    if (this.usesEmbeddedRuntime) {
      return {
        id: messageId,
        session_id: sessionId,
        role: 'assistant',
        content: body.content || '',
        reasoning: body.reasoning || null,
        tool_calls: body.tool_calls || [],
        input_tokens: body.input_tokens ?? null,
        output_tokens: body.output_tokens ?? null,
        error: body.error ?? null,
        streaming: body.streaming ?? false,
        created_at: Date.now(),
        updated_at: Date.now(),
      }
    }
    const url = `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`
    const res = await this.fetchWithHardTimeout(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 10000)
    if (!res.ok) await this._throwForResponse(res, url, 'Update message failed')
    return res.json()
  }

  /** Delete a single message. */
  async deleteMessage(sessionId: string, messageId: string): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const path = `/threads/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`
      const res = await this.runtimeFetch(path, { method: 'DELETE' })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, 'Delete Runtime message failed')
      return
    }
    const url = `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`
    const res = await this.fetchWithHardTimeout(url, { method: 'DELETE' }, 10000)
    if (!res.ok) await this._throwForResponse(res, url, 'Delete message failed')
  }

  /**
   * Backend atomic rewind — deletes the given message_id AND all
   * messages after it, plus truncates the session log to the
   * corresponding turn boundary. Returns the count of deleted
   * messages. Use this instead of the client-side `deleteMessage`
   * loop when you want the log to stay consistent with the message
   * store (i.e. always, for the "撤回此轮" button).
   */
  async rewindSessionToMessage(sessionId: string, messageId: string): Promise<{ deleted_messages: number }> {
    if (this.usesEmbeddedRuntime) {
      const path = `/threads/${encodeURIComponent(sessionId)}/rewind`
      const res = await this.runtimeFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id: messageId }),
      }, 15000)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, 'Rewind Runtime session failed')
      return res.json()
    }
    const url = `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/rewind`
    const res = await this.fetchWithHardTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id: messageId }),
      },
      15000,
    )
    if (!res.ok) await this._throwForResponse(res, url, 'Rewind session failed')
    return res.json()
  }

  /** Get the append-only session log (JSONL events). */
  async getSessionLog(sessionId: string, opts?: { sinceTurn?: number; limit?: number }): Promise<{
    session_id: string
    events: SessionLogEvent[]
    stats: SessionLogStats
  }> {
    if (this.usesEmbeddedRuntime) {
      const params = new URLSearchParams()
      if (opts?.sinceTurn !== undefined) params.set('since_turn', String(opts.sinceTurn))
      if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
      const query = params.toString() ? `?${params.toString()}` : ''
      const path = `/threads/${encodeURIComponent(sessionId)}/event-log${query}`
      const url = `${this.baseUrl}/v1${path}`
      const res = await this.runtimeFetch(path)
      if (!res.ok) await this._throwForResponse(res, url, 'Get Runtime session log failed')
      return res.json()
    }
    const params = new URLSearchParams()
    if (opts?.sinceTurn) params.set('since_turn', String(opts.sinceTurn))
    if (opts?.limit) params.set('limit', String(opts.limit))
    const qs = params.toString() ? `?${params.toString()}` : ''
    const url = `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/log${qs}`
    const res = await this.fetchWithHardTimeout(url, {}, 10000)
    if (!res.ok) await this._throwForResponse(res, url, 'Get session log failed')
    return res.json()
  }

  /** Manually trigger session log compaction. */
  async compactSessionLog(sessionId: string): Promise<{ session_id: string; stats: SessionLogStats }> {
    if (this.usesEmbeddedRuntime) {
      // Runtime event logs are compacted through the thread endpoint. Read
      // the projection back afterwards so callers keep the legacy stats
      // contract used by the review panel.
      await this.compactRuntimeThread(sessionId, {})
      const compacted = await this.getSessionLog(sessionId)
      return { session_id: sessionId, stats: compacted.stats }
    }
    const url = `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/log/compact`
    const res = await this.fetchWithHardTimeout(url, { method: 'POST' }, 15000)
    if (!res.ok) await this._throwForResponse(res, url, 'Compact session log failed')
    return res.json()
  }

  /** Clear the session log (live + archive). */
  async clearSessionLog(sessionId: string): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const path = `/threads/${encodeURIComponent(sessionId)}/event-log`
      const res = await this.runtimeFetch(path, { method: 'DELETE' })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, 'Clear Runtime session log failed')
      return
    }
    const url = `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/log`
    const res = await this.fetchWithHardTimeout(url, { method: 'DELETE' }, 10000)
    if (!res.ok) await this._throwForResponse(res, url, 'Clear session log failed')
  }

  /** Clear all messages in a session (keeps the session row). */
  async clearSessionMessages(sessionId: string): Promise<{ deleted_messages: number }> {
    if (this.usesEmbeddedRuntime) {
      const path = `/threads/${encodeURIComponent(sessionId)}/messages`
      const res = await this.runtimeFetch(path, { method: 'DELETE' })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, 'Clear Runtime session messages failed')
      const data = await res.json()
      return { deleted_messages: Number(data.deleted_items || 0) }
    }
    const url = `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`
    const res = await this.fetchWithHardTimeout(url, { method: 'DELETE' }, 10000)
    if (!res.ok) await this._throwForResponse(res, url, 'Clear session messages failed')
    return res.json()
  }

  /** Bulk import sessions + messages (idempotent INSERT OR REPLACE). */
  async migrateSessions(body: BulkImportBody): Promise<{ imported: { sessions: number; messages: number } }> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/sessions/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 60000)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/sessions/migrate`, 'Migrate Runtime sessions failed')
      return res.json()
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/sessions/migrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 30000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/sessions/migrate`, 'Migrate sessions failed')
    return res.json()
  }

  /** Export all sessions + messages as a single JSON (for backup/restore). */
  async exportSessions(): Promise<BulkImportBody & { schema_version: number; exported_at: number }> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/sessions/export', {}, 60000)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/sessions/export`, 'Export Runtime sessions failed')
      return res.json()
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/sessions/export`, {}, 30000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/sessions/export`, 'Export sessions failed')
    return res.json()
  }

  /** Wipe ALL sessions + messages. Dangerous — frontend must confirm. */
  async wipeAllSessions(): Promise<{ deleted_sessions: number }> {
    if (this.usesEmbeddedRuntime) {
      const sessions = await this.listSessions()
      await Promise.all(sessions.map((session) => this.deleteSession(session.id)))
      return { deleted_sessions: sessions.length }
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/sessions`, { method: 'DELETE' }, 10000)
    if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/api/sessions`, 'Wipe sessions failed')
    return res.json()
  }

  // ---- 微信 ClawBot ----
  async getWeChatStatus(): Promise<WeChatStatus> {
    if (this.usesEmbeddedRuntime) {
      const res = await this.runtimeFetch('/wechat/status')
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1/wechat/status`, 'Get Runtime WeChat status failed')
      return res.json()
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/wechat/status`, {}, 10000)
    if (!res.ok) await this._throwForResponse(res, 'wechat/status', 'Get wechat status failed')
    return res.json()
  }

  async weChatSetAutoReply(enabled: boolean): Promise<{ enabled: boolean }> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/wechat/settings`
      const res = await this.runtimeFetch('/wechat/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) await this._throwForResponse(res, url, 'Save WeChat settings failed')
      return res.json()
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/wechat/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }, 10000)
    if (!res.ok) await this._throwForResponse(res, 'wechat/settings', 'Save WeChat settings failed')
    return res.json()
  }

  async weChatLogin(): Promise<{ status: string; qrcode_base64?: string }> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/wechat/login`
      const res = await this.runtimeFetch('/wechat/login', { method: 'POST' }, 30000)
      if (!res.ok) await this._throwForResponse(res, url, 'Runtime WeChat login failed')
      return res.json()
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/wechat/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, 30000)
    if (!res.ok) await this._throwForResponse(res, 'wechat/login', 'WeChat login failed')
    return res.json()
  }

  async weChatDisconnect(): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/wechat/logout`
      const res = await this.runtimeFetch('/wechat/logout', { method: 'POST' })
      if (!res.ok) await this._throwForResponse(res, url, 'Runtime WeChat logout failed')
      return
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/wechat/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, 10000)
    if (!res.ok) await this._throwForResponse(res, 'wechat/disconnect', 'WeChat disconnect failed')
  }

  async weChatSend(userId: string, text: string): Promise<{ success: boolean }> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/wechat/send`
      const res = await this.runtimeFetch('/wechat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, text }),
      }, 15000)
      if (!res.ok) await this._throwForResponse(res, url, 'Runtime WeChat send failed')
      return res.json()
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/wechat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, text }),
    }, 15000)
    if (!res.ok) await this._throwForResponse(res, 'wechat/send', 'WeChat send failed')
    return res.json()
  }

  // ============ Git / Workspace (review panel) ============

  /**
   * GET /api/git/status — branch + changed file list for the agent working dir.
   * Returns is_repo=false when the workdir is not inside a git repository,
   * so the UI can show a "not a git repo" hint instead of erroring.
   */
  async getGitStatus(): Promise<GitStatusResponse> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/workspace/status/files`
      const res = await this.runtimeFetch('/workspace/status/files')
      if (!res.ok) await this._throwForResponse(res, url, 'Get Runtime workspace status failed')
      const data = await res.json()
      return {
        branch: String(data.branch || ''),
        workdir: String(data.workdir || ''),
        is_repo: Boolean(data.is_repo),
        unstaged: Array.isArray(data.unstaged) ? data.unstaged : [],
        staged: Array.isArray(data.staged) ? data.staged : [],
        untracked: Array.isArray(data.untracked) ? data.untracked : [],
      }
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/git/status`, {}, 10000)
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/git/status`, 'Get git status failed')
    }
    return res.json()
  }

  /**
   * GET /api/git/diff — unified diff text for unstaged / staged / ref changes.
   * Pass staged=true for --cached, or ref='HEAD~1' to diff against a ref.
   */
  async getGitDiff(opts?: { staged?: boolean; ref?: string; paths?: string[] }): Promise<GitDiffResponse> {
    if (this.usesEmbeddedRuntime) {
      const params = new URLSearchParams()
      if (opts?.staged) params.set('staged', 'true')
      if (opts?.ref) params.set('ref', opts.ref)
      if (opts?.paths?.length) params.set('paths', opts.paths.join(','))
      const query = params.toString() ? `?${params.toString()}` : ''
      const path = `/workspace/diff${query}`
      const url = `${this.baseUrl}/v1${path}`
      const res = await this.runtimeFetch(path, {}, 15000)
      if (!res.ok) await this._throwForResponse(res, url, 'Get Runtime git diff failed')
      return res.json()
    }
    const params = new URLSearchParams()
    if (opts?.staged) params.set('staged', 'true')
    if (opts?.ref) params.set('ref', opts.ref)
    if (opts?.paths && opts.paths.length) params.set('paths', opts.paths.join(','))
    const qs = params.toString()
    const url = `${this.baseUrl}/api/git/diff${qs ? `?${qs}` : ''}`
    const res = await this.fetchWithHardTimeout(url, {}, 15000)
    if (!res.ok) {
      await this._throwForResponse(res, url, 'Get git diff failed')
    }
    return res.json()
  }

  /** POST /api/git/stage — stage or unstage a path (git add / git restore --staged). */
  async stagePath(path: string, unstage: boolean = false): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/workspace/stage`
      const res = await this.runtimeFetch('/workspace/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, unstage }),
      })
      if (!res.ok) await this._throwForResponse(res, url, 'Stage Runtime git path failed')
      return
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/git/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, unstage }),
    }, 10000)
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/git/stage`, 'Stage path failed')
    }
  }

  /** POST /api/git/discard — discard local changes to a path (git checkout -- / git clean -f). */
  async discardPath(path: string): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.baseUrl}/v1/workspace/discard`
      const res = await this.runtimeFetch('/workspace/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      if (!res.ok) await this._throwForResponse(res, url, 'Discard Runtime git path failed')
      return
    }
    const res = await this.fetchWithHardTimeout(`${this.baseUrl}/api/git/discard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }, 10000)
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/git/discard`, 'Discard path failed')
    }
  }

  /** Return current REST base URL. */
  getBaseUrl(): string {
    return this.baseUrl
  }

  /** WebSocket URL for the built-in terminal (shares agent working dir). */
  /**
   * GET /api/logs — fetch persisted backend logs.
   * - name: log filename (backend.log / agent.log / orchestrator.log / tools.log / llm.log / hakusai.log)
   * - lines: number of recent lines (default 200, max 5000)
   * - level: optional filter DEBUG/INFO/WARNING/ERROR
   * - after_ts: only entries after this unix timestamp (for live polling)
   */
  async getLogs(opts?: {
    name?: string
    lines?: number
    level?: string
    after_ts?: number
  }): Promise<LogsResponse> {
    if (this.usesEmbeddedRuntime) {
      const params = new URLSearchParams()
      if (opts?.name) params.set('name', opts.name)
      if (opts?.lines) params.set('lines', String(opts.lines))
      if (opts?.level) params.set('level', opts.level)
      if (opts?.after_ts) params.set('after_ts', String(opts.after_ts))
      const query = params.toString() ? `?${params.toString()}` : ''
      const path = `/logs${query}`
      const res = await this.runtimeFetch(path)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, 'Get Runtime logs failed')
      return res.json()
    }
    const params = new URLSearchParams()
    if (opts?.name) params.set('name', opts.name)
    if (opts?.lines) params.set('lines', String(opts.lines))
    if (opts?.level) params.set('level', opts.level)
    if (opts?.after_ts) params.set('after_ts', String(opts.after_ts))
    const qs = params.toString()
    const url = `${this.baseUrl}/api/logs${qs ? `?${qs}` : ''}`
    const res = await this.fetchWithHardTimeout(url, {}, 10000)
    if (!res.ok) {
      await this._throwForResponse(res, url, 'Get logs failed')
    }
    return res.json()
  }

  /** Clear one Runtime log file, or every Runtime log when name is omitted. */
  async clearLogs(name?: string): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const query = name ? `?name=${encodeURIComponent(name)}` : ''
      const path = `/logs${query}`
      const res = await this.runtimeFetch(path, { method: 'DELETE' })
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, 'Clear Runtime logs failed')
      return
    }
    const query = name ? `?name=${encodeURIComponent(name)}` : ''
    const url = `${this.baseUrl}/api/logs${query}`
    const res = await this.fetchWithHardTimeout(url, { method: 'DELETE' }, 10000)
    if (!res.ok) await this._throwForResponse(res, url, 'Clear logs failed')
  }

  /** Download one persisted log as a plain-text blob. */
  async downloadLogs(name: string): Promise<Blob> {
    if (this.usesEmbeddedRuntime) {
      const path = `/logs?download=1&name=${encodeURIComponent(name)}`
      const res = await this.runtimeFetch(path)
      if (!res.ok) await this._throwForResponse(res, `${this.baseUrl}/v1${path}`, 'Download Runtime logs failed')
      return res.blob()
    }
    const url = `${this.baseUrl}/api/logs?download=1&name=${encodeURIComponent(name)}`
    const res = await this.fetchWithHardTimeout(url, {}, 30000)
    if (!res.ok) await this._throwForResponse(res, url, 'Download logs failed')
    return res.blob()
  }

  terminalWsUrl(): string {
    return `${this.wsBaseUrl}/ws/terminal`
  }

  // ============ Projects (project picker) ============

  async listProjects(): Promise<Project[]> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.localBaseUrl}/v1/projects`
      const res = await this.fetchWithHardTimeout(url, {}, 8000)
      if (!res.ok) await this._throwForResponse(res, url, 'List Runtime projects failed')
      const data = await res.json() as ProjectsListResponse
      return data.projects || []
    }
    const url = `${this.localBaseUrl}/api/projects`
    const res = await this.fetchWithHardTimeout(url, {}, 8000)
    if (!res.ok) {
      await this._throwForResponse(res, url, 'List projects failed')
    }
    const data = (await res.json()) as ProjectsListResponse
    return data.projects || []
  }

  async createProject(body: ProjectCreateBody): Promise<Project> {
    if (this.usesEmbeddedRuntime) {
      const url = `${this.localBaseUrl}/v1/projects`
      const res = await this.fetchWithHardTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) await this._throwForResponse(res, url, 'Create Runtime project failed')
      return res.json()
    }
    const res = await this.fetchWithHardTimeout(
      `${this.localBaseUrl}/api/projects`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      8000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/projects`, 'Create project failed')
    }
    return res.json()
  }

  async updateProject(projectId: string, body: ProjectUpdateBody): Promise<Project> {
    if (this.usesEmbeddedRuntime) {
      const path = `/projects/${encodeURIComponent(projectId)}`
      const url = `${this.localBaseUrl}/v1${path}`
      const res = await this.fetchWithHardTimeout(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) await this._throwForResponse(res, url, 'Update Runtime project failed')
      return res.json()
    }
    const res = await this.fetchWithHardTimeout(
      `${this.localBaseUrl}/api/projects/${encodeURIComponent(projectId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      8000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/projects/${projectId}`, 'Update project failed')
    }
    return res.json()
  }

  async deleteProject(projectId: string): Promise<void> {
    if (this.usesEmbeddedRuntime) {
      const path = `/projects/${encodeURIComponent(projectId)}`
      const url = `${this.localBaseUrl}/v1${path}`
      const res = await this.fetchWithHardTimeout(url, { method: 'DELETE' })
      if (!res.ok) await this._throwForResponse(res, url, 'Delete Runtime project failed')
      return
    }
    const res = await this.fetchWithHardTimeout(
      `${this.localBaseUrl}/api/projects/${encodeURIComponent(projectId)}`,
      { method: 'DELETE' },
      8000,
    )
    if (!res.ok) {
      await this._throwForResponse(res, `${this.baseUrl}/api/projects/${projectId}`, 'Delete project failed')
    }
  }
}

// Singleton — but settings store can call setBaseUrl() to reconfigure
export const apiClient = new HakusAIClient()
