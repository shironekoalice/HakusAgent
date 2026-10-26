/**
 * HakusAI Server API Types
 *
 * 这些类型与 frontend/terminal 的 Rust Runtime API 模型对应
 * 以及 hakus/protocol/events.py 中的 AgentEvent 事件类型对应
 */

// ========== REST 请求/响应 ==========

// AgentMode is 'swift' (Work) or 'deep' (Code). 'fleet' is kept in the
// union so legacy session_log entries still type-check on load — the
// UI hides it (no picker), and the store normalizes persisted values
// to 'swift' on read.
export type AgentMode = 'swift' | 'deep' | 'fleet' | 'flow'

export interface ChatRequest {
  message: string
  session_id?: string
  stream?: boolean
  /**
   * Per-request provider override (e.g. "opencode" / "deepseek" / "glm").
   * If set, the runtime binds the turn to this provider instead of the
   * global default model from config.
   *
   * This is what makes the TopBar "switch provider" dropdown actually
   * take effect — without it, the runtime would silently reuse whatever
   * provider was default at session start.
   */
  provider?: string
  /**
   * Agent mode per turn.
   * swift: Work — daily chat + tools, no browser automation.
   * deep: Code — full coding agent.
   * If unset, the server falls back to config.yaml / HAKUS_MODE.
   */
  run_mode?: AgentMode
  /**
   * Per-request reasoning effort override (DeepSeek thinking mode).
   * Accepts 'low' / 'high' / 'max'. If unset, the server uses the
   * per-mode default (swift='low', deep='high').
   * See https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
   */
  reasoning_effort?: string
  /**
   * Per-request project override. If set to a registered project id,
   * the agent's working_dir is set to that project's folder — so all
   * file/shell tools operate inside the project without the user
   * having to spell out absolute paths. None / "none" / unknown id
   * falls back to the default workspace.
   */
  project_id?: string
}

export interface ChatResponse {
  content: string
  emotion?: string | null
  actions?: any[]
  session_id?: string
}

export interface ChatMessageResponse {
  success: boolean
  data?: {
    content: string
    role: string
  }
  error?: string
}

export interface HealthResponse {
  status: string
  version: string
  model_loaded: boolean
  agent_ready: boolean
}

/**
 * Runtime version response — 客户端用来检测连接的 Runtime 是否过旧。
 *
 * Tauri 客户端通常使用进程内 Rust Runtime；远程/兼容连接也可能返回旧协议，
 * 这时客户端会向旧 Runtime 发请求并遇到 404。
 *
 * 客户端启动时调 /api/version，如果 backend_api_version_int < EXPECTED，
 * 直接提示用户「Runtime 版本过旧，请更新或重启 Runtime」。
 */
export interface BackendVersionInfo {
  backend_api_version: string
  backend_api_version_int: number
  server_version: string
  endpoints: string[]
}

/**
 * 客户端期望的 backend API 版本。
 * 必须与 Rust Runtime API 的 BACKEND_API_VERSION_INT 保持同步。
 * 每次 backend 新增端点或变更 API 形状时，Rust Runtime 那边 bump 这个数字，
 * 这里也要同步 bump，否则客户端不会提示用户升级。
 *
 * 历史:
 *   v11 (0.11.0): + Fleet CTDE v2 — Planner + parallel Workers (sub_dir)
 *                 + Reviewer gate + counterfactual expert re-run (RETIRED
 *                 2026-08-18 — backend code + /api/fleet endpoints + UI
 *                 tab all removed; new parallel mode TBD).
 *                 Rich orchestrator_phase events.
 *   v10 (0.10.0): + Project management (/api/projects CRUD) +
 *                 ChatRequest.project_id — agent can be told which
 *                 folder to work in without the user spelling out
 *                 absolute paths every turn.
 *   v8 (0.8.0): + review panel: /api/git/status, /api/git/diff,
 *               /api/git/stage + /ws/terminal
 *   v7 (0.7.0): + /api/question/answer + ask_user 工具交互式提问
 *   v6 (0.6.0): + Phase 4 WS 心跳/重连 + Phase 5 /api/metrics 端点
 *               + WS resume_session / interrupt / pong 协议
 *   v5 (0.5.0): + MCP 客户端支持 (/api/config/mcp-servers* + /api/mcp/servers/*)
 *   v4 (0.4.0): + SQLite 会话持久化 + 聊天记录导出/导入
 *   v3 (0.3.0): + 提供商配置 API (test/fetch-models/multi-key/headers)
 *   v2 (0.2.0): + /api/version 端点本身
 */
export const EXPECTED_BACKEND_API_VERSION_INT = 13

export interface AppConfig {
  version: string
  character: {
    name: string
    personality: string
  }
  model: {
    provider: string
    model_name: string
  }
  voice: {
    enabled: boolean
    asr_provider: string
    tts_provider: string
  }
  avatar: {
    enabled: boolean
    type: string
    name: string
  }
}

export interface CharacterInfo {
  name: string
  nickname: string
  personality: string
  scenario: string
  first_message: string
  avatar_type: string
}

// ========== Provider / Model 配置 ==========

export interface ProviderInfo {
  id: string
  display_name: string
  has_url: boolean
  has_api_key: boolean
  masked_api_key: string
  model_name: string
  base_url: string
  is_default: boolean
  default_base_url?: string
  default_model?: string
  has_model_catalog?: boolean
  env_vars?: string[]
  has_custom_headers?: boolean
  group?: string
  auth_mode?: string
  /** Explicit request dialect for providers that support more than one API. */
  wire?: 'openai' | 'responses' | 'anthropic' | string
  supports_connection_test?: boolean
  supports_live_models?: boolean
  supports_headers?: boolean
  supports_multi_key?: boolean
  /** True for a user-managed `[providers.<id>]` route. */
  is_custom?: boolean
  /** Optional user-facing label persisted with a custom route. */
  description?: string
  /** Whether this route is available in model pickers. */
  enabled?: boolean
  /** User-curated models merged with catalog/live models. */
  models?: string[]
  configured_models?: string[]
  /**
   * User-supplied context-window size in tokens. Set for custom/aggregator
   * routes the built-in catalog does not cover, so the UI can show context
   * usage instead of "unknown".
   */
  context_window?: number | null
}

/**
 * User-facing Rust Runtime settings shared by the permission and tools
 * surfaces. This intentionally mirrors only the safe, editable projection of
 * `/v1/config`; secrets and internal runtime state stay server-side.
 */
export interface RuntimeConfigSnapshot {
  provider: string
  model: string
  approval_mode: string
  reasoning_effort: string
  auto_compact: boolean
  default_mode: string
  default_model: string
  base_url: string
  allow_shell: boolean
  mcp_config_path: string
  subagents_enabled: boolean
  subagents_max_depth: number
  /** Maximum concurrent sub-agents; they share the provider's rate limit. */
  subagents_max_concurrent: number
  /** Retry policy for provider requests (rate-limit resilience). */
  retry_enabled: boolean
  retry_max_retries: number
  retry_initial_delay: number
  retry_max_delay: number
  show_thinking: boolean
  thinking_default_expanded: boolean
  thinking_highlight: boolean
  show_tool_details: boolean
  inline_diffs: string
  locale: string
  max_history: number
  workspace_follow_symlinks: boolean
  calm_mode: boolean
  sandbox_mode: string
  strict_tool_mode: boolean
  memory_enabled: boolean
  search_provider: string
  prompt_suggestion: boolean
}

export interface WeChatStatus {
  status: string
  auto_reply?: boolean
  account_id?: string | null
  qrcode_base64?: string | null
}

export interface ProvidersResponse {
  providers: ProviderInfo[]
  default_model: string
}

export interface UpdateProviderBody {
  provider: string
  model_name?: string
  base_url?: string
  api_key?: string
  set_as_default?: boolean
  enabled?: boolean
  models?: string[]
  /** Persisted API dialect (for example `openai` or `anthropic`). */
  wire?: string
  /**
   * Context-window size in tokens for this route. `null` clears a previously
   * saved value; omitting the field leaves it unchanged.
   */
  context_window?: number | null
}

// --- Provider 运维操作 (测试连接 / 获取模型 / 多 Key / 自定义 Header) ---

/** Provider 元数据 (静态分组 + 默认值), 来自 GET /api/providers/meta */
export interface ProviderMeta {
  id: string
  display_name: string
  has_url: boolean
  group: string
  default_url: string
  default_model: string
}

export interface ProvidersMetaResponse {
  providers: ProviderMeta[]
  groups: string[]
}

/** 测试连接结果, 来自 POST /api/providers/{id}/test */
export interface ConnectionTestResult {
  ok: boolean
  message: string
  detail?: string | null
  latency_ms?: number | null
}

/** 获取模型列表结果, 来自 POST /api/providers/{id}/fetch-models */
export interface FetchModelsResult {
  ok: boolean
  models: ProviderModel[]
  message: string
  detail?: string | null
}

export interface ProviderModel {
  id: string
  name: string
  owned_by?: string | null
  /** Raw model/provider metadata. Empty means no authoritative ladder. */
  reasoning_options?: Array<{ type?: string; values?: string[]; default?: string }>
  supports_reasoning?: boolean | null
  /** Total context window in tokens, when the catalog declares one. */
  context_window?: number | null
}

export type ThreadGoalStatus = 'active' | 'paused' | 'blocked' | 'usage_limited' | 'budget_limited' | 'complete'

export interface ThreadGoal {
  thread_id: string
  goal_id: string
  objective: string
  status: ThreadGoalStatus
  token_budget?: number | null
  tokens_used: number
  time_used_seconds: number
  continuation_count: number
  created_at: number
  updated_at: number
}

/** 多 API Key 条目, 来自 GET /api/providers/{id}/keys */
export interface ProviderKeyEntry {
  id: string
  label: string
  masked_key: string
  enabled: boolean
  is_primary: boolean
}

export interface UpdateCharacterBody {
  name?: string
  nickname?: string
  personality?: string
  scenario?: string
  first_message?: string
  system_prompt?: string
}

// ========== 工具与权限 ==========

export interface ToolInfo {
  id: string
  name: string
  desc: string
  dangerous: boolean
  enabled: boolean
  /** v0.12.0+: list of tool names in this category (derived from registry). */
  tools?: string[]
}

export interface ToolsResponse {
  tools: ToolInfo[]
}

export interface CreateCustomProviderBody {
  id: string
  display_name?: string
  base_url: string
  model?: string
  api_key?: string
  api_key_env?: string
  group?: string
  models?: string[]
  enabled?: boolean
  wire?: string
}

export interface ProviderMutationResponse {
  provider: string
  message: string
}

// ========== Skills ==========

export interface SkillInfo {
  name: string
  description: string
  path: string | null
  source: string
  scope?: 'project' | 'global' | 'logical'
  enabled: boolean
  writable?: boolean
  is_bundled: boolean
  plugin_id?: string | null
  plugin_generation?: number | null
  plugin_content_hash?: string | null
}

export interface SkillsResponse {
  directory: string
  directories: string[]
  warnings: string[]
  skills: SkillInfo[]
}

export interface SkillMutationReceipt {
  name: string
  outcome: string
  scope: string
  safe_target_path: string
  trust_note?: string
}

// ========== Extensions (installed plugin bundles) ==========

export interface PluginCapabilityInventory {
  filesystem_roots: string[]
  network_hosts: string[]
  lifecycle_mutation: boolean
}

export interface PluginExtensionDescriptor {
  id: string
  version: string
  protocol: string
  entrypoint: string
  capabilities: string[]
  permissions: string[]
  supported_platforms: string[]
  checksum: string
}

export interface PluginDiagnosticEntry {
  level: 'warning' | 'error'
  code: string
  message: string
}

/** Redacted inventory entry from GET /v1/plugins — no install paths by construction. */
export interface RuntimePluginInfo {
  id: string
  name: string
  version: string
  scope: 'builtin' | 'user' | 'workspace'
  origin: string
  enabled: boolean
  trust_status: 'trusted' | 'not-reviewed' | 'content-changed' | 'capabilities-changed'
  applicable: boolean
  staged: boolean
  capabilities: PluginCapabilityInventory
  extension?: PluginExtensionDescriptor
  content_hash: string
  capability_hash: string
  state_generation: number
  skill_count: number
  diagnostics: PluginDiagnosticEntry[]
}

export interface RuntimePluginsResponse {
  plugins: RuntimePluginInfo[]
}

export interface RuntimeExtensionStatus {
  extension_id: string
  state: 'started' | 'unavailable' | 'rejected' | 'crashed'
  running: boolean
  pid: number | null
  error: string | null
}

export interface PluginMutationResponse {
  id: string
  name: string
  enabled: boolean
  trust_status: RuntimePluginInfo['trust_status']
  state_generation: number
}

/** Receipt returned by Runtime-owned plugin install/update/uninstall. */
export interface PluginMutationReceiptResponse {
  name: string
  outcome: 'installed' | 'updated' | 'no_change' | 'uninstalled' | string
  content_hash?: string
  installed_content_hash?: string
}

// ========== Session Log (v0.12.0+, DeepSeek-Harness-style append-only JSONL) ==========

export type SessionLogEventType =
  | 'turn_start'
  | 'text_delta'
  | 'reasoning'
  | 'tool_call_started'
  | 'tool_call_finished'
  | 'subagent_spawned'
  | 'token_usage'
  | 'turn_completed'
  | 'turn_failed'
  | 'cancelled'
  | 'compacted'
  | string  // forward-compat for custom event types

export interface SessionLogEvent {
  type: SessionLogEventType
  ts: number
  turn: number
  // Type-specific fields (all optional, discriminated by `type`)
  user_message?: string
  run_mode?: string
  working_dir?: string
  provider?: string
  model?: string
  text?: string
  call_id?: string
  name?: string
  arguments?: Record<string, unknown>
  category?: string
  success?: boolean
  duration_ms?: number
  result_preview?: string
  result_truncated?: boolean
  result_full_length?: number
  error?: string
  code?: string
  reason?: string
  content?: string
  input_tokens?: number
  output_tokens?: number
  cache_hit_tokens?: number
  cache_miss_tokens?: number
  sub_agent_id?: string
  task?: string
  allowed_tools?: string[]
  events_archived?: number
  archive_path?: string
  [key: string]: unknown  // forward-compat
}

export interface SessionLogStats {
  session_id: string
  log_path: string
  archive_path: string
  live_size_bytes: number
  archive_size_bytes: number
  event_count: number
  current_turn: number
}

/** Canonical Rust Runtime ledger event used for durable replay. */
export interface CanonicalLedgerEvent {
  event_id: string
  session_id: string
  seq: number
  event_type: string
  workspace_id?: string | null
  turn_id?: string | null
  correlation_id?: string | null
  parent_event_id?: string | null
  actor: Record<string, unknown>
  visibility: string
  payload: Record<string, any>
  timestamp: string
}

export interface CanonicalLedgerVerification {
  session_id: string
  event_count: number
  last_seq: number
  contiguous: boolean
}

export interface CanonicalLedgerResponse {
  session_id: string
  after_seq: number
  events: CanonicalLedgerEvent[]
  verification: CanonicalLedgerVerification
  /**
   * Canonical events in the session beyond the returned window.
   *
   * The Runtime read is bounded and returns the oldest events after the cursor,
   * so a non-zero value means `events` is a prefix, not the whole transcript.
   * `verification.last_seq` still reports the true tail.
   */
  omitted_events?: number
}

export type PermissionMode =
  | 'read_only'
  | 'auto'
  | 'granular'
  | 'guardian'
  | 'full_access'
  // legacy three-mode values (embedded Rust runtime)
  | 'ask'
  | 'bypass'

export interface GranularRules {
  shell: 'none' | 'read_only' | 'all'
  write_paths: string[]
  network: boolean
}

export interface PermissionInfo {
  mode: PermissionMode
  available_modes: string[]
  profile?: string
  granular_rules?: GranularRules
}

export interface ApprovalRecord {
  id: string
  session_id: string
  tool: string
  action_key: string
  reason: string
  approver: string
  status: 'pending' | 'approved' | 'denied' | 'timeout'
  created_at?: number
}

// ========== 记忆系统 ==========

export interface MemoryDetails {
  enabled: boolean
  long_term_enabled: boolean
  short_term_max: number
  auto_summary: boolean
  summary_interval: number
  stats: Record<string, any>
}

// ========== 诊断 ==========

export interface DiagnosticsInfo {
  status: string
  version: string
  ready: boolean
  error?: string
  components: Record<string, string>
  registered_providers: string[]
  configured_provider: string
  configured_model_name?: string
  init_started_at?: string
  init_finished_at?: string
  // 兼容字段
  model_loaded?: boolean
  agent_ready?: boolean
}

// ========== TTS ==========

export interface TtsVoicesResponse {
  voices: string[]
}

// ========== 配置导出/导入 ==========

export interface ExportConfigResponse {
  config: Record<string, any>
}

// ========== 文件上传 ==========

/**
 * POST /api/upload 响应中的单个文件条目，以及 GET /api/files 列表项。
 * 与 Rust Runtime 的 /v1/upload、/v1/files 端点对应。
 */
export interface UploadedFile {
  file_id: string
  filename: string
  size: number
  content_type: string
  text_preview?: string
  is_text: boolean
}

// ========== SSE 流式事件 ==========

/** SSE 流中的单条数据 */
export interface ChatStreamChunk {
  content?: string
  emotion?: string | null
  actions?: any[]
  done?: boolean
  error?: string
}

// ========== AgentEvent 协议 (hakus/protocol/events.py) ==========
// 这些事件类型对应服务端 AgentEvent 的序列化形式
// 当服务端通过 SSE/WebSocket 推送 AgentEvent 时使用

export type AgentEventType =
  | 'turn_started'
  | 'turn_completed'
  | 'turn_failed'
  | 'cancelled'
  | 'text_delta'
  | 'reasoning_delta'
  | 'tool_call_started'
  | 'tool_call_finished'
  | 'browser_tool_requested'
  | 'orchestrator_phase_changed'
  | 'activity_changed'
  | 'checkpoint_saved'
  | 'task_progress'
  | 'token_usage'
  | 'patch_applied'
  | 'patch_approval'
  | 'question_asked'
  | 'question_answered'
  | 'reflection_started'
  | 'reflection_completed'
  | 'approval_required'
  | 'ssh_password_required'
  | 'goal_updated'

export interface BaseAgentEvent {
  event_type: AgentEventType
}

export interface ApprovalRequiredEvent extends BaseAgentEvent {
  event_type: 'approval_required'
  approval: {
    id: string
    session_id: string
    tool: string
    action_key: string
    reason: string
    approver: string
    status: string
    decision: string | null
    created_at?: number
    resolved_at?: number | null
  }
}

export interface SshPasswordRequiredEvent extends BaseAgentEvent {
  event_type: 'ssh_password_required'
  approval: {
    approvalId: string
    runId: string
    workerId: string
  }
}

export interface GoalUpdatedEvent extends BaseAgentEvent {
  event_type: 'goal_updated'
  goal?: ThreadGoal | null
  cleared?: boolean
}

export interface TurnStartedEvent extends BaseAgentEvent {
  event_type: 'turn_started'
  turn_id: string
  model: string
}

export interface TurnCompletedEvent extends BaseAgentEvent {
  event_type: 'turn_completed'
  content: string
  tool_calls: any[]
  iterations: number
  total_time: number
  input_tokens: number
  output_tokens: number
  /** DeepSeek KV cache hit tokens (0 for non-DeepSeek providers). */
  cache_hit_tokens?: number
  /** DeepSeek KV cache miss tokens (0 for non-DeepSeek providers). */
  cache_miss_tokens?: number
  compressed: boolean
}

export interface TurnFailedEvent extends BaseAgentEvent {
  event_type: 'turn_failed'
  code: string
  error: string
}

export interface CancelledEvent extends BaseAgentEvent {
  event_type: 'cancelled'
  reason: string
  partial_content: string
}

export interface TextDeltaEvent extends BaseAgentEvent {
  event_type: 'text_delta'
  text: string
}

export interface ReasoningDeltaEvent extends BaseAgentEvent {
  event_type: 'reasoning_delta'
  text: string
}

export interface ToolCallStartedEvent extends BaseAgentEvent {
  event_type: 'tool_call_started'
  call_id: string
  name: string
  arguments: Record<string, any>
}

export interface ToolCallFinishedEvent extends BaseAgentEvent {
  event_type: 'tool_call_finished'
  call_id: string
  name: string
  result: string
  success: boolean
  duration: number
  arguments: Record<string, any>
}

export interface BrowserToolRequestedEvent extends BaseAgentEvent {
  event_type: 'browser_tool_requested'
  thread_id: string
  turn_id: string
  call_id: string
  arguments: Record<string, unknown>
}

export interface OrchestratorPhaseChangedEvent extends BaseAgentEvent {
  event_type: 'orchestrator_phase_changed'
  from_phase: string
  to_phase: string
  phase: string
  detail: string
}

export interface ActivityChangedEvent extends BaseAgentEvent {
  event_type: 'activity_changed'
  phase: string
  detail: string
  tool_name: string | null
  activity: string
}

export interface TokenUsageEvent extends BaseAgentEvent {
  event_type: 'token_usage'
  input_tokens: number
  output_tokens: number
  /** DeepSeek KV cache hit tokens (0 for non-DeepSeek providers). */
  cache_hit_tokens?: number
  /** DeepSeek KV cache miss tokens (0 for non-DeepSeek providers). */
  cache_miss_tokens?: number
}

export interface PatchAppliedEvent extends BaseAgentEvent {
  event_type: 'patch_applied'
  path: string
  diff: string
  old_content: string
  new_content: string
}

export interface TaskProgressEvent extends BaseAgentEvent {
  event_type: 'task_progress'
  completed: number
  total: number
  current_task: string
  phase: string
  detail: string
  /** Whole-list rows with per-row status, on Runtime sessions. */
  items?: Array<{ id?: number; content?: string; status?: string }>
}

export interface QuestionAskedEvent extends BaseAgentEvent {
  event_type: 'question_asked'
  question_id: string
  question: string
  options: string[]
  allow_free_text?: boolean
}

export interface QuestionAnsweredEvent extends BaseAgentEvent {
  event_type: 'question_answered'
  question_id: string
  choice: string
}

export type AgentEvent =
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | CancelledEvent
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallStartedEvent
  | ToolCallFinishedEvent
  | BrowserToolRequestedEvent
  | OrchestratorPhaseChangedEvent
  | ActivityChangedEvent
  | TokenUsageEvent
  | PatchAppliedEvent
  | TaskProgressEvent
  | QuestionAskedEvent
  | QuestionAnsweredEvent
  | ApprovalRequiredEvent
  | SshPasswordRequiredEvent
  | GoalUpdatedEvent

// ========== WebSocket 消息 ==========

export interface WSIncomingMessage {
  // Phase 4 新增: ping (服务端主动心跳), resume_ok/resume_failed, interrupt_ack
  type: 'stream' | 'error' | 'pong' | 'event' | 'ping' | 'resume_ok' | 'resume_failed' | 'interrupt_ack'
  content?: string
  emotion?: string | null
  actions?: any[]
  done?: boolean
  message?: string
  // If server sends typed AgentEvent via WS:
  event?: AgentEvent
  // Phase 4 — resume_session 回包
  session_id?: string
  messages_restored?: number
  reason?: string
  // Phase 4 — 服务端 ping 携带时间戳, 客户端可用来算 RTT
  ts?: number
}

export interface WSOutgoingMessage {
  // Phase 4 新增: pong (响应服务端 ping), resume_session (重连后恢复会话)
  type: 'message' | 'ping' | 'pong' | 'interrupt' | 'resume_session'
  content?: string
  session_id?: string
  provider?: string
  /** Per-message project override — same semantics as ChatRequest.project_id. */
  project_id?: string
}

// ========== Phase 5: Metrics (服务端 /api/metrics 响应) ==========

/**
 * GET /api/metrics 响应 — 5h SWE 任务可观测性。
 *
 * 客户端 AdvancedPanel 显示这些数字, 让用户能直观看到:
 *   - 服务运行了多久 (uptime_seconds)
 *   - 处理了多少 turn / 多少 LLM 调用
 *   - 错误率 (total_errors / total_turns)
 *   - 当前有多少 WebSocket 连接
 *   - checkpoint 保存次数 (5h 长任务的关键指标)
 *
 * 所有字段都是 "since process start" 的累计值, 不分时间窗口。
 */
export interface MetricsResponse {
  uptime_seconds: number
  total_turns: number
  total_errors: number
  active_websockets: number
  checkpoints_saved: number
  llm_calls: number
  llm_retries: number
  // 兼容字段 — 给前端更细的 breakdown
  by_provider?: Record<string, { turns: number; errors: number; llm_calls: number }>
}

// ========== 日志系统 (/api/logs) ==========

export interface LogFileInfo {
  name: string
  size: number
  mtime: number
}

export interface LogEntry {
  ts?: string | null
  level: string
  logger: string
  msg?: any
  event?: string | null
  fields?: Record<string, any> | null
  raw?: string
}

export interface LogsResponse {
  files: LogFileInfo[]
  logs: LogEntry[]
}

// ========== 客户端本地数据模型 ==========

export type MessageRole = 'user' | 'assistant' | 'system'

export interface ToolCall {
  call_id: string
  name: string
  arguments: Record<string, any>
  // Filled when ToolCallFinished arrives
  result?: string
  success?: boolean
  duration?: number
  started_at: number
  finished_at?: number
}

/**
 * A run of assistant text bounded by tool calls.
 *
 * `after_tool_call_id` is set on every segment except the first one — it's
 * the call_id of the tool call that PRECEDES this segment. The timeline
 * renderer uses this to interleave text and tool-call bubbles in execution
 * order, so the chat reads like an article (text → tool → text → tool → …).
 */
export interface TextSegment {
  id: string
  text: string
  after_tool_call_id?: string
}

/** Same shape as TextSegment but holds reasoning/thinking-chain content. */
export interface ReasoningSegment {
  id: string
  text: string
  after_tool_call_id?: string
}

export interface QuestionAttachment {
  question_id: string
  question: string
  options: string[]
  allow_free_text?: boolean
  answered?: boolean
  selected?: string
}

export interface TaskProgressAttachment {
  completed: number
  total: number
  current_task: string
  tasks?: string[]
  /**
   * The list as the Runtime reported it, each row with its own status.
   *
   * Present on Runtime sessions, where one frame carries the whole list. The
   * legacy `tasks` array is a growing list of names with no per-row state, so
   * the card can only infer completion from a prefix count; `items` removes
   * that guess and is preferred when present.
   */
  items?: Array<{ content: string; status: string }>
}

export interface ChatMessage {
  id: string
  session_id: string
  role: MessageRole
  content: string
  reasoning?: string
  tool_calls: ToolCall[]
  /**
   * Ordered text segments, one per "turn" between tool calls.
   * - segments[0] = text before the first tool call
   * - segments[i] (i>0) = text after tool_calls[i-1]
   *
   * For legacy messages loaded from the server (which stores only a flat
   * `content` string), this is undefined and the renderer falls back to a
   * single segment containing `content`.
   */
  text_segments?: TextSegment[]
  /** Same as text_segments but for reasoning/thinking-chain content. */
  reasoning_segments?: ReasoningSegment[]
  // Streaming flags
  streaming?: boolean
  // Metadata
  created_at: number
  updated_at: number
  // Token usage for this turn
  input_tokens?: number
  output_tokens?: number
  /** DeepSeek KV cache hit tokens (0 / absent for non-DeepSeek providers). */
  cache_hit_tokens?: number
  /** DeepSeek KV cache miss tokens (0 / absent for non-DeepSeek providers). */
  cache_miss_tokens?: number
  // Error info if failed
  error?: string
  // Phase / activity (for orchestrator)
  phase?: string
  activity?: string
  // Interactive question surfaced during agent execution
  question?: QuestionAttachment
  // Live task progress / TODO list surfaced during agent execution
  task_progress?: TaskProgressAttachment
}

export interface ChatSession {
  id: string
  title: string
  // Optional remote session_id (HakusAI server-side session)
  remote_session_id?: string
  // Per-session provider override (e.g. "deepseek" / "opencode" / "openai").
  // If unset, the global defaultModel from settings is used.
  provider?: string
  created_at: number
  updated_at: number
  pinned?: boolean
  /** Temporary chat: not persisted to server history, no memory writes. */
  ephemeral?: boolean
}

/** Server-side session row (matches session_store._row_to_session). */
export interface ServerSession {
  id: string
  title: string
  remote_session_id: string | null
  provider: string | null
  pinned: boolean
  created_at: number
  updated_at: number
}

/** Server-side message row (matches session_store._row_to_message). */
export interface ServerMessage {
  id: string
  session_id: string
  role: string
  content: string
  reasoning: string | null
  tool_calls: ToolCall[]
  input_tokens: number | null
  output_tokens: number | null
  error: string | null
  streaming: boolean
  created_at: number
  updated_at: number
}

/** POST /api/sessions body. */
export interface SessionCreateBody {
  id: string
  title?: string
  remote_session_id?: string
  provider?: string
  pinned?: boolean
  created_at?: number
  updated_at?: number
}

/** PATCH /api/sessions/{id} body — all fields optional. */
export interface SessionUpdateBody {
  title?: string
  remote_session_id?: string
  provider?: string
  pinned?: boolean
}

/** POST /api/sessions/{id}/messages body. */
export interface MessageCreateBody {
  id: string
  role?: string
  content?: string
  reasoning?: string | null
  tool_calls?: ToolCall[]
  input_tokens?: number | null
  output_tokens?: number | null
  error?: string | null
  streaming?: boolean
  created_at?: number
  updated_at?: number
}

/** PATCH /api/sessions/{id}/messages/{msg_id} body — all fields optional. */
export interface MessageUpdateBody {
  content?: string
  reasoning?: string | null
  tool_calls?: ToolCall[]
  input_tokens?: number | null
  output_tokens?: number | null
  error?: string | null
  streaming?: boolean
}

/** POST /api/sessions/migrate body. */
export interface BulkImportBody {
  sessions: ServerSession[]
  messages: Record<string, ServerMessage[]>
}

/** Read-only summary returned by POST /v1/migrations/legacy-sessions. */
export interface LegacyDiscoveredSession {
  session_id: string
  title: string
  provider?: string | null
  message_count: number
  created_at: number
  updated_at: number
}

export interface LegacyDiscoveredStore {
  path: string
  size_bytes: number
  checkpoint_path?: string | null
  sessions: LegacyDiscoveredSession[]
}

export interface LegacyRejectedStore {
  path: string
  reason: string
}

export interface LegacyDiscovery {
  stores: LegacyDiscoveredStore[]
  rejected: LegacyRejectedStore[]
}

export interface ConnectionSettings {
  serverUrl: string
  // Use WebSocket (full-duplex) instead of SSE
  useWebSocket: boolean
  // Connection timeout (ms)
  timeout: number
}

export interface AppSettings {
  connection: ConnectionSettings
  theme: 'light' | 'dark' | 'system'
  /** UI language preference. `system` resolves from the host/WebView locale. */
  language: 'system' | 'zh-CN' | 'en-US'
  /** True after the first-run setup has been dismissed or completed. */
  onboardingCompleted: boolean
  // Default model provider (for display only — actual model is configured server-side)
  defaultSessionName: string
  // Send on Enter, newline on Shift+Enter
  sendOnEnter: boolean
  // Show reasoning blocks (for Claude / O-series)
  showReasoning: boolean
  // Auto-scroll on new content
  autoScroll: boolean
  // Font size in chat (px)
  fontSize: number
  // TTS (本地控制开关，与 server TTS 配置独立)
  ttsEnabled: boolean
  ttsProvider: 'cosyvoice' | 'gpt_sovits' | 'elevenlabs'
  ttsVoice: string
  ttsSpeed: number
  // Voice scene mode — controls silence waiting, tone and speed presets
  voiceMode: 'companion' | 'assistant' | 'balanced'
  // API keys for voice providers (stored locally, sent to backend on demand)
  dashscopeApiKey: string
  // Voice call and broadcast settings
  voiceCallEnabled: boolean
  voiceCallBackend: 'celia' | 'builtin'
  celiaPath: string
  celiaConfigPath: string
  celiaPythonCommand: string
  celiaOpenInTerminal: boolean
  // ASR / VAD configuration (builtin voice-call engine)
  asrProvider: 'funasr' | 'whisper' | 'azure'
  asrLanguage: string
  vadThreshold: number
  vadSilenceEndFrames: number
  voiceBroadcastEnabled: boolean
  voiceBroadcastMode: 'tts' | 'chime'
  voiceBroadcastChime: 'dingdong' | 'soft'
  // Phase 3 — System tray + global shortcuts (Electron-only; ignored in browser dev mode)
  trayEnabled: boolean
  minimizeToTray: boolean
  toggleShortcut: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  connection: {
    serverUrl: 'http://127.0.0.1:48081',
    useWebSocket: false,
    timeout: 30000,
  },
  theme: 'dark',
  language: 'system',
  onboardingCompleted: false,
  defaultSessionName: 'New Chat',
  sendOnEnter: true,
  showReasoning: true,
  autoScroll: true,
  fontSize: 14,
  ttsEnabled: false,
  ttsProvider: 'cosyvoice',
  ttsVoice: '',
  ttsSpeed: 1.0,
  voiceMode: 'balanced',
  dashscopeApiKey: '',
  voiceCallEnabled: false,
  voiceCallBackend: 'builtin',
  // Celia is optional and user-local; never ship a developer machine path.
  celiaPath: '',
  celiaConfigPath: 'config.yaml',
  celiaPythonCommand: 'python',
  celiaOpenInTerminal: false,
  asrProvider: 'funasr',
  asrLanguage: 'zh',
  vadThreshold: 0.03,
  vadSilenceEndFrames: 8,
  voiceBroadcastEnabled: false,
  voiceBroadcastMode: 'chime',
  voiceBroadcastChime: 'dingdong',
  // Phase 3 — tray + shortcuts
  trayEnabled: true,
  minimizeToTray: true,
  toggleShortcut: 'Shift+CommandOrControl+H',
}

// =====================================================================
// MCP (Model Context Protocol) — Phase 2 round 2
// =====================================================================
// Mirrors the shapes returned by the Rust Runtime MCP endpoints.
// Keep in sync with frontend/terminal/crates/tui/src/runtime_api.rs and
// hakus/mcp-compatible configuration parsing.
// =====================================================================

export interface McpServerInfo {
  name: string
  enabled: boolean
  transport: 'stdio' | 'sse' | 'http'
  command: string
  args: string[]
  // Only env KEYS are exposed — values are masked server-side.
  env_keys: string[]
  has_env: boolean
  cwd: string | null
  startup_timeout: number
  tool_timeout: number
  // Runtime status (merged from McpClientManager)
  status: 'stopped' | 'starting' | 'running' | 'failed' | 'disabled'
  last_error: string | null
  started_at: number | null
  tool_count: number
}

export interface McpServerConfig {
  enabled: boolean
  transport: 'stdio' | 'sse' | 'http'
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string | null
  startup_timeout: number
  tool_timeout: number
}

export interface McpGlobalConfig {
  auto_start: boolean
  fail_fast: boolean
  tool_naming: 'namespace' | 'flat'
}

export interface McpServersResponse {
  servers: McpServerInfo[]
  global: McpGlobalConfig
}

export interface McpToolInfo {
  name: string
  description: string
  input_schema: Record<string, unknown>
  is_dangerous: boolean
}

export interface McpStartResult {
  ok: boolean
  message: string
  status: {
    name: string
    status: string
    last_error: string | null
    started_at: number | null
    tool_count: number
  }
  tools: McpToolInfo[]
}

export interface McpTestResult {
  ok: boolean
  message: string
  detail: string
  tools: McpToolInfo[]
}

export interface McpServerToolsResponse {
  ok: boolean
  message: string
  tools: McpToolInfo[]
}

export interface McpInvokeResult {
  ok: boolean
  message: string
  result: string
  is_error: boolean
}

// =====================================================================
// Git / Workspace — review panel
// =====================================================================

export interface GitFileChange {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'unknown'
  staged: boolean
}

export interface GitStatusResponse {
  /** Current branch name (empty if detached/none). */
  branch: string
  /** Working directory the server inspects. */
  workdir: string
  /** Whether the workdir is inside a git repository. */
  is_repo: boolean
  /** Files with unstaged changes. */
  unstaged: GitFileChange[]
  /** Files with staged changes. */
  staged: GitFileChange[]
  /** Files not tracked by git. */
  untracked: GitFileChange[]
}

export interface GitDiffResponse {
  /** Unified diff text (may be empty when no changes). */
  diff: string
  /** True if the diff was truncated due to size. */
  truncated: boolean
  /** Working directory used. */
  workdir: string
}

// =====================================================================
// Projects — local and remote workspaces
// =====================================================================

/**
 * A registered project. The user picks a folder via the Tauri folder
 * dialog, we POST it to /api/projects, and the server stores it in
 * ~/.hakus/projects.json. Subsequent chat turns send the project_id
 * so the agent runs with that folder as its working_dir.
 */
export interface Project {
  id: string
  name: string
  /** Absolute filesystem path to the project folder. */
  path: string
  /** Pinned projects float to the top of the picker. */
  pinned: boolean
  /** Unix ms when the project was registered. */
  created_at: number
  /** Unix ms when the project was last used in a chat turn. */
  last_used_at: number
  /** Android SAF tree URI; absent on desktop projects. */
  source_uri?: string
  /** Remote projects are managed by the desktop shell and never sent to the local runtime. */
  kind?: 'local' | 'remote'
  remote?: RemoteProjectConnection
}

export interface ProjectsListResponse {
  projects: Project[]
}

export interface ProjectCreateBody {
  name: string
  path: string
  pinned?: boolean
  source_uri?: string
}

export interface ProjectUpdateBody {
  name?: string
  pinned?: boolean
}

export type RemoteConnectionType = 'ssh' | 'wsl' | 'docker'
export type RemoteAuthMethod = 'password' | 'key'
export type RemoteRuntimeInstallMode = 'localUpload' | 'remoteDownload'

/** Connection details retained with a remote project, excluding secrets. */
export interface RemoteProjectConnection {
  id: string
  type: RemoteConnectionType
  alias?: string
  host?: string
  port?: number
  username?: string
  authMethod?: RemoteAuthMethod
  privateKeyPath?: string
  installMode?: RemoteRuntimeInstallMode
  distro?: string
  container?: string
}

export interface RemoteProjectCreateBody {
  name: string
  path: string
  pinned?: boolean
  remote: RemoteProjectConnection
}

// =====================================================================
// Feature extensions
// =====================================================================

/** Session flag: in-memory only — not listed in server history, no memory writes. */
export interface ChatSessionEphemeralFlag {
  ephemeral?: boolean
}

export type ReviewScope = 'unstaged' | 'staged' | 'last_turn' | 'head1' | 'pr'

/** Per-1M-token USD pricing for a model. */
export interface ModelPricing {
  /** Substring match against provider/model name, e.g. "deepseek" or "gpt-4o". */
  match: string
  label: string
  input_per_mtok: number
  output_per_mtok: number
  cache_hit_per_mtok?: number
  cache_miss_per_mtok?: number
}

export interface UsageTurnRow {
  index: number
  timestamp: number
  provider?: string
  model?: string
  input_tokens: number
  output_tokens: number
  cache_hit_tokens: number
  cache_miss_tokens: number
  cost_usd: number
}

export interface UsageModelShare {
  key: string
  label: string
  input_tokens: number
  output_tokens: number
  cache_hit_tokens: number
  cache_miss_tokens: number
  cost_usd: number
  share_pct: number
}

export interface UsageBreakdown {
  turns: UsageTurnRow[]
  totals: {
    input_tokens: number
    output_tokens: number
    cache_hit_tokens: number
    cache_miss_tokens: number
    cost_usd: number
    turn_count: number
  }
  by_model: UsageModelShare[]
  /** Runtime usage payload when the backend provides one. */
  runtime?: unknown
}

export interface GitWorktree {
  path: string
  branch: string | null
  head: string
  bare: boolean
  locked: boolean
  prunable?: boolean
}

export interface HandoffStatus {
  id: string
  session_id: string
  tool: string
  destination: string
  status: 'pending' | 'working' | 'done' | 'failed'
  summary?: string
  created_at: number
}

export interface DependencyCheck {
  id: string
  name: string
  required: boolean
  found: boolean
  version?: string
  path?: string
  status: 'ok' | 'missing' | 'outdated' | 'error'
  hint?: string
}

export interface DoctorReport {
  checks: DependencyCheck[]
  backend: { healthy: boolean; version?: string; port?: number }
  generated_at: number
}

export interface PullRequestInfo {
  number: number
  title: string
  state: 'open' | 'closed' | 'draft' | 'merged'
  branch: string
  url?: string
  author?: string
}

export interface WorkspaceFileEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
}

export interface ApplyPatchBody {
  patch: string
  reverse?: boolean
  cached?: boolean
  workdir?: string
}

export interface HunkRef {
  path: string
  /** Zero-based hunk index within the file's parsed hunks. */
  hunkIndex: number
  oldStart: number
  newStart: number
}
