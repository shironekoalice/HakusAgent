//! Runtime HTTP/SSE API for local Hakus automation.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::convert::Infallible;
use std::fs;
use std::net::{SocketAddr, UdpSocket};
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use async_stream::stream;
use base64::Engine;
use axum::extract::{Path, Query, Request, State};
use axum::http::header;
use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware;
use axum::response::Html;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use chrono::Utc;
use hakus_protocol::agent_mail::{
    AgentMailDeliveryMode, AgentMailEnvelope, AgentMailMessageId, AgentMailSendRequest,
    AgentMailSendResponse,
};
use hakus_protocol::runtime::{
    DynamicToolCallResult, RUNTIME_API_VERSION, RUNTIME_EVENT_ENVELOPE_SCHEMA_VERSION,
    RuntimeCapabilities, RuntimeEventEnvelope, RuntimeExecutionPlane,
    RuntimeExperimentalCapabilities, RuntimeFeatureGates,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tower_http::cors::CorsLayer;

#[cfg(test)]
use crate::dependencies::ExternalTool;

use crate::automation_manager::{
    AutomationManager, AutomationRecord, AutomationRunRecord, AutomationSchedulerConfig,
    CreateAutomationRequest, SharedAutomationManager, UpdateAutomationRequest, spawn_scheduler,
};
use crate::config_persistence;
use crate::config::{
    ApiProvider, Config, DEFAULT_TEXT_MODEL, normalize_model_name_for_provider, validate_route,
};
use crate::fleet::executor::{FleetExecutor, configured_hakus_binary};
use crate::fleet::ledger::{FleetEventReplayError, FleetLedgerState, FleetTaskLedgerStatus};
use crate::fleet::manager::{
    FleetManager, FleetStatusSnapshot, FleetWorkerInspection, FleetWorkerRuntimeProjection,
    ManagedFleetRunDescriptor,
};
use crate::fleet::ssh_secret::SshPasswordVault;
use crate::fleet::profile::canonical_public_role_name;
use crate::fleet::task_spec::FleetTaskSpecDocument;
use crate::fleet::worker_runtime::fleet_write_roots;
use crate::mcp::McpPool;
#[cfg(test)]
pub(super) use crate::models::{ContentBlock, Message};
use crate::runtime_threads::{
    CompactThreadRequest, CreateThreadRequest, ExternalApprovalDecision,
    MAX_RUNTIME_EVENT_REPLAY_TAIL, RuntimeThreadManager, RuntimeThreadManagerConfig,
    SharedRuntimeThreadManager, StartTurnRequest, SteerTurnRequest, ThreadDetail,
    ThreadListFilter, ThreadRecord, TurnItemKind, TurnRecord, UpdateThreadRequest, UsageGroupBy,
};
pub(super) use crate::runtime_threads::{RuntimeTurnStatus, TurnItemLifecycleStatus};
use crate::session_manager::default_sessions_dir;
#[cfg(test)]
pub(super) use crate::session_manager::{SavedSession, SessionMetadata};
use crate::skill_state::SkillStateStore;
use crate::task_manager::{
    NewTaskRequest, SharedTaskManager, TaskManager, TaskManagerConfig, TaskRecord, TaskSummary,
};
use crate::tools::subagent::{
    AgentWorkerRecord, SharedSubAgentManager, load_persisted_agent_worker_records,
    new_shared_subagent_manager_with_timeout,
};
use hakus_wechat::{IlLinkClient, LoginHandle, QrLoginStatus};
use hakus_protocol::fleet::{
    FleetArtifactKind, FleetEventReplay, FleetRun, FleetRunId, FleetRuntimeEvent,
    FleetRuntimeTarget, FleetSecurityPolicy, FleetTaskSpec, FleetWorkerEventPayload,
    FleetWorkerSpec, FleetWorkerStatus, FleetWorkflowDescriptor, FleetWorkflowKind,
};

mod auth;
mod projects;
mod sessions;
#[cfg(all(not(target_os = "android"), not(target_env = "ohos")))]
mod terminal;
mod web;
mod workspace;
#[cfg(test)]
use self::auth::{ResolvedRuntimeAuth, token_from_cookie_header};
use self::auth::{require_runtime_token, resolve_runtime_auth, runtime_auth_status_lines};
use self::sessions::{
    create_session_from_thread, delete_session, get_session, list_sessions, list_sessions_summary,
    patch_session, resume_session_thread, save_current_session,
};
#[cfg(test)]
use self::sessions::{messages_from_thread_detail, session_to_detail};
/// Re-exported for the durable transcript rebuild's cross-check: export and
/// save-as-session persist whatever this projection returns, so the projection
/// and the per-turn rebuild must agree about the engine-composed user blocks.
#[cfg(test)]
pub(crate) use self::sessions::messages_from_thread_detail as thread_detail_messages;
#[cfg(test)]
use self::workspace::collect_workspace_status;
use self::workspace::{collect_workspace_git_metadata, workspace_status};

const RUNTIME_TOKEN_ENV: &str = "HAKUS_RUNTIME_TOKEN";
const LEGACY_RUNTIME_TOKEN_ENV: &str = "DEEPSEEK_RUNTIME_TOKEN";
const LEGACY_RUNTIME_TOKEN_WARNING: &str = "Warning: DEEPSEEK_RUNTIME_TOKEN is deprecated; use \
HAKUS_RUNTIME_TOKEN (the legacy alias is removed in 0.10.0).";

struct RuntimeTokenEnvironment {
    token: Option<String>,
    legacy_alias_used: bool,
}

fn runtime_token_environment(lookup: &dyn Fn(&str) -> Option<String>) -> RuntimeTokenEnvironment {
    let nonblank = |name| {
        lookup(name)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };

    if let Some(token) = nonblank(RUNTIME_TOKEN_ENV) {
        return RuntimeTokenEnvironment {
            token: Some(token),
            legacy_alias_used: false,
        };
    }

    let token = nonblank(LEGACY_RUNTIME_TOKEN_ENV);
    RuntimeTokenEnvironment {
        legacy_alias_used: token.is_some(),
        token,
    }
}

fn runtime_token_alias_warning(
    cli_token: Option<&str>,
    environment: &RuntimeTokenEnvironment,
) -> Option<&'static str> {
    let cli_token_is_used = cli_token.is_some_and(|token| !token.trim().is_empty());
    (!cli_token_is_used && environment.legacy_alias_used).then_some(LEGACY_RUNTIME_TOKEN_WARNING)
}

#[derive(Clone)]
pub struct RuntimeApiState {
    config: Arc<parking_lot::RwLock<Config>>,
    workspace: PathBuf,
    plugin_discovery: Arc<crate::plugins::PluginDiscoveryContext>,
    task_manager: SharedTaskManager,
    runtime_threads: SharedRuntimeThreadManager,
    cors_origins: Vec<String>,
    sessions_dir: PathBuf,
    /// Original `--config` path (if any) used to load the initial config.
    /// Passed to `Config::load` on reload and to persistence helpers so
    /// GUI-driven config changes target the same file the server was
    /// started with, instead of falling back to the default discovery.
    config_path: Option<PathBuf>,
    /// Effective initial profile (`--profile` or `DEEPSEEK_PROFILE`).
    /// Reload must retain this overlay so profile-scoped routes do not vanish.
    config_profile: Option<String>,
    automations: SharedAutomationManager,
    sub_agent_manager: SharedSubAgentManager,
    runtime_token: Option<String>,
    skill_state: Arc<Mutex<SkillStateStore>>,
    auth_required: bool,
    bind_host: String,
    bind_port: u16,
    mobile_enabled: bool,
    web: Option<web::RuntimeWebState>,
    /// Executable used by Runtime API-owned Fleet manager loops. Stored on
    /// state so tests and embedded callers can provide a hermetic worker.
    fleet_hakus_binary: String,
    /// Runtime-lifetime, memory-only SSH password handoff. The vault never
    /// writes credentials to the Fleet ledger or any diagnostic surface.
    ssh_password_vault: Arc<SshPasswordVault>,
    /// Shared McpPool reused for explicit live MCP discovery. Passive API
    /// calls do not initialize this pool so dashboards cannot accidentally
    /// become a second stdio-process owner. The outer mutex guards only the
    /// lazily-initialized slot; slow per-pool work (connect_all) runs under
    /// the inner handle so it cannot block slot reads.
    mcp_pool: Arc<Mutex<Option<Arc<Mutex<McpPool>>>>>,
    mcp_global_config: Arc<Mutex<McpGlobalConfig>>,
    wechat: Arc<Mutex<WechatRuntimeState>>,
    started_at: Instant,
    started_at_unix_ms: u64,
    execution_plane: RuntimeExecutionPlane,
    feature_gates: RuntimeFeatureGates,
    #[cfg(test)]
    compat_stream_test_hook: Option<tokio::sync::mpsc::UnboundedSender<CompatStreamTestPoint>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct McpGlobalConfig {
    #[serde(default)]
    auto_start: bool,
    #[serde(default)]
    fail_fast: bool,
    #[serde(default = "default_mcp_tool_naming")]
    tool_naming: String,
}

fn default_mcp_tool_naming() -> String {
    "namespace".to_string()
}

impl Default for McpGlobalConfig {
    fn default() -> Self {
        Self {
            auto_start: false,
            fail_fast: false,
            tool_naming: default_mcp_tool_naming(),
        }
    }
}

struct WechatRuntimeState {
    client: IlLinkClient,
    login: Option<LoginHandle>,
    /// Whether ordinary inbound messages should be sent to the Runtime agent.
    /// Slash commands are handled locally even when this is disabled.
    auto_reply: bool,
    /// Serializes long-poll calls from the background bot and the manual API.
    poll_lock: Arc<Mutex<()>>,
    /// One Runtime thread per WeChat user for conversation continuity.
    threads: HashMap<String, String>,
    users: HashMap<String, hakus_wechat::WechatUserSettings>,
}

#[derive(Debug, Serialize)]
struct WechatStatusResponse {
    status: &'static str,
    auto_reply: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    qrcode_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WechatSendRequest {
    user_id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct WechatSettingsRequest {
    enabled: bool,
}

#[derive(Debug, Serialize)]
struct WechatMessagesResponse {
    messages: Vec<WechatMessageEntry>,
}

#[derive(Debug, Serialize)]
struct WechatMessageEntry {
    user_id: String,
    text: String,
    id: String,
}

#[cfg(test)]
enum CompatStreamTestPoint {
    ThreadCreated {
        thread_id: String,
        resume: tokio::sync::oneshot::Sender<()>,
    },
    SubscribedBeforeReplay {
        thread_id: String,
        turn_id: String,
        resume: tokio::sync::oneshot::Sender<()>,
    },
    ReplayLoaded {
        thread_id: String,
        turn_id: String,
        resume: tokio::sync::oneshot::Sender<()>,
    },
}

#[derive(Debug, Clone)]
pub struct RuntimeApiOptions {
    pub host: String,
    pub port: u16,
    pub workers: usize,
    /// Additional CORS origins to allow on top of the built-in defaults
    /// (`http://localhost:{3000,1420}`, `http://127.0.0.1:{3000,1420}`,
    /// `tauri://localhost`). Populated by `--cors-origin` (repeatable),
    /// `HAKUS_CORS_ORIGINS` (comma-separated, `DEEPSEEK_CORS_ORIGINS`
    /// as alias), and `[runtime_api] cors_origins` in `config.toml`.
    /// Whalescale#255 / #561.
    pub cors_origins: Vec<String>,
    /// Optional bearer token required for `/v1/*` routes. If omitted here,
    /// `run_http_server` checks `HAKUS_RUNTIME_TOKEN`, then
    /// `DEEPSEEK_RUNTIME_TOKEN` as an alias.
    pub auth_token: Option<String>,
    /// Allow `/v1/*` routes without auth when no token is configured.
    pub insecure_no_auth: bool,
    /// Enables the built-in mobile control page at `/mobile`.
    pub mobile: bool,
    /// Enables the embedded local browser client and opens it after binding.
    /// Web mode is always loopback-only and uses a one-time bootstrap cookie
    /// exchange rather than exposing the Runtime token to the browser URL.
    pub web: bool,
    /// Show a QR code for the mobile URL in the terminal.
    pub show_qr: bool,
    /// Original `--config` path used to load the initial config. When
    /// `Some`, GUI-driven config reloads and persistence target this file
    /// instead of the default discovery path.
    pub config_path: Option<PathBuf>,
    /// Effective profile used to load the server's initial Config.
    pub config_profile: Option<String>,
}

impl Default for RuntimeApiOptions {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port: 7878,
            workers: 2,
            cors_origins: Vec::new(),
            auth_token: None,
            insecure_no_auth: false,
            mobile: false,
            web: false,
            show_qr: false,
            config_path: None,
            config_profile: None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct StreamTurnRequest {
    prompt: String,
    model: Option<String>,
    mode: Option<String>,
    permission_posture: Option<String>,
    workspace: Option<PathBuf>,
    allow_shell: Option<bool>,
    trust_mode: Option<bool>,
    auto_approve: Option<bool>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
    mode: &'static str,
    execution_plane: RuntimeExecutionPlane,
    feature_gates: RuntimeFeatureGates,
    uptime_seconds: u64,
}

#[derive(Debug, Serialize)]
struct TasksResponse {
    tasks: Vec<TaskSummary>,
    counts: crate::task_manager::TaskCounts,
}

#[derive(Debug, Deserialize)]
struct TasksQuery {
    limit: Option<usize>,
    workspace: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct ThreadsQuery {
    limit: Option<usize>,
    include_archived: Option<bool>,
    /// When `true`, returns archived threads only (overrides `include_archived`).
    /// Whalescale#260 / #563.
    archived_only: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ThreadSummaryQuery {
    limit: Option<usize>,
    search: Option<String>,
    include_archived: Option<bool>,
    /// When `true`, returns archived threads only (overrides `include_archived`).
    /// Whalescale#260 / #563.
    archived_only: Option<bool>,
}

fn resolve_thread_filter(
    include_archived: Option<bool>,
    archived_only: Option<bool>,
) -> ThreadListFilter {
    if archived_only.unwrap_or(false) {
        ThreadListFilter::ArchivedOnly
    } else if include_archived.unwrap_or(false) {
        ThreadListFilter::IncludeArchived
    } else {
        ThreadListFilter::ActiveOnly
    }
}

#[derive(Debug, Serialize)]
struct ThreadSummary {
    id: String,
    title: String,
    preview: String,
    model: String,
    mode: String,
    workspace: PathBuf,
    branch: Option<String>,
    head: Option<String>,
    dirty: bool,
    archived: bool,
    updated_at: chrono::DateTime<Utc>,
    latest_turn_id: Option<String>,
    latest_turn_status: Option<String>,
}

#[derive(Debug, Serialize)]
struct SkillEntry {
    name: String,
    description: String,
    /// Native Skill locator. Reviewed plugin paths are deliberately omitted;
    /// their bodies are available only through the authority-bound snapshot.
    path: Option<PathBuf>,
    source: String,
    plugin_id: Option<String>,
    plugin_generation: Option<u64>,
    plugin_content_hash: Option<String>,
    enabled: bool,
    is_bundled: bool,
}

#[derive(Debug, Serialize)]
struct SkillsResponse {
    directory: PathBuf,
    directories: Vec<PathBuf>,
    warnings: Vec<String>,
    skills: Vec<SkillEntry>,
}

/// Declared capability inventory of a plugin manifest. These are the
/// permission-relevant requests the manifest makes; the policy boundary still
/// gates every actual side effect.
#[derive(Debug, Serialize)]
struct PluginCapabilityInventory {
    filesystem_roots: Vec<String>,
    network_hosts: Vec<String>,
    lifecycle_mutation: bool,
}

/// Protocol-bound feature descriptor returned without install paths or
/// executable resolution details. The manifest validator guarantees the
/// checksum shape and supported platform values before this is serialized.
#[derive(Debug, Serialize)]
struct PluginExtensionDescriptor {
    id: String,
    version: String,
    protocol: String,
    entrypoint: String,
    capabilities: Vec<String>,
    permissions: Vec<String>,
    supported_platforms: Vec<String>,
    checksum: String,
}

#[derive(Debug, Serialize)]
struct PluginDiagnosticEntry {
    level: &'static str,
    code: String,
    message: String,
}

/// One installed extension in the desktop permission surface. Redacted by
/// construction: identity, trust state, capability requests, and hashes only —
/// install locations and file paths are deliberately omitted.
#[derive(Debug, Serialize)]
struct PluginEntry {
    id: String,
    name: String,
    version: String,
    scope: &'static str,
    origin: &'static str,
    enabled: bool,
    /// "trusted" | "not-reviewed" | "content-changed" | "capabilities-changed"
    trust_status: &'static str,
    applicable: bool,
    /// Whether the content-addressed staged copy exists; an unstaged plugin
    /// can never become active regardless of the enablement bit.
    staged: bool,
    capabilities: PluginCapabilityInventory,
    #[serde(skip_serializing_if = "Option::is_none")]
    extension: Option<PluginExtensionDescriptor>,
    content_hash: String,
    capability_hash: String,
    state_generation: u64,
    skill_count: usize,
    diagnostics: Vec<PluginDiagnosticEntry>,
}

#[derive(Debug, Serialize)]
struct PluginsResponse {
    plugins: Vec<PluginEntry>,
}

#[derive(Debug, Deserialize)]
struct SetPluginEnabledRequest {
    enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StartExtensionRequest {
    #[serde(default)]
    thread_id: Option<String>,
    event_type: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Serialize)]
struct PluginMutationResponse {
    id: String,
    name: String,
    enabled: bool,
    trust_status: &'static str,
    state_generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallPluginRequest {
    /// Local bundle path, `path:<dir>`, `github:owner/repo`, or an archive URL.
    source: String,
    /// Optional content hash observed during review. When present, the
    /// installer refuses to publish if the copied bundle differs.
    #[serde(default)]
    expected_content_hash: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct UpdatePluginRequest {}

#[derive(Debug, Serialize)]
struct PluginMutationReceiptResponse {
    name: String,
    outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    installed_content_hash: Option<String>,
}

#[derive(Debug, Serialize)]
struct AgentRunsResponse {
    runs: Vec<AgentWorkerRecord>,
}

#[derive(Debug, Deserialize)]
struct SetSkillEnabledRequest {
    enabled: bool,
}

#[derive(Debug, Serialize)]
struct SetSkillEnabledResponse {
    name: String,
    enabled: bool,
}

// ─── Skill lifecycle request/response types ────────────────────────────────

#[derive(Debug, Deserialize)]
struct InstallSkillRequest {
    /// Remote source spec: `github:owner/repo`, `https://…`, or a registry name.
    source: String,
    /// `"project"` or `"global"` (default: `"global"`).
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateSkillRequest {
    /// `"project"`, `"global"`, or `null` (auto-detect).
    #[serde(default)]
    scope: Option<String>,
    /// Digest the caller observed before requesting the update. The mutation
    /// will fail if the on-disk digest has changed since.
    #[serde(default)]
    expected_digest: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UninstallSkillQuery {
    /// `"project"`, `"global"`, or `null` (auto-detect).
    #[serde(default)]
    scope: Option<String>,
    /// Digest the caller observed. The mutation will fail if it has drifted.
    #[serde(default)]
    expected_digest: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TrustSkillRequest {
    /// `"project"`, `"global"`, or `null` (auto-detect).
    #[serde(default)]
    scope: Option<String>,
    /// Digest the caller reviewed. The mutation will fail if it has drifted.
    #[serde(default)]
    expected_digest: Option<String>,
}

/// Scope query parameter used by the audit endpoint.
#[derive(Debug, Deserialize, Default)]
struct SkillScopeQuery {
    /// `"project"` or `"global"` to restrict to one root.
    scope: Option<String>,
}

#[derive(Debug, Serialize)]
struct SkillMutationReceiptResponse {
    /// Skill name as recorded by the mutation.
    name: String,
    /// Human-readable action performed: `"installed"`, `"updated"`, `"removed"`,
    /// `"trusted"`, `"no_change"`, etc.
    outcome: &'static str,
    /// Resolved install scope: `"project"` or `"global"`.
    scope: String,
    /// Display path of the skill package (may be redacted for plugin snapshots).
    safe_target_path: String,
    /// Trust advisory note, present only for `"trusted"` outcomes.
    #[serde(skip_serializing_if = "Option::is_none")]
    trust_note: Option<&'static str>,
}

/// Read-only audit receipt for a single installed skill.
#[derive(Debug, Serialize)]
struct SkillAuditEntry {
    name: String,
    safe_display_path: String,
    source_kind: String,
    scope: String,
    digest: SkillAuditDigest,
    trust: String,
    integrity: String,
    available_actions: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
struct SkillAuditDigest {
    state: String,
    /// Hex digest value; absent when the digest is unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

#[derive(Debug, Serialize)]
struct SkillAuditResponse {
    /// `true` when multiple owned copies with the same name exist. The
    /// caller should re-request with an explicit `scope` parameter.
    ambiguous: bool,
    skills: Vec<SkillAuditEntry>,
}

#[derive(Debug, Deserialize)]
struct DecideApprovalBody {
    decision: String,
    #[serde(default)]
    remember: bool,
}

#[derive(Debug, Serialize)]
struct DecideApprovalResponse {
    ok: bool,
    approval_id: String,
    decision: String,
    delivered: bool,
}

#[derive(Debug, Deserialize)]
struct SubmitUserInputBody {
    answers: Vec<UserInputAnswerBody>,
}

#[derive(Debug, Deserialize)]
struct UserInputAnswerBody {
    id: String,
    label: String,
    value: String,
}

#[derive(Debug, Serialize)]
struct SubmitUserInputResponse {
    ok: bool,
    input_id: String,
    delivered: bool,
}

#[derive(Debug, Serialize)]
struct RuntimeInfoResponse {
    service: &'static str,
    runtime_api_version: &'static str,
    hakus_version: &'static str,
    /// Full 40-character source commit embedded by the shared build script.
    /// Desktop compatibility intentionally rejects `unknown` and abbreviated
    /// values, so source archives without build provenance fail closed.
    hakus_commit: &'static str,
    bind_host: String,
    port: u16,
    auth_required: bool,
    transports: Vec<&'static str>,
    capabilities: RuntimeCapabilities,
    experimental: RuntimeExperimentalCapabilities,
    execution_plane: RuntimeExecutionPlane,
    feature_gates: RuntimeFeatureGates,
    process_started_at_unix_ms: u64,
    // Backward-compatible alias kept for existing clients.
    version: &'static str,
}

#[derive(Debug, Serialize)]
struct RuntimeCapabilitiesResponse {
    runtime_api_version: &'static str,
    event_schema_version: u32,
    capabilities: RuntimeCapabilities,
    execution_plane: RuntimeExecutionPlane,
    feature_gates: RuntimeFeatureGates,
}

#[derive(Debug, Serialize)]
struct RuntimeDiagnosticsResponse {
    service: &'static str,
    runtime_api_version: &'static str,
    execution_plane: RuntimeExecutionPlane,
    feature_gates: RuntimeFeatureGates,
    process_started_at_unix_ms: u64,
    uptime_seconds: u64,
    event_count: u64,
    canonical_ledger_event_count: u64,
    canonical_ledger_session_count: u64,
    /// Whether every canonical ledger session verified as contiguous, with the
    /// failing sessions named when it did not.
    canonical_ledger_integrity: hakus_state::LedgerIntegrityReport,
    provider_activity: Vec<String>,
}

/// Process memory sample in MiB. Both fields are null on platforms without
/// a sampler; on Windows they come from GetProcessMemoryInfo.
#[derive(Debug, Serialize)]
struct MemorySample {
    working_set_mb: Option<f64>,
    peak_working_set_mb: Option<f64>,
}

/// Gap between the legacy JSONL event cursor and the canonical SQLite ledger.
/// A nonzero `shadow_write_lag` is the exact divergence the canonical-ledger
/// refactor exists to prevent, so the bundle surfaces it as a number.
#[derive(Debug, Serialize)]
struct ProjectionLag {
    jsonl_event_seq: u64,
    canonical_event_count: u64,
    shadow_write_lag: u64,
}

/// Release migration diagnostics (Phase 8): the quotable evidence that the
/// default coding path has no Python compat turn and that imported legacy
/// data landed in a healthy canonical ledger. Every field is read from live
/// runtime state — none is asserted unconditionally — so a release that
/// flips `HAKUS_PYTHON_COMPAT_PATH` or drifts from the ledger cannot report
/// a clean migration.
#[derive(Debug, Serialize)]
struct MigrationDiagnostics {
    /// Whether the Python compat turn path was enabled at startup. The
    /// migration gate requires `false`.
    python_compat_flag: bool,
    /// Legacy events imported into the canonical ledger so far.
    compat_imported_event_count: u64,
    /// Legacy JSONL cursor minus canonical events; nonzero means a shadow
    /// write diverged from the ledger.
    shadow_write_lag: u64,
    /// Every verified ledger session was contiguous.
    canonical_ledger_healthy: bool,
    canonical_ledger_sessions_verified: u64,
    canonical_ledger_events_verified: u64,
}

/// Everything a migration or support report needs, in one redacted payload:
/// diagnostics, the metrics counters, a process memory sample, and the
/// JSONL→ledger projection lag. No credential, prompt, or message content is
/// included by construction — every field is a counter, a version, a flag,
/// or a path-free identifier.
#[derive(Debug, Serialize)]
struct RuntimeDiagnosticsBundleResponse {
    generated_at_unix_ms: u64,
    service: &'static str,
    runtime_api_version: &'static str,
    execution_plane: RuntimeExecutionPlane,
    feature_gates: RuntimeFeatureGates,
    process_started_at_unix_ms: u64,
    uptime_seconds: u64,
    event_count: u64,
    canonical_ledger_event_count: u64,
    canonical_ledger_session_count: u64,
    canonical_ledger_integrity: hakus_state::LedgerIntegrityReport,
    provider_activity: Vec<String>,
    compat_imported_event_count: u64,
    memory: MemorySample,
    projection: ProjectionLag,
    migration: MigrationDiagnostics,
}

/// Current and peak process working set in MiB (Windows).
#[cfg(windows)]
fn process_memory_sample() -> MemorySample {
    use windows::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;

    unsafe {
        // GetCurrentProcess returns a pseudo-handle: it must not be closed.
        let mut pmc = PROCESS_MEMORY_COUNTERS::default();
        pmc.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let ok = GetProcessMemoryInfo(GetCurrentProcess(), &mut pmc, pmc.cb);
        if ok.is_ok() {
            MemorySample {
                working_set_mb: Some(pmc.WorkingSetSize as f64 / 1_048_576.0),
                peak_working_set_mb: Some(pmc.PeakWorkingSetSize as f64 / 1_048_576.0),
            }
        } else {
            MemorySample {
                working_set_mb: None,
                peak_working_set_mb: None,
            }
        }
    }
}

#[cfg(not(windows))]
fn process_memory_sample() -> MemorySample {
    MemorySample {
        working_set_mb: None,
        peak_working_set_mb: None,
    }
}

fn default_runtime_capabilities() -> RuntimeCapabilities {
    RuntimeCapabilities {
        threads: true,
        turns: true,
        turn_steer: true,
        turn_interrupt: true,
        event_replay: true,
        external_tools: true,
        environments: true,
        worker_runtime: true,
        fleet_run_create: true,
        fleet_run_start: true,
        fleet_event_replay: true,
        fleet_event_stream: true,
        fleet_local_target: true,
        thread_goals: true,
        memory: true,
        mcp_server_management: true,
        skill_lifecycle: true,
        agent_mail: true,
    }
}

fn env_flag(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => default,
        },
        Err(_) => default,
    }
}

fn runtime_feature_gates() -> RuntimeFeatureGates {
    RuntimeFeatureGates {
        rust_default_path: env_flag("HAKUS_RUST_DEFAULT_PATH", true),
        python_compat_path: env_flag("HAKUS_PYTHON_COMPAT_PATH", false),
        legacy_agentcore: env_flag("HAKUS_LEGACY_AGENTCORE", false),
    }
}

fn process_started_at_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn runtime_api_sub_agent_manager(workspace: &FsPath, workers: usize) -> SharedSubAgentManager {
    let max_agents = workers.max(1);
    new_shared_subagent_manager_with_timeout(
        workspace.to_path_buf(),
        max_agents,
        max_agents,
        Duration::from_secs(crate::config::DEFAULT_SUBAGENT_HEARTBEAT_TIMEOUT_SECS),
        max_agents,
        None,
    )
}

#[derive(Debug, Serialize)]
struct McpServerEntry {
    name: String,
    enabled: bool,
    required: bool,
    command: Option<String>,
    url: Option<String>,
    connected: bool,
    enabled_tools: Vec<String>,
    disabled_tools: Vec<String>,
}

#[derive(Debug, Serialize)]
struct McpServersResponse {
    servers: Vec<McpServerEntry>,
    global: McpGlobalConfig,
}

#[derive(Debug, Deserialize)]
struct McpToolsQuery {
    server: Option<String>,
    #[serde(default)]
    connect: bool,
}

#[derive(Debug, Serialize)]
struct McpToolEntry {
    server: String,
    name: String,
    prefixed_name: String,
    description: Option<String>,
    input_schema: Value,
}

#[derive(Debug, Serialize)]
struct McpToolsResponse {
    tools: Vec<McpToolEntry>,
}

#[derive(Debug, Deserialize)]
struct McpInvokeRequest {
    #[serde(default = "default_json_object")]
    arguments: Value,
}

fn default_json_object() -> Value {
    json!({})
}

/// Project native Runtime events into the session-log shape consumed by the
/// desktop review panel. Keep the original event and payload fields so newer
/// clients can still inspect the complete Rust event envelope.
fn session_log_projection(
    event_name: &str,
    payload: &Value,
) -> (String, serde_json::Map<String, Value>) {
    let mut fields = match payload {
        Value::Object(object) => object.clone(),
        _ => serde_json::Map::new(),
    };
    let item = payload.get("item");
    let item_kind = item
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let is_tool_item = matches!(item_kind, "tool_call" | "command_execution" | "file_change");

    let event_type = match event_name {
        "turn.started" => "turn_start",
        "turn.completed" => "turn_completed",
        "turn.failed" => "turn_failed",
        "turn.cancelled" | "turn.canceled" => "cancelled",
        "item.delta"
            if payload.get("kind").and_then(Value::as_str) == Some("agent_reasoning") =>
        {
            "reasoning"
        }
        "item.delta" => "text_delta",
        "item.started" if is_tool_item => "tool_call_started",
        "item.completed" | "item.failed" if is_tool_item => "tool_call_finished",
        "agent.spawned" => "subagent_spawned",
        "token.usage" | "token_usage" => "token_usage",
        _ => event_name,
    }
    .to_string();

    if let Some(delta) = payload.get("delta") {
        fields.insert("text".to_string(), delta.clone());
    }
    if let Some(turn) = payload.get("turn") {
        for (source, target) in [
            ("input_summary", "user_message"),
            ("effective_provider", "provider"),
            ("effective_model", "model"),
        ] {
            if let Some(value) = turn.get(source) {
                fields.insert(target.to_string(), value.clone());
            }
        }
        if let Some(usage) = turn.get("usage") {
            for key in ["input_tokens", "output_tokens", "cache_hit_tokens"] {
                if let Some(value) = usage.get(key) {
                    fields.insert(key.to_string(), value.clone());
                }
            }
        }
    }
    if is_tool_item {
        if let Some(item) = item {
            let metadata = item.get("metadata");
            let name = metadata
                .and_then(|value| value.get("tool_name"))
                .or_else(|| item.get("summary"));
            if let Some(name) = name {
                fields.insert("name".to_string(), name.clone());
            }
            if let Some(call_id) = metadata
                .and_then(|value| value.get("tool_use_id"))
                .or_else(|| item.get("id"))
            {
                fields.insert("call_id".to_string(), call_id.clone());
            }
            if let Some(detail) = item.get("detail").and_then(Value::as_str) {
                if event_type == "tool_call_started" {
                    let arguments = serde_json::from_str(detail)
                        .unwrap_or_else(|_| Value::String(detail.to_string()));
                    fields.insert("arguments".to_string(), arguments);
                } else {
                    fields.insert("result_preview".to_string(), Value::String(detail.to_string()));
                }
            }
            if event_type == "tool_call_finished" {
                fields.insert(
                    "success".to_string(),
                    json!(event_name == "item.completed"
                        && item.get("status").and_then(Value::as_str) != Some("failed")),
                );
            }
        }
        if let Some(error) = payload.get("error") {
            fields.insert("error".to_string(), error.clone());
        }
    }
    if event_name == "agent.spawned" {
        if let Some(agent_id) = payload.get("agent_id") {
            fields.insert("sub_agent_id".to_string(), agent_id.clone());
        }
        if let Some(task) = item.and_then(|value| value.get("detail")) {
            fields.insert("task".to_string(), task.clone());
        }
    }

    (event_type, fields)
}

#[derive(Debug, Serialize)]
struct McpInvokeResponse {
    ok: bool,
    message: String,
    result: String,
    is_error: bool,
}

#[derive(Debug, Deserialize, Default)]
struct ThreadEventLogQuery {
    #[serde(default)]
    since_seq: Option<u64>,
    #[serde(default)]
    since_turn: Option<u64>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
struct ThreadEventLogResponse {
    session_id: String,
    events: Vec<ThreadEventLogEntry>,
    stats: ThreadEventLogStats,
}

#[derive(Debug, Serialize)]
struct ThreadEventLogEntry {
    #[serde(skip)]
    seq: u64,
    #[serde(rename = "type")]
    event_type: String,
    ts: i64,
    turn: u64,
    event: String,
    payload: Value,
    #[serde(flatten)]
    fields: serde_json::Map<String, Value>,
}

#[derive(Debug, Serialize)]
struct ThreadEventLogStats {
    session_id: String,
    log_path: String,
    archive_path: String,
    live_size_bytes: u64,
    archive_size_bytes: u64,
    event_count: usize,
    current_turn: u64,
}

#[derive(Debug, Deserialize, Default)]
struct CanonicalLedgerQuery {
    #[serde(default)]
    since_seq: Option<u64>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
struct CanonicalLedgerResponse {
    session_id: String,
    after_seq: u64,
    events: Vec<hakus_state::LedgerEventRecord>,
    verification: hakus_state::LedgerVerification,
    /// Number of canonical events in the session beyond the returned window.
    ///
    /// The store read is bounded, and it returns the *oldest* events after the
    /// cursor, so a caller that ignores this can mistake a prefix for the whole
    /// transcript. `verification.last_seq` still reports the true tail.
    omitted_events: u64,
}

#[derive(Debug, Deserialize)]
struct LegacyLedgerImportRequest {
    source_path: PathBuf,
}

/// Where to look for a previous install's Python session store.
///
/// Omitted means "the places a Python sidecar actually used": the runtime's own
/// home, the Python sidecar's default home, and the current directory. A caller
/// that knows better — a portable install, a backup drive — passes explicit
/// roots and gets exactly those.
#[derive(Debug, Default, Deserialize)]
struct LegacyDiscoveryRequest {
    #[serde(default)]
    roots: Vec<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct LegacySessionImportRequest {
    source_path: PathBuf,
    source_session_id: String,
    checkpoint_path: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
struct RuntimeMetricsResponse {
    uptime_seconds: u64,
    process_started_at_unix_ms: u64,
    event_count: u64,
    canonical_ledger_event_count: u64,
    canonical_ledger_session_count: u64,
    /// Canonical events imported from Python compat sources, persisted in
    /// the state database (Phase 0 migration metric). Zero until an import
    /// has happened.
    compat_imported_event_count: u64,
    execution_plane: RuntimeExecutionPlane,
    feature_gates: RuntimeFeatureGates,
    total_turns: u32,
    total_errors: u32,
    active_websockets: u32,
    checkpoints_saved: u32,
    llm_calls: u32,
    llm_retries: u32,
    by_provider: BTreeMap<String, RuntimeProviderMetrics>,
    providers: Vec<String>,
    counters: hakus_telemetry::Counters,
    errors: hakus_telemetry::Errors,
    turn_wall: hakus_telemetry::TurnWall,
}

#[derive(Debug, Serialize)]
struct RuntimeProviderMetrics {
    turns: u32,
    errors: u32,
    llm_calls: u32,
}

/// Request body for `POST /v1/apps/mcp/servers` (create) and
/// `PATCH /v1/apps/mcp/servers/{name}` (update).
///
/// Either `command` **or** `url` must be set on create. On update, only
/// supplied fields are applied; absent fields leave the existing value in
/// place.
#[derive(Debug, Deserialize)]
struct McpServerWriteRequest {
    /// stdio command binary (e.g. `"npx"`).
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    command: Option<Option<String>>,
    /// Arguments for the stdio command.
    args: Option<Vec<String>>,
    /// Working directory for the stdio child process.
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    cwd: Option<Option<PathBuf>>,
    /// Environment variables injected into the stdio child process.
    /// Values are stored as-is; use `${VAR}` syntax to reference environment
    /// variables at runtime instead of embedding secrets here.
    env: Option<std::collections::HashMap<String, String>>,
    /// HTTP(S) endpoint for streamable-HTTP or SSE MCP servers.
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    url: Option<Option<String>>,
    /// Explicit transport override (`"sse"` or `"streamable_http"`).
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    transport: Option<Option<String>>,
    /// Override the server-level connect timeout in seconds.
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    connect_timeout: Option<Option<u64>>,
    /// Override the server-level execute timeout in seconds.
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    execute_timeout: Option<Option<u64>>,
    /// Override the server-level read timeout in seconds.
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    read_timeout: Option<Option<u64>>,
    /// Whether the server is enabled. Defaults to `true` on create.
    enabled: Option<bool>,
    /// Whether a connection failure for this server is fatal.
    required: Option<bool>,
    /// Allowlist of tool names to expose (empty = expose all).
    enabled_tools: Option<Vec<String>>,
    /// Denylist of tool names to hide.
    disabled_tools: Option<Vec<String>>,
    /// Variable names whose runtime values are injected as HTTP headers.
    /// The key in this map is the HTTP header name; the value is the
    /// environment variable whose value supplies the header value at
    /// request time. Credentials remain in the environment, not on disk.
    env_headers: Option<std::collections::HashMap<String, String>>,
    /// Environment variable that contains a bearer token for URL-based servers.
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    bearer_token_env_var: Option<Option<String>>,
    /// OAuth scopes requested during `hakus mcp login`.
    scopes: Option<Vec<String>>,
    /// RFC 8707 resource parameter for the OAuth authorization URL.
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    oauth_resource: Option<Option<String>>,
}

/// Preserve the difference between an omitted PATCH field and an explicit
/// `null`: serde only calls this decoder when the field is present.
fn deserialize_present_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// Response returned by MCP server management endpoints.
///
/// Sensitive fields (`headers`, `env_headers`, `bearer_token_env_var`,
/// `env`, OAuth client secrets) are intentionally omitted or redacted so
/// the API never echoes credentials back to callers.
#[derive(Debug, Serialize)]
struct McpServerDetail {
    name: String,
    enabled: bool,
    required: bool,
    command: Option<String>,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    /// Environment variable names injected into the process.
    /// Values are **not** returned — callers see only the keys.
    env_keys: Vec<String>,
    url: Option<String>,
    transport: Option<String>,
    connect_timeout: Option<u64>,
    execute_timeout: Option<u64>,
    read_timeout: Option<u64>,
    enabled_tools: Vec<String>,
    disabled_tools: Vec<String>,
    /// HTTP header names that are read from environment variables.
    /// The corresponding environment variable values are **not** returned.
    env_header_keys: Vec<String>,
    /// Whether a `bearer_token_env_var` is configured (value not returned).
    has_bearer_token_env_var: bool,
    scopes: Vec<String>,
    oauth_resource: Option<String>,
    /// Live connection state from the in-memory pool (if the pool is active).
    connected: bool,
}

impl McpServerDetail {
    fn from_config(name: &str, cfg: &crate::mcp::McpServerConfig, connected: bool) -> Self {
        let mut env_keys: Vec<String> = cfg.env.keys().cloned().collect();
        env_keys.sort();
        let mut env_header_keys: Vec<String> = cfg.env_headers.keys().cloned().collect();
        env_header_keys.sort();
        Self {
            name: name.to_string(),
            enabled: cfg.is_enabled(),
            required: cfg.required,
            command: cfg.command.clone(),
            args: cfg.args.clone(),
            cwd: cfg.cwd.clone(),
            env_keys,
            url: cfg.url.clone(),
            transport: cfg.transport.clone(),
            connect_timeout: cfg.connect_timeout,
            execute_timeout: cfg.execute_timeout,
            read_timeout: cfg.read_timeout,
            enabled_tools: cfg.enabled_tools.clone(),
            disabled_tools: cfg.disabled_tools.clone(),
            env_header_keys,
            has_bearer_token_env_var: cfg.bearer_token_env_var.is_some(),
            scopes: cfg.scopes.clone(),
            oauth_resource: cfg.oauth_resource.clone(),
            connected,
        }
    }
}

#[derive(Debug, Serialize)]
struct McpServerActionReceipt {
    name: String,
    action: &'static str,
    ok: bool,
}

#[derive(Debug, Deserialize)]
struct AutomationRunsQuery {
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct ThreadEventsQuery {
    since_seq: Option<u64>,
    replay_limit: Option<usize>,
    /// Which durable log to replay. Omitted means the canonical SQLite ledger,
    /// which is the read authority; `jsonl` selects the legacy per-thread event
    /// file, which the runtime keeps mirroring so an older client can still
    /// replay. Passing `canonical` explicitly is still accepted.
    #[serde(default)]
    source: Option<String>,
}

const DEFAULT_FLEET_EVENT_REPLAY_LIMIT: usize = 250;
const MAX_FLEET_EVENT_REPLAY_LIMIT: usize = 1_000;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateFleetRunRequest {
    #[serde(default)]
    name: Option<String>,
    target: FleetRuntimeTarget,
    roles: Vec<ManagedFleetRoleRequest>,
    workflow: ManagedFleetWorkflowRequest,
    #[serde(default, alias = "workers")]
    worker_specs: Vec<FleetWorkerSpec>,
    #[serde(default)]
    labels: BTreeMap<String, String>,
    #[serde(default)]
    security_policy: Option<FleetSecurityPolicy>,
    #[serde(default)]
    max_workers: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManagedFleetRoleRequest {
    name: String,
    #[serde(default)]
    agent_profile: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManagedFleetWorkflowRequest {
    id: String,
    kind: FleetWorkflowKind,
    #[serde(alias = "task_specs")]
    tasks: Vec<FleetTaskSpec>,
}

#[derive(Debug, Deserialize)]
struct FleetEventsQuery {
    after: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProvisionSshPasswordRequest {
    /// This field is accepted only at the authenticated secure-input
    /// boundary and is never serialized, logged, or persisted.
    password: String,
}

#[derive(Debug, Serialize)]
struct StartTurnResponse {
    thread: ThreadRecord,
    turn: TurnRecord,
}

fn install_runtime_server_workshop_budgets(
    config: &Config,
) -> crate::tools::large_output_router::WorkshopConfig {
    crate::tools::large_output_router::WorkshopConfig::install_active(config.workshop.as_ref())
}

fn open_runtime_threads_for_server(
    config: &Config,
    workspace: PathBuf,
    manager_config: RuntimeThreadManagerConfig,
    plugin_registry: Arc<crate::plugins::PluginRegistry>,
) -> Result<(
    SharedRuntimeThreadManager,
    crate::tools::large_output_router::WorkshopConfig,
)> {
    // The Runtime API lazily creates engines after the HTTP/Web server starts.
    // Install the resolved process-wide read/tool byte limits before the
    // thread manager can spawn any of those engines, matching interactive and
    // headless exec startup.
    let workshop_activation = install_runtime_server_workshop_budgets(config);
    let manager = Arc::new(RuntimeThreadManager::open_with_plugin_registry(
        config.clone(),
        workspace,
        manager_config,
        plugin_registry,
    )?);
    Ok((manager, workshop_activation))
}

/// Start the runtime API server.
pub async fn run_http_server(
    config: Config,
    workspace: PathBuf,
    plugin_discovery: Arc<crate::plugins::PluginDiscoveryContext>,
    options: RuntimeApiOptions,
) -> Result<()> {
    if options.web && options.host != "127.0.0.1" {
        bail!("Hakus web is loopback-only and must bind to 127.0.0.1");
    }
    if options.web && options.insecure_no_auth {
        bail!("Hakus web requires Runtime authentication; remove --insecure");
    }

    let addr: SocketAddr = format!("{}:{}", options.host, options.port)
        .parse()
        .with_context(|| format!("Invalid bind address '{}:{}'", options.host, options.port))?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("Failed to bind {addr}"))?;
    let bound_addr = listener
        .local_addr()
        .context("Failed to read Runtime API listener address")?;

    let task_cfg = TaskManagerConfig::from_runtime(
        &config,
        workspace.clone(),
        config.default_text_model.clone(),
        Some(options.workers),
    );
    let (runtime_threads, _workshop_activation) = open_runtime_threads_for_server(
        &config,
        workspace.clone(),
        RuntimeThreadManagerConfig::from_task_data_dir(task_cfg.data_dir.clone()),
        plugin_discovery.registry_for_workspace(&workspace),
    )?;
    let task_manager =
        TaskManager::start_with_runtime_manager(task_cfg, config.clone(), runtime_threads.clone())
            .await?;
    let automations = Arc::new(Mutex::new(AutomationManager::default_location()?));
    runtime_threads.attach_automation_manager(automations.clone());
    let scheduler_cancel = CancellationToken::new();
    let scheduler_handle = spawn_scheduler(
        automations.clone(),
        task_manager.clone(),
        scheduler_cancel.clone(),
        AutomationSchedulerConfig::default(),
    );

    let sessions_dir = default_sessions_dir()?;
    let runtime_token_env = runtime_token_environment(&|name| std::env::var(name).ok());
    let runtime_token_alias_warning =
        runtime_token_alias_warning(options.auth_token.as_deref(), &runtime_token_env);
    let resolved_auth = resolve_runtime_auth(
        options.auth_token.clone(),
        runtime_token_env.token,
        options.insecure_no_auth,
    );
    let runtime_token = resolved_auth.token.clone();
    let auth_enabled = runtime_token.is_some();
    let (web, web_bootstrap) = if options.web {
        runtime_token
            .as_ref()
            .context("Hakus web requires a Runtime authentication token")?;
        let (web, bootstrap) = web::RuntimeWebState::new();
        (Some(web), Some(bootstrap))
    } else {
        (None, None)
    };
    let skill_state = SkillStateStore::load_default()
        .context("load persistent Skill activation state for Runtime API")?;
    let sub_agent_manager = runtime_api_sub_agent_manager(&workspace, options.workers);
    let mcp_global_config = load_mcp_global_config(&config)
        .context("load persistent MCP UI configuration")?;
    let wechat_client = IlLinkClient::new(hakus_wechat::WechatState::default_dir());
    let wechat_settings = wechat_client
        .state()
        .load_settings()
        .ok()
        .unwrap_or_default();
    let state = RuntimeApiState {
        config: Arc::new(parking_lot::RwLock::new(config.clone())),
        workspace,
        plugin_discovery,
        task_manager,
        runtime_threads,
        cors_origins: options.cors_origins.clone(),
        sessions_dir,
        config_path: options.config_path.clone(),
        config_profile: options.config_profile.clone(),
        automations,
        sub_agent_manager,
        runtime_token: runtime_token.clone(),
        skill_state: Arc::new(Mutex::new(skill_state)),
        auth_required: auth_enabled,
        bind_host: options.host.clone(),
        bind_port: bound_addr.port(),
        mobile_enabled: options.mobile,
        web,
        fleet_hakus_binary: configured_hakus_binary(),
        ssh_password_vault: Arc::new(SshPasswordVault::new()),
        mcp_pool: Arc::new(Mutex::new(None)),
        mcp_global_config: Arc::new(Mutex::new(mcp_global_config)),
        wechat: Arc::new(Mutex::new(WechatRuntimeState {
            client: wechat_client,
            login: None,
            auto_reply: wechat_settings.auto_reply,
            poll_lock: Arc::new(Mutex::new(())),
            threads: HashMap::new(),
            users: wechat_settings.users,
        })),
        started_at: Instant::now(),
        started_at_unix_ms: process_started_at_unix_ms(),
        execution_plane: RuntimeExecutionPlane::Rust,
        feature_gates: runtime_feature_gates(),
        #[cfg(test)]
        compat_stream_test_hook: None,
    };
    let wechat_bot = tokio::spawn(run_wechat_bot(state.clone()));
    let app = build_router(state);

    println!("Runtime API listening on http://{bound_addr}");
    for line in runtime_auth_status_lines(&resolved_auth) {
        println!("{line}");
    }
    if let Some(warning) = runtime_token_alias_warning {
        println!("{warning}");
    }
    if options.mobile {
        print_mobile_urls(
            bound_addr,
            auth_enabled,
            resolved_auth.generated,
            options.show_qr,
        );
    }
    if let Some(bootstrap) = web_bootstrap {
        println!("Hakus web enabled at http://{bound_addr}/");
        let bootstrap_url = web::bootstrap_url(bound_addr, &bootstrap);
        println!(
            "Hakus web bootstrap (single-use, expires in {} min): {bootstrap_url}",
            web::BOOTSTRAP_TTL.as_secs() / 60
        );
        if let Some(warning) = web_launcher_warning(crate::utils::open_url(&bootstrap_url)) {
            println!("{warning}");
        }
    }
    let is_loopback = options.host == "127.0.0.1" || options.host == "::1";
    if is_loopback {
        println!("Security: this server is local-first. Do not expose it to untrusted networks.");
    } else {
        println!(
            "Security: bound to {host}; reachable from any peer that can route to this address.",
            host = options.host
        );
        if !auth_enabled {
            println!(
                "  WARNING: auth is disabled. Anyone on the network can call /v1/* without authentication."
            );
        }
        println!(
            "  /v1/runtime/info reports bind_host={host:?}, port={port}, auth_required={auth}.",
            host = options.host,
            port = bound_addr.port(),
            auth = auth_enabled,
        );
    }
    let serve_result = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .map_err(|e| anyhow!("Runtime API server error: {e}"));
    scheduler_cancel.cancel();
    scheduler_handle.abort();
    wechat_bot.abort();
    serve_result
}

fn web_launcher_warning(result: Result<()>) -> Option<String> {
    result.err().map(|error| {
        format!(
            "warning: could not open the default browser ({error}); open the bootstrap URL above manually"
        )
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RuntimeCharacter {
    name: String,
    nickname: String,
    personality: String,
    scenario: String,
    first_message: String,
    avatar_type: String,
    #[serde(default)]
    system_prompt: String,
}

impl Default for RuntimeCharacter {
    fn default() -> Self {
        Self {
            name: "HakusAI".to_string(),
            nickname: "HakusAI".to_string(),
            personality: String::new(),
            scenario: String::new(),
            first_message: String::new(),
            avatar_type: "none".to_string(),
            system_prompt: String::new(),
        }
    }
}

#[derive(Debug, Deserialize, Default)]
struct UpdateCharacterRequest {
    name: Option<String>,
    nickname: Option<String>,
    personality: Option<String>,
    scenario: Option<String>,
    first_message: Option<String>,
    system_prompt: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct McpGlobalConfigPatch {
    auto_start: Option<bool>,
    fail_fast: Option<bool>,
    tool_naming: Option<String>,
}

fn character_path(state: &RuntimeApiState) -> PathBuf {
    state
        .config
        .read()
        .mcp_config_path()
        .parent()
        .unwrap_or_else(|| FsPath::new("."))
        .join("character.json")
}

fn load_character(state: &RuntimeApiState) -> Result<RuntimeCharacter, ApiError> {
    let path = character_path(state);
    if !path.exists() {
        return Ok(RuntimeCharacter::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| ApiError::internal(format!("Failed to read character config: {e}")))?;
    serde_json::from_str(&raw)
        .map_err(|e| ApiError::internal(format!("Failed to parse character config: {e}")))
}

fn save_character(state: &RuntimeApiState, character: &RuntimeCharacter) -> Result<(), ApiError> {
    let path = character_path(state);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| ApiError::internal(format!("Failed to create character directory: {e}")))?;
    }
    let bytes = serde_json::to_vec_pretty(character)
        .map_err(|e| ApiError::internal(format!("Failed to serialize character config: {e}")))?;
    crate::utils::write_atomic(&path, &bytes)
        .map_err(|e| ApiError::internal(format!("Failed to save character config: {e}")))
}

fn mcp_global_config_path(config: &Config) -> PathBuf {
    config
        .mcp_config_path()
        .parent()
        .unwrap_or_else(|| FsPath::new("."))
        .join("mcp-ui.json")
}

fn load_mcp_global_config(config: &Config) -> Result<McpGlobalConfig> {
    let path = mcp_global_config_path(config);
    if !path.exists() {
        return Ok(McpGlobalConfig::default());
    }
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read MCP UI config {}", path.display()))?;
    serde_json::from_str(&raw)
        .with_context(|| format!("Failed to parse MCP UI config {}", path.display()))
}

fn save_mcp_global_config(config: &Config, value: &McpGlobalConfig) -> Result<()> {
    let path = mcp_global_config_path(config);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create MCP UI config directory {}", parent.display()))?;
    }
    let bytes = serde_json::to_vec_pretty(value)?;
    crate::utils::write_atomic(&path, &bytes)
        .with_context(|| format!("Failed to save MCP UI config {}", path.display()))
}

pub fn build_router(state: RuntimeApiState) -> Router {
    let api_routes = Router::new()
        .route(
            "/v1/sessions",
            get(list_sessions)
                .post(create_session_from_thread)
                .put(save_current_session),
        )
        .route("/v1/sessions/summary", get(list_sessions_summary))
        .route("/v1/sessions/export", get(sessions::export_sessions))
        .route("/v1/sessions/migrate", post(sessions::migrate_sessions))
        .route(
            "/v1/sessions/{id}",
            get(get_session).patch(patch_session).delete(delete_session),
        )
        .route(
            "/v1/sessions/{id}/resume-thread",
            post(resume_session_thread),
        )
        .route("/v1/workspace/status", get(workspace_status))
        .route("/v1/workspace/status/files", get(workspace::workspace_git_status))
        .route("/v1/workspace/diff", get(workspace::workspace_diff))
        .route("/v1/workspace/stage", post(workspace::stage_path))
        .route("/v1/workspace/discard", post(workspace::discard_path))
        .route("/v1/workspace/apply-hunk", post(workspace::apply_hunk))
        .route("/v1/workspace/worktree", post(workspace::add_worktree))
        .route(
            "/v1/projects",
            get(projects::list_projects).post(projects::create_project),
        )
        .route(
            "/v1/projects/{id}",
            patch(projects::update_project).delete(projects::delete_project),
        )
        .route("/v1/agent-runs", get(list_agent_runs))
        .route("/v1/agent-runs/{run_id}", get(get_agent_run))
        .route(
            "/v1/fleet/runs",
            get(list_fleet_runs).post(create_fleet_run),
        )
        .route("/v1/fleet/runs/{run_id}", get(get_fleet_run))
        .route(
            "/v1/fleet/runs/{run_id}/workers",
            get(list_fleet_run_workers),
        )
        .route("/v1/fleet/runs/{run_id}/start", post(start_fleet_run))
        .route(
            "/v1/fleet/runs/{run_id}/workers/{worker_id}/ssh-password",
            post(provision_fleet_ssh_password),
        )
        .route("/v1/fleet/runs/{run_id}/events", get(stream_fleet_events))
        .route(
            "/v1/fleet/runs/{run_id}/events/replay",
            get(replay_fleet_events),
        )
        .route("/v1/fleet/runs/{run_id}/stop", post(stop_fleet_run))
        .route(
            "/v1/fleet/runs/{run_id}/receipts",
            get(list_fleet_run_receipts),
        )
        .route(
            "/v1/fleet/runs/{run_id}/receipts/{task_id}",
            get(get_fleet_run_receipt),
        )
        .route(
            "/v1/fleet/runs/{run_id}/receipts/{task_id}/evidence",
            get(inspect_fleet_run_receipt_evidence),
        )
        .route("/v1/fleet/workers/{worker_id}", get(get_fleet_worker))
        .route(
            "/v1/fleet/workers/{worker_id}/interrupt",
            post(interrupt_fleet_worker),
        )
        .route(
            "/v1/fleet/workers/{worker_id}/stop",
            post(stop_fleet_worker),
        )
        .route(
            "/v1/fleet/workers/{worker_id}/restart",
            post(restart_fleet_worker),
        )
        .route("/v1/stream", post(stream_turn))
        .route("/v1/threads", get(list_threads).post(create_thread))
        .route("/v1/threads/summary", get(list_threads_summary))
        .route(
            "/v1/threads/{id}",
            get(get_thread).patch(update_thread).delete(delete_thread),
        )
        .route(
            "/v1/threads/{id}/event-log",
            get(get_thread_event_log).delete(clear_thread_event_log),
        )
        .route(
            "/v1/threads/{id}/ledger",
            get(get_canonical_ledger),
        )
        .route(
            "/v1/threads/{id}/ledger/verify",
            get(verify_canonical_ledger),
        )
        .route(
            "/v1/threads/{id}/ledger/import-legacy",
            post(import_legacy_ledger),
        )
        .route(
            "/v1/threads/{id}/state/import-legacy",
            post(import_legacy_session_state),
        )
        .route(
            "/v1/migrations/legacy-sessions",
            post(discover_legacy_sessions),
        )
        .route("/v1/threads/{id}/messages", delete(clear_thread_messages))
        .route("/v1/threads/{id}/messages/{message_id}", delete(delete_thread_message))
        .route("/v1/threads/{id}/rewind", post(rewind_thread_to_message))
        .route("/v1/threads/{id}/resume", post(resume_thread))
        .route("/v1/threads/{id}/fork", post(fork_thread))
        .route("/v1/threads/{id}/undo", post(undo_thread_turn))
        .route("/v1/threads/{id}/patch-undo", post(patch_undo_thread_turn))
        .route("/v1/threads/{id}/retry", post(retry_thread_turn))
        .route("/v1/threads/{id}/turns", post(start_thread_turn))
        .route(
            "/v1/threads/{id}/turns/{turn_id}/steer",
            post(steer_thread_turn),
        )
        .route(
            "/v1/threads/{id}/turns/{turn_id}/interrupt",
            post(interrupt_thread_turn),
        )
        .route(
            "/v1/threads/{id}/turns/{turn_id}/tool-calls/{call_id}/result",
            post(deliver_dynamic_tool_result),
        )
        .route("/v1/threads/{id}/compact", post(compact_thread))
        .route("/v1/threads/{id}/events", get(stream_thread_events))
        .route("/v1/agent-mail", post(send_agent_mail))
        .route("/v1/threads/{id}/agent-mail", get(list_agent_mail))
        .route(
            "/v1/threads/{id}/agent-mail/{message_id}/deliver",
            post(deliver_agent_mail),
        )
        .route(
            "/v1/threads/{id}/agent-mail/{message_id}/read",
            post(mark_agent_mail_read),
        )
        .route(
            "/v1/threads/{id}/goal",
            get(get_thread_goal)
                .put(upsert_thread_goal)
                .delete(delete_thread_goal),
        )
        .route("/v1/threads/{id}/goal/complete", post(complete_thread_goal))
        .route("/v1/threads/{id}/goal/block", post(block_thread_goal))
        .route("/v1/threads/{id}/goal/pause", post(pause_thread_goal))
        .route("/v1/threads/{id}/goal/resume", post(resume_thread_goal))
        .route("/v1/approvals/{approval_id}", post(decide_approval))
        .route(
            "/v1/user-input/{thread_id}/{input_id}",
            post(submit_user_input),
        )
        .route("/v1/tasks", get(list_tasks).post(create_task))
        .route("/v1/tasks/{id}", get(get_task))
        .route("/v1/tasks/{id}/cancel", post(cancel_task))
        .route("/v1/skills", get(list_skills))
        .route(
            "/v1/skills/{name}",
            post(set_skill_enabled).delete(uninstall_skill_api),
        )
        .route(
            "/v1/apps/mcp/servers",
            get(list_mcp_servers).post(create_mcp_server),
        )
        .route(
            "/v1/apps/mcp/servers/{name}",
            get(get_mcp_server)
                .patch(update_mcp_server)
                .delete(delete_mcp_server),
        )
        .route(
            "/v1/apps/mcp/servers/{name}/enable",
            post(enable_mcp_server),
        )
        .route(
            "/v1/apps/mcp/servers/{name}/disable",
            post(disable_mcp_server),
        )
        .route(
            "/v1/apps/mcp/servers/{name}/reconnect",
            post(reconnect_mcp_server),
        )
        .route(
            "/v1/apps/mcp/servers/{name}/stop",
            post(stop_mcp_server),
        )
        .route(
            "/v1/apps/mcp/servers/{name}/tools/{tool}/invoke",
            post(invoke_mcp_tool),
        )
        .route("/v1/skills/install", post(install_skill_api))
        .route("/v1/skills/{name}/update", post(update_skill_api))
        .route("/v1/skills/{name}/trust", post(trust_skill_api))
        .route("/v1/skills/{name}/audit", get(audit_skill_api))
        .route("/v1/plugins", get(list_plugins))
        .route(
            "/v1/plugins/{name}/enable",
            post(set_plugin_enabled),
        )
        .route(
            "/v1/plugins/{name}/disable",
            post(set_plugin_enabled),
        )
        .route("/v1/plugins/install", post(install_plugin_api))
        .route("/v1/plugins/{name}/update", post(update_plugin_api))
        .route("/v1/plugins/{name}", delete(uninstall_plugin_api))
        .route("/v1/extensions/{name}/start", post(start_extension))
        .route("/v1/extensions/{name}/stop", post(stop_extension))
        .route("/v1/extensions/{name}", get(extension_status))
        .route("/v1/apps/mcp/tools", get(list_mcp_tools))
        .route(
            "/v1/automations",
            get(list_automations).post(create_automation),
        )
        .route(
            "/v1/automations/{id}",
            get(get_automation)
                .patch(update_automation)
                .delete(delete_automation),
        )
        .route("/v1/automations/{id}/run", post(run_automation))
        .route("/v1/automations/{id}/pause", post(pause_automation))
        .route("/v1/automations/{id}/resume", post(resume_automation))
        .route("/v1/automations/{id}/runs", get(list_automation_runs))
        .route("/v1/usage", get(get_usage))
        .route("/v1/snapshots", get(list_snapshots))
        .route("/v1/snapshots/{id}/restore", post(restore_snapshot))
        .route("/v1/providers", get(list_providers).post(create_custom_provider))
        .route(
            "/v1/providers/{id}",
            post(update_provider).delete(delete_custom_provider),
        )
        .route(
            "/v1/providers/{id}/models",
            get(list_provider_models).post(fetch_provider_models),
        )
        .route(
            "/v1/providers/{id}/test",
            post(test_provider_connection),
        )
        .route("/v1/providers/{id}/switch", post(switch_provider))
        .route(
            "/v1/providers/{id}/headers",
            get(get_provider_headers).put(set_provider_headers),
        )
        .route("/v1/config", get(get_config).post(set_config))
        .route("/v1/config/credentials", delete(clear_runtime_credentials))
        .route("/v1/config/user-data", delete(clear_user_config))
        .route("/v1/config/import", post(import_config))
        .route("/v1/upload", post(upload_files))
        .route("/v1/files", get(list_files))
        .route("/v1/files/{id}", get(get_file).delete(delete_file))
        .route("/v1/tts", post(text_to_speech))
        .route("/v1/tts/voices", get(list_tts_voices))
        .route("/v1/voice/clone", post(clone_voice))
        .route("/v1/voice/clone/status", get(clone_voice_status))
        .route("/v1/voice/asr", post(transcribe_voice))
        .route("/v1/character", get(get_character).patch(update_character))
        .route(
            "/v1/apps/mcp/config",
            get(get_mcp_global_config).patch(update_mcp_global_config),
        )
        .route("/v1/config/reload", post(reload_config))
        .route(
            "/v1/memory",
            get(list_memory)
                .post(create_memory_entry)
                .delete(clear_memory),
        )
        .route("/v1/memory/{id}", get(get_memory_entry))
        .route("/v1/wechat/status", get(get_wechat_status))
        .route("/v1/wechat/login", post(wechat_login))
        .route("/v1/wechat/logout", post(wechat_logout))
        .route("/v1/wechat/settings", patch(update_wechat_settings))
        .route("/v1/wechat/send", post(wechat_send))
        .route("/v1/wechat/poll", post(wechat_poll))
        .route("/v1/metrics", get(get_metrics))
        .route("/v1/diagnostics", get(get_diagnostics))
        .route("/v1/diagnostics/bundle", get(get_diagnostics_bundle))
        .route(
            "/v1/diagnostics/ledger/{session_id}",
            get(get_canonical_ledger),
        )
        .route("/v1/logs", get(get_runtime_logs).delete(clear_runtime_logs))
        .route("/v1/logs/files", get(list_runtime_log_files))
        .route(
            "/v1/providers/{id}/keys",
            get(list_provider_keys).post(add_provider_key),
        )
        .route("/v1/providers/{id}/keys/{key_id}", delete(delete_provider_key))
        .route("/v1/providers/{id}/key", delete(clear_provider_api_key))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_runtime_token,
        ));

    let router = Router::new()
        .route("/", get(web::web_page))
        .route("/assets/hakus-web.css", get(web::web_styles))
        .route("/assets/hakus-web.js", get(web::web_script))
        .route("/assets/hakus-192.png", get(web::web_icon))
        .route(
            "/__hakus/bootstrap/{nonce}",
            get(web::exchange_bootstrap),
        )
        .route("/health", get(health))
        .route("/v1/health", get(health))
        .route("/mobile", get(mobile_page))
        .route("/mobile/", get(mobile_page))
        .route("/v1/runtime/info", get(runtime_info))
        .route("/v1/capabilities", get(runtime_capabilities))
        .merge(api_routes)
        .layer(cors_layer(&state.cors_origins));

    #[cfg(all(not(target_os = "android"), not(target_env = "ohos")))]
    let router = router.route("/ws/terminal", get(terminal::terminal_ws));

    router.with_state(state)
}

async fn mobile_page(State(state): State<RuntimeApiState>, req: Request) -> Response {
    if !state.mobile_enabled {
        return (
            StatusCode::NOT_FOUND,
            "mobile control is disabled; start with `hakus serve --mobile`",
        )
            .into_response();
    }
    let _ = req;
    Html(MOBILE_HTML).into_response()
}

fn print_mobile_urls(addr: SocketAddr, auth_enabled: bool, generated_auth: bool, show_qr: bool) {
    println!("Mobile control page enabled.");

    let port = addr.port();
    let qr_url = if addr.ip().is_unspecified() {
        println!("  Local: http://127.0.0.1:{port}/mobile");
        if let Some(ip) = detect_lan_ip() {
            let lan_url = format!("http://{ip}:{port}/mobile");
            println!("  LAN:   {lan_url}");
            lan_url
        } else {
            println!("  LAN:   bind is 0.0.0.0; open http://<this-machine-ip>:{port}/mobile");
            format!("http://127.0.0.1:{port}/mobile")
        }
    } else {
        let url = format!("http://{addr}/mobile");
        println!("  URL:   {url}");
        url
    };
    if auth_enabled {
        if generated_auth {
            println!(
                "  Auth uses an unprinted generated token; restart with HAKUS_RUNTIME_TOKEN or --auth-token to sign in from another client."
            );
        } else {
            println!("  Enter the configured runtime token in the page connection field.");
        }
    }
    println!("Mobile security: use only on a trusted LAN/VPN; this server does not provide TLS.");

    if show_qr {
        match qrcode::QrCode::new(qr_url.as_bytes()) {
            Ok(qr) => {
                let qr_str = qr.render::<qrcode::render::unicode::Dense1x2>().build();
                println!("\n{qr_str}");
            }
            Err(e) => {
                eprintln!("Warning: could not generate QR code: {e}");
            }
        }
    }
}

#[cfg(test)]
fn url_query_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                use std::fmt::Write as _;
                let _ = write!(encoded, "%{byte:02X}");
            }
        }
    }
    encoded
}

fn detect_lan_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    // UDP connect only selects the outbound interface locally; no packet is sent.
    socket.connect("10.255.255.255:1").ok()?;
    let addr = socket.local_addr().ok()?;
    Some(addr.ip().to_string())
}

async fn health(State(state): State<RuntimeApiState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "hakus-runtime-api",
        mode: "local",
        execution_plane: state.execution_plane,
        feature_gates: state.feature_gates.clone(),
        uptime_seconds: state.started_at.elapsed().as_secs(),
    })
}

async fn get_wechat_status(
    State(state): State<RuntimeApiState>,
) -> Result<Json<WechatStatusResponse>, ApiError> {
    let guard = state.wechat.lock().await;
    let client = guard.client.clone();
    let auto_reply = guard.auto_reply;
    let qrcode_base64 = guard
        .login
        .as_ref()
        .map(|handle| handle.qr_image_b64.clone());
    let login_status = match guard.login.as_ref() {
        Some(handle) => handle.current_status().await,
        None => None,
    };
    drop(guard);

    if client.is_logged_in().await {
        let account_id = client.account_snapshot().await.map(|account| account.account_id);
        return Ok(Json(WechatStatusResponse {
            status: "connected",
            auto_reply,
            qrcode_base64: None,
            account_id,
        }));
    }

    let status = match login_status {
        Some(QrLoginStatus::Scanned) => "scanned",
        Some(QrLoginStatus::Expired) => "expired",
        Some(QrLoginStatus::Confirmed { .. }) => "waiting",
        Some(QrLoginStatus::Redirect { .. }) | Some(QrLoginStatus::Waiting) => "waiting",
        None if qrcode_base64.is_some() => "waiting",
        None => "disconnected",
    };
    Ok(Json(WechatStatusResponse {
        status,
        auto_reply,
        qrcode_base64: if status == "disconnected" || status == "expired" {
            None
        } else {
            qrcode_base64
        },
        account_id: None,
    }))
}

async fn wechat_login(
    State(state): State<RuntimeApiState>,
) -> Result<Json<WechatStatusResponse>, ApiError> {
    let mut guard = state.wechat.lock().await;
    if let Some(handle) = guard.login.as_ref() {
        let current = handle.current_status().await;
        if !matches!(&current, Some(QrLoginStatus::Expired)) {
            let status = match current {
                Some(QrLoginStatus::Scanned) => "scanned",
                Some(QrLoginStatus::Confirmed { .. }) if guard.client.is_logged_in().await => {
                    "connected"
                }
                _ => "waiting",
            };
            return Ok(Json(WechatStatusResponse {
                status,
                auto_reply: guard.auto_reply,
                qrcode_base64: Some(handle.qr_image_b64.clone()),
                account_id: None,
            }));
        }
        handle.cancel();
        guard.login = None;
    }

    let client = guard.client.clone();
    let handle = hakus_wechat::login::start_qr_login(&client)
        .await
        .map_err(|error| ApiError::bad_request(format!("WeChat QR login failed: {error}")))?;
    let qrcode_base64 = handle.qr_image_b64.clone();
    guard.login = Some(handle);
    Ok(Json(WechatStatusResponse {
        status: "waiting",
        auto_reply: guard.auto_reply,
        qrcode_base64: Some(qrcode_base64),
        account_id: None,
    }))
}

async fn wechat_logout(
    State(state): State<RuntimeApiState>,
) -> Result<Json<Value>, ApiError> {
    let (client, login) = {
        let mut guard = state.wechat.lock().await;
        (guard.client.clone(), guard.login.take())
    };
    if let Some(handle) = login {
        handle.cancel();
    }
    client
        .logout()
        .await
        .map_err(|error| ApiError::internal(format!("WeChat logout failed: {error}")))?;
    Ok(Json(json!({ "ok": true })))
}

async fn update_wechat_settings(
    State(state): State<RuntimeApiState>,
    Json(request): Json<WechatSettingsRequest>,
) -> Result<Json<Value>, ApiError> {
    let mut guard = state.wechat.lock().await;
    guard
        .client
        .state()
        .save_settings(&hakus_wechat::WechatSettings {
            auto_reply: request.enabled,
            users: guard.users.clone(),
        })
        .map_err(|error| ApiError::internal(format!("Failed to save WeChat settings: {error}")))?;
    guard.auto_reply = request.enabled;
    Ok(Json(json!({ "enabled": request.enabled })))
}

async fn wechat_send(
    State(state): State<RuntimeApiState>,
    Json(request): Json<WechatSendRequest>,
) -> Result<Json<Value>, ApiError> {
    if request.user_id.trim().is_empty() || request.text.trim().is_empty() {
        return Err(ApiError::bad_request("user_id and text are required"));
    }
    let client = state.wechat.lock().await.client.clone();
    client
        .send_text(request.user_id.trim(), &request.text)
        .await
        .map_err(|error| ApiError::bad_request(format!("WeChat send failed: {error}")))?;
    Ok(Json(json!({ "success": true })))
}

async fn wechat_poll(
    State(state): State<RuntimeApiState>,
) -> Result<Json<WechatMessagesResponse>, ApiError> {
    let (client, poll_lock) = {
        let guard = state.wechat.lock().await;
        (guard.client.clone(), guard.poll_lock.clone())
    };
    let _poll = poll_lock.lock().await;
    let messages = client
        .poll_text_messages()
        .await
        .map_err(|error| ApiError::bad_request(format!("WeChat poll failed: {error}")))?
        .into_iter()
        .map(|(user_id, text, id)| WechatMessageEntry { user_id, text, id })
        .collect();
    Ok(Json(WechatMessagesResponse { messages }))
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum WechatCommand {
    Help,
    Status,
    New,
    Project(Option<String>),
    Model(Option<String>),
    Mode(Option<String>),
    Thinking(Option<String>),
    Reply(Option<String>),
    Bind(Option<String>),
    Unknown(String),
}

fn parse_wechat_command(text: &str) -> Option<WechatCommand> {
    let mut tokens = text.trim().split_whitespace();
    let name = tokens.next()?.strip_prefix('/')?;
    if name.is_empty() {
        return None;
    }
    let argument = tokens.collect::<Vec<_>>().join(" ");
    let argument = (!argument.is_empty()).then_some(argument);
    let normalized = name.to_ascii_lowercase();

    Some(match normalized.as_str() {
        "help" | "帮助" => WechatCommand::Help,
        "status" | "状态" => WechatCommand::Status,
        "new" | "新建" | "clear" => WechatCommand::New,
        "project" | "项目" => WechatCommand::Project(argument),
        "model" | "模型" => WechatCommand::Model(argument),
        "mode" | "模式" => WechatCommand::Mode(argument),
        "think" | "thinking" | "思考" => WechatCommand::Thinking(argument),
        "reply" | "回复" => WechatCommand::Reply(argument),
        "bind" => WechatCommand::Bind(argument),
        _ => WechatCommand::Unknown(name.to_string()),
    })
}

fn wechat_help_text() -> String {
    [
        "机器人命令：",
        "/帮助 — 查看这份说明",
        "/状态 — 查看工作区、模型和任务状态",
        "/新建 或 /clear — 开始新的对话",
        "/项目 [名称] — 查看或切换工作区",
        "/模型 [名称] — 查看或切换模型",
        "/模式 [工作|编码|计划] — 查看或切换运行模式",
        "/思考 [auto|low|medium|high|max] — 查看或切换思考级别",
        "/回复 [normal|concise] — 查看或切换回复详细程度",
        "/bind — 查看当前聊天关联状态",
    ]
    .join("\n")
}

fn wechat_workspace_name(workspace: &FsPath) -> String {
    workspace
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("当前工作区")
        .to_string()
}

fn wechat_task_status(status: crate::task_manager::TaskStatus) -> &'static str {
    match status {
        crate::task_manager::TaskStatus::Queued => "排队中",
        crate::task_manager::TaskStatus::Running => "运行中",
        crate::task_manager::TaskStatus::Completed => "已完成",
        crate::task_manager::TaskStatus::Failed => "失败",
        crate::task_manager::TaskStatus::Canceled => "已取消",
    }
}

async fn wechat_status_text(state: &RuntimeApiState, user_id: &str) -> String {
    let user_settings = state
        .wechat
        .lock()
        .await
        .users
        .get(user_id)
        .cloned()
        .unwrap_or_default();
    let thread_id = wechat_thread_for_user(state, user_id).await;
    let thread = if let Some(thread_id) = thread_id {
        state.runtime_threads.get_thread(&thread_id).await.ok()
    } else {
        None
    };
    let (model, reasoning) = {
        let config = state.config.read();
        (
            thread
                .as_ref()
                .map(|thread| thread.model.clone())
                .or(user_settings.model.clone())
                .unwrap_or_else(|| config.default_model()),
            user_settings
                .reasoning_effort
                .clone()
                .unwrap_or_else(|| config.reasoning_effort().unwrap_or("auto").to_string()),
        )
    };
    let workspace = if let Some(thread) = thread.as_ref() {
        thread.workspace.clone()
    } else {
        user_settings.workspace.clone()
            .unwrap_or_else(|| state.workspace.clone())
    };
    let tasks = state
        .task_manager
        .list_tasks_scoped(Some(1), Some(workspace.as_path()))
        .await;
    let (task, status) = tasks
        .first()
        .map(|task| {
            (
                if task.prompt_summary.trim().is_empty() {
                    "草稿".to_string()
                } else {
                    task.prompt_summary.clone()
                },
                wechat_task_status(task.status).to_string(),
            )
        })
        .unwrap_or_else(|| ("草稿".to_string(), "草稿".to_string()));

    format!(
        "工作区: {}\n模型: {}\n思考: {}\n\n任务: {}\n状态: {}",
        wechat_workspace_name(&workspace),
        model,
        reasoning,
        task,
        status,
    )
}

async fn wechat_thread_for_user(state: &RuntimeApiState, user_id: &str) -> Option<String> {
    state
        .wechat
        .lock()
        .await
        .threads
        .get(user_id)
        .cloned()
}

async fn ensure_wechat_thread(state: &RuntimeApiState, user_id: &str) -> Result<String> {
    if let Some(thread_id) = wechat_thread_for_user(state, user_id).await {
        if state.runtime_threads.get_thread(&thread_id).await.is_ok() {
            return Ok(thread_id);
        }
    }

    let preferences = state
        .wechat
        .lock()
        .await
        .users
        .get(user_id)
        .cloned()
        .unwrap_or_default();
    let thread = state
        .runtime_threads
        .create_thread(CreateThreadRequest {
            model: preferences.model,
            workspace: Some(
                preferences
                    .workspace
                    .unwrap_or_else(|| state.workspace.clone()),
            ),
            mode: Some(preferences.mode.unwrap_or_else(|| "act".to_string())),
            permission_posture: Some("auto-review".to_string()),
            allow_shell: Some(false),
            trust_mode: Some(false),
            auto_approve: None,
            ..Default::default()
        })
        .await?;
    let _ = state
        .runtime_threads
        .update_thread(
            &thread.id,
            UpdateThreadRequest {
                title: Some(format!("微信 {}", user_id)),
                ..Default::default()
            },
        )
        .await;
    state
        .wechat
        .lock()
        .await
        .threads
        .insert(user_id.to_string(), thread.id.clone());
    Ok(thread.id)
}

async fn reset_wechat_thread(state: &RuntimeApiState, user_id: &str) -> Result<()> {
    let old_thread = state.wechat.lock().await.threads.remove(user_id);
    if let Some(thread_id) = old_thread {
        let _ = state
            .runtime_threads
            .update_thread(
                &thread_id,
                UpdateThreadRequest {
                    archived: Some(true),
                    ..Default::default()
                },
            )
            .await;
    }
    Ok(())
}

async fn switch_wechat_project(
    state: &RuntimeApiState,
    user_id: &str,
    name: &str,
) -> Result<Option<String>> {
    let projects = crate::runtime_api::projects::project_records(state)
        .map_err(|error| anyhow!(error.message))?;
    let Some(project) = projects.iter().find(|project| {
        project.name.eq_ignore_ascii_case(name.trim())
            || project.path.eq_ignore_ascii_case(name.trim())
    }) else {
        return Ok(None);
    };
    let workspace = PathBuf::from(&project.path);
    if let Some(thread_id) = wechat_thread_for_user(state, user_id).await {
        state
            .runtime_threads
            .update_thread(
                &thread_id,
                UpdateThreadRequest {
                    workspace: Some(workspace.clone()),
                    title: Some(format!("微信 {} · {}", user_id, project.name)),
                    ..Default::default()
                },
            )
            .await?;
    }
    update_wechat_user_settings(state, user_id, |settings| {
        settings.workspace = Some(workspace.clone());
    })
    .await?;
    Ok(Some(project.name.clone()))
}

async fn update_wechat_user_settings(
    state: &RuntimeApiState,
    user_id: &str,
    update: impl FnOnce(&mut hakus_wechat::WechatUserSettings),
) -> Result<hakus_wechat::WechatUserSettings> {
    let mut guard = state.wechat.lock().await;
    let mut users = guard.users.clone();
    let mut settings = users.get(user_id).cloned().unwrap_or_default();
    update(&mut settings);
    users.insert(user_id.to_string(), settings.clone());
    guard
        .client
        .state()
        .save_settings(&hakus_wechat::WechatSettings {
            auto_reply: guard.auto_reply,
            users: users.clone(),
        })?;
    guard.users = users;
    Ok(settings)
}

async fn wait_for_wechat_turn(
    state: &RuntimeApiState,
    thread_id: &str,
    turn_id: &str,
) -> Result<String> {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let detail = state.runtime_threads.get_thread_detail(thread_id).await?;
        if let Some(turn) = detail.turns.iter().find(|turn| turn.id == turn_id) {
            if matches!(
                turn.status,
                RuntimeTurnStatus::Completed
                    | RuntimeTurnStatus::Failed
                    | RuntimeTurnStatus::Interrupted
                    | RuntimeTurnStatus::Canceled
            ) {
                if turn.status != RuntimeTurnStatus::Completed {
                    return Err(anyhow!(
                        turn.error
                            .clone()
                            .unwrap_or_else(|| "Runtime turn did not complete".to_string())
                    ));
                }
                let response = detail
                    .items
                    .iter()
                    .filter(|item| {
                        item.turn_id == turn_id
                            && item.kind == TurnItemKind::AgentMessage
                            && item.status == crate::runtime_threads::TurnItemLifecycleStatus::Completed
                    })
                    .filter_map(|item| item.detail.as_deref())
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                if !response.is_empty() {
                    return Ok(response);
                }
                return Err(anyhow!("Runtime returned an empty response"));
            }
        }
        if Instant::now() >= deadline {
            return Err(anyhow!("Runtime response timed out"));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn wechat_command_reply(
    state: &RuntimeApiState,
    user_id: &str,
    command: WechatCommand,
) -> Result<String> {
    match command {
        WechatCommand::Help => Ok(wechat_help_text()),
        WechatCommand::Status => Ok(wechat_status_text(state, user_id).await),
        WechatCommand::New => {
            reset_wechat_thread(state, user_id).await?;
            Ok("已开始新的对话。发送 /帮助 查看可用命令。".to_string())
        }
        WechatCommand::Project(project) => {
            match project {
                Some(name) => match switch_wechat_project(state, user_id, &name).await? {
                    Some(name) => Ok(format!(
                        "已切换工作区: {name}\n\n{}",
                        wechat_status_text(state, user_id).await
                    )),
                    None => Ok(format!(
                        "没有找到项目: {name}\n发送 /项目 查看可用项目。"
                    )),
                },
                None => {
                    let projects = crate::runtime_api::projects::project_records(state)
                        .map_err(|error| anyhow!(error.message))?;
                    let workspace = wechat_status_text(state, user_id)
                        .await
                        .lines()
                        .next()
                        .and_then(|line| line.strip_prefix("工作区: "))
                        .unwrap_or("当前工作区")
                        .to_string();
                    let mut lines = vec![format!("当前工作区: {workspace}")];
                    if projects.is_empty() {
                        lines.push("尚无已登记项目。".to_string());
                    } else {
                        lines.push("可用项目:".to_string());
                        lines.extend(projects.into_iter().map(|project| {
                            format!("/项目 {}", project.name)
                        }));
                    }
                    Ok(lines.join("\n"))
                }
            }
        }
        WechatCommand::Model(model) => {
            if let Some(model) = model {
                if model.trim().is_empty() {
                    return Ok("用法: /模型 <名称>".to_string());
                }
                let model = model.trim().to_string();
                if let Some(thread_id) = wechat_thread_for_user(state, user_id).await {
                    state
                        .runtime_threads
                        .update_thread(
                            &thread_id,
                            UpdateThreadRequest {
                                model: Some(model.clone()),
                                ..Default::default()
                            },
                        )
                        .await?;
                }
                update_wechat_user_settings(state, user_id, |settings| {
                    settings.model = Some(model.clone());
                })
                .await?;
                Ok(format!("已切换模型: {model}"))
            } else {
                let model = wechat_status_text(state, user_id)
                    .await
                    .lines()
                    .find_map(|line| line.strip_prefix("模型: "))
                    .unwrap_or("未设置")
                    .to_string();
                Ok(format!("当前模型: {model}"))
            }
        }
        WechatCommand::Mode(mode) => {
            let changed = mode.is_some();
            let selected = if let Some(mode) = mode {
                let mode = match mode.trim().to_ascii_lowercase().as_str() {
                    "work" | "工作" | "act" => "act",
                    "code" | "编码" | "operate" => "operate",
                    "plan" | "计划" => "plan",
                    _ => return Ok("用法: /模式 工作|编码|计划".to_string()),
                }
                .to_string();
                if let Some(thread_id) = wechat_thread_for_user(state, user_id).await {
                    state
                        .runtime_threads
                        .update_thread(
                            &thread_id,
                            UpdateThreadRequest {
                                mode: Some(mode.clone()),
                                ..Default::default()
                            },
                        )
                        .await?;
                }
                update_wechat_user_settings(state, user_id, |settings| {
                    settings.mode = Some(mode.clone());
                })
                .await?;
                mode
            } else {
                let preferences = state
                    .wechat
                    .lock()
                    .await
                    .users
                    .get(user_id)
                    .cloned()
                    .unwrap_or_default();
                let thread_id = wechat_thread_for_user(state, user_id).await;
                match thread_id {
                Some(thread_id) => state
                    .runtime_threads
                    .get_thread(&thread_id)
                    .await
                    .map(|thread| thread.mode)
                    .unwrap_or_else(|_| preferences.mode.unwrap_or_else(|| "act".to_string())),
                None => preferences.mode.unwrap_or_else(|| "act".to_string()),
                }
            };
            let label = match selected.as_str() {
                "act" => "工作",
                "operate" => "编码",
                "plan" => "计划",
                other => other,
            };
            if changed {
                Ok(format!("已切换模式: {label}"))
            } else {
                Ok(format!("当前模式: {label}"))
            }
        }
        WechatCommand::Thinking(effort) => {
            if let Some(effort) = effort {
                let effort = effort.trim().to_ascii_lowercase();
                if !matches!(effort.as_str(), "auto" | "low" | "medium" | "high" | "max") {
                    return Ok("用法: /思考 auto|low|medium|high|max".to_string());
                }
                update_wechat_user_settings(state, user_id, |settings| {
                    settings.reasoning_effort = Some(effort.clone());
                })
                .await?;
                Ok(format!("已切换思考级别: {effort}"))
            } else {
                let effort = state
                    .wechat
                    .lock()
                    .await
                    .users
                    .get(user_id)
                    .and_then(|settings| settings.reasoning_effort.clone())
                    .unwrap_or_else(|| {
                        state
                            .config
                            .read()
                            .reasoning_effort()
                            .unwrap_or("auto")
                            .to_string()
                    });
                Ok(format!("当前思考级别: {effort}"))
            }
        }
        WechatCommand::Reply(verbosity) => {
            if let Some(verbosity) = verbosity {
                let verbosity = match verbosity.trim().to_ascii_lowercase().as_str() {
                    "normal" | "标准" => "normal",
                    "concise" | "简洁" => "concise",
                    _ => return Ok("用法: /回复 normal|concise".to_string()),
                }
                .to_string();
                update_wechat_user_settings(state, user_id, |settings| {
                    settings.verbosity = Some(verbosity.clone());
                })
                .await?;
                Ok(format!("已切换回复详细程度: {verbosity}"))
            } else {
                let verbosity = state
                    .wechat
                    .lock()
                    .await
                    .users
                    .get(user_id)
                    .and_then(|settings| settings.verbosity.clone())
                    .unwrap_or_else(|| "normal".to_string());
                Ok(format!("当前回复详细程度: {verbosity}"))
            }
        }
        WechatCommand::Bind(_code) => Ok(
            "当前微信聊天已自动关联本地会话，无需绑定码。".to_string(),
        ),
        WechatCommand::Unknown(name) => Ok(format!(
            "未识别命令: /{name}\n\n{}",
            wechat_help_text()
        )),
    }
}

async fn handle_wechat_message(
    state: &RuntimeApiState,
    user_id: &str,
    text: &str,
) -> Result<Option<String>> {
    if let Some(command) = parse_wechat_command(text) {
        return Ok(Some(wechat_command_reply(state, user_id, command).await?));
    }

    let enabled = state.wechat.lock().await.auto_reply;
    if !enabled {
        return Ok(None);
    }

    let preferences = state
        .wechat
        .lock()
        .await
        .users
        .get(user_id)
        .cloned()
        .unwrap_or_default();
    let prompt = if preferences.verbosity.as_deref() == Some("concise") {
        format!("请用简洁的方式回复，不省略完成任务所需的关键信息。\n\n{}", text.trim())
    } else {
        text.trim().to_string()
    };
    let thread_id = ensure_wechat_thread(state, user_id).await?;
    let turn = state
        .runtime_threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                prompt,
                mode: preferences.mode,
                permission_posture: Some("auto-review".to_string()),
                allow_shell: Some(false),
                trust_mode: Some(false),
                auto_approve: None,
                reasoning_effort: preferences.reasoning_effort,
                ..Default::default()
            },
        )
        .await?;
    Ok(Some(
        wait_for_wechat_turn(state, &thread_id, &turn.id)
            .await
            .unwrap_or_else(|error| format!("暂时无法完成回复: {error}")),
    ))
}

async fn run_wechat_bot(state: RuntimeApiState) {
    loop {
        let (client, poll_lock) = {
            let guard = state.wechat.lock().await;
            (guard.client.clone(), guard.poll_lock.clone())
        };
        if !client.is_logged_in().await {
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        }

        let messages = {
            let _poll = poll_lock.lock().await;
            client.poll_text_messages().await
        };
        let messages = match messages {
            Ok(messages) => messages,
            Err(error) => {
                tracing::warn!("WeChat background poll failed: {error}");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };

        for (user_id, text, _message_id) in messages {
            if user_id.trim().is_empty() || text.trim().is_empty() {
                continue;
            }
            match handle_wechat_message(&state, &user_id, &text).await {
                Ok(Some(reply)) => {
                    if let Err(error) = client.send_text(&user_id, &reply).await {
                        tracing::warn!(user_id = %user_id, "WeChat reply failed: {error}");
                    }
                }
                Ok(None) => {}
                Err(error) => tracing::warn!(user_id = %user_id, "WeChat message handling failed: {error}"),
            }
        }
    }
}

async fn get_metrics(
    State(state): State<RuntimeApiState>,
) -> Json<RuntimeMetricsResponse> {
    let counters = hakus_telemetry::session_counters().counters();
    let errors = hakus_telemetry::session_counters().errors();
    let total_errors = errors
        .auth_preflight_failed
        .saturating_add(errors.provider_http_4xx)
        .saturating_add(errors.provider_http_5xx)
        .saturating_add(errors.tool_denied_by_policy)
        .saturating_add(errors.tool_timeout)
        .saturating_add(errors.network_error);
    let ledger_stats = state
        .runtime_threads
        .canonical_ledger_stats()
        .await
        .unwrap_or(hakus_state::LedgerStats {
            event_count: 0,
            session_count: 0,
        });
    let compat_imported_event_count = state
        .runtime_threads
        .compat_imported_event_count()
        .await
        .unwrap_or_default();
    Json(RuntimeMetricsResponse {
        uptime_seconds: state.started_at.elapsed().as_secs(),
        process_started_at_unix_ms: state.started_at_unix_ms,
        event_count: state
            .runtime_threads
            .current_event_seq()
            .await
            .unwrap_or_default(),
        canonical_ledger_event_count: ledger_stats.event_count,
        canonical_ledger_session_count: ledger_stats.session_count,
        compat_imported_event_count,
        execution_plane: state.execution_plane,
        feature_gates: state.feature_gates.clone(),
        total_turns: counters.turns,
        total_errors,
        active_websockets: 0,
        // These metrics are not emitted by the Rust Runtime. They remain
        // explicit zeroes so the shared UI does not mistake missing data for
        // a failed request or silently call the retired Python API.
        checkpoints_saved: 0,
        llm_calls: 0,
        llm_retries: 0,
        by_provider: BTreeMap::new(),
        providers: hakus_telemetry::session_counters().providers(),
        counters,
        errors,
        turn_wall: hakus_telemetry::session_counters().turn_wall(),
    })
}

async fn get_diagnostics(
    State(state): State<RuntimeApiState>,
) -> Json<RuntimeDiagnosticsResponse> {
    let event_count = state
        .runtime_threads
        .current_event_seq()
        .await
        .unwrap_or_default();
    let ledger_stats = state
        .runtime_threads
        .canonical_ledger_stats()
        .await
        .unwrap_or(hakus_state::LedgerStats {
            event_count: 0,
            session_count: 0,
        });
    // Integrity is reported, not assumed: a store with a broken sequence is
    // exactly what diagnostics exists to surface, and a verification failure
    // must not turn the whole endpoint into an error.
    let canonical_ledger_integrity = state
        .runtime_threads
        .verify_all_ledgers()
        .await
        .unwrap_or_default();
    Json(RuntimeDiagnosticsResponse {
        service: "hakus-runtime-api",
        runtime_api_version: RUNTIME_API_VERSION,
        execution_plane: state.execution_plane,
        feature_gates: state.feature_gates.clone(),
        process_started_at_unix_ms: state.started_at_unix_ms,
        uptime_seconds: state.started_at.elapsed().as_secs(),
        event_count,
        canonical_ledger_event_count: ledger_stats.event_count,
        canonical_ledger_session_count: ledger_stats.session_count,
        canonical_ledger_integrity,
        provider_activity: hakus_telemetry::session_counters().providers(),
    })
}

/// One-shot redacted bundle for migration and support reports: diagnostics
/// plus metrics counters, a process memory sample, and the JSONL→ledger
/// projection lag. Field-level redaction is by construction — see
/// `RuntimeDiagnosticsBundleResponse`.
async fn get_diagnostics_bundle(
    State(state): State<RuntimeApiState>,
) -> Json<RuntimeDiagnosticsBundleResponse> {
    let event_count = state
        .runtime_threads
        .current_event_seq()
        .await
        .unwrap_or_default();
    let ledger_stats = state
        .runtime_threads
        .canonical_ledger_stats()
        .await
        .unwrap_or(hakus_state::LedgerStats {
            event_count: 0,
            session_count: 0,
        });
    let canonical_ledger_integrity = state
        .runtime_threads
        .verify_all_ledgers()
        .await
        .unwrap_or_default();
    let compat_imported_event_count = state
        .runtime_threads
        .compat_imported_event_count()
        .await
        .unwrap_or_default();
    let projection = ProjectionLag {
        jsonl_event_seq: event_count,
        canonical_event_count: ledger_stats.event_count,
        shadow_write_lag: event_count.saturating_sub(ledger_stats.event_count),
    };
    let shadow_write_lag = event_count.saturating_sub(ledger_stats.event_count);
    let canonical_ledger_healthy = canonical_ledger_integrity.is_healthy();
    let canonical_ledger_sessions_verified = canonical_ledger_integrity.sessions_verified;
    let canonical_ledger_events_verified = canonical_ledger_integrity.events_verified;
    Json(RuntimeDiagnosticsBundleResponse {
        generated_at_unix_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or_default(),
        service: "hakus-runtime-api",
        runtime_api_version: RUNTIME_API_VERSION,
        execution_plane: state.execution_plane,
        feature_gates: state.feature_gates.clone(),
        process_started_at_unix_ms: state.started_at_unix_ms,
        uptime_seconds: state.started_at.elapsed().as_secs(),
        event_count,
        canonical_ledger_event_count: ledger_stats.event_count,
        canonical_ledger_session_count: ledger_stats.session_count,
        canonical_ledger_integrity,
        provider_activity: hakus_telemetry::session_counters().providers(),
        compat_imported_event_count,
        memory: process_memory_sample(),
        projection,
        migration: MigrationDiagnostics {
            python_compat_flag: state.feature_gates.python_compat_path,
            compat_imported_event_count,
            shadow_write_lag,
            canonical_ledger_healthy,
            canonical_ledger_sessions_verified,
            canonical_ledger_events_verified,
        },
    })
}

// ── Runtime log and provider key compatibility endpoints ───────────────────

#[derive(Debug, Deserialize, Default)]
struct RuntimeLogsQuery {
    name: Option<String>,
    lines: Option<usize>,
    level: Option<String>,
    after_ts: Option<f64>,
    download: Option<String>,
}

#[derive(Debug, Serialize)]
struct RuntimeLogFileInfo {
    name: String,
    size: u64,
    mtime: f64,
}

#[derive(Debug, Serialize)]
struct RuntimeLogEntry {
    ts: Option<String>,
    level: String,
    logger: String,
    msg: String,
    raw: String,
}

#[derive(Debug, Serialize)]
struct RuntimeLogsResponse {
    files: Vec<RuntimeLogFileInfo>,
    logs: Vec<RuntimeLogEntry>,
}

fn runtime_log_files() -> Result<Vec<(PathBuf, RuntimeLogFileInfo)>, ApiError> {
    let Some(dir) = crate::runtime_log::log_directory() else {
        return Ok(Vec::new());
    };
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(&dir)
        .map_err(|error| ApiError::internal(format!("Failed to read runtime log directory: {error}")))?;
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()).map(str::to_string) else {
            continue;
        };
        if !name.starts_with("tui-") || !name.ends_with(".log") {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => continue,
        };
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_secs_f64())
            .unwrap_or_default();
        files.push((
            path,
            RuntimeLogFileInfo {
                name,
                size: metadata.len(),
                mtime,
            },
        ));
    }
    files.sort_by(|left, right| {
        right
            .1
            .mtime
            .partial_cmp(&left.1.mtime)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.1.name.cmp(&right.1.name))
    });
    Ok(files)
}

fn parse_runtime_log_line(raw: &str) -> RuntimeLogEntry {
    // The file subscriber uses tracing's stable text formatter:
    // `timestamp LEVEL target: message`. Keep the complete raw line so newer
    // formatter fields remain inspectable even when they are not recognized.
    let trimmed = raw.trim_end_matches(['\r', '\n']);
    let mut parts = trimmed.splitn(3, ' ');
    let timestamp = parts.next().unwrap_or_default();
    let level = parts.next().unwrap_or("INFO").to_ascii_uppercase();
    let remainder = parts.next().unwrap_or_default();
    let (logger, msg) = remainder
        .split_once(": ")
        .map(|(logger, msg)| (logger.trim(), msg.trim()))
        .unwrap_or(("runtime", remainder.trim()));
    RuntimeLogEntry {
        ts: (!timestamp.is_empty()).then(|| timestamp.to_string()),
        level,
        logger: if logger.is_empty() { "runtime" } else { logger }.to_string(),
        msg: msg.to_string(),
        raw: trimmed.to_string(),
    }
}

fn log_entry_timestamp(entry: &RuntimeLogEntry) -> Option<f64> {
    entry
        .ts
        .as_deref()
        .and_then(|timestamp| chrono::DateTime::parse_from_rfc3339(timestamp).ok())
        .map(|timestamp| timestamp.timestamp_millis() as f64 / 1000.0)
}

async fn list_runtime_log_files() -> Result<Json<RuntimeLogsResponse>, ApiError> {
    let files = runtime_log_files()?;
    Ok(Json(RuntimeLogsResponse {
        files: files.into_iter().map(|(_, info)| info).collect(),
        logs: Vec::new(),
    }))
}

async fn get_runtime_logs(
    Query(query): Query<RuntimeLogsQuery>,
) -> Result<Response, ApiError> {
    let files = runtime_log_files()?;
    if files.is_empty() {
        return Ok(Json(RuntimeLogsResponse { files: Vec::new(), logs: Vec::new() }).into_response());
    }
    let selected = match query.name.as_deref().map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => files
            .iter()
            .find(|(_, info)| info.name == name)
            .ok_or_else(|| ApiError::bad_request("Unknown runtime log file"))?,
        None => files
            .first()
            .ok_or_else(|| ApiError::bad_request("No runtime log files are available"))?,
    };
    let limit = query.lines.unwrap_or(200).clamp(1, 5000);
    let level = query.level.as_deref().map(str::to_ascii_uppercase);
    let content = fs::read_to_string(&selected.0)
        .map_err(|error| ApiError::internal(format!("Failed to read runtime log: {error}")))?;
    let mut logs: Vec<RuntimeLogEntry> = content
        .lines()
        .map(parse_runtime_log_line)
        .filter(|entry| level.as_deref().is_none_or(|wanted| entry.level == wanted))
        .filter(|entry| query.after_ts.is_none_or(|after| log_entry_timestamp(entry).is_some_and(|ts| ts > after)))
        .collect();
    if logs.len() > limit {
        logs.drain(..logs.len() - limit);
    }
    let response = RuntimeLogsResponse {
        files: files.iter().map(|(_, info)| RuntimeLogFileInfo {
            name: info.name.clone(),
            size: info.size,
            mtime: info.mtime,
        }).collect(),
        logs,
    };
    if query.download.as_deref().is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true")) {
        let body = fs::read(&selected.0)
            .map_err(|error| ApiError::internal(format!("Failed to read runtime log: {error}")))?;
        let content_disposition = format!("attachment; filename=\"{}\"", selected.1.name);
        return Ok((
            [
                (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
                (header::CONTENT_DISPOSITION, content_disposition.as_str()),
            ],
            body,
        )
            .into_response());
    }
    Ok(Json(response).into_response())
}

async fn clear_runtime_logs(
    Query(query): Query<RuntimeLogsQuery>,
) -> Result<Json<Value>, ApiError> {
    let files = runtime_log_files()?;
    let targets: Vec<PathBuf> = match query.name.as_deref().map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => vec![files
            .iter()
            .find(|(_, info)| info.name == name)
            .map(|(path, _)| path.clone())
            .ok_or_else(|| ApiError::bad_request("Unknown runtime log file"))?],
        None => files.into_iter().map(|(path, _)| path).collect(),
    };
    let mut cleared = Vec::new();
    for path in targets {
        fs::write(&path, [])
            .map_err(|error| ApiError::internal(format!("Failed to clear runtime log: {error}")))?;
        if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
            cleared.push(name.to_string());
        }
    }
    Ok(Json(json!({ "cleared": cleared })))
}

#[derive(Debug, Deserialize, Default)]
struct ProviderKeyRequest {
    key: String,
    #[serde(default)]
    label: String,
}

#[derive(Debug, Serialize)]
struct RuntimeProviderKeyEntry {
    id: String,
    label: String,
    masked_key: String,
    enabled: bool,
    is_primary: bool,
}

fn provider_key_table_key(route: &RuntimeProviderRoute) -> Result<String, ApiError> {
    if route.provider == ApiProvider::Custom {
        return Ok(route.identity.clone());
    }
    if let Some(metadata) = route.provider.metadata() {
        return Ok(metadata.provider_config_key().to_string());
    }
    Ok("deepseek_cn".to_string())
}

fn provider_keys_path(state: &RuntimeApiState) -> Result<PathBuf, ApiError> {
    config_persistence::config_toml_path(state.config_path.as_deref())
        .map_err(|error| ApiError::internal(format!("Failed to resolve config path: {error}")))
}

fn read_provider_multi_keys(
    state: &RuntimeApiState,
    table_key: &str,
) -> Result<Vec<(String, String, String, bool)>, ApiError> {
    let path = provider_keys_path(state)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| ApiError::internal(format!("Failed to read provider config: {error}")))?;
    // Parse the complete TOML document through serde. `toml::Value`'s
    // `FromStr` implementation is value-oriented in the version used by the
    // runtime and rejects a document as soon as it contains a root key.
    // `toml::from_str` is the document parser used by the rest of the config
    // stack and preserves support for ordinary root/provider tables.
    let value: toml::Value = toml::from_str(&raw)
        .map_err(|error| ApiError::internal(format!("Failed to parse provider config: {error}")))?;
    let Some(entries) = value
        .get("providers")
        .and_then(|value| value.get(table_key))
        .and_then(|value| value.get("api_keys"))
        .and_then(toml::Value::as_array)
    else {
        return Ok(Vec::new());
    };
    Ok(entries
        .iter()
        .filter_map(|entry| {
            let table = entry.as_table()?;
            let id = table.get("id")?.as_str()?.trim().to_string();
            let key = table.get("key")?.as_str()?.to_string();
            if id.is_empty() || key.trim().is_empty() {
                return None;
            }
            let label = table
                .get("label")
                .and_then(toml::Value::as_str)
                .unwrap_or_default()
                .to_string();
            let enabled = table
                .get("enabled")
                .and_then(toml::Value::as_bool)
                .unwrap_or(true);
            Some((id, key, label, enabled))
        })
        .collect())
}

async fn list_provider_keys(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let config = state.config.read().clone();
    let route = resolve_runtime_provider(&config, &id)?;
    let primary = provider_route_config_for_identity(&config, &route.identity)
        .deepseek_api_key_read_only()
        .ok()
        .unwrap_or_default();
    let mut keys = Vec::new();
    if !primary.trim().is_empty() {
        keys.push(RuntimeProviderKeyEntry {
            id: "__primary__".to_string(),
            label: "主 Key".to_string(),
            masked_key: mask_provider_key(&primary),
            enabled: true,
            is_primary: true,
        });
    }
    let table_key = provider_key_table_key(&route)?;
    for (key_id, key, label, enabled) in read_provider_multi_keys(&state, &table_key)? {
        keys.push(RuntimeProviderKeyEntry {
            id: key_id,
            label,
            masked_key: mask_provider_key(&key),
            enabled,
            is_primary: false,
        });
    }
    Ok(Json(json!({ "keys": keys })))
}

async fn add_provider_key(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(req): Json<ProviderKeyRequest>,
) -> Result<Json<RuntimeProviderKeyEntry>, ApiError> {
    let key = req.key.trim();
    if key.is_empty() {
        return Err(ApiError::bad_request("key cannot be empty"));
    }
    let config = state.config.read().clone();
    let route = resolve_runtime_provider(&config, &id)?;
    let table_key = provider_key_table_key(&route)?;
    let mut entries = read_provider_multi_keys(&state, &table_key)?;
    let key_id = format!("{}-{}", route.identity, uuid::Uuid::new_v4().simple());
    entries.push((key_id.clone(), key.to_string(), req.label.trim().to_string(), true));
    let path = provider_keys_path(&state)?;
    config_persistence::mutate_config_document(&path, |doc| {
        let mut array = toml_edit::Array::new();
        for (id, key, label, enabled) in &entries {
            let mut table = toml_edit::InlineTable::new();
            table.insert("id", toml_edit::Value::from(id.as_str()));
            table.insert("key", toml_edit::Value::from(key.as_str()));
            if !label.is_empty() {
                table.insert("label", toml_edit::Value::from(label.as_str()));
            }
            table.insert("enabled", toml_edit::Value::from(*enabled));
            array.push(toml_edit::Value::InlineTable(table));
        }
        config_persistence::set_document_value(
            doc,
            &["providers", table_key.as_str(), "api_keys"],
            toml_edit::Value::Array(array),
        )
    })
    .map_err(|error| ApiError::internal(format!("Failed to save provider key: {error}")))?;
    Ok(Json(RuntimeProviderKeyEntry {
        id: key_id,
        label: req.label.trim().to_string(),
        masked_key: mask_provider_key(key),
        enabled: true,
        is_primary: false,
    }))
}

async fn delete_provider_key(
    State(state): State<RuntimeApiState>,
    Path((id, key_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    if key_id == "__primary__" {
        return Err(ApiError::bad_request("Cannot delete the primary API key"));
    }
    let config = state.config.read().clone();
    let route = resolve_runtime_provider(&config, &id)?;
    let table_key = provider_key_table_key(&route)?;
    let mut entries = read_provider_multi_keys(&state, &table_key)?;
    let before = entries.len();
    entries.retain(|(entry_id, _, _, _)| entry_id != &key_id);
    if entries.len() == before {
        return Err(ApiError { status: StatusCode::NOT_FOUND, message: "Key not found".to_string() });
    }
    let path = provider_keys_path(&state)?;
    config_persistence::mutate_config_document(&path, |doc| {
        if entries.is_empty() {
            config_persistence::unset_document_value(
                doc,
                &["providers", table_key.as_str(), "api_keys"],
            )
            .map(|_| ())
        } else {
            let mut array = toml_edit::Array::new();
            for (entry_id, key, label, enabled) in &entries {
                let mut table = toml_edit::InlineTable::new();
                table.insert("id", toml_edit::Value::from(entry_id.as_str()));
                table.insert("key", toml_edit::Value::from(key.as_str()));
                if !label.is_empty() {
                    table.insert("label", toml_edit::Value::from(label.as_str()));
                }
                table.insert("enabled", toml_edit::Value::from(*enabled));
                array.push(toml_edit::Value::InlineTable(table));
            }
            config_persistence::set_document_value(
                doc,
                &["providers", table_key.as_str(), "api_keys"],
                toml_edit::Value::Array(array),
            )
        }
    })
    .map_err(|error| ApiError::internal(format!("Failed to delete provider key: {error}")))?;
    Ok(Json(json!({ "message": "Key deleted", "key_id": key_id })))
}

/// Remove the primary credential for one provider. This is intentionally a
/// separate endpoint from multi-key deletion so first-run re-authentication
/// can clear restored secrets without exposing key material to the client.
async fn clear_provider_api_key(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let route = {
        let config = state.config.read().clone();
        resolve_runtime_provider(&config, &id)?
    };
    crate::config::clear_active_provider_api_key(route.id())
        .map_err(|error| ApiError::internal(format!("Failed to clear provider API key: {error}")))?;
    let reloaded = Config::load(state.config_path.clone(), state.config_profile.as_deref())
        .map_err(|error| ApiError::internal(format!("Failed to reload provider config: {error}")))?;
    state
        .runtime_threads
        .reload_config(reloaded.clone())
        .await
        .map_err(|error| ApiError::bad_request(format!("Config reload rejected: {error}")))?;
    *state.config.write() = reloaded;
    Ok(Json(json!({ "provider": route.id(), "cleared": true })))
}

async fn create_task(
    State(state): State<RuntimeApiState>,
    Json(mut req): Json<NewTaskRequest>,
) -> Result<(StatusCode, Json<TaskRecord>), ApiError> {
    if req.prompt.trim().is_empty() {
        return Err(ApiError::bad_request("prompt is required"));
    }
    if req.workspace.is_none() {
        req.workspace = Some(state.workspace.clone());
    }
    if req.model.is_none() {
        req.model = Some(
            state
                .config
                .read()
                .default_text_model
                .clone()
                .unwrap_or_else(|| DEFAULT_TEXT_MODEL.to_string()),
        );
    }
    let task = state
        .task_manager
        .add_task(req)
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    Ok((StatusCode::CREATED, Json(task)))
}

async fn create_thread(
    State(state): State<RuntimeApiState>,
    Json(mut req): Json<CreateThreadRequest>,
) -> Result<(StatusCode, Json<ThreadRecord>), ApiError> {
    if req.workspace.is_none() {
        req.workspace = Some(state.workspace.clone());
    }
    if req.mode.as_ref().is_none_or(|m| m.trim().is_empty()) {
        req.mode = Some("agent".to_string());
    }
    if req.system_prompt.is_none() {
        let character = load_character(&state)?;
        req.system_prompt = character_system_prompt(&character);
    }

    let thread = state
        .runtime_threads
        .create_thread(req)
        .await
        .map_err(|e| {
            let message = e.to_string();
            if crate::runtime_threads::is_runtime_store_failure(&message) {
                // Store/filesystem faults are backend failures, not request
                // errors — reporting them as 400 made the GUI label them
                // "请求参数错误".
                ApiError::internal(message)
            } else {
                ApiError::bad_request(message)
            }
        })?;
    Ok((StatusCode::CREATED, Json(thread)))
}

fn character_system_prompt(character: &RuntimeCharacter) -> Option<String> {
    let mut sections = Vec::new();
    if !character.system_prompt.trim().is_empty() {
        sections.push(character.system_prompt.trim().to_string());
    }
    if !character.personality.trim().is_empty() {
        sections.push(format!("Personality:\n{}", character.personality.trim()));
    }
    if !character.scenario.trim().is_empty() {
        sections.push(format!("Scenario:\n{}", character.scenario.trim()));
    }
    (!sections.is_empty()).then(|| sections.join("\n\n"))
}

async fn list_threads(
    State(state): State<RuntimeApiState>,
    Query(query): Query<ThreadsQuery>,
) -> Result<Json<Vec<ThreadRecord>>, ApiError> {
    let filter = resolve_thread_filter(query.include_archived, query.archived_only);
    let threads = state
        .runtime_threads
        .list_threads(filter, query.limit)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(Json(threads))
}

async fn list_threads_summary(
    State(state): State<RuntimeApiState>,
    Query(query): Query<ThreadSummaryQuery>,
) -> Result<Json<Vec<ThreadSummary>>, ApiError> {
    let limit = query.limit.unwrap_or(50).clamp(1, 500);
    let search = query.search.as_deref().map(str::to_ascii_lowercase);
    let filter = resolve_thread_filter(query.include_archived, query.archived_only);
    let threads = state
        .runtime_threads
        .list_threads(filter, Some(limit))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let mut summaries = Vec::new();
    for thread in threads {
        let detail = state
            .runtime_threads
            .get_thread_detail(&thread.id)
            .await
            .map_err(map_thread_err)?;
        let latest_turn = detail.turns.last();
        let latest_status =
            latest_turn.map(|turn| format!("{:?}", turn.status).to_ascii_lowercase());

        let title = thread
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| truncate_text(t, 72))
            .unwrap_or_else(|| {
                latest_turn
                    .map(|turn| {
                        if turn.input_summary.trim().is_empty() {
                            "New Thread".to_string()
                        } else {
                            truncate_text(&turn.input_summary, 72)
                        }
                    })
                    .unwrap_or_else(|| "New Thread".to_string())
            });

        let preview = detail
            .items
            .iter()
            .rev()
            .find_map(|item| match item.kind {
                TurnItemKind::AgentMessage | TurnItemKind::UserMessage => {
                    let text = item.detail.clone().unwrap_or_else(|| item.summary.clone());
                    if text.trim().is_empty() {
                        None
                    } else {
                        Some(truncate_text(&text, 140))
                    }
                }
                _ => None,
            })
            .unwrap_or_else(|| title.clone());

        if let Some(search) = &search {
            let haystack = format!(
                "{} {} {} {}",
                thread.id.to_ascii_lowercase(),
                title.to_ascii_lowercase(),
                preview.to_ascii_lowercase(),
                thread.model.to_ascii_lowercase()
            );
            if !haystack.contains(search) {
                continue;
            }
        }

        let workspace_git = collect_workspace_git_metadata(&thread.workspace);
        summaries.push(ThreadSummary {
            id: thread.id,
            title,
            preview,
            model: thread.model,
            mode: thread.mode,
            branch: workspace_git.branch,
            head: workspace_git.head,
            dirty: workspace_git.dirty,
            workspace: thread.workspace,
            archived: thread.archived,
            updated_at: thread.updated_at,
            latest_turn_id: thread.latest_turn_id,
            latest_turn_status: latest_status,
        });
    }

    if summaries.len() > limit {
        summaries.truncate(limit);
    }

    Ok(Json(summaries))
}

async fn list_agent_runs(
    State(state): State<RuntimeApiState>,
) -> Result<Json<AgentRunsResponse>, ApiError> {
    let runs = load_persisted_agent_worker_records(&state.workspace).map_err(|err| {
        ApiError::internal(format!("Failed to load persisted agent run records: {err}"))
    })?;
    Ok(Json(AgentRunsResponse { runs }))
}

async fn get_agent_run(
    State(state): State<RuntimeApiState>,
    Path(run_id): Path<String>,
) -> Result<Json<AgentWorkerRecord>, ApiError> {
    let runs = load_persisted_agent_worker_records(&state.workspace).map_err(|err| {
        ApiError::internal(format!("Failed to load persisted agent run records: {err}"))
    })?;
    let run = runs
        .into_iter()
        .find(|record| {
            let effective_run_id = if record.spec.run_id.is_empty() {
                record.spec.worker_id.as_str()
            } else {
                record.spec.run_id.as_str()
            };
            effective_run_id == run_id || record.spec.worker_id == run_id
        })
        .ok_or_else(|| ApiError::not_found(format!("agent run '{run_id}' not found")))?;
    Ok(Json(run))
}

async fn create_fleet_run(
    State(state): State<RuntimeApiState>,
    Json(request): Json<CreateFleetRunRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if request.target != FleetRuntimeTarget::ThisComputer {
        return Err(ApiError::not_implemented(format!(
            "Fleet target {:?} is not available in this local Runtime; choose this_computer",
            request.target
        )));
    }
    let (document, descriptor, max_workers) = prepare_managed_fleet_run(request)?;
    let manager = open_fleet_manager(&state)?;
    let report = manager
        .create_queued_run_with_descriptor(document, max_workers, descriptor)
        .map_err(|error| ApiError::bad_request(format!("Failed to create Fleet run: {error}")))?;
    let ledger_state = manager
        .rebuild_state()
        .map_err(|error| ApiError::internal(format!("Failed to rebuild Fleet state: {error}")))?;
    let run = ledger_state
        .runs
        .get(&report.run_id.0)
        .ok_or_else(|| ApiError::internal("Created Fleet run was missing from its ledger"))?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "execution": "awaiting_start",
            "run": fleet_run_detail_json(&manager, run, &ledger_state)?,
            "warnings": report.warnings,
        })),
    ))
}

fn prepare_managed_fleet_run(
    request: CreateFleetRunRequest,
) -> Result<(FleetTaskSpecDocument, ManagedFleetRunDescriptor, usize), ApiError> {
    if request.security_policy.is_some() {
        return Err(ApiError::not_implemented(
            "Managed Fleet security_policy overrides are not executable yet; use named roles and bounded task workspace/tool scopes",
        ));
    }
    if !request.worker_specs.is_empty() {
        return Err(ApiError::not_implemented(
            "Managed Fleet custom worker_specs are not available yet; local Runtime worker IDs are generated per run so worker controls cannot collide across Fleets",
        ));
    }
    if request.roles.is_empty() {
        return Err(ApiError::bad_request(
            "roles must declare at least one named Fleet role",
        ));
    }
    if request.roles.len() > 128 {
        return Err(ApiError::bad_request(
            "roles cannot contain more than 128 entries",
        ));
    }
    let workflow_id = managed_fleet_token("workflow.id", &request.workflow.id)?;
    let workflow_kind = request.workflow.kind;
    let name = request
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(workflow_id.as_str())
        .to_string();
    if name.len() > 256 || name.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "name must be one printable line no longer than 256 bytes",
        ));
    }

    let mut roles = BTreeMap::new();
    for role in request.roles {
        let normalized = canonical_public_role_name(&managed_fleet_token("role.name", &role.name)?);
        let agent_profile = role
            .agent_profile
            .as_deref()
            .map(|profile| managed_fleet_token("role.agent_profile", profile))
            .transpose()?;
        if roles.insert(normalized.clone(), agent_profile).is_some() {
            return Err(ApiError::bad_request(format!(
                "duplicate Fleet role '{normalized}'"
            )));
        }
    }

    let mut tasks = request.workflow.tasks;
    let mut used_roles = BTreeSet::new();
    for task in &mut tasks {
        let worker = task.worker.as_mut().ok_or_else(|| {
            ApiError::bad_request(format!(
                "Fleet task '{}' must select one named role through worker.role",
                task.id
            ))
        })?;
        let role = worker.role.as_deref().ok_or_else(|| {
            ApiError::bad_request(format!(
                "Fleet task '{}' must select one named role through worker.role",
                task.id
            ))
        })?;
        let role = canonical_public_role_name(&managed_fleet_token("task.worker.role", role)?);
        let declared_profile = roles.get(&role).ok_or_else(|| {
            ApiError::bad_request(format!(
                "Fleet task '{}' references undeclared role '{role}'",
                task.id
            ))
        })?;
        if let Some(profile) = declared_profile {
            match worker.agent_profile.as_deref() {
                Some(task_profile) if task_profile != profile => {
                    return Err(ApiError::bad_request(format!(
                        "Fleet task '{}' overrides role '{role}' agent_profile '{profile}' with '{task_profile}'",
                        task.id
                    )));
                }
                None => worker.agent_profile = Some(profile.clone()),
                Some(_) => {}
            }
        }
        worker.role = Some(role.clone());
        used_roles.insert(role);
    }
    let unused_roles = roles
        .keys()
        .filter(|role| !used_roles.contains(*role))
        .cloned()
        .collect::<Vec<_>>();
    if !unused_roles.is_empty() {
        return Err(ApiError::bad_request(format!(
            "Every declared Fleet role must own a Workflow task; unused roles: {}",
            unused_roles.join(", ")
        )));
    }
    reject_parallel_write_collisions(&tasks)?;

    let default_workers = roles.len().min(tasks.len()).max(1);
    let max_workers = request.max_workers.unwrap_or(default_workers);
    if !(1..=128).contains(&max_workers) {
        return Err(ApiError::bad_request(
            "max_workers must be between 1 and 128",
        ));
    }
    let role_names = roles.into_keys().collect::<Vec<_>>();
    Ok((
        FleetTaskSpecDocument {
            name: Some(name),
            labels: request.labels,
            security_policy: None,
            workers: Vec::new(),
            tasks,
        },
        ManagedFleetRunDescriptor {
            target: Some(request.target),
            workflow: Some(FleetWorkflowDescriptor {
                id: workflow_id,
                kind: workflow_kind,
            }),
            roles: role_names,
        },
        max_workers,
    ))
}

fn managed_fleet_token(field: &str, value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err(ApiError::bad_request(format!(
            "{field} must be a simple ASCII token no longer than 128 bytes"
        )));
    }
    Ok(value.to_string())
}

fn reject_parallel_write_collisions(tasks: &[FleetTaskSpec]) -> Result<(), ApiError> {
    let mut claims: Vec<(String, String)> = Vec::new();
    for task in tasks {
        let write_roots = fleet_write_roots(task).map_err(|error| {
            ApiError::bad_request(format!(
                "Fleet task '{}' has an invalid write scope: {error}",
                task.id
            ))
        })?;
        for normalized in write_roots {
            for (owner, existing) in &claims {
                if owner != &task.id && managed_paths_overlap(existing.as_str(), &normalized) {
                    return Err(ApiError::bad_request(format!(
                        "Parallel Workflow write scope collision: tasks '{owner}' and '{}' both claim overlapping paths",
                        task.id
                    )));
                }
            }
            claims.push((task.id.clone(), normalized));
        }
    }
    Ok(())
}

fn managed_paths_overlap(left: &str, right: &str) -> bool {
    left == right
        || left
            .strip_prefix(right)
            .is_some_and(|suffix| suffix.starts_with('/'))
        || right
            .strip_prefix(left)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

async fn start_fleet_run(
    State(state): State<RuntimeApiState>,
    Path(run_id): Path<String>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let manager = open_fleet_manager(&state)?;
    let durable = manager
        .rebuild_state()
        .map_err(|error| ApiError::internal(format!("Failed to rebuild Fleet state: {error}")))?;
    let run = durable
        .runs
        .get(&run_id)
        .ok_or_else(|| ApiError::not_found(format!("fleet run '{run_id}' not found")))?;
    match run.target {
        Some(FleetRuntimeTarget::ThisComputer) => {}
        Some(target) => {
            return Err(ApiError::not_implemented(format!(
                "Fleet target {target:?} is not available in this local Runtime"
            )));
        }
        None => {
            return Err(ApiError::bad_request(
                "Fleet run has no explicit Runtime target and cannot be started through the managed API",
            ));
        }
    }
    if run.workflow.is_none() || run.roles.is_empty() {
        return Err(ApiError::bad_request(
            "Fleet run has no managed Workflow/role descriptor and cannot be started through the managed API",
        ));
    }
    let run_id = FleetRunId::from(run_id);
    let report = manager.activate_run(&run_id).map_err(|error| {
        let message = format!("Failed to start Fleet run '{}': {error}", run_id.0);
        if message.contains("already terminal") {
            ApiError::conflict(message)
        } else {
            ApiError::bad_request(message)
        }
    })?;
    let max_workers = durable
        .runs
        .get(&run_id.0)
        .and_then(|run| run.max_workers)
        .unwrap_or_else(|| report.worker_ids.len().max(1));
    let workspace = state.workspace.clone();
    let hakus_binary = state.fleet_hakus_binary.clone();
    let execution_run_id = run_id.clone();
    let ssh_password_vault = state.ssh_password_vault.clone();
    tokio::spawn(async move {
        let mut executor = FleetExecutor::new(&workspace).with_ssh_password_vault(ssh_password_vault);
        if let Err(error) = manager
            .run_to_completion(
                &execution_run_id,
                max_workers,
                &mut executor,
                &hakus_binary,
                None,
                Duration::from_millis(250),
            )
            .await
        {
            tracing::error!(
                run_id = %execution_run_id.0,
                error = %error,
                "Runtime API Fleet manager exited with an error"
            );
        }
    });
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "action": "start",
            "execution": "scheduled",
            "run_id": run_id.0,
            "target": "this_computer",
            "leased": report.leased,
            "queued": report.queued,
            "worker_ids": report.worker_ids,
        })),
    ))
}

async fn provision_fleet_ssh_password(
    State(state): State<RuntimeApiState>,
    Path((run_id, worker_id)): Path<(String, String)>,
    Json(request): Json<ProvisionSshPasswordRequest>,
) -> Result<Json<Value>, ApiError> {
    let password = request.password;
    if password.is_empty() || password.len() > 4096 || password.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "password must be non-empty, printable, and no longer than 4096 bytes",
        ));
    }
    let manager = open_fleet_manager(&state)?;
    let run_id = FleetRunId::from(run_id);
    let approval_id = manager
        .request_ssh_password(&run_id, &worker_id)
        .map_err(|err| ApiError::bad_request(format!("SSH password approval unavailable: {err}")))?;
    state
        .ssh_password_vault
        .provision(&worker_id, &password)
        .map_err(|err| ApiError::internal(format!("Failed to provision SSH password broker: {err}")))?;
    manager
        .ledger_record_approval_decided(&approval_id, &run_id, &worker_id)
        .map_err(|err| ApiError::internal(format!("Failed to record SSH approval decision: {err}")))?;
    manager
        .resolve_ssh_password(&run_id)
        .map_err(|err| ApiError::internal(format!("Failed to resume Fleet run: {err}")))?;
    Ok(Json(json!({
        "action": "provision_ssh_password",
        "run_id": run_id.0,
        "worker_id": worker_id,
        "approval_id": approval_id,
        "execution": "resumed",
    })))
}

async fn replay_fleet_events(
    State(state): State<RuntimeApiState>,
    Path(run_id): Path<String>,
    Query(query): Query<FleetEventsQuery>,
) -> Result<Json<FleetEventReplay>, ApiError> {
    let (after, limit) = validate_fleet_events_query(query)?;
    let replay = load_fleet_event_replay(state, FleetRunId::from(run_id), after, limit)
        .await
        .map_err(map_fleet_replay_error)?;
    Ok(Json(replay))
}

async fn stream_fleet_events(
    State(state): State<RuntimeApiState>,
    Path(run_id): Path<String>,
    Query(query): Query<FleetEventsQuery>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let (after, limit) = validate_fleet_events_query(query)?;
    let run_id = FleetRunId::from(run_id);
    let initial = load_fleet_event_replay(state.clone(), run_id.clone(), after.clone(), limit)
        .await
        .map_err(map_fleet_replay_error)?;
    let event_stream = replay_live_fleet_events(state, run_id, after, limit, initial);
    Ok(Sse::new(event_stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
}

fn replay_live_fleet_events(
    state: RuntimeApiState,
    run_id: FleetRunId,
    mut after: Option<String>,
    limit: usize,
    initial: FleetEventReplay,
) -> impl futures_util::Stream<Item = Result<SseEvent, Infallible>> {
    stream! {
        let mut page = initial;
        loop {
            if page.history_truncated {
                yield Ok(sse_json(
                    "fleet.replay.truncated",
                    json!({
                        "run_id": run_id.0.clone(),
                        "reload_projection": true,
                    }),
                ));
            }
            for event in page.events {
                after = Some(event.cursor.clone());
                yield Ok(fleet_sse_event(&event));
            }
            if !page.has_more {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            match load_fleet_event_replay(
                state.clone(),
                run_id.clone(),
                after.clone(),
                limit,
            )
            .await
            {
                Ok(next) => page = next,
                Err(FleetEventReplayError::CursorUnavailable { .. }) => {
                    yield Ok(sse_json(
                        "fleet.replay.cursor_unavailable",
                        json!({
                            "run_id": run_id.0.clone(),
                            "reload_projection": true,
                        }),
                    ));
                    return;
                }
                Err(error) => {
                    tracing::warn!(
                        run_id = %run_id.0,
                        error = %error,
                        "Fleet event stream stopped while reading durable history"
                    );
                    yield Ok(sse_json(
                        "fleet.stream.error",
                        json!({ "retryable": true }),
                    ));
                    return;
                }
            }
        }
    }
}

async fn load_fleet_event_replay(
    state: RuntimeApiState,
    run_id: FleetRunId,
    after: Option<String>,
    limit: usize,
) -> std::result::Result<FleetEventReplay, FleetEventReplayError> {
    tokio::task::spawn_blocking(move || {
        let manager =
            open_fleet_manager(&state).map_err(|error| FleetEventReplayError::Storage {
                message: error.message,
            })?;
        manager.replay_events(&run_id, after.as_deref(), limit)
    })
    .await
    .map_err(|error| FleetEventReplayError::Storage {
        message: format!("Fleet replay worker failed: {error}"),
    })?
}

fn validate_fleet_events_query(
    query: FleetEventsQuery,
) -> Result<(Option<String>, usize), ApiError> {
    let after = query
        .after
        .map(|cursor| cursor.trim().to_string())
        .filter(|cursor| !cursor.is_empty());
    if after.as_deref().is_some_and(|cursor| {
        cursor.len() > 96
            || !cursor.starts_with("fev1_")
            || !cursor
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    }) {
        return Err(ApiError::bad_request(
            "after is not a valid Fleet event cursor",
        ));
    }
    let limit = query.limit.unwrap_or(DEFAULT_FLEET_EVENT_REPLAY_LIMIT);
    if !(1..=MAX_FLEET_EVENT_REPLAY_LIMIT).contains(&limit) {
        return Err(ApiError::bad_request(format!(
            "limit must be between 1 and {MAX_FLEET_EVENT_REPLAY_LIMIT}"
        )));
    }
    Ok((after, limit))
}

fn map_fleet_replay_error(error: FleetEventReplayError) -> ApiError {
    let message = error.to_string();
    match error {
        FleetEventReplayError::UnknownRun { .. } => ApiError::not_found(message),
        FleetEventReplayError::CursorUnavailable { .. } => ApiError::conflict(message),
        FleetEventReplayError::Storage { .. } => ApiError::internal(message),
    }
}

fn fleet_sse_event(event: &FleetRuntimeEvent) -> SseEvent {
    let data = serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string());
    SseEvent::default()
        .id(event.cursor.clone())
        .event(event.event.clone())
        .data(data)
}

async fn list_fleet_runs(State(state): State<RuntimeApiState>) -> Result<Json<Value>, ApiError> {
    let manager = open_fleet_manager(&state)?;
    let ledger_state = manager
        .rebuild_state()
        .map_err(|err| ApiError::internal(format!("Failed to rebuild fleet state: {err}")))?;
    let runs: Vec<_> = ledger_state
        .runs
        .values()
        .map(|run| fleet_run_summary_json(&manager, run, &ledger_state))
        .collect::<Result<Vec<_>, _>>()?;
    let status = manager
        .status()
        .map_err(|err| ApiError::internal(format!("Failed to read fleet status: {err}")))?;
    Ok(Json(json!({
        "status": fleet_status_json(&status),
        "runs": runs,
    })))
}

async fn get_fleet_run(
    State(state): State<RuntimeApiState>,
    Path(run_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let manager = open_fleet_manager(&state)?;
    let ledger_state = manager
        .rebuild_state()
        .map_err(|err| ApiError::internal(format!("Failed to rebuild fleet state: {err}")))?;
    let run = ledger_state
        .runs
        .get(&run_id)
        .ok_or_else(|| ApiError::not_found(format!("fleet run '{run_id}' not found")))?;
    Ok(Json(fleet_run_detail_json(&manager, run, &ledger_state)?))
}

async fn list_fleet_run_workers(
    State(state): State<RuntimeApiState>,
    Path(run_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let manager = open_fleet_manager(&state)?;
    let ledger_state = manager
        .rebuild_state()
        .map_err(|err| ApiError::internal(format!("Failed to rebuild fleet state: {err}")))?;
    let run = ledger_state
        .runs
        .get(&run_id)
        .ok_or_else(|| ApiError::not_found(format!("fleet run '{run_id}' not found")))?;
    let workers = run
        .worker_specs
        .iter()
        .map(|worker| {
            manager
                .inspect_worker(&worker.id)
                .map(|inspection| fleet_worker_json(&inspection))
                .map_err(|err| {
                    ApiError::internal(format!(
                        "Failed to inspect fleet worker {}: {err}",
                        worker.id
                    ))
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({
        "run_id": run_id,
        "workers": workers,
    })))
}

async fn get_fleet_worker(
    State(state): State<RuntimeApiState>,
    Path(worker_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let manager = open_fleet_manager(&state)?;
    let inspection = manager.inspect_worker(&worker_id).map_err(|err| {
        ApiError::not_found(format!("fleet worker '{worker_id}' not found: {err}"))
    })?;
    Ok(Json(fleet_worker_json(&inspection)))
}

async fn interrupt_fleet_worker(
    State(state): State<RuntimeApiState>,
    Path(worker_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let manager = open_fleet_manager(&state)?;
    let inspection = manager.interrupt_worker(&worker_id).map_err(|err| {
        ApiError::bad_request(format!(
            "Failed to interrupt fleet worker '{worker_id}': {err}"
        ))
    })?;
    Ok(Json(json!({
        "action": "interrupt",
        "worker": fleet_worker_json(&inspection),
    })))
}

async fn stop_fleet_worker(
    State(state): State<RuntimeApiState>,
    Path(worker_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let manager = open_fleet_manager(&state)?;
    let inspection = manager.interrupt_worker(&worker_id).map_err(|err| {
        ApiError::bad_request(format!("Failed to stop fleet worker '{worker_id}': {err}"))
    })?;
    Ok(Json(json!({
        "action": "stop",
        "worker": fleet_worker_json(&inspection),
    })))
}

async fn restart_fleet_worker(
    State(state): State<RuntimeApiState>,
    Path(worker_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let manager = open_fleet_manager(&state)?;
    let report = manager.restart_worker(&worker_id).map_err(|err| {
        ApiError::bad_request(format!(
            "Failed to restart fleet worker '{worker_id}': {err}"
        ))
    })?;
    let worker = fleet_worker_json(&report.inspection);
    let run_id = report.run_id.clone();
    let max_workers = report.max_workers;
    let workspace = state.workspace.clone();
    let hakus_binary = state.fleet_hakus_binary.clone();
    let ssh_password_vault = state.ssh_password_vault.clone();
    tokio::spawn(async move {
        let mut executor = FleetExecutor::new(&workspace).with_ssh_password_vault(ssh_password_vault);
        if let Err(err) = manager
            .run_to_completion(
                &run_id,
                max_workers,
                &mut executor,
                &hakus_binary,
                None,
                Duration::from_millis(250),
            )
            .await
        {
            tracing::error!(
                run_id = %run_id.0,
                error = %err,
                "Runtime API Fleet restart manager exited with an error"
            );
        }
    });
    Ok(Json(json!({
        "action": "restart",
        "execution": "scheduled",
        "run_id": report.run_id.0,
        "worker": worker,
    })))
}

async fn stop_fleet_run(
    State(state): State<RuntimeApiState>,
    Path(run_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let manager = open_fleet_manager(&state)?;
    let run_id = FleetRunId::from(run_id);
    let stopped = manager.stop_run(&run_id).map_err(|err| {
        ApiError::bad_request(format!("Failed to stop fleet run '{}': {err}", run_id.0))
    })?;
    let status = manager
        .run_status(&run_id)
        .map_err(|err| ApiError::internal(format!("Failed to read fleet run status: {err}")))?;
    Ok(Json(json!({
        "action": "stop",
        "run_id": run_id.0,
        "stopped": stopped,
        "status": fleet_status_json(&status),
    })))
}

/// Maximum bytes read from a receipt evidence file for the inspection endpoint.
const MAX_RECEIPT_EVIDENCE_READ_BYTES: u64 = 65_536;

async fn list_fleet_run_receipts(
    State(state): State<RuntimeApiState>,
    Path(run_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let manager = open_fleet_manager(&state)?;
    let ledger_state = manager
        .rebuild_state()
        .map_err(|err| ApiError::internal(format!("Failed to rebuild fleet state: {err}")))?;
    if !ledger_state.runs.contains_key(&run_id) {
        return Err(ApiError::not_found(format!(
            "fleet run '{run_id}' not found"
        )));
    }
    let run_id_parsed = FleetRunId::from(run_id.clone());
    let receipts: Vec<Value> = ledger_state
        .receipts
        .values()
        .filter(|r| r.run_id == run_id_parsed)
        .map(fleet_receipt_json)
        .collect();
    Ok(Json(json!({
        "run_id": run_id,
        "receipts": receipts,
    })))
}

async fn get_fleet_run_receipt(
    State(state): State<RuntimeApiState>,
    Path((run_id, task_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let manager = open_fleet_manager(&state)?;
    let ledger_state = manager
        .rebuild_state()
        .map_err(|err| ApiError::internal(format!("Failed to rebuild fleet state: {err}")))?;
    let key = format!("{run_id}:{task_id}");
    let receipt = ledger_state.receipts.get(&key).ok_or_else(|| {
        ApiError::not_found(format!(
            "no receipt found for run '{run_id}' task '{task_id}'"
        ))
    })?;
    Ok(Json(fleet_receipt_json(receipt)))
}

async fn inspect_fleet_run_receipt_evidence(
    State(state): State<RuntimeApiState>,
    Path((run_id, task_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let manager = open_fleet_manager(&state)?;
    let ledger_state = manager
        .rebuild_state()
        .map_err(|err| ApiError::internal(format!("Failed to rebuild fleet state: {err}")))?;
    let key = format!("{run_id}:{task_id}");
    let receipt = ledger_state.receipts.get(&key).ok_or_else(|| {
        ApiError::not_found(format!(
            "no receipt found for run '{run_id}' task '{task_id}'"
        ))
    })?;
    // Locate the most recent Receipt-kind artifact.
    let receipt_artifact = receipt
        .artifacts
        .iter()
        .rfind(|a| a.kind == FleetArtifactKind::Receipt)
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "no verifier evidence file for run '{run_id}' task '{task_id}'"
            ))
        })?;
    let abs_path = state.workspace.join(&receipt_artifact.path);
    let metadata = std::fs::metadata(&abs_path).map_err(|err| {
        ApiError::not_found(format!(
            "evidence file not readable for run '{run_id}' task '{task_id}': {err}"
        ))
    })?;
    let size_bytes = metadata.len();
    let truncated = size_bytes > MAX_RECEIPT_EVIDENCE_READ_BYTES;
    let raw = {
        use std::io::Read;
        let file = std::fs::File::open(&abs_path)
            .map_err(|err| ApiError::internal(format!("Failed to open evidence file: {err}")))?;
        let mut buf = Vec::new();
        file.take(MAX_RECEIPT_EVIDENCE_READ_BYTES)
            .read_to_end(&mut buf)
            .map_err(|err| ApiError::internal(format!("Failed to read evidence file: {err}")))?;
        buf
    };
    // Parse as JSON if possible; fall back to a raw string representation.
    let content: Value = serde_json::from_slice(&raw)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&raw).into_owned()));
    Ok(Json(json!({
        "run_id": run_id,
        "task_id": task_id,
        "path": receipt_artifact.path,
        "checksum": receipt_artifact.checksum,
        "size_bytes": size_bytes,
        "truncated": truncated,
        "content": content,
    })))
}

fn open_fleet_manager(state: &RuntimeApiState) -> Result<FleetManager, ApiError> {
    let (exec_config, fleet_config, session_model, route_config) = {
        let config = state.config.read();
        let exec_config = config
            .fleet
            .as_ref()
            .map(|fleet| fleet.exec.clone())
            .unwrap_or_default();
        // The active session route is the operator: workers without a
        // task/profile model pin inherit the model the user picked in /model.
        (
            exec_config,
            config.fleet_config(),
            config.default_model(),
            config.clone(),
        )
    };
    FleetManager::open(&state.workspace)
        .map(|manager| {
            manager
                .with_exec_config(exec_config)
                .with_fleet_config(fleet_config)
                .with_sub_agent_manager(state.sub_agent_manager.clone())
                .with_session_model(session_model)
                .with_route_config(route_config)
        })
        .map_err(|err| ApiError::internal(format!("Failed to open fleet manager: {err}")))
}

fn fleet_run_summary_json(
    manager: &FleetManager,
    run: &FleetRun,
    ledger_state: &FleetLedgerState,
) -> Result<Value, ApiError> {
    let status = manager
        .run_status(&run.id)
        .map_err(|err| ApiError::internal(format!("Failed to read fleet run status: {err}")))?;
    let task_statuses = ledger_state
        .tasks
        .values()
        .filter(|task| task.entry.run_id == run.id)
        .map(|task| {
            json!({
                "task_id": task.entry.task_id.clone(),
                "status": fleet_task_status_label(task.status),
                "leased_to": task.leased_to.clone(),
                "attempts": task.entry.attempts,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "id": run.id.0.clone(),
        "name": run.name.clone(),
        "lifecycle_status": ledger_state
            .run_status_overrides
            .get(&run.id.0)
            .unwrap_or(&run.status),
        "status": fleet_status_json(&status),
        "target": run.target,
        "workflow": run.workflow.clone(),
        "roles": run.roles.clone(),
        "task_count": run.task_specs.len(),
        "worker_count": run.worker_specs.len(),
        "tasks": task_statuses,
        "labels": run.labels.clone(),
        "created_at": run.created_at.clone(),
        "updated_at": run.updated_at.clone(),
        "completed_at": run.completed_at.clone(),
    }))
}

fn fleet_run_detail_json(
    manager: &FleetManager,
    run: &FleetRun,
    ledger_state: &FleetLedgerState,
) -> Result<Value, ApiError> {
    let mut value = fleet_run_summary_json(manager, run, ledger_state)?;
    if let Some(map) = value.as_object_mut() {
        map.insert("task_specs".to_string(), json!(run.task_specs.clone()));
        map.insert("worker_specs".to_string(), json!(run.worker_specs.clone()));
    }
    Ok(value)
}

fn fleet_status_json(status: &FleetStatusSnapshot) -> Value {
    json!({
        "runs": status.runs,
        "queued": status.queued,
        "running": status.running,
        "completed": status.completed,
        "partial": status.partial,
        "failed": status.failed,
        "restarted": status.restarted,
        "escalated": status.escalated,
        "transport_failed": status.transport_failed,
        "task_failed": status.task_failed,
        "verifier_failed": status.verifier_failed,
        "cancelled": status.cancelled,
        "stale": status.stale,
        "workers": status
            .workers
            .iter()
            .map(|(worker_id, status)| {
                (
                    worker_id.clone(),
                    Value::String(worker_status_label(status).to_string()),
                )
            })
            .collect::<serde_json::Map<String, Value>>(),
    })
}

fn fleet_worker_json(inspection: &FleetWorkerInspection) -> Value {
    json!({
        "worker_id": inspection.worker_id.clone(),
        "status": worker_status_label(&inspection.status),
        "run_id": inspection.current_run_id.as_ref().map(|run_id| run_id.0.clone()),
        "task_id": inspection.current_task_id.clone(),
        "objective": inspection.objective.clone(),
        "role": inspection.role.clone(),
        "host": inspection.host.clone(),
        "latest_heartbeat_at": inspection.latest_heartbeat_at.clone(),
        "latest_event": inspection.latest_event.as_ref().map(fleet_event_json),
        "artifacts": inspection.artifacts.iter().map(fleet_artifact_json).collect::<Vec<_>>(),
        "last_error": inspection.last_error.clone(),
        "alert_state": inspection.alert_state.clone(),
        "runtime_state": inspection.runtime_state.as_ref().map(fleet_worker_runtime_json),
    })
}

fn fleet_worker_runtime_json(runtime: &FleetWorkerRuntimeProjection) -> Value {
    json!({
        "agent_status": runtime.agent_status.clone(),
        "steps_taken": runtime.steps_taken,
        "latest_message": runtime.latest_message.clone(),
        "error": runtime.error.clone(),
        "result_summary": runtime.result_summary.clone(),
        "has_session": runtime.has_session,
    })
}

fn fleet_artifact_json(artifact: &hakus_protocol::fleet::FleetArtifactRef) -> Value {
    json!({
        "kind": artifact_kind_label(&artifact.kind),
        "path": artifact.path.clone(),
        "checksum": artifact.checksum.clone(),
        "mime_type": artifact.mime_type.clone(),
        "size_bytes": artifact.size_bytes,
    })
}

fn fleet_receipt_json(receipt: &hakus_protocol::fleet::FleetReceipt) -> Value {
    use hakus_protocol::fleet::{FleetTaskFailureKind, FleetTaskResult};

    let result_label = match receipt.result {
        FleetTaskResult::Pass => "pass",
        FleetTaskResult::Partial => "partial",
        FleetTaskResult::Fail => "fail",
        FleetTaskResult::Skip => "skip",
        FleetTaskResult::Timeout => "timeout",
    };
    let (failure_kind_label, failure_class, retry_eligible) = match receipt.failure_kind.as_ref() {
        Some(FleetTaskFailureKind::Transport) => (
            Some("transport"),
            Some("Infrastructure or network failure during task transport"),
            true,
        ),
        Some(FleetTaskFailureKind::Task) => (
            Some("task"),
            Some("Task logic exited unsuccessfully"),
            false,
        ),
        Some(FleetTaskFailureKind::Verifier) => (
            Some("verifier"),
            Some("Verifier rejected the task output; manual review or code change required"),
            false,
        ),
        None => (None, None, false),
    };
    let evidence_available = receipt
        .artifacts
        .iter()
        .any(|a| a.kind == FleetArtifactKind::Receipt);
    let score_json = receipt.score.as_ref().map(|s| {
        json!({
            "value": s.value,
            "max": s.max,
            "notes": s.notes,
        })
    });
    json!({
        "run_id": receipt.run_id.0.clone(),
        "task_id": receipt.task_id.clone(),
        "worker_id": receipt.worker_id.clone(),
        "attempt": receipt.attempt,
        "terminal_seq": receipt.terminal_seq,
        "completed_at": receipt.completed_at.clone(),
        "result": result_label,
        "failure_kind": failure_kind_label,
        "failure_class": failure_class,
        "retry_eligible": retry_eligible,
        "score": score_json,
        "artifacts": receipt.artifacts.iter().map(fleet_artifact_json).collect::<Vec<_>>(),
        "evidence_available": evidence_available,
    })
}

fn fleet_event_json(event: &hakus_protocol::fleet::FleetWorkerEvent) -> Value {
    json!({
        "seq": event.seq,
        "run_id": event.run_id.0.clone(),
        "worker_id": event.worker_id.clone(),
        "task_id": event.task_id.clone(),
        "timestamp": event.timestamp.clone(),
        "label": fleet_event_label(&event.payload),
        "payload": event.payload.clone(),
    })
}

fn worker_status_label(status: &FleetWorkerStatus) -> &'static str {
    match status {
        FleetWorkerStatus::Unknown => "unknown",
        FleetWorkerStatus::Online => "online",
        FleetWorkerStatus::Busy => "busy",
        FleetWorkerStatus::Offline => "offline",
        FleetWorkerStatus::Unhealthy => "unhealthy",
        FleetWorkerStatus::Draining => "draining",
        FleetWorkerStatus::Retired => "retired",
    }
}

fn fleet_task_status_label(status: FleetTaskLedgerStatus) -> &'static str {
    match status {
        FleetTaskLedgerStatus::Enqueued => "enqueued",
        FleetTaskLedgerStatus::Leased => "leased",
        FleetTaskLedgerStatus::Completed => "completed",
        FleetTaskLedgerStatus::Failed => "failed",
        FleetTaskLedgerStatus::Cancelled => "cancelled",
    }
}

fn artifact_kind_label(kind: &FleetArtifactKind) -> String {
    match kind {
        FleetArtifactKind::Log => "log".to_string(),
        FleetArtifactKind::Patch => "patch".to_string(),
        FleetArtifactKind::TestResult => "test_result".to_string(),
        FleetArtifactKind::Report => "report".to_string(),
        FleetArtifactKind::Checkpoint => "checkpoint".to_string(),
        FleetArtifactKind::Receipt => "receipt".to_string(),
        FleetArtifactKind::Other(value) => value.clone(),
    }
}

fn fleet_event_label(payload: &FleetWorkerEventPayload) -> String {
    match payload {
        FleetWorkerEventPayload::Queued => "queued".to_string(),
        FleetWorkerEventPayload::Leased { .. } => "leased".to_string(),
        FleetWorkerEventPayload::Starting => "starting".to_string(),
        FleetWorkerEventPayload::Running => "running".to_string(),
        FleetWorkerEventPayload::ModelWait { model } => model
            .as_ref()
            .map(|model| format!("model_wait model={model}"))
            .unwrap_or_else(|| "model_wait".to_string()),
        FleetWorkerEventPayload::RunningTool { tool, call_id } => call_id
            .as_ref()
            .map(|call_id| format!("running_tool tool={tool} call_id={call_id}"))
            .unwrap_or_else(|| format!("running_tool tool={tool}")),
        FleetWorkerEventPayload::WorkflowEvent {
            workflow_run_id,
            event,
        } => event
            .get("type")
            .and_then(serde_json::Value::as_str)
            .map(|kind| format!("workflow_event run_id={workflow_run_id} type={kind}"))
            .unwrap_or_else(|| format!("workflow_event run_id={workflow_run_id}")),
        FleetWorkerEventPayload::Heartbeat { .. } => "heartbeat".to_string(),
        FleetWorkerEventPayload::Artifact(artifact) => {
            format!("artifact kind={}", artifact_kind_label(&artifact.kind))
        }
        FleetWorkerEventPayload::Completed { exit_code, summary } => match (exit_code, summary) {
            (Some(code), Some(summary)) => format!("completed exit_code={code} {summary}"),
            (Some(code), None) => format!("completed exit_code={code}"),
            (None, Some(summary)) => format!("completed {summary}"),
            (None, None) => "completed".to_string(),
        },
        FleetWorkerEventPayload::Failed {
            reason,
            recoverable,
        } => {
            format!("failed recoverable={recoverable} reason={reason}")
        }
        FleetWorkerEventPayload::Cancelled { cancelled_by } => cancelled_by
            .as_ref()
            .map(|by| format!("cancelled by={by}"))
            .unwrap_or_else(|| "cancelled".to_string()),
        FleetWorkerEventPayload::Interrupted { signal } => signal
            .as_ref()
            .map(|signal| format!("interrupted signal={signal}"))
            .unwrap_or_else(|| "interrupted".to_string()),
        FleetWorkerEventPayload::Stale { last_heartbeat_at } => last_heartbeat_at
            .as_ref()
            .map(|ts| format!("stale last_heartbeat_at={ts}"))
            .unwrap_or_else(|| "stale".to_string()),
        FleetWorkerEventPayload::Restarted { restart_count } => {
            format!("restarted count={restart_count}")
        }
        FleetWorkerEventPayload::Escalated { channel, alert_id } => alert_id
            .as_ref()
            .map(|alert_id| format!("escalated channel={channel} alert_id={alert_id}"))
            .unwrap_or_else(|| format!("escalated channel={channel}")),
    }
}

async fn list_skills(
    State(state): State<RuntimeApiState>,
) -> Result<Json<SkillsResponse>, ApiError> {
    let (skills_dir, mode) = {
        let config = state.config.read();
        let skills_dir = resolve_skills_dir(&config, &state.workspace);
        let mode = crate::skills::SkillDiscoveryMode::from_hakus_only(
            config.skills_config().scan_hakus_only(),
        );
        (skills_dir, mode)
    };
    let plugin_registry = state
        .plugin_discovery
        .registry_for_workspace(&state.workspace);
    let (registry, directories) = discover_skills_for_runtime_api(
        &state.workspace,
        &skills_dir,
        mode,
        Some(plugin_registry.as_ref()),
    );
    let mut skill_state = state.skill_state.lock().await;
    skill_state
        .refresh()
        .map_err(|error| ApiError::internal(format!("refresh skill state: {error}")))?;
    let skills = registry
        .list()
        .iter()
        .map(|skill| {
            let (path, source, plugin_id, plugin_generation, plugin_content_hash) =
                match &skill.source {
                    crate::skills::SkillSource::Native => (
                        Some(skill.path.clone()),
                        "native".to_string(),
                        None,
                        None,
                        None,
                    ),
                    crate::skills::SkillSource::Plugin {
                        plugin_id,
                        plugin_name,
                        authority,
                    } => (
                        None,
                        format!("reviewed-plugin-snapshot:{plugin_name}"),
                        Some(plugin_id.clone()),
                        Some(authority.state_generation),
                        Some(authority.content_hash.clone()),
                    ),
                };
            SkillEntry {
                name: skill.name.clone(),
                description: skill.description.clone(),
                path,
                source,
                plugin_id,
                plugin_generation,
                plugin_content_hash,
                enabled: skill_state.is_enabled(&skill.name),
                is_bundled: skill_entry_is_bundled(skill, &skills_dir),
            }
        })
        .collect();
    Ok(Json(SkillsResponse {
        directory: skills_dir,
        directories,
        warnings: registry.warnings().to_vec(),
        skills,
    }))
}

/// Read-only installed-extension inventory for the desktop permission
/// surface (Phase 7: "extension permissions are visible"). Redaction is by
/// construction — no install paths, no skill bodies, no secrets; only
/// identity, trust state, and the manifest's declared capability requests.
async fn list_plugins(State(state): State<RuntimeApiState>) -> Json<PluginsResponse> {
    let registry = state.plugin_discovery.registry_for_workspace(&state.workspace);
    let plugins = registry
        .list()
        .iter()
        .map(|plugin| PluginEntry {
            id: plugin.id.0.clone(),
            name: plugin.name().to_string(),
            version: plugin.manifest.plugin.version.clone(),
            scope: plugin.scope.as_str(),
            origin: plugin.origin.as_str(),
            enabled: plugin.enabled,
            trust_status: plugin.trust_status.as_str(),
            applicable: plugin.applicable,
            staged: plugin.staged_root.is_some(),
            capabilities: PluginCapabilityInventory {
                filesystem_roots: plugin.manifest.capabilities.filesystem_roots.clone(),
                network_hosts: plugin.manifest.capabilities.network_hosts.clone(),
                lifecycle_mutation: plugin.manifest.capabilities.lifecycle_mutation,
            },
            extension: plugin.manifest.extension.as_ref().map(|extension| {
                PluginExtensionDescriptor {
                    id: extension.id.clone(),
                    version: extension.version.clone(),
                    protocol: extension.protocol.clone(),
                    entrypoint: extension.entrypoint.clone(),
                    capabilities: extension.capabilities.clone(),
                    permissions: extension.permissions.clone(),
                    supported_platforms: extension.supported_platforms.clone(),
                    checksum: extension.checksum.clone(),
                }
            }),
            content_hash: plugin.content_hash.clone(),
            capability_hash: plugin.capability_hash.clone(),
            state_generation: plugin.state_generation,
            skill_count: plugin.skill_snapshots.len(),
            diagnostics: plugin
                .diagnostics
                .iter()
                .map(|diagnostic| PluginDiagnosticEntry {
                    level: match diagnostic.level {
                        crate::plugins::types::PluginDiagnosticLevel::Warning => "warning",
                        crate::plugins::types::PluginDiagnosticLevel::Error => "error",
                    },
                    code: diagnostic.code.to_string(),
                    message: diagnostic.message.clone(),
                })
                .collect(),
        })
        .collect();
    Json(PluginsResponse { plugins })
}

fn plugin_receipt_to_response(
    receipt: &crate::plugins::mutation::PluginMutationReceipt,
) -> PluginMutationReceiptResponse {
    use crate::plugins::mutation::PluginMutationOutcome;

    let outcome = match receipt.outcome {
        PluginMutationOutcome::Installed => "installed",
        PluginMutationOutcome::Updated => "updated",
        PluginMutationOutcome::NoChange => "no_change",
        PluginMutationOutcome::Uninstalled => "uninstalled",
        PluginMutationOutcome::NeedsApproval(_) => "needs_approval",
        PluginMutationOutcome::NetworkDenied(_) => "network_denied",
    };
    PluginMutationReceiptResponse {
        name: receipt.name.clone(),
        outcome,
        // Deliberately omit `path`: Runtime API responses must not disclose
        // the user's home or workspace layout. Hashes are the stable review
        // handles needed by a desktop client.
        content_hash: receipt.content_hash.clone(),
        installed_content_hash: receipt.installed_content_hash.clone(),
    }
}

fn plugin_policy_error_message(
    outcome: &crate::plugins::mutation::PluginMutationOutcome,
) -> Option<String> {
    match outcome {
        crate::plugins::mutation::PluginMutationOutcome::NeedsApproval(host) => Some(format!(
            "network access to '{host}' requires explicit approval; approve the host in your network policy before installing or updating this plugin"
        )),
        crate::plugins::mutation::PluginMutationOutcome::NetworkDenied(host) => Some(format!(
            "network access to '{host}' was denied by the active network policy"
        )),
        _ => None,
    }
}

fn plugin_mutation_failure(operation: &str, error: anyhow::Error) -> ApiError {
    // Installer diagnostics can contain canonical source or destination paths.
    // Return a stable, path-free API error so a remote desktop client cannot
    // learn the user's filesystem; detailed diagnostics remain in the caller's
    // local command context.
    let not_found = error
        .to_string()
        .to_ascii_lowercase()
        .contains("was not found");
    if not_found {
        ApiError::not_found(format!("plugin {operation} target was not found"))
    } else {
        ApiError::bad_request(format!("plugin {operation} was rejected"))
    }
}

async fn install_plugin_api(
    State(state): State<RuntimeApiState>,
    Json(req): Json<InstallPluginRequest>,
) -> Result<(StatusCode, Json<PluginMutationReceiptResponse>), ApiError> {
    use crate::plugins::mutation::{PluginMutationContext, PluginMutationRequest};

    let source = crate::plugins::install::PluginInstallSource::parse(&req.source)
        .map_err(|err| ApiError::bad_request(format!("invalid plugin install source: {err}")))?;
    let request = match req.expected_content_hash {
        Some(expected_content_hash) => PluginMutationRequest::InstallExact {
            source,
            expected_content_hash,
        },
        None => PluginMutationRequest::Install { source },
    };
    let (network, max_size, _, _) = mutation_context_settings(&state);
    let mut registry = state.plugin_discovery.registry_for_workspace(&state.workspace);
    let receipt = crate::plugins::mutation::execute(
        request,
        &PluginMutationContext {
            network: &network,
            max_size,
        },
        Arc::make_mut(&mut registry),
    )
    .await
    .map_err(|err| plugin_mutation_failure("install", err))?;
    if let Some(message) = plugin_policy_error_message(&receipt.outcome) {
        return Err(ApiError::forbidden(message));
    }
    let status = if matches!(
        receipt.outcome,
        crate::plugins::mutation::PluginMutationOutcome::Installed
    ) {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(plugin_receipt_to_response(&receipt))))
}

async fn update_plugin_api(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
    _req: Option<Json<UpdatePluginRequest>>,
) -> Result<Json<PluginMutationReceiptResponse>, ApiError> {
    use crate::plugins::mutation::{PluginMutationContext, PluginMutationRequest};

    let (network, max_size, _, _) = mutation_context_settings(&state);
    let mut registry = state.plugin_discovery.registry_for_workspace(&state.workspace);
    let receipt = crate::plugins::mutation::execute(
        PluginMutationRequest::Update { selector: name },
        &PluginMutationContext {
            network: &network,
            max_size,
        },
        Arc::make_mut(&mut registry),
    )
    .await
    .map_err(|err| plugin_mutation_failure("update", err))?;
    if let Some(message) = plugin_policy_error_message(&receipt.outcome) {
        return Err(ApiError::forbidden(message));
    }
    Ok(Json(plugin_receipt_to_response(&receipt)))
}

async fn uninstall_plugin_api(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
) -> Result<Json<PluginMutationReceiptResponse>, ApiError> {
    use crate::plugins::mutation::{PluginMutationContext, PluginMutationRequest};

    let mut registry = state.plugin_discovery.registry_for_workspace(&state.workspace);
    let receipt = crate::plugins::mutation::execute(
        PluginMutationRequest::Uninstall { selector: name },
        &PluginMutationContext {
            network: &crate::network_policy::NetworkPolicy::default(),
            max_size: 0,
        },
        Arc::make_mut(&mut registry),
    )
    .await
    .map_err(|err| plugin_mutation_failure("uninstall", err))?;
    Ok(Json(plugin_receipt_to_response(&receipt)))
}

/// Enable or disable an installed extension over the Runtime API. The
/// registry enforces the policy itself: enablement requires an existing trust
/// receipt, a verified staged snapshot, host applicability, and at least one
/// supported declarative component — an untrusted bundle cannot be switched
/// on from here. **Trust granting is deliberately not exposed** over the API;
/// capability review stays a command-layer human decision.
async fn set_plugin_enabled(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
    Json(req): Json<SetPluginEnabledRequest>,
) -> Result<Json<PluginMutationResponse>, ApiError> {
    let mut registry = state.plugin_discovery.registry_for_workspace(&state.workspace);
    let mutation = Arc::make_mut(&mut registry);
    let result = if req.enabled {
        mutation.enable(&name)
    } else {
        mutation.disable(&name)
    };
    result.map_err(ApiError::bad_request)?;
    let plugin = mutation
        .get(&name)
        .ok_or_else(|| ApiError::not_found(format!("plugin '{name}' not found")))?;
    Ok(Json(PluginMutationResponse {
        id: plugin.id.0.clone(),
        name: plugin.name().to_string(),
        enabled: plugin.enabled,
        trust_status: plugin.trust_status.as_str(),
        state_generation: plugin.state_generation,
    }))
}

/// Start a reviewed extension through the Runtime-owned host. The desktop
/// receives only a redacted lifecycle projection; process handles stay inside
/// `RuntimeThreadManager`.
async fn start_extension(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
    Json(req): Json<StartExtensionRequest>,
) -> Result<Json<crate::runtime_threads::ExtensionRuntimeStatus>, ApiError> {
    if req.event_type.trim().is_empty() {
        return Err(ApiError::bad_request("extension event_type cannot be empty"));
    }
    let status = state
        .runtime_threads
        .start_managed_extension(
            &name,
            req.thread_id.as_deref(),
            &req.event_type,
            req.payload,
        )
        .await
        .map_err(|error| ApiError::internal(format!("extension start failed: {error}")))?;
    Ok(Json(status))
}

async fn stop_extension(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
) -> Result<Json<crate::runtime_threads::ExtensionRuntimeStatus>, ApiError> {
    let status = state
        .runtime_threads
        .stop_managed_extension(&name)
        .await
        .map_err(|error| ApiError::internal(format!("extension stop failed: {error}")))?;
    Ok(Json(status))
}

async fn extension_status(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
) -> Result<Json<crate::runtime_threads::ExtensionRuntimeStatus>, ApiError> {
    let status = state
        .runtime_threads
        .managed_extension_status(&name)
        .await
        .map_err(|error| ApiError::internal(format!("extension status failed: {error}")))?;
    Ok(Json(status))
}

async fn set_skill_enabled(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
    Json(req): Json<SetSkillEnabledRequest>,
) -> Result<Json<SetSkillEnabledResponse>, ApiError> {
    let (skills_dir, mode) = {
        let config = state.config.read();
        let skills_dir = resolve_skills_dir(&config, &state.workspace);
        let mode = crate::skills::SkillDiscoveryMode::from_hakus_only(
            config.skills_config().scan_hakus_only(),
        );
        (skills_dir, mode)
    };
    let plugin_registry = state
        .plugin_discovery
        .registry_for_workspace(&state.workspace);
    let (registry, directories) = discover_skills_for_runtime_api(
        &state.workspace,
        &skills_dir,
        mode,
        Some(plugin_registry.as_ref()),
    );
    let exists = registry.list().iter().any(|skill| skill.name == name);
    if !exists {
        return Err(ApiError::not_found(format!(
            "skill '{name}' not found in searched directories: {}",
            format_skill_search_paths(&directories)
        )));
    }

    let mut store = state.skill_state.lock().await;
    store
        .set_enabled(&name, req.enabled)
        .map_err(|err| ApiError::internal(format!("persist skill state: {err}")))?;
    Ok(Json(SetSkillEnabledResponse {
        name,
        enabled: req.enabled,
    }))
}

// ─── Skill lifecycle helpers ────────────────────────────────────────────────

/// Build a [`crate::skills::mutation::MutationContext`] from the current
/// server state. Reads the network policy and installer settings directly
/// from the config already held in `state`.
fn mutation_context_settings(
    state: &RuntimeApiState,
) -> (
    crate::network_policy::NetworkPolicy,
    u64,
    String,
    Option<PathBuf>,
) {
    use crate::skills::install::{DEFAULT_MAX_SIZE_BYTES, DEFAULT_REGISTRY_URL};
    let config = state.config.read();
    let network = config
        .network
        .clone()
        .map(|p| p.into_runtime())
        .unwrap_or_default();
    let skills_cfg = config.skills.as_ref();
    let max_size = skills_cfg
        .and_then(|s| s.max_install_size_bytes)
        .unwrap_or(DEFAULT_MAX_SIZE_BYTES);
    let registry_url = skills_cfg
        .and_then(|s| s.registry_url.clone())
        .unwrap_or_else(|| DEFAULT_REGISTRY_URL.to_string());
    let configured_skills_dir = config.skills_dir.as_ref().map(PathBuf::from);
    (network, max_size, registry_url, configured_skills_dir)
}

fn parse_api_scope(
    scope: Option<&str>,
) -> Result<Option<crate::skills::mutation::SkillTargetScope>, ApiError> {
    match scope {
        None => Ok(None),
        Some("project") => Ok(Some(crate::skills::mutation::SkillTargetScope::Project)),
        Some("global") => Ok(Some(crate::skills::mutation::SkillTargetScope::Global)),
        Some(other) => Err(ApiError::bad_request(format!(
            "invalid scope '{other}'; expected \"project\" or \"global\""
        ))),
    }
}

fn receipt_to_response(
    receipt: &crate::skills::mutation::SkillMutationReceipt,
) -> SkillMutationReceiptResponse {
    use crate::skills::mutation::SkillMutationOutcome;
    use crate::skills::roots::SkillScope;

    const TRUST_NOTE: &str = "The .trusted marker is advisory and digest-bound; \
         it records your review intent but does not sandbox or auto-authorize scripts.";

    let outcome: &'static str = match &receipt.outcome {
        SkillMutationOutcome::Installed => "installed",
        SkillMutationOutcome::Updated => "updated",
        SkillMutationOutcome::NoChange => "no_change",
        SkillMutationOutcome::Removed => "removed",
        SkillMutationOutcome::Trusted => "trusted",
        SkillMutationOutcome::Imported => "imported",
        SkillMutationOutcome::AlreadyPresent => "already_present",
        // NeedsApproval / NetworkDenied are returned as ApiError::forbidden
        // before reaching this conversion; they should not appear here.
        SkillMutationOutcome::NeedsApproval(_) => "needs_approval",
        SkillMutationOutcome::NetworkDenied(_) => "network_denied",
    };
    let scope = match receipt.scope {
        SkillScope::Project => "project".to_string(),
        SkillScope::Global => "global".to_string(),
        SkillScope::Logical => "logical".to_string(),
    };
    let trust_note = if receipt.outcome == SkillMutationOutcome::Trusted {
        Some(TRUST_NOTE)
    } else {
        None
    };
    SkillMutationReceiptResponse {
        name: receipt.name.clone(),
        outcome,
        scope,
        safe_target_path: receipt.safe_target_path.clone(),
        trust_note,
    }
}

fn outcome_is_policy_error(outcome: &crate::skills::mutation::SkillMutationOutcome) -> bool {
    matches!(
        outcome,
        crate::skills::mutation::SkillMutationOutcome::NeedsApproval(_)
            | crate::skills::mutation::SkillMutationOutcome::NetworkDenied(_)
    )
}

fn policy_error_message(outcome: &crate::skills::mutation::SkillMutationOutcome) -> String {
    match outcome {
        crate::skills::mutation::SkillMutationOutcome::NeedsApproval(host) => format!(
            "network access to '{host}' requires explicit approval; \
             approve the host in your network policy before installing this skill"
        ),
        crate::skills::mutation::SkillMutationOutcome::NetworkDenied(host) => {
            format!("network access to '{host}' was denied by the active network policy")
        }
        _ => "operation denied by policy".to_string(),
    }
}

// ─── POST /v1/skills/install ────────────────────────────────────────────────

async fn install_skill_api(
    State(state): State<RuntimeApiState>,
    Json(req): Json<InstallSkillRequest>,
) -> Result<(StatusCode, Json<SkillMutationReceiptResponse>), ApiError> {
    use crate::skills::install::InstallSource;
    use crate::skills::mutation::{MutationContext, SkillMutationRequest, SkillTargetScope};

    let source = InstallSource::parse(&req.source)
        .map_err(|err| ApiError::bad_request(format!("invalid install source: {err}")))?;
    let target = parse_api_scope(req.scope.as_deref())?.unwrap_or(SkillTargetScope::Global);

    let (network, max_size, registry_url, configured_skills_dir) =
        mutation_context_settings(&state);
    let home = crate::config::effective_home_dir();
    let workspace = state.workspace.clone();

    let receipt = crate::skills::mutation::execute(
        SkillMutationRequest::InstallRemote { source, target },
        &MutationContext {
            workspace: &workspace,
            home: home.as_deref(),
            configured_skills_dir: configured_skills_dir.as_deref(),
            network: &network,
            max_size,
            registry_url: &registry_url,
        },
    )
    .await
    .map_err(|err| ApiError::bad_request(format!("install failed: {err:#}")))?;

    if outcome_is_policy_error(&receipt.outcome) {
        return Err(ApiError::forbidden(policy_error_message(&receipt.outcome)));
    }

    let status = if receipt.outcome == crate::skills::mutation::SkillMutationOutcome::Installed {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(receipt_to_response(&receipt))))
}

// ─── POST /v1/skills/{name}/update ─────────────────────────────────────────

async fn update_skill_api(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
    Json(req): Json<UpdateSkillRequest>,
) -> Result<Json<SkillMutationReceiptResponse>, ApiError> {
    use crate::skills::mutation::{MutationContext, SkillMutationRequest};

    let scope = parse_api_scope(req.scope.as_deref())?;
    let (network, max_size, registry_url, configured_skills_dir) =
        mutation_context_settings(&state);
    let home = crate::config::effective_home_dir();
    let workspace = state.workspace.clone();

    let receipt = crate::skills::mutation::execute(
        SkillMutationRequest::UpdateByName {
            name: name.clone(),
            scope,
            expected_digest: req.expected_digest,
        },
        &MutationContext {
            workspace: &workspace,
            home: home.as_deref(),
            configured_skills_dir: configured_skills_dir.as_deref(),
            network: &network,
            max_size,
            registry_url: &registry_url,
        },
    )
    .await
    .map_err(|err| {
        let msg = err.to_string();
        if msg.contains("not found") {
            ApiError::not_found(format!("update failed: {err:#}"))
        } else {
            ApiError::bad_request(format!("update failed: {err:#}"))
        }
    })?;

    if outcome_is_policy_error(&receipt.outcome) {
        return Err(ApiError::forbidden(policy_error_message(&receipt.outcome)));
    }

    Ok(Json(receipt_to_response(&receipt)))
}

// ─── DELETE /v1/skills/{name} (uninstall) ──────────────────────────────────

async fn uninstall_skill_api(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
    Query(query): Query<UninstallSkillQuery>,
) -> Result<Json<SkillMutationReceiptResponse>, ApiError> {
    use crate::skills::mutation::{MutationContext, SkillMutationRequest};

    let scope = parse_api_scope(query.scope.as_deref())?;
    let (network, max_size, registry_url, configured_skills_dir) =
        mutation_context_settings(&state);
    let home = crate::config::effective_home_dir();

    let receipt = crate::skills::mutation::execute_sync(
        SkillMutationRequest::RemoveByName {
            name: name.clone(),
            scope,
            expected_digest: query.expected_digest,
        },
        &MutationContext {
            workspace: &state.workspace,
            home: home.as_deref(),
            configured_skills_dir: configured_skills_dir.as_deref(),
            network: &network,
            max_size,
            registry_url: &registry_url,
        },
    )
    .map_err(|err| {
        let msg = err.to_string();
        if msg.contains("not found") {
            ApiError::not_found(format!("uninstall failed: {err:#}"))
        } else {
            ApiError::bad_request(format!("uninstall failed: {err:#}"))
        }
    })?;

    Ok(Json(receipt_to_response(&receipt)))
}

// ─── POST /v1/skills/{name}/trust ──────────────────────────────────────────

async fn trust_skill_api(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
    Json(req): Json<TrustSkillRequest>,
) -> Result<Json<SkillMutationReceiptResponse>, ApiError> {
    use crate::skills::mutation::{MutationContext, SkillMutationRequest};

    let scope = parse_api_scope(req.scope.as_deref())?;
    let (network, max_size, registry_url, configured_skills_dir) =
        mutation_context_settings(&state);
    let home = crate::config::effective_home_dir();

    let receipt = crate::skills::mutation::execute_sync(
        SkillMutationRequest::TrustByName {
            name: name.clone(),
            scope,
            expected_digest: req.expected_digest,
        },
        &MutationContext {
            workspace: &state.workspace,
            home: home.as_deref(),
            configured_skills_dir: configured_skills_dir.as_deref(),
            network: &network,
            max_size,
            registry_url: &registry_url,
        },
    )
    .map_err(|err| {
        let msg = err.to_string();
        if msg.contains("not found") {
            ApiError::not_found(format!("trust failed: {err:#}"))
        } else {
            ApiError::bad_request(format!("trust failed: {err:#}"))
        }
    })?;

    Ok(Json(receipt_to_response(&receipt)))
}

// ─── GET /v1/skills/{name}/audit ───────────────────────────────────────────

async fn audit_skill_api(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
    Query(query): Query<SkillScopeQuery>,
) -> Result<Json<SkillAuditResponse>, ApiError> {
    use crate::skills::audit::{
        AuditedSkill, DigestState, IntegrityState, SkillActionKind, SkillAuditMode,
        SkillAuditWarning, SkillSourceKind, TrustState, scan_with_configured,
    };
    use crate::skills::roots::SkillRootKind;

    let scope_filter = parse_api_scope(query.scope.as_deref())?;
    let home = crate::config::effective_home_dir();
    let configured_skills_dir = {
        let config = state.config.read();
        config.skills_dir.as_ref().map(PathBuf::from)
    };
    let canonical = crate::skills::normalize_skill_name_for_lookup(&name);

    let snap = scan_with_configured(
        &state.workspace,
        home.as_deref(),
        configured_skills_dir.as_deref(),
        SkillAuditMode::Compatible,
        None,
    );

    let mut matches: Vec<&AuditedSkill> = snap
        .skills
        .iter()
        .filter(|s| s.id.canonical_name == canonical)
        .collect();

    if let Some(scope) = scope_filter {
        let want = match scope {
            crate::skills::mutation::SkillTargetScope::Project => SkillRootKind::CodeWhaleProject,
            crate::skills::mutation::SkillTargetScope::Global => SkillRootKind::CodeWhaleGlobal,
        };
        matches.retain(|s| s.root.kind == want);
    }

    if matches.is_empty() {
        return Err(ApiError::not_found(format!(
            "skill '{name}' not found in any audited root"
        )));
    }

    let ambiguous = matches.len() > 1;
    let entries = matches
        .into_iter()
        .map(|skill| {
            let source_kind = match skill.source_kind {
                SkillSourceKind::CodeWhaleManaged => "hakus_managed",
                SkillSourceKind::CodeWhaleManual => "hakus_manual",
                SkillSourceKind::CompatibleExternal => "compatible_external",
                SkillSourceKind::BuiltIn => "built_in",
                SkillSourceKind::ReviewedPluginSnapshot => "reviewed_plugin_snapshot",
                SkillSourceKind::RegistryCache => "registry_cache",
            };
            let scope_str = match skill.root.kind {
                SkillRootKind::CodeWhaleProject => "project",
                SkillRootKind::CodeWhaleGlobal => "global",
                _ => "other",
            };
            let digest = match &skill.digest {
                DigestState::Known(v) => SkillAuditDigest {
                    state: "known".to_string(),
                    value: Some(v.clone()),
                },
                DigestState::Unknown(reason) => SkillAuditDigest {
                    state: format!("unknown:{reason:?}").to_ascii_lowercase(),
                    value: None,
                },
            };
            let trust = match &skill.trust {
                TrustState::TrustedForDigest(_) => "trusted_for_digest",
                TrustState::TrustStale => "trust_stale",
                TrustState::LegacyAdvisory => "legacy_advisory",
                TrustState::Untrusted => "untrusted",
                TrustState::NotApplicable => "not_applicable",
                TrustState::Unknown => "unknown",
            };
            let integrity = match &skill.integrity {
                IntegrityState::Healthy => "healthy",
                IntegrityState::LocalContentDrift => "local_content_drift",
                IntegrityState::BrokenManagedInstall => "broken_managed_install",
                IntegrityState::LegacyMetadataUnknown => "legacy_metadata_unknown",
                IntegrityState::Unknown => "unknown",
            };
            let available_actions = skill
                .available_actions
                .iter()
                .map(|a| match a {
                    SkillActionKind::Install => "install",
                    SkillActionKind::Import => "import",
                    SkillActionKind::Update => "update",
                    SkillActionKind::Remove => "remove",
                    SkillActionKind::Trust => "trust",
                })
                .map(str::to_string)
                .collect();
            let warnings = skill
                .warnings
                .iter()
                .map(|w| match w {
                    SkillAuditWarning::Message(m) => m.clone(),
                })
                .collect();
            SkillAuditEntry {
                name: skill.name.clone(),
                safe_display_path: skill.safe_display_path.clone(),
                source_kind: source_kind.to_string(),
                scope: scope_str.to_string(),
                digest,
                trust: trust.to_string(),
                integrity: integrity.to_string(),
                available_actions,
                warnings,
            }
        })
        .collect();

    Ok(Json(SkillAuditResponse {
        ambiguous,
        skills: entries,
    }))
}

async fn decide_approval(
    State(state): State<RuntimeApiState>,
    Path(approval_id): Path<String>,
    Json(req): Json<DecideApprovalBody>,
) -> Result<Json<DecideApprovalResponse>, ApiError> {
    let decision = match req.decision.as_str() {
        "allow" => ExternalApprovalDecision::Allow {
            remember: req.remember,
        },
        "deny" => ExternalApprovalDecision::Deny {
            remember: req.remember,
        },
        other => {
            return Err(ApiError::bad_request(format!(
                "invalid decision '{other}'; expected \"allow\" or \"deny\""
            )));
        }
    };
    let delivered = state
        .runtime_threads
        .deliver_external_approval(&approval_id, decision);
    if !delivered {
        return Err(ApiError::not_found(format!(
            "no pending approval with id '{approval_id}'"
        )));
    }
    Ok(Json(DecideApprovalResponse {
        ok: true,
        approval_id,
        decision: req.decision,
        delivered,
    }))
}

async fn submit_user_input(
    State(state): State<RuntimeApiState>,
    Path((thread_id, input_id)): Path<(String, String)>,
    Json(req): Json<SubmitUserInputBody>,
) -> Result<Json<SubmitUserInputResponse>, ApiError> {
    use crate::tools::user_input::{UserInputAnswer, UserInputResponse};
    let answers: Vec<UserInputAnswer> = req
        .answers
        .into_iter()
        .map(|a| UserInputAnswer {
            id: a.id,
            label: a.label,
            value: a.value,
        })
        .collect();
    let response = UserInputResponse { answers };
    let delivered = state
        .runtime_threads
        .submit_user_input(&thread_id, &input_id, response)
        .await
        .map_err(map_thread_err)?;
    if !delivered {
        return Err(ApiError::not_found(format!(
            "no pending user-input request with id '{input_id}'"
        )));
    }
    Ok(Json(SubmitUserInputResponse {
        ok: true,
        input_id,
        delivered,
    }))
}

async fn runtime_info(
    State(state): State<RuntimeApiState>,
    _request: Request,
) -> Json<RuntimeInfoResponse> {
    let version = env!("CARGO_PKG_VERSION");
    let commit = option_env!("HAKUS_BUILD_COMMIT").unwrap_or("unknown");
    Json(RuntimeInfoResponse {
        service: "hakus-runtime-api",
        runtime_api_version: RUNTIME_API_VERSION,
        hakus_version: version,
        hakus_commit: commit,
        bind_host: state.bind_host.clone(),
        port: state.bind_port,
        auth_required: state.auth_required,
        transports: vec!["http", "sse"],
        capabilities: default_runtime_capabilities(),
        experimental: RuntimeExperimentalCapabilities::default(),
        execution_plane: state.execution_plane,
        feature_gates: state.feature_gates.clone(),
        process_started_at_unix_ms: state.started_at_unix_ms,
        version,
    })
}

async fn runtime_capabilities(
    State(state): State<RuntimeApiState>,
) -> Json<RuntimeCapabilitiesResponse> {
    Json(RuntimeCapabilitiesResponse {
        runtime_api_version: RUNTIME_API_VERSION,
        event_schema_version: RUNTIME_EVENT_ENVELOPE_SCHEMA_VERSION,
        capabilities: default_runtime_capabilities(),
        execution_plane: state.execution_plane,
        feature_gates: state.feature_gates.clone(),
    })
}

async fn list_mcp_servers(
    State(state): State<RuntimeApiState>,
) -> Result<Json<McpServersResponse>, ApiError> {
    let mcp_config_path = state.config.read().mcp_config_path();
    let plugin_registry = state
        .plugin_discovery
        .registry_for_workspace(&state.workspace);
    let config = crate::mcp::load_config_with_workspace_and_plugins(
        &mcp_config_path,
        &state.workspace,
        plugin_registry.as_ref(),
    )
    .map_err(|e| ApiError::internal(format!("Failed to load MCP config: {e}")))?;

    let connected_servers = {
        let pool_slot = state.mcp_pool.lock().await;
        if let Some(pool_handle) = pool_slot.as_ref() {
            let pool = pool_handle.lock().await;
            pool.connected_servers()
                .into_iter()
                .map(str::to_string)
                .collect::<BTreeSet<_>>()
        } else {
            BTreeSet::new()
        }
    };

    let mut servers = Vec::new();
    for (name, server_cfg) in config.servers {
        servers.push(McpServerEntry {
            name: name.clone(),
            enabled: server_cfg.is_enabled(),
            required: server_cfg.required,
            command: server_cfg.command.clone(),
            url: server_cfg.url.clone(),
            connected: connected_servers.contains(&name),
            enabled_tools: server_cfg.enabled_tools.clone(),
            disabled_tools: server_cfg.disabled_tools.clone(),
        });
    }
    servers.sort_by(|a, b| a.name.cmp(&b.name));

    let global = state.mcp_global_config.lock().await.clone();
    Ok(Json(McpServersResponse { servers, global }))
}

async fn list_mcp_tools(
    State(state): State<RuntimeApiState>,
    Query(query): Query<McpToolsQuery>,
) -> Result<Json<McpToolsResponse>, ApiError> {
    let connect = query.connect || state.mcp_global_config.lock().await.auto_start;
    // Double-checked init: hold the state-level slot mutex only long enough
    // to grab (or lazily create) the pool handle. connect_all can stall on a
    // slow MCP server and must not run under the slot lock.
    let pool_handle = {
        let mut pool_slot = state.mcp_pool.lock().await;
        match pool_slot.as_ref() {
            Some(pool) => Some(Arc::clone(pool)),
            None if connect => {
                let mcp_config_path = state.config.read().mcp_config_path();
                let plugin_registry = state
                    .plugin_discovery
                    .registry_for_workspace(&state.workspace);
                let new_pool = McpPool::from_config_path_with_workspace_and_plugins(
                    &mcp_config_path,
                    &state.workspace,
                    plugin_registry,
                )
                .map_err(|e| ApiError::internal(format!("Failed to load MCP config: {e}")))?;
                let handle = Arc::new(Mutex::new(new_pool));
                pool_slot.replace(Arc::clone(&handle));
                Some(handle)
            }
            None => None,
        }
    };

    let Some(pool_handle) = pool_handle else {
        return Ok(Json(McpToolsResponse { tools: Vec::new() }));
    };

    let mut pool = pool_handle.lock().await;
    if connect {
        let _errors = pool.connect_all().await;
    }

    let mut tools = Vec::new();
    for (prefixed_name, tool) in pool.all_tools() {
        let Ok((server, name)) = pool.parse_prefixed_name(&prefixed_name) else {
            continue;
        };

        if let Some(filter) = query.server.as_deref()
            && server != filter
        {
            continue;
        }

        tools.push(McpToolEntry {
            server: server.to_string(),
            name: name.to_string(),
            prefixed_name,
            description: tool.description.clone(),
            input_schema: tool.input_schema.clone(),
        });
    }

    tools.sort_by(|a, b| a.server.cmp(&b.server).then_with(|| a.name.cmp(&b.name)));

    Ok(Json(McpToolsResponse { tools }))
}

async fn get_mcp_global_config(
    State(state): State<RuntimeApiState>,
) -> Result<Json<Value>, ApiError> {
    let global = state.mcp_global_config.lock().await.clone();
    Ok(Json(json!({ "global": global })))
}

async fn update_mcp_global_config(
    State(state): State<RuntimeApiState>,
    Json(patch): Json<McpGlobalConfigPatch>,
) -> Result<Json<Value>, ApiError> {
    let mut updated = state.mcp_global_config.lock().await.clone();
    if let Some(auto_start) = patch.auto_start {
        updated.auto_start = auto_start;
    }
    if let Some(fail_fast) = patch.fail_fast {
        updated.fail_fast = fail_fast;
    }
    if let Some(tool_naming) = patch.tool_naming {
        let normalized = tool_naming.trim().to_ascii_lowercase();
        if normalized != "namespace" && normalized != "flat" {
            return Err(ApiError::bad_request(
                "tool_naming must be either 'namespace' or 'flat'",
            ));
        }
        updated.tool_naming = normalized;
    }

    let config = state.config.read().clone();
    save_mcp_global_config(&config, &updated)
        .map_err(|error| ApiError::internal(format!("Failed to save MCP global config: {error}")))?;
    *state.mcp_global_config.lock().await = updated.clone();
    Ok(Json(json!({ "global": updated })))
}

/// `GET /v1/apps/mcp/servers/{name}` — fetch a single server's redacted config.
async fn get_mcp_server(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
) -> Result<Json<McpServerDetail>, ApiError> {
    let mcp_config_path = state.config.read().mcp_config_path();
    let plugin_registry = state
        .plugin_discovery
        .registry_for_workspace(&state.workspace);
    let config = crate::mcp::load_config_with_workspace_and_plugins(
        &mcp_config_path,
        &state.workspace,
        plugin_registry.as_ref(),
    )
    .map_err(|e| ApiError::internal(format!("Failed to load MCP config: {e}")))?;

    let server_cfg = config
        .servers
        .get(&name)
        .ok_or_else(|| ApiError::not_found(format!("MCP server '{name}' not found")))?;

    let connected = {
        let pool_slot = state.mcp_pool.lock().await;
        pool_slot.as_ref().is_some_and(|pool_handle| {
            pool_handle
                .try_lock()
                .is_ok_and(|p| p.connected_servers().contains(&name.as_str()))
        })
    };

    Ok(Json(McpServerDetail::from_config(
        &name, server_cfg, connected,
    )))
}

/// `POST /v1/apps/mcp/servers` — add a new server to the persistent config.
///
/// Body: JSON object with all `McpServerWriteRequest` fields **plus** a
/// required top-level `"name"` string that will be the server key.
async fn create_mcp_server(
    State(state): State<RuntimeApiState>,
    Json(body): Json<serde_json::Value>,
) -> Result<(StatusCode, Json<McpServerDetail>), ApiError> {
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::bad_request("'name' is required"))?
        .to_string();

    if name.trim().is_empty() {
        return Err(ApiError::bad_request("'name' must not be empty"));
    }

    let req: McpServerWriteRequest = serde_json::from_value(body)
        .map_err(|e| ApiError::bad_request(format!("Invalid request body: {e}")))?;

    if req.command.as_ref().and_then(Option::as_ref).is_none()
        && req.url.as_ref().and_then(Option::as_ref).is_none()
    {
        return Err(ApiError::bad_request(
            "Either 'command' or 'url' is required to create an MCP server",
        ));
    }

    if let Some(Some(transport)) = &req.transport {
        crate::mcp::validate_mcp_transport(Some(transport.as_str()))
            .map_err(|e| ApiError::bad_request(e.to_string()))?;
    }

    let mcp_config_path = state.config.read().mcp_config_path();

    // Build the config entry from the request.
    let new_cfg = mcp_server_config_from_write_request(req, None);

    // Persist to the global MCP config.
    {
        let mut cfg = crate::mcp::load_config(&mcp_config_path)
            .map_err(|e| ApiError::internal(format!("Failed to load MCP config: {e}")))?;
        if cfg.servers.contains_key(&name) {
            return Err(ApiError {
                status: StatusCode::CONFLICT,
                message: format!("MCP server '{name}' already exists"),
            });
        }
        cfg.servers.insert(name.clone(), new_cfg.clone());
        crate::mcp::save_config(&mcp_config_path, &cfg)
            .map_err(|e| ApiError::internal(format!("Failed to save MCP config: {e}")))?;
    }

    // Invalidate the in-memory pool so the next tool call reloads from disk.
    {
        let mut pool_slot = state.mcp_pool.lock().await;
        *pool_slot = None;
    }

    Ok((
        StatusCode::CREATED,
        Json(McpServerDetail::from_config(&name, &new_cfg, false)),
    ))
}

/// `PATCH /v1/apps/mcp/servers/{name}` — update an existing server's config.
async fn update_mcp_server(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
    Json(req): Json<McpServerWriteRequest>,
) -> Result<Json<McpServerDetail>, ApiError> {
    if let Some(Some(transport)) = &req.transport {
        crate::mcp::validate_mcp_transport(Some(transport.as_str()))
            .map_err(|e| ApiError::bad_request(e.to_string()))?;
    }

    let mcp_config_path = state.config.read().mcp_config_path();

    let updated_cfg = {
        let mut cfg = crate::mcp::load_config(&mcp_config_path)
            .map_err(|e| ApiError::internal(format!("Failed to load MCP config: {e}")))?;
        let existing = cfg
            .servers
            .get_mut(&name)
            .ok_or_else(|| ApiError::not_found(format!("MCP server '{name}' not found")))?;
        apply_write_request_to_config(req, existing);
        if existing.command.is_none() && existing.url.is_none() {
            return Err(ApiError::bad_request(
                "Either 'command' or 'url' must remain configured for an MCP server",
            ));
        }
        let updated = existing.clone();
        crate::mcp::save_config(&mcp_config_path, &cfg)
            .map_err(|e| ApiError::internal(format!("Failed to save MCP config: {e}")))?;
        updated
    };

    // Invalidate the in-memory pool.
    {
        let mut pool_slot = state.mcp_pool.lock().await;
        *pool_slot = None;
    }

    Ok(Json(McpServerDetail::from_config(
        &name,
        &updated_cfg,
        false,
    )))
}

/// `DELETE /v1/apps/mcp/servers/{name}` — remove a server from the persistent config.
async fn delete_mcp_server(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
) -> Result<Json<McpServerActionReceipt>, ApiError> {
    let mcp_config_path = state.config.read().mcp_config_path();

    crate::mcp::remove_server_config(&mcp_config_path, &name).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("not found") {
            ApiError::not_found(msg)
        } else {
            ApiError::internal(msg)
        }
    })?;

    // Invalidate the in-memory pool.
    {
        let mut pool_slot = state.mcp_pool.lock().await;
        *pool_slot = None;
    }

    Ok(Json(McpServerActionReceipt {
        name,
        action: "deleted",
        ok: true,
    }))
}

/// `POST /v1/apps/mcp/servers/{name}/enable` — enable a configured server.
async fn enable_mcp_server(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
) -> Result<Json<McpServerActionReceipt>, ApiError> {
    let mcp_config_path = state.config.read().mcp_config_path();

    crate::mcp::set_server_enabled(&mcp_config_path, &name, true).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("not found") {
            ApiError::not_found(msg)
        } else {
            ApiError::internal(msg)
        }
    })?;

    // Invalidate the in-memory pool so the enabled server participates next time.
    {
        let mut pool_slot = state.mcp_pool.lock().await;
        *pool_slot = None;
    }

    Ok(Json(McpServerActionReceipt {
        name,
        action: "enabled",
        ok: true,
    }))
}

/// `POST /v1/apps/mcp/servers/{name}/disable` — disable a configured server.
async fn disable_mcp_server(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
) -> Result<Json<McpServerActionReceipt>, ApiError> {
    let mcp_config_path = state.config.read().mcp_config_path();

    crate::mcp::set_server_enabled(&mcp_config_path, &name, false).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("not found") {
            ApiError::not_found(msg)
        } else {
            ApiError::internal(msg)
        }
    })?;

    // Invalidate the in-memory pool so the disabled server is excluded next time.
    {
        let mut pool_slot = state.mcp_pool.lock().await;
        *pool_slot = None;
    }

    Ok(Json(McpServerActionReceipt {
        name,
        action: "disabled",
        ok: true,
    }))
}

/// `POST /v1/apps/mcp/servers/{name}/reconnect` — drop the cached pool entry
/// for this server so it re-initializes on the next call that needs tools.
async fn reconnect_mcp_server(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
) -> Result<Json<McpServerActionReceipt>, ApiError> {
    // Verify the server exists in the config.
    let mcp_config_path = state.config.read().mcp_config_path();
    let plugin_registry = state
        .plugin_discovery
        .registry_for_workspace(&state.workspace);
    let config = crate::mcp::load_config_with_workspace_and_plugins(
        &mcp_config_path,
        &state.workspace,
        plugin_registry.as_ref(),
    )
    .map_err(|e| ApiError::internal(format!("Failed to load MCP config: {e}")))?;

    if !config.servers.contains_key(&name) {
        return Err(ApiError::not_found(format!(
            "MCP server '{name}' not found"
        )));
    }

    // Drop the whole pool so the next connect_all call recreates all
    // connections from the current on-disk config.
    {
        let mut pool_slot = state.mcp_pool.lock().await;
        *pool_slot = None;
    }

    Ok(Json(McpServerActionReceipt {
        name,
        action: "reconnect_scheduled",
        ok: true,
    }))
}

/// `POST /v1/apps/mcp/servers/{name}/stop` — stop one live MCP connection.
async fn stop_mcp_server(
    State(state): State<RuntimeApiState>,
    Path(name): Path<String>,
) -> Result<Json<McpServerActionReceipt>, ApiError> {
    let pool_handle = {
        let pool_slot = state.mcp_pool.lock().await;
        pool_slot.as_ref().cloned()
    };
    if let Some(pool_handle) = pool_handle {
        pool_handle.lock().await.disconnect_server(&name);
    }
    Ok(Json(McpServerActionReceipt {
        name,
        action: "stopped",
        ok: true,
    }))
}

/// `POST /v1/apps/mcp/servers/{name}/tools/{tool}/invoke` — invoke a
/// discovered MCP tool explicitly from the desktop/mobile settings UI.
async fn invoke_mcp_tool(
    State(state): State<RuntimeApiState>,
    Path((name, tool)): Path<(String, String)>,
    Json(request): Json<McpInvokeRequest>,
) -> Result<Json<McpInvokeResponse>, ApiError> {
    let pool_handle = {
        let mut pool_slot = state.mcp_pool.lock().await;
        match pool_slot.as_ref() {
            Some(pool) => Arc::clone(pool),
            None => {
                let mcp_config_path = state.config.read().mcp_config_path();
                let plugin_registry = state
                    .plugin_discovery
                    .registry_for_workspace(&state.workspace);
                let pool = McpPool::from_config_path_with_workspace_and_plugins(
                    &mcp_config_path,
                    &state.workspace,
                    plugin_registry,
                )
                .map_err(|error| {
                    ApiError::internal(format!("Failed to load MCP config: {error}"))
                })?;
                let handle = Arc::new(Mutex::new(pool));
                pool_slot.replace(Arc::clone(&handle));
                handle
            }
        }
    };

    let prefixed_name = McpPool::mcp_model_tool_name(&name, &tool);
    let result = pool_handle
        .lock()
        .await
        .call_tool(&prefixed_name, request.arguments)
        .await;
    match result {
        Ok(value) => {
            let is_error = value
                .get("isError")
                .and_then(Value::as_bool)
                .or_else(|| value.get("is_error").and_then(Value::as_bool))
                .unwrap_or(false);
            let result = serde_json::to_string_pretty(&value)
                .map_err(|error| ApiError::internal(format!("Failed to serialize MCP result: {error}")))?;
            Ok(Json(McpInvokeResponse {
                ok: !is_error,
                message: if is_error {
                    format!("MCP tool {name}/{tool} returned an error")
                } else {
                    format!("MCP tool {name}/{tool} completed")
                },
                result,
                is_error,
            }))
        }
        Err(error) => Ok(Json(McpInvokeResponse {
            ok: false,
            message: error.to_string(),
            result: String::new(),
            is_error: true,
        })),
    }
}

/// Build a fresh [`McpServerConfig`] from a create request.
fn mcp_server_config_from_write_request(
    req: McpServerWriteRequest,
    _existing: Option<&crate::mcp::McpServerConfig>,
) -> crate::mcp::McpServerConfig {
    let enabled = req.enabled.unwrap_or(true);
    crate::mcp::McpServerConfig {
        command: req.command.flatten(),
        args: req.args.unwrap_or_default(),
        cwd: req.cwd.flatten(),
        env: req.env.unwrap_or_default(),
        url: req.url.flatten(),
        transport: req.transport.flatten(),
        connect_timeout: req.connect_timeout.flatten(),
        execute_timeout: req.execute_timeout.flatten(),
        read_timeout: req.read_timeout.flatten(),
        disabled: !enabled,
        enabled,
        required: req.required.unwrap_or(false),
        enabled_tools: req.enabled_tools.unwrap_or_default(),
        disabled_tools: req.disabled_tools.unwrap_or_default(),
        headers: std::collections::HashMap::new(),
        env_headers: req.env_headers.unwrap_or_default(),
        bearer_token_env_var: req.bearer_token_env_var.flatten(),
        scopes: req.scopes.unwrap_or_default(),
        oauth: None,
        oauth_resource: req.oauth_resource.flatten(),
        reviewed_plugin: None,
    }
}

/// Apply a partial update from a PATCH request onto an existing config entry.
fn apply_write_request_to_config(
    req: McpServerWriteRequest,
    cfg: &mut crate::mcp::McpServerConfig,
) {
    if let Some(v) = req.command {
        cfg.command = v;
    }
    if let Some(v) = req.args {
        cfg.args = v;
    }
    if let Some(v) = req.cwd {
        cfg.cwd = v;
    }
    if let Some(v) = req.env {
        cfg.env = v;
    }
    if let Some(v) = req.url {
        cfg.url = v;
    }
    if let Some(v) = req.transport {
        cfg.transport = v;
    }
    if let Some(v) = req.connect_timeout {
        cfg.connect_timeout = v;
    }
    if let Some(v) = req.execute_timeout {
        cfg.execute_timeout = v;
    }
    if let Some(v) = req.read_timeout {
        cfg.read_timeout = v;
    }
    if let Some(v) = req.enabled {
        cfg.enabled = v;
        cfg.disabled = !v;
    }
    if let Some(v) = req.required {
        cfg.required = v;
    }
    if let Some(v) = req.enabled_tools {
        cfg.enabled_tools = v;
    }
    if let Some(v) = req.disabled_tools {
        cfg.disabled_tools = v;
    }
    if let Some(v) = req.env_headers {
        cfg.env_headers = v;
    }
    if let Some(v) = req.bearer_token_env_var {
        cfg.bearer_token_env_var = v;
    }
    if let Some(v) = req.scopes {
        cfg.scopes = v;
    }
    if let Some(v) = req.oauth_resource {
        cfg.oauth_resource = v;
    }
}

async fn list_automations(
    State(state): State<RuntimeApiState>,
) -> Result<Json<Vec<AutomationRecord>>, ApiError> {
    let manager = state.automations.lock().await;
    let automations = manager
        .list_automations()
        .map_err(|e| ApiError::internal(format!("Failed to list automations: {e}")))?;
    Ok(Json(automations))
}

async fn create_automation(
    State(state): State<RuntimeApiState>,
    Json(req): Json<CreateAutomationRequest>,
) -> Result<(StatusCode, Json<AutomationRecord>), ApiError> {
    let manager = state.automations.lock().await;
    let automation = manager
        .create_automation(req)
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    Ok((StatusCode::CREATED, Json(automation)))
}

async fn get_automation(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<AutomationRecord>, ApiError> {
    let manager = state.automations.lock().await;
    let automation = manager.get_automation(&id).map_err(map_automation_err)?;
    Ok(Json(automation))
}

async fn update_automation(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateAutomationRequest>,
) -> Result<Json<AutomationRecord>, ApiError> {
    let manager = state.automations.lock().await;
    let automation = manager
        .update_automation(&id, req)
        .map_err(map_automation_err)?;
    Ok(Json(automation))
}

async fn delete_automation(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<AutomationRecord>, ApiError> {
    let manager = state.automations.lock().await;
    let automation = manager.delete_automation(&id).map_err(map_automation_err)?;
    Ok(Json(automation))
}

async fn run_automation(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<AutomationRunRecord>, ApiError> {
    // run_now_shared drops the manager mutex across the task-manager await so
    // other automation endpoints stay responsive behind a slow enqueue.
    let run =
        crate::automation_manager::run_now_shared(&state.automations, &id, &state.task_manager)
            .await
            .map_err(map_automation_err)?;
    Ok(Json(run))
}

async fn pause_automation(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<AutomationRecord>, ApiError> {
    let manager = state.automations.lock().await;
    let automation = manager.pause_automation(&id).map_err(map_automation_err)?;
    Ok(Json(automation))
}

async fn resume_automation(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<AutomationRecord>, ApiError> {
    let manager = state.automations.lock().await;
    let automation = manager.resume_automation(&id).map_err(map_automation_err)?;
    Ok(Json(automation))
}

async fn list_automation_runs(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Query(query): Query<AutomationRunsQuery>,
) -> Result<Json<Vec<AutomationRunRecord>>, ApiError> {
    let manager = state.automations.lock().await;
    let runs = manager
        .list_runs(&id, query.limit)
        .map_err(map_automation_err)?;
    Ok(Json(runs))
}

async fn get_thread(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<ThreadDetail>, ApiError> {
    let detail = state
        .runtime_threads
        .get_thread_detail(&id)
        .await
        .map_err(map_thread_err)?;
    Ok(Json(detail))
}

async fn update_thread(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateThreadRequest>,
) -> Result<Json<ThreadRecord>, ApiError> {
    let thread = state
        .runtime_threads
        .update_thread(&id, req)
        .await
        .map_err(map_thread_err)?;
    Ok(Json(thread))
}

async fn delete_thread(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state
        .runtime_threads
        .delete_thread(&id)
        .await
        .map_err(map_thread_err)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_thread_event_log(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Query(query): Query<ThreadEventLogQuery>,
) -> Result<Json<ThreadEventLogResponse>, ApiError> {
    // Validate the thread before reading its event file. An empty event file
    // is valid for a new thread, but an unknown id must still be a 404.
    state
        .runtime_threads
        .get_thread_detail(&id)
        .await
        .map_err(map_thread_err)?;

    let raw_events = state
        .runtime_threads
        .events_since_async(&id, None)
        .await
        .map_err(|error| ApiError::internal(format!("Failed to read thread event log: {error}")))?;
    let mut turn_numbers = BTreeMap::<String, u64>::new();
    let mut next_turn = 1u64;
    let mut mapped = Vec::with_capacity(raw_events.len());
    let mut live_size_bytes = 0u64;

    for event in raw_events {
        let (event_type, fields) = session_log_projection(&event.event, &event.payload);
        let turn = match event.turn_id.as_deref() {
            Some(turn_id) => {
                if let Some(number) = turn_numbers.get(turn_id) {
                    *number
                } else {
                    let number = next_turn;
                    next_turn = next_turn.saturating_add(1);
                    turn_numbers.insert(turn_id.to_string(), number);
                    number
                }
            }
            None => 0,
        };
        live_size_bytes = live_size_bytes.saturating_add(
            serde_json::to_vec(&event)
                .map(|bytes| bytes.len() as u64 + 1)
                .unwrap_or_default(),
        );
        mapped.push(ThreadEventLogEntry {
            seq: event.seq,
            event_type,
            ts: event.timestamp.timestamp(),
            turn,
            event: event.event,
            payload: event.payload,
            fields,
        });
    }

    let event_count = mapped.len();
    let current_turn = mapped.iter().map(|event| event.turn).max().unwrap_or(0);
    if let Some(since_seq) = query.since_seq {
        mapped.retain(|event| event.seq > since_seq);
    }
    if let Some(since_turn) = query.since_turn {
        mapped.retain(|event| event.turn == 0 || event.turn > since_turn);
    }
    if let Some(limit) = query.limit {
        let limit = limit.clamp(1, 5000);
        if mapped.len() > limit {
            mapped.drain(..mapped.len() - limit);
        }
    }

    Ok(Json(ThreadEventLogResponse {
        session_id: id.clone(),
        stats: ThreadEventLogStats {
            session_id: id.clone(),
            log_path: format!("events/{id}.jsonl"),
            archive_path: String::new(),
            live_size_bytes,
            archive_size_bytes: 0,
            event_count,
            current_turn,
        },
        events: mapped,
    }))
}

/// Read the SQLite canonical ledger for a thread using a durable per-session
/// cursor. This is the migration-safe replay endpoint for new desktop clients.
async fn get_canonical_ledger(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Query(query): Query<CanonicalLedgerQuery>,
) -> Result<Json<CanonicalLedgerResponse>, ApiError> {
    state
        .runtime_threads
        .get_thread_detail(&id)
        .await
        .map_err(map_thread_err)?;
    let after_seq = query.since_seq.unwrap_or(0);
    let events = state
        .runtime_threads
        .canonical_ledger_events(&id, after_seq, query.limit.unwrap_or(500))
        .await
        .map_err(|error| ApiError::internal(format!("Failed to read canonical ledger: {error}")))?;
    let verification = state
        .runtime_threads
        .verify_canonical_ledger(&id)
        .await
        .map_err(|error| ApiError::internal(format!("Failed to verify canonical ledger: {error}")))?;
    // Events this session holds beyond the window we are about to return. The
    // read returns the oldest events after `after_seq`, so anything past the
    // window sits between the returned events and the verified tail.
    let returned = events.len() as u64;
    let omitted_events = verification
        .event_count
        .saturating_sub(after_seq.min(verification.event_count))
        .saturating_sub(returned);
    Ok(Json(CanonicalLedgerResponse {
        session_id: id,
        after_seq,
        events,
        verification,
        omitted_events,
    }))
}

async fn verify_canonical_ledger(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<hakus_state::LedgerVerification>, ApiError> {
    state
        .runtime_threads
        .get_thread_detail(&id)
        .await
        .map_err(map_thread_err)?;
    let verification = state
        .runtime_threads
        .verify_canonical_ledger(&id)
        .await
        .map_err(|error| ApiError::internal(format!("Failed to verify canonical ledger: {error}")))?;
    Ok(Json(verification))
}

async fn import_legacy_ledger(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(request): Json<LegacyLedgerImportRequest>,
) -> Result<Json<hakus_state::LedgerImportSummary>, ApiError> {
    state
        .runtime_threads
        .get_thread_detail(&id)
        .await
        .map_err(map_thread_err)?;
    if request.source_path.as_os_str().is_empty() {
        return Err(ApiError::bad_request(
            "source_path must not be empty".to_string(),
        ));
    }
    let summary = state
        .runtime_threads
        .import_legacy_ledger(&id, request.source_path)
        .await
        .map_err(|error| ApiError::internal(format!("Failed to import legacy ledger: {error}")))?;
    Ok(Json(summary))
}

/// Discover the legacy Python session stores a migration could import.
///
/// Read-only and side-effect free: the response is the summary a migration
/// surface shows *before* anything is imported. Importing is a separate,
/// explicit action (`/state/import-legacy`), so a person can see what exists and
/// choose, rather than discovering the consequence after the fact.
async fn discover_legacy_sessions(
    State(state): State<RuntimeApiState>,
    Json(request): Json<LegacyDiscoveryRequest>,
) -> Result<Json<hakus_state::LegacyDiscovery>, ApiError> {
    let roots = if request.roots.is_empty() {
        default_legacy_search_roots()
    } else {
        for root in &request.roots {
            if root.as_os_str().is_empty() {
                return Err(ApiError::bad_request(
                    "roots must not contain an empty path".to_string(),
                ));
            }
        }
        request.roots
    };
    let discovery = state
        .runtime_threads
        .discover_legacy_session_stores(roots)
        .await
        .map_err(|error| ApiError::internal(format!("Failed to discover legacy sessions: {error}")))?;
    Ok(Json(discovery))
}

/// Where a previous Python-sidecar install kept its session store.
///
/// The runtime's own home comes first so a portable install finds its own data,
/// then the sidecar's documented default (`~/.hakus`), then the working
/// directory. Duplicates are harmless: discovery canonicalizes and reports each
/// store once.
fn default_legacy_search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(home) = hakus_config::hakus_home() {
        roots.push(home);
    }
    if let Some(user) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let default_home = PathBuf::from(user).join(".hakus");
        if !roots.contains(&default_home) {
            roots.push(default_home);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    roots
}

async fn import_legacy_session_state(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(request): Json<LegacySessionImportRequest>,
) -> Result<Json<hakus_state::LegacySessionImportSummary>, ApiError> {    if request.source_path.as_os_str().is_empty()
        || request.source_session_id.trim().is_empty()
    {
        return Err(ApiError::bad_request(
            "source_path and source_session_id are required".to_string(),
        ));
    }
    let summary = state
        .runtime_threads
        .import_legacy_session_db(
            &id,
            request.source_path,
            &request.source_session_id,
            request.checkpoint_path,
        )
        .await
        .map_err(|error| ApiError::internal(format!("Failed to import legacy session state: {error}")))?;
    Ok(Json(summary))
}

async fn clear_thread_event_log(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state
        .runtime_threads
        .clear_thread_event_log(&id)
        .await
        .map_err(map_thread_err)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize)]
struct ClearThreadMessagesResponse {
    deleted_items: usize,
}

async fn clear_thread_messages(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<ClearThreadMessagesResponse>, ApiError> {
    let deleted_items = state
        .runtime_threads
        .clear_thread_history(&id)
        .await
        .map_err(map_thread_err)?;
    Ok(Json(ClearThreadMessagesResponse { deleted_items }))
}

async fn delete_thread_message(
    State(state): State<RuntimeApiState>,
    Path((id, message_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let deleted = state
        .runtime_threads
        .delete_thread_item(&id, &message_id)
        .await
        .map_err(map_thread_err)?;
    if deleted { Ok(StatusCode::NO_CONTENT) } else { Err(ApiError { status: StatusCode::NOT_FOUND, message: "Message not found".to_string() }) }
}

#[derive(Debug, Deserialize)]
struct RewindThreadRequest {
    message_id: String,
}

#[derive(Debug, Serialize)]
struct RewindThreadResponse {
    deleted_messages: usize,
}

async fn rewind_thread_to_message(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(req): Json<RewindThreadRequest>,
) -> Result<Json<RewindThreadResponse>, ApiError> {
    let deleted_messages = state
        .runtime_threads
        .rewind_thread_to_item(&id, &req.message_id)
        .await
        .map_err(map_thread_err)?;
    Ok(Json(RewindThreadResponse { deleted_messages }))
}

async fn get_character(
    State(state): State<RuntimeApiState>,
) -> Result<Json<RuntimeCharacter>, ApiError> {
    Ok(Json(load_character(&state)?))
}

async fn update_character(
    State(state): State<RuntimeApiState>,
    Json(patch): Json<UpdateCharacterRequest>,
) -> Result<Json<RuntimeCharacter>, ApiError> {
    let mut character = load_character(&state)?;
    if let Some(value) = patch.name {
        character.name = value;
    }
    if let Some(value) = patch.nickname {
        character.nickname = value;
    }
    if let Some(value) = patch.personality {
        character.personality = value;
    }
    if let Some(value) = patch.scenario {
        character.scenario = value;
    }
    if let Some(value) = patch.first_message {
        character.first_message = value;
    }
    if let Some(value) = patch.system_prompt {
        character.system_prompt = value;
    }
    if character.name.trim().is_empty() {
        return Err(ApiError::bad_request("character name must not be empty"));
    }
    save_character(&state, &character)?;
    Ok(Json(character))
}

async fn resume_thread(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<ThreadRecord>, ApiError> {
    let thread = state
        .runtime_threads
        .resume_thread(&id)
        .await
        .map_err(map_thread_err)?;
    Ok(Json(thread))
}

async fn fork_thread(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<ThreadRecord>), ApiError> {
    let thread = state
        .runtime_threads
        .fork_thread(&id)
        .await
        .map_err(map_thread_err)?;
    Ok((StatusCode::CREATED, Json(thread)))
}

#[derive(Debug, Deserialize)]
struct UndoTurnRequest {
    /// How many turns back to undo (default 0 = last turn only).
    #[serde(default)]
    depth: Option<usize>,
}

#[derive(Debug, Serialize)]
struct UndoTurnResponse {
    /// The new forked thread (with the last N turns removed).
    thread: ThreadRecord,
    /// The original user message text from the first dropped turn,
    /// so the GUI can pre-populate the input box.
    original_user_text: Option<String>,
}

async fn undo_thread_turn(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(req): Json<UndoTurnRequest>,
) -> Result<(StatusCode, Json<UndoTurnResponse>), ApiError> {
    let depth = req.depth.unwrap_or(0);
    let (forked_thread, original_user_text) = state
        .runtime_threads
        .fork_at_user_message(&id, depth)
        .await
        .map_err(map_thread_err)?;
    Ok((
        StatusCode::CREATED,
        Json(UndoTurnResponse {
            thread: forked_thread,
            original_user_text,
        }),
    ))
}

/// Result of the snapshot-based file rollback step of patch-undo, reported
/// alongside the new forked thread.
#[derive(Debug, Serialize)]
struct PatchUndoResult {
    /// Whether files were restored from a snapshot.
    files_restored: bool,
    /// Human-readable summary of what was restored (diff stat).
    summary: Option<String>,
    /// The label of the restored snapshot (e.g. "tool:apply_patch" or "pre-turn:3").
    snapshot_label: Option<String>,
}

#[derive(Debug, Serialize)]
struct PatchUndoResponse {
    /// Result of the snapshot-based file rollback step.
    patch_result: PatchUndoResult,
    /// The new forked thread (with the last turn removed).
    thread: ThreadRecord,
    /// The original user text from the removed turn (for re-editing).
    original_user_text: Option<String>,
}

async fn patch_undo_thread_turn(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(req): Json<UndoTurnRequest>,
) -> Result<(StatusCode, Json<PatchUndoResponse>), ApiError> {
    let depth = req.depth.unwrap_or(0);

    // Step 1: Try snapshot-based file rollback (patch_undo).
    let thread = state
        .runtime_threads
        .get_thread(&id)
        .await
        .map_err(map_thread_err)?;
    let patch_result = patch_undo_workspace_files(&thread.workspace, thread.session_id.as_deref());

    // Step 2: Remove the last conversation turn (undo_conversation).
    let (forked_thread, original_user_text) = state
        .runtime_threads
        .fork_at_user_message(&id, depth)
        .await
        .map_err(map_thread_err)?;

    Ok((
        StatusCode::CREATED,
        Json(PatchUndoResponse {
            patch_result,
            thread: forked_thread,
            original_user_text,
        }),
    ))
}

/// Restore the newest `tool:` or `pre-turn:` snapshot that differs from the
/// current workspace — same target selection as the TUI's `patch_undo`.
fn patch_undo_workspace_files(
    workspace: &FsPath,
    current_session_id: Option<&str>,
) -> PatchUndoResult {
    let repo = match crate::snapshot::SnapshotRepo::open_or_init(workspace) {
        Ok(repo) => repo,
        Err(e) => {
            return PatchUndoResult {
                files_restored: false,
                summary: Some(format!("Snapshot repo unavailable: {e}")),
                snapshot_label: None,
            };
        }
    };
    let Some(current_session_id) = current_session_id else {
        return PatchUndoResult {
            files_restored: false,
            summary: Some(
                "No current session is bound to this thread; workspace files were not changed."
                    .to_string(),
            ),
            snapshot_label: None,
        };
    };
    let snapshots = match repo.list(100) {
        Ok(snapshots) => snapshots,
        Err(e) => {
            return PatchUndoResult {
                files_restored: false,
                summary: Some(format!("Failed to list snapshots: {e}")),
                snapshot_label: None,
            };
        }
    };
    let target = snapshots
        .iter()
        .filter(|s| s.label.starts_with("tool:") || s.label.starts_with("pre-turn:"))
        .filter(|s| s.session_id.as_deref() == Some(current_session_id))
        .find(|s| matches!(repo.work_tree_matches_snapshot(&s.id), Ok(false)));
    let Some(target) = target else {
        return PatchUndoResult {
            files_restored: false,
            summary: Some(
                "No current-session tool or pre-turn snapshots differ from the current workspace."
                    .to_string(),
            ),
            snapshot_label: None,
        };
    };
    if let Err(e) = repo.restore(&target.id) {
        return PatchUndoResult {
            files_restored: false,
            summary: Some(format!("Restore failed: {e}")),
            snapshot_label: None,
        };
    }

    // Compute a diff stat for the summary.
    use crate::dependencies::{ExternalTool as _, Git};
    let diff_stat = Git::command().and_then(|mut git| {
        git.args(["diff", "--stat"])
            .current_dir(workspace)
            .output()
            .ok()
            .and_then(|o| {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if s.is_empty() { None } else { Some(s) }
            })
    });

    let short = &target.id.as_str()[..target.id.as_str().len().min(8)];
    let summary = match diff_stat {
        Some(ref stat) => format!(
            "Restored snapshot '{}' ({}). Files affected:\n{stat}",
            target.label, short
        ),
        None => format!(
            "Restored snapshot '{}' ({}). No diff changes detected.",
            target.label, short
        ),
    };
    PatchUndoResult {
        files_restored: true,
        summary: Some(summary),
        snapshot_label: Some(target.label.clone()),
    }
}

#[derive(Debug, Deserialize)]
struct RetryTurnRequest {
    /// How many turns back to retry (default 0 = last turn only).
    #[serde(default)]
    depth: Option<usize>,
    /// Override the user message text. If omitted, the original text
    /// from the dropped turn is re-used.
    #[serde(default)]
    prompt: Option<String>,
}

#[derive(Debug, Serialize)]
struct RetryTurnResponse {
    /// The new forked thread (with the last N turns removed).
    thread: ThreadRecord,
    /// The turn created by the retry.
    turn: TurnRecord,
}

async fn retry_thread_turn(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(req): Json<RetryTurnRequest>,
) -> Result<(StatusCode, Json<RetryTurnResponse>), ApiError> {
    let depth = req.depth.unwrap_or(0);
    let (forked_thread, original_user_text) = state
        .runtime_threads
        .fork_at_user_message(&id, depth)
        .await
        .map_err(map_thread_err)?;

    let retry_prompt = req.prompt.or(original_user_text).unwrap_or_default();
    if retry_prompt.trim().is_empty() {
        return Err(ApiError::bad_request(
            "No user message to retry — the dropped turn had no user text",
        ));
    }

    let turn = state
        .runtime_threads
        .start_turn(
            &forked_thread.id,
            StartTurnRequest {
                prompt: retry_prompt,
                input_summary: None,
                model: None,
                model_provider: None,
                model_provider_id: None,
                mode: None,
                permission_posture: None,
                allow_shell: None,
                trust_mode: None,
                auto_approve: None,
                dynamic_tools: Vec::new(),
                environment_id: None,
                reasoning_effort: None,
            },
        )
        .await
        .map_err(map_thread_err)?;

    Ok((
        StatusCode::CREATED,
        Json(RetryTurnResponse {
            thread: forked_thread,
            turn,
        }),
    ))
}

async fn start_thread_turn(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(req): Json<StartTurnRequest>,
) -> Result<(StatusCode, Json<StartTurnResponse>), ApiError> {
    let turn = state
        .runtime_threads
        .start_turn(&id, req)
        .await
        .map_err(map_thread_err)?;
    let thread = state
        .runtime_threads
        .get_thread(&id)
        .await
        .map_err(map_thread_err)?;
    Ok((
        StatusCode::CREATED,
        Json(StartTurnResponse { thread, turn }),
    ))
}

#[derive(Debug, Serialize)]
struct AgentMailDeliveryResponse {
    envelope: AgentMailEnvelope,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn: Option<TurnRecord>,
}

async fn send_agent_mail(
    State(state): State<RuntimeApiState>,
    Json(request): Json<AgentMailSendRequest>,
) -> Result<(StatusCode, Json<AgentMailSendResponse>), ApiError> {
    let mut response = state
        .runtime_threads
        .queue_agent_mail(request)
        .await
        .map_err(map_agent_mail_err)?;
    if response.envelope.delivery_mode == AgentMailDeliveryMode::WakeAtSafeBoundary
        && response.envelope.trigger_turn
    {
        let (envelope, _) = state
            .runtime_threads
            .deliver_agent_mail(
                &response.envelope.destination.thread_id,
                &response.envelope.message_id,
            )
            .await
            .map_err(map_agent_mail_err)?;
        response.envelope = envelope;
    }
    let status = if response.idempotent_replay {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(response)))
}

async fn list_agent_mail(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<AgentMailEnvelope>>, ApiError> {
    let inbox = state
        .runtime_threads
        .list_agent_mail_for_thread(&id)
        .await
        .map_err(map_agent_mail_err)?;
    Ok(Json(inbox))
}

async fn deliver_agent_mail(
    State(state): State<RuntimeApiState>,
    Path((id, message_id)): Path<(String, String)>,
) -> Result<Json<AgentMailDeliveryResponse>, ApiError> {
    let message_id = AgentMailMessageId::parse(message_id)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let (envelope, turn) = state
        .runtime_threads
        .deliver_agent_mail(&id, &message_id)
        .await
        .map_err(map_agent_mail_err)?;
    Ok(Json(AgentMailDeliveryResponse { envelope, turn }))
}

async fn mark_agent_mail_read(
    State(state): State<RuntimeApiState>,
    Path((id, message_id)): Path<(String, String)>,
) -> Result<Json<AgentMailEnvelope>, ApiError> {
    let message_id = AgentMailMessageId::parse(message_id)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let envelope = state
        .runtime_threads
        .mark_agent_mail_read(&id, &message_id)
        .await
        .map_err(map_agent_mail_err)?;
    Ok(Json(envelope))
}

async fn steer_thread_turn(
    State(state): State<RuntimeApiState>,
    Path((id, turn_id)): Path<(String, String)>,
    Json(req): Json<SteerTurnRequest>,
) -> Result<Json<TurnRecord>, ApiError> {
    let turn = state
        .runtime_threads
        .steer_turn(&id, &turn_id, req)
        .await
        .map_err(map_thread_err)?;
    Ok(Json(turn))
}

async fn interrupt_thread_turn(
    State(state): State<RuntimeApiState>,
    Path((id, turn_id)): Path<(String, String)>,
) -> Result<Json<TurnRecord>, ApiError> {
    let turn = state
        .runtime_threads
        .interrupt_turn(&id, &turn_id)
        .await
        .map_err(map_thread_err)?;
    Ok(Json(turn))
}

async fn deliver_dynamic_tool_result(
    State(state): State<RuntimeApiState>,
    Path((id, turn_id, call_id)): Path<(String, String, String)>,
    Json(result): Json<DynamicToolCallResult>,
) -> Result<StatusCode, ApiError> {
    state
        .runtime_threads
        .get_thread(&id)
        .await
        .map_err(map_thread_err)?;
    if state
        .runtime_threads
        .deliver_dynamic_tool_result(&id, &turn_id, &call_id, result)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
    {
        Ok(StatusCode::ACCEPTED)
    } else {
        Err(ApiError::not_found(format!(
            "No pending dynamic tool call '{call_id}'"
        )))
    }
}

async fn compact_thread(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(req): Json<CompactThreadRequest>,
) -> Result<(StatusCode, Json<StartTurnResponse>), ApiError> {
    let turn = state
        .runtime_threads
        .compact_thread(&id, req)
        .await
        .map_err(map_thread_err)?;
    let thread = state
        .runtime_threads
        .get_thread(&id)
        .await
        .map_err(map_thread_err)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(StartTurnResponse { thread, turn }),
    ))
}

// ---------------------------------------------------------------------------
// Thread goal endpoints
// ---------------------------------------------------------------------------

/// `GET /v1/threads/{id}/goal` — return the persistent goal for a thread, or
/// 404 if the thread has no goal.
async fn get_thread_goal(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<hakus_protocol::ThreadGoal>, ApiError> {
    // Verify the thread exists so we can return a clean 404 for unknown threads.
    state
        .runtime_threads
        .get_thread(&id)
        .await
        .map_err(map_thread_err)?;
    let goal = state
        .runtime_threads
        .get_goal(&id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .ok_or_else(|| ApiError::not_found(format!("thread '{id}' has no goal")))?;
    Ok(Json(goal))
}

#[derive(Debug, Deserialize)]
struct UpsertThreadGoalRequest {
    objective: String,
    #[serde(default)]
    token_budget: Option<i64>,
}

/// `PUT /v1/threads/{id}/goal` — create or replace the persistent goal for a
/// thread. Only `Active` goals may be created through this route; lifecycle
/// transitions (`complete`, `block`) have dedicated action endpoints.
async fn upsert_thread_goal(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(req): Json<UpsertThreadGoalRequest>,
) -> Result<(StatusCode, Json<hakus_protocol::ThreadGoal>), ApiError> {
    if req.objective.trim().is_empty() {
        return Err(ApiError::bad_request("objective must not be blank"));
    }
    // Verify the thread exists.
    state
        .runtime_threads
        .get_thread(&id)
        .await
        .map_err(map_thread_err)?;
    let now = chrono::Utc::now().timestamp();
    let existing = state
        .runtime_threads
        .get_goal(&id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let is_new = existing.is_none();
    let goal = hakus_protocol::ThreadGoal {
        thread_id: id.clone(),
        goal_id: format!("goal-{}", uuid::Uuid::new_v4()),
        objective: req.objective.clone(),
        status: hakus_protocol::ThreadGoalStatus::Active,
        token_budget: req.token_budget,
        tokens_used: 0,
        time_used_seconds: 0,
        continuation_count: 0,
        created_at: now,
        updated_at: now,
    };
    state
        .runtime_threads
        .save_goal(goal.clone())
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    state
        .runtime_threads
        .set_goal_objective(&id, goal.objective.clone(), goal.token_budget)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let status_code = if is_new {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    // Emit a replayable goal-updated event so SSE subscribers can react.
    let _ = state
        .runtime_threads
        .emit_goal_updated_event(&id, goal.clone())
        .await;
    Ok((status_code, Json(goal)))
}

/// `DELETE /v1/threads/{id}/goal` — remove the persistent goal from a thread.
/// Returns 204 No Content on success, 404 if there was no goal.
async fn delete_thread_goal(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state
        .runtime_threads
        .get_thread(&id)
        .await
        .map_err(map_thread_err)?;
    // Clear the live engine first so a queued continuation cannot resurrect
    // an objective that has already been removed from durable storage.
    state
        .runtime_threads
        .set_goal_status(&id, crate::tools::goal::GoalStatus::Active, true)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let deleted = state
        .runtime_threads
        .remove_goal(&id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if !deleted {
        return Err(ApiError::not_found(format!("thread '{id}' has no goal")));
    }
    let _ = state.runtime_threads.emit_goal_cleared_event(&id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /v1/threads/{id}/goal/complete` — transition the goal to `Complete`.
/// Only valid from a non-terminal status; returns 409 Conflict if the goal is
/// already in a terminal state, and 404 if the thread has no goal.
async fn complete_thread_goal(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<hakus_protocol::ThreadGoal>, ApiError> {
    state
        .runtime_threads
        .get_thread(&id)
        .await
        .map_err(map_thread_err)?;
    let goal = state
        .runtime_threads
        .get_goal(&id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .ok_or_else(|| ApiError::not_found(format!("thread '{id}' has no goal")))?;
    if matches!(goal.status, hakus_protocol::ThreadGoalStatus::Complete) {
        return Err(ApiError {
            status: StatusCode::CONFLICT,
            message: format!("goal for thread '{id}' is already complete"),
        });
    }
    let now = chrono::Utc::now().timestamp();
    let updated = hakus_protocol::ThreadGoal {
        status: hakus_protocol::ThreadGoalStatus::Complete,
        updated_at: now,
        ..goal
    };
    state
        .runtime_threads
        .save_goal(updated.clone())
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    state
        .runtime_threads
        .set_goal_status(&id, crate::tools::goal::GoalStatus::Complete, false)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let _ = state
        .runtime_threads
        .emit_goal_updated_event(&id, updated.clone())
        .await;
    Ok(Json(updated))
}

/// `POST /v1/threads/{id}/goal/block` — transition the goal to `Blocked`.
/// Rejects transitions from terminal states (returns 409).
async fn block_thread_goal(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<hakus_protocol::ThreadGoal>, ApiError> {
    state
        .runtime_threads
        .get_thread(&id)
        .await
        .map_err(map_thread_err)?;
    let goal = state
        .runtime_threads
        .get_goal(&id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .ok_or_else(|| ApiError::not_found(format!("thread '{id}' has no goal")))?;
    if matches!(goal.status, hakus_protocol::ThreadGoalStatus::Complete) {
        return Err(ApiError {
            status: StatusCode::CONFLICT,
            message: format!(
                "goal for thread '{id}' is already complete; cannot transition to blocked"
            ),
        });
    }
    let now = chrono::Utc::now().timestamp();
    let updated = hakus_protocol::ThreadGoal {
        status: hakus_protocol::ThreadGoalStatus::Blocked,
        updated_at: now,
        ..goal
    };
    state
        .runtime_threads
        .save_goal(updated.clone())
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    state
        .runtime_threads
        .set_goal_status(&id, crate::tools::goal::GoalStatus::Blocked, false)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let _ = state
        .runtime_threads
        .emit_goal_updated_event(&id, updated.clone())
        .await;
    Ok(Json(updated))
}

/// `POST /v1/threads/{id}/goal/pause` — pause an active goal without
/// discarding its objective or progress.
async fn pause_thread_goal(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<hakus_protocol::ThreadGoal>, ApiError> {
    let goal = state
        .runtime_threads
        .get_goal(&id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .ok_or_else(|| ApiError::not_found(format!("thread '{id}' has no goal")))?;
    if matches!(goal.status, hakus_protocol::ThreadGoalStatus::Complete) {
        return Err(ApiError { status: StatusCode::CONFLICT, message: format!("goal for thread '{id}' is already complete") });
    }
    let updated = hakus_protocol::ThreadGoal { status: hakus_protocol::ThreadGoalStatus::Paused, updated_at: chrono::Utc::now().timestamp(), ..goal };
    state.runtime_threads.save_goal(updated.clone()).await.map_err(|e| ApiError::internal(e.to_string()))?;
    state.runtime_threads.set_goal_status(&id, crate::tools::goal::GoalStatus::Paused, false).await.map_err(|e| ApiError::internal(e.to_string()))?;
    let _ = state.runtime_threads.emit_goal_updated_event(&id, updated.clone()).await;
    Ok(Json(updated))
}

/// `POST /v1/threads/{id}/goal/resume` — resume a paused or blocked goal.
async fn resume_thread_goal(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<hakus_protocol::ThreadGoal>, ApiError> {
    let goal = state
        .runtime_threads
        .get_goal(&id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .ok_or_else(|| ApiError::not_found(format!("thread '{id}' has no goal")))?;
    if matches!(goal.status, hakus_protocol::ThreadGoalStatus::Complete) {
        return Err(ApiError { status: StatusCode::CONFLICT, message: format!("goal for thread '{id}' is already complete") });
    }
    let updated = hakus_protocol::ThreadGoal { status: hakus_protocol::ThreadGoalStatus::Active, updated_at: chrono::Utc::now().timestamp(), ..goal };
    state.runtime_threads.save_goal(updated.clone()).await.map_err(|e| ApiError::internal(e.to_string()))?;
    state.runtime_threads.set_goal_status(&id, crate::tools::goal::GoalStatus::Active, false).await.map_err(|e| ApiError::internal(e.to_string()))?;
    let _ = state.runtime_threads.emit_goal_updated_event(&id, updated.clone()).await;
    Ok(Json(updated))
}

/// Runtime-authenticated administrative task inventory.
///
/// Unlike in-session TUI/model controls, the Runtime API token authorizes the
/// caller for the whole host runtime, so these endpoints intentionally span
/// sessions. Running with `--insecure` explicitly opts out of that host boundary.
async fn list_tasks(
    State(state): State<RuntimeApiState>,
    Query(query): Query<TasksQuery>,
) -> Result<Json<TasksResponse>, ApiError> {
    let tasks = match query.workspace.as_deref() {
        Some(workspace) => {
            state
                .task_manager
                .list_tasks_scoped(query.limit, Some(workspace))
                .await
        }
        None => state.task_manager.list_tasks(query.limit).await,
    };
    let counts = state.task_manager.counts().await;
    Ok(Json(TasksResponse { tasks, counts }))
}

/// Runtime-authenticated administrative task lookup across host sessions.
async fn get_task(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<TaskRecord>, ApiError> {
    let task = state
        .task_manager
        .get_task(&id)
        .await
        .map_err(map_task_err)?;
    Ok(Json(task))
}

/// Runtime-authenticated administrative task cancellation across host sessions.
async fn cancel_task(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<TaskRecord>, ApiError> {
    let cancellation = state
        .task_manager
        .cancel_task(&id)
        .await
        .map_err(map_task_err)?;
    Ok(Json(cancellation.task))
}

async fn stream_thread_events(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Query(query): Query<ThreadEventsQuery>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let _ = state
        .runtime_threads
        .get_thread(&id)
        .await
        .map_err(map_thread_err)?;

    // Subscribe before reading durable history. An event emitted while replay
    // is loaded is then present in both places (and deduped below) or queued
    // live, never in an uncovered handoff window.
    let live = state.runtime_threads.subscribe_events();
    // The canonical SQLite ledger is the read authority. JSONL stays served for
    // a client that explicitly asks for it during the migration window, but a
    // request that does not name a source now reads the ledger.
    let legacy_source = query.source.as_deref() == Some("jsonl");
    if legacy_source
        && query
            .replay_limit
            .is_some_and(|limit| limit > MAX_RUNTIME_EVENT_REPLAY_TAIL)
    {
        // This bound caps how much of the legacy event *file* a replay reads, so
        // it applies only to the source that reads that file. The ledger bounds
        // its own window (`CANONICAL_REPLAY_LIMIT`) and is not file-bound.
        return Err(ApiError::bad_request(format!(
            "replay_limit cannot exceed {MAX_RUNTIME_EVENT_REPLAY_TAIL}"
        )));
    }
    let replay = if legacy_source {
        state
            .runtime_threads
            .replay_events(&id, query.since_seq, query.replay_limit)
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?
    } else {
        state
            .runtime_threads
            .replay_canonical_events(&id, query.since_seq, query.replay_limit)
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?
    };

    let stream = replay_live_thread_events(
        state.runtime_threads.clone(),
        id,
        replay.base_seq,
        replay.batches,
        live,
    );

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
}

fn replay_live_thread_events(
    runtime_threads: SharedRuntimeThreadManager,
    thread_id: String,
    mut last_seq: u64,
    mut backlog: tokio::sync::mpsc::Receiver<
        std::result::Result<Vec<crate::runtime_threads::RuntimeEventRecord>, String>,
    >,
    mut live: tokio::sync::broadcast::Receiver<crate::runtime_threads::RuntimeEventRecord>,
) -> impl futures_util::Stream<Item = Result<SseEvent, Infallible>> {
    stream! {
        while let Some(batch) = backlog.recv().await {
            let events = match batch {
                Ok(events) => events,
                Err(error) => {
                    tracing::warn!(
                        thread_id = %thread_id,
                        last_seq,
                        %error,
                        "Failed to replay Runtime web event stream from durable history"
                    );
                    return;
                }
            };
            for event in events {
                if event.thread_id != thread_id || event.seq <= last_seq {
                    continue;
                }
                let previous_seq = last_seq;
                last_seq = event.seq;
                let event_name = event.event.clone();
                yield Ok(sse_json(
                    &event_name,
                    runtime_event_payload_with_previous(event, previous_seq),
                ));
            }
        }

        'live: loop {
            match live.recv().await {
                Ok(event) => {
                    if event.thread_id != thread_id || event.seq <= last_seq {
                        continue;
                    }
                    let previous_seq = last_seq;
                    last_seq = event.seq;
                    let event_name = event.event.clone();
                    yield Ok(sse_json(
                        &event_name,
                        runtime_event_payload_with_previous(event, previous_seq),
                    ));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    // Broadcast is only a wake-up path; durable history remains
                    // authoritative. Catch up from the last delivered cursor so
                    // receiver pressure cannot turn into a silent prompt loss.
                    let mut recovered = match runtime_threads
                        .replay_events(&thread_id, Some(last_seq), None)
                        .await
                    {
                        Ok(replay) => replay.batches,
                        Err(error) => {
                            tracing::warn!(
                                thread_id = %thread_id,
                                last_seq,
                                skipped,
                                %error,
                                "Failed to recover lagged Runtime web event stream from durable history"
                            );
                            break 'live;
                        }
                    };
                    while let Some(batch) = recovered.recv().await {
                        let events = match batch {
                            Ok(events) => events,
                            Err(error) => {
                                tracing::warn!(
                                    thread_id = %thread_id,
                                    last_seq,
                                    skipped,
                                    %error,
                                    "Failed to recover lagged Runtime web event stream from durable history"
                                );
                                break 'live;
                            }
                        };
                        for event in events {
                            if event.thread_id != thread_id || event.seq <= last_seq {
                                continue;
                            }
                            let previous_seq = last_seq;
                            last_seq = event.seq;
                            let event_name = event.event.clone();
                            yield Ok(sse_json(
                                &event_name,
                                runtime_event_payload_with_previous(event, previous_seq),
                            ));
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    }
}

async fn stream_turn(
    State(state): State<RuntimeApiState>,
    Json(req): Json<StreamTurnRequest>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    if req.prompt.trim().is_empty() {
        return Err(ApiError::bad_request("prompt is required"));
    }

    let model = req.model.clone().unwrap_or_else(|| {
        state
            .config
            .read()
            .default_text_model
            .clone()
            .unwrap_or_else(|| DEFAULT_TEXT_MODEL.to_string())
    });
    let workspace = req
        .workspace
        .clone()
        .unwrap_or_else(|| state.workspace.clone());
    let mode = req.mode.clone().unwrap_or_else(|| "agent".to_string());
    let permission_posture = req.permission_posture.clone();
    let allow_shell = req.allow_shell.unwrap_or(state.config.read().allow_shell());
    let trust_mode = req.trust_mode.unwrap_or(false);
    let auto_approve = req.auto_approve.unwrap_or(false);
    let prompt = req.prompt;
    let system_prompt = character_system_prompt(
        &load_character(&state)
            .map_err(|error| ApiError::internal(format!("Failed to load character: {error:?}")))?,
    );

    let thread = state
        .runtime_threads
        .create_thread(CreateThreadRequest {
            model: Some(model.clone()),
            workspace: Some(workspace.clone()),
            mode: Some(mode.clone()),
            permission_posture: permission_posture.clone(),
            allow_shell: Some(allow_shell),
            trust_mode: Some(trust_mode),
            auto_approve: Some(auto_approve),
            archived: true,
            system_prompt,
            task_id: None,
            ..Default::default()
        })
        .await
        .map_err(|e| ApiError::internal(format!("Failed to create stream thread: {e}")))?;

    #[cfg(test)]
    if let Some(hook) = &state.compat_stream_test_hook {
        let (resume, wait_for_resume) = tokio::sync::oneshot::channel();
        hook.send(CompatStreamTestPoint::ThreadCreated {
            thread_id: thread.id.clone(),
            resume,
        })
        .map_err(|_| ApiError::internal("Compatibility stream test hook closed"))?;
        wait_for_resume
            .await
            .map_err(|_| ApiError::internal("Compatibility stream test hook dropped resume"))?;
    }

    let turn = state
        .runtime_threads
        .start_turn(
            &thread.id,
            StartTurnRequest {
                prompt,
                input_summary: None,
                model: Some(model.clone()),
                mode: Some(mode.clone()),
                permission_posture,
                allow_shell: Some(allow_shell),
                trust_mode: Some(trust_mode),
                auto_approve: Some(auto_approve),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| ApiError::internal(format!("Failed to start stream turn: {e}")))?;

    // Subscribe before reading the durable replay. Events produced while the
    // replay is loaded then exist in at least one source, and the sequence
    // cursor below removes overlap without dropping the handoff edge.
    let mut live = state.runtime_threads.subscribe_events();
    let thread_id = thread.id.clone();
    let turn_id = turn.id.clone();

    #[cfg(test)]
    if let Some(hook) = &state.compat_stream_test_hook {
        let (resume, wait_for_resume) = tokio::sync::oneshot::channel();
        hook.send(CompatStreamTestPoint::SubscribedBeforeReplay {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            resume,
        })
        .map_err(|_| ApiError::internal("Compatibility stream test hook closed"))?;
        wait_for_resume
            .await
            .map_err(|_| ApiError::internal("Compatibility stream test hook dropped resume"))?;
    }

    let mut backlog = state
        .runtime_threads
        .replay_events(&thread.id, None, None)
        .await
        .map_err(|e| ApiError::internal(format!("Failed to load stream backlog: {e}")))?;

    #[cfg(test)]
    if let Some(hook) = &state.compat_stream_test_hook {
        let (resume, wait_for_resume) = tokio::sync::oneshot::channel();
        hook.send(CompatStreamTestPoint::ReplayLoaded {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            resume,
        })
        .map_err(|_| ApiError::internal("Compatibility stream test hook closed"))?;
        wait_for_resume
            .await
            .map_err(|_| ApiError::internal("Compatibility stream test hook dropped resume"))?;
    }

    let stream = stream! {
        let mut last_seq = 0;
        yield Ok(sse_json("turn.started", json!({
            "thread_id": thread.id,
            "turn_id": turn.id,
            "model": model,
            "mode": mode,
            "workspace": workspace,
        })));

        while let Some(batch) = backlog.batches.recv().await {
            let events = match batch {
                Ok(events) => events,
                Err(error) => {
                    tracing::warn!(
                        thread_id = %thread_id,
                        turn_id = %turn_id,
                        %error,
                        "Failed to replay compatibility stream from durable history"
                    );
                    yield Ok(sse_json("error", json!({
                        "message": "failed to replay durable event stream",
                    })));
                    return;
                }
            };
            for event in events {
                let Some((mapped, terminal)) = take_compat_turn_event(
                    &event,
                    &thread_id,
                    &turn_id,
                    &mut last_seq,
                ) else {
                    continue;
                };
                if let Some(mapped) = mapped {
                    yield Ok(mapped);
                }
                if terminal {
                    yield Ok(sse_json("done", json!({})));
                    return;
                }
            }
        }

        loop {
            match live.recv().await {
                Ok(event) => {
                    let Some((mapped, terminal)) = take_compat_turn_event(
                        &event,
                        &thread_id,
                        &turn_id,
                        &mut last_seq,
                    ) else {
                        continue;
                    };
                    if let Some(mapped) = mapped {
                        yield Ok(mapped);
                    }
                    if terminal {
                        yield Ok(sse_json("done", json!({})));
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    let mut recovered = match state.runtime_threads
                        .replay_events(&thread_id, Some(last_seq), None)
                        .await
                    {
                        Ok(replay) => replay.batches,
                        Err(error) => {
                            tracing::warn!(
                                thread_id = %thread_id,
                                turn_id = %turn_id,
                                last_seq,
                                skipped,
                                %error,
                                "Failed to recover lagged compatibility stream from durable history"
                            );
                            yield Ok(sse_json("error", json!({
                                "message": "failed to recover lagged event stream",
                            })));
                            return;
                        }
                    };
                    while let Some(batch) = recovered.recv().await {
                        let events = match batch {
                            Ok(events) => events,
                            Err(error) => {
                                tracing::warn!(
                                    thread_id = %thread_id,
                                    turn_id = %turn_id,
                                    last_seq,
                                    skipped,
                                    %error,
                                    "Failed to recover lagged compatibility stream from durable history"
                                );
                                yield Ok(sse_json("error", json!({
                                    "message": "failed to recover lagged event stream",
                                })));
                                return;
                            }
                        };
                        for event in events {
                            let Some((mapped, terminal)) = take_compat_turn_event(
                                &event,
                                &thread_id,
                                &turn_id,
                                &mut last_seq,
                            ) else {
                                continue;
                            };
                            if let Some(mapped) = mapped {
                                yield Ok(mapped);
                            }
                            if terminal {
                                yield Ok(sse_json("done", json!({})));
                                return;
                            }
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    yield Ok(sse_json("error", json!({ "message": "event channel closed" })));
                    return;
                }
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
}

fn take_compat_turn_event(
    event: &crate::runtime_threads::RuntimeEventRecord,
    thread_id: &str,
    turn_id: &str,
    last_seq: &mut u64,
) -> Option<(Option<SseEvent>, bool)> {
    if event.thread_id != thread_id
        || event.turn_id.as_deref() != Some(turn_id)
        || event.seq <= *last_seq
    {
        return None;
    }
    *last_seq = event.seq;
    Some((
        map_compat_stream_event(event),
        event.event == "turn.completed",
    ))
}

fn runtime_event_payload(event: crate::runtime_threads::RuntimeEventRecord) -> serde_json::Value {
    let event_name = event.event.clone();
    let timestamp = event.timestamp.to_rfc3339();
    let schema_version = RUNTIME_EVENT_ENVELOPE_SCHEMA_VERSION;
    let envelope = RuntimeEventEnvelope {
        schema_version,
        seq: event.seq,
        event: event_name.clone(),
        kind: event_name,
        thread_id: event.thread_id,
        turn_id: event.turn_id,
        item_id: event.item_id,
        timestamp: timestamp.clone(),
        created_at: Some(timestamp),
        payload: event.payload,
        extra: Default::default(),
    };
    serde_json::to_value(envelope).expect("serialize runtime event envelope")
}

fn runtime_event_payload_with_previous(
    event: crate::runtime_threads::RuntimeEventRecord,
    previous_seq: u64,
) -> serde_json::Value {
    let mut payload = runtime_event_payload(event);
    if let Some(object) = payload.as_object_mut() {
        object.insert("previous_seq".to_string(), json!(previous_seq));
    }
    payload
}

fn map_compat_stream_event(event: &crate::runtime_threads::RuntimeEventRecord) -> Option<SseEvent> {
    let payload = &event.payload;
    match event.event.as_str() {
        "item.delta" => {
            let kind = payload
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if kind == "agent_message" {
                let content = payload
                    .get("delta")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                Some(sse_json("message.delta", json!({ "content": content })))
            } else if kind == "tool_call" {
                let output = payload
                    .get("delta")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                Some(sse_json("tool.progress", json!({ "output": output })))
            } else {
                None
            }
        }
        "item.started" => {
            let tool = payload.get("tool")?;
            let id = tool.get("id").cloned().unwrap_or(Value::Null);
            let name = tool.get("name").cloned().unwrap_or(Value::Null);
            let input = tool.get("input").cloned().unwrap_or(Value::Null);
            Some(sse_json(
                "tool.started",
                json!({
                    "id": id,
                    "name": name,
                    "input": input,
                }),
            ))
        }
        "item.completed" | "item.failed" => {
            let item = payload.get("item")?;
            let kind = item
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if kind == "tool_call" || kind == "file_change" || kind == "command_execution" {
                let id = item.get("id").cloned().unwrap_or(Value::Null);
                let success = event.event == "item.completed";
                let output = item.get("detail").cloned().unwrap_or_else(|| {
                    Value::String(
                        item.get("summary")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                    )
                });
                Some(sse_json(
                    "tool.completed",
                    json!({
                        "id": id,
                        "success": success,
                        "output": output,
                    }),
                ))
            } else if kind == "status" {
                let message = item
                    .get("detail")
                    .and_then(|v| v.as_str())
                    .or_else(|| item.get("summary").and_then(|v| v.as_str()))
                    .unwrap_or_default();
                Some(sse_json("status", json!({ "message": message })))
            } else if kind == "error" {
                let message = item
                    .get("detail")
                    .and_then(|v| v.as_str())
                    .or_else(|| item.get("summary").and_then(|v| v.as_str()))
                    .unwrap_or_default();
                Some(sse_json("error", json!({ "message": message })))
            } else {
                None
            }
        }
        "approval.required" => {
            let approval_id = payload
                .get("approval_id")
                .or_else(|| payload.get("id"))?
                .clone();
            Some(sse_json(
                "approval.required",
                json!({
                    "id": approval_id,
                    "approval_id": approval_id,
                    "thread_id": event.thread_id,
                    "turn_id": event.turn_id,
                    "tool_name": payload.get("tool_name"),
                    "description": payload.get("description"),
                    "intent_summary": payload.get("intent_summary"),
                }),
            ))
        }
        "approval.decided" => {
            let approval_id = payload
                .get("approval_id")
                .or_else(|| payload.get("id"))?
                .clone();
            Some(sse_json(
                "approval.decided",
                json!({
                    "id": approval_id,
                    "approval_id": approval_id,
                    "thread_id": event.thread_id,
                    "turn_id": event.turn_id,
                    "decision": payload.get("decision"),
                    "remember": payload.get("remember"),
                    "auto": payload.get("auto"),
                    "timeout": payload.get("timeout"),
                }),
            ))
        }
        "approval.timeout" => {
            let approval_id = payload
                .get("approval_id")
                .or_else(|| payload.get("id"))?
                .clone();
            Some(sse_json(
                "approval.timeout",
                json!({
                    "id": approval_id,
                    "approval_id": approval_id,
                    "thread_id": event.thread_id,
                    "turn_id": event.turn_id,
                    "timeout_secs": payload.get("timeout_secs"),
                }),
            ))
        }
        "user_input.required" => {
            let input_id = payload
                .get("input_id")
                .or_else(|| payload.get("id"))?
                .clone();
            let request = payload.get("request")?.clone();
            Some(sse_json(
                "user_input.required",
                json!({
                    "id": input_id,
                    "input_id": input_id,
                    "thread_id": event.thread_id,
                    "turn_id": event.turn_id,
                    "status": "required",
                    "request": request,
                }),
            ))
        }
        "user_input.answered" | "user_input.canceled" => {
            let input_id = payload
                .get("input_id")
                .or_else(|| payload.get("id"))?
                .clone();
            let status = if event.event == "user_input.answered" {
                "submitted"
            } else {
                "canceled"
            };
            Some(sse_json(
                &event.event,
                json!({
                    "id": input_id,
                    "input_id": input_id,
                    "thread_id": event.thread_id,
                    "turn_id": event.turn_id,
                    "status": status,
                    "terminal": payload.get("terminal").and_then(Value::as_bool).unwrap_or(false),
                }),
            ))
        }
        "sandbox.denied" => Some(sse_json("sandbox.denied", payload.clone())),
        "turn.completed" => {
            let usage = payload
                .get("turn")
                .and_then(|turn| turn.get("usage"))
                .cloned()
                .unwrap_or(json!(null));
            Some(sse_json("turn.completed", json!({ "usage": usage })))
        }
        _ => None,
    }
}

fn sse_json(event: &str, payload: serde_json::Value) -> SseEvent {
    let data = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
    SseEvent::default().event(event).data(data)
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    let char_count = text.chars().count();
    if char_count <= max_chars {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_chars.saturating_sub(3)).collect();
    format!("{truncated}...")
}

fn resolve_skills_dir(config: &Config, workspace: &std::path::Path) -> PathBuf {
    if config.skills_config().scan_hakus_only() {
        if config.skills_dir.is_some() {
            return config.skills_dir();
        }
        if let Some(hakus_skills_dir) = crate::skills::hakus_workspace_skills_dir(workspace)
            && let Ok(canonical_skills) = fs::canonicalize(&hakus_skills_dir)
        {
            return canonical_skills;
        }
        return config.skills_dir();
    }

    // Canonicalize the workspace once so the symlink-containment check below
    // compares like-for-like. If the workspace can't be canonicalized at all
    // (e.g. it doesn't exist on disk yet) fall back to the configured global
    // skills dir rather than risk constructing paths from a non-existent root.
    let canonical_workspace = match fs::canonicalize(workspace) {
        Ok(path) => path,
        Err(_) => return config.skills_dir(),
    };
    for candidate in [
        canonical_workspace.join(".agents").join("skills"),
        canonical_workspace.join("skills"),
    ] {
        // Re-canonicalize the candidate so a `.agents/skills` symlink to e.g.
        // `/etc` cannot promote arbitrary filesystem locations into the
        // skills directory. The candidate must still resolve under the
        // canonicalized workspace root after symlink expansion.
        if let Ok(canon) = fs::canonicalize(&candidate)
            && canon.starts_with(&canonical_workspace)
            && canon.is_dir()
        {
            return canon;
        }
    }
    config.skills_dir()
}

fn skills_search_directories(
    workspace: &FsPath,
    skills_dir: &FsPath,
    mode: crate::skills::SkillDiscoveryMode,
) -> Vec<PathBuf> {
    crate::skills::skill_directories_for_workspace_and_dir(workspace, skills_dir, mode)
}

fn discover_skills_for_runtime_api(
    workspace: &FsPath,
    skills_dir: &FsPath,
    mode: crate::skills::SkillDiscoveryMode,
    plugins: Option<&crate::plugins::PluginRegistry>,
) -> (crate::skills::SkillRegistry, Vec<PathBuf>) {
    let directories = skills_search_directories(workspace, skills_dir, mode);
    let registry =
        crate::skills::discover_from_directories_with_plugins(directories.clone(), plugins);
    (registry, directories)
}

fn skill_entry_is_bundled(skill: &crate::skills::Skill, skills_dir: &FsPath) -> bool {
    if !crate::skills::is_bundled_skill_name(&skill.name) {
        return false;
    }

    let expected_path = skills_dir.join(&skill.name).join("SKILL.md");
    paths_refer_to_same_file(&skill.path, &expected_path)
}

fn paths_refer_to_same_file(left: &FsPath, right: &FsPath) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn format_skill_search_paths(directories: &[PathBuf]) -> String {
    if directories.is_empty() {
        return "<none>".to_string();
    }
    directories
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

#[derive(Debug, Deserialize)]
struct UsageQuery {
    /// ISO-8601 lower bound (inclusive). When omitted, no lower bound.
    since: Option<String>,
    /// ISO-8601 upper bound (inclusive). When omitted, no upper bound.
    until: Option<String>,
    /// Bucket key. One of `day` (default), `model`, `provider`, `thread`.
    group_by: Option<String>,
}

fn parse_iso8601(raw: &str, field: &str) -> Result<chrono::DateTime<Utc>, ApiError> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|e| ApiError::bad_request(format!("Invalid {field} (expected RFC 3339): {e}")))
}

async fn get_usage(
    State(state): State<RuntimeApiState>,
    Query(query): Query<UsageQuery>,
) -> Result<Json<Value>, ApiError> {
    let since = match query.since.as_deref() {
        Some(raw) => Some(parse_iso8601(raw, "since")?),
        None => None,
    };
    let until = match query.until.as_deref() {
        Some(raw) => Some(parse_iso8601(raw, "until")?),
        None => None,
    };
    if let (Some(s), Some(u)) = (since, until)
        && s > u
    {
        return Err(ApiError::bad_request("since must be <= until".to_string()));
    }
    let group_by = match query.group_by.as_deref().unwrap_or("day") {
        "day" => UsageGroupBy::Day,
        "model" => UsageGroupBy::Model,
        "provider" => UsageGroupBy::Provider,
        "thread" => UsageGroupBy::Thread,
        other => {
            return Err(ApiError::bad_request(format!(
                "Unsupported group_by '{other}': expected one of day, model, provider, thread"
            )));
        }
    };

    let aggregation = state
        .runtime_threads
        .aggregate_usage(since, until, group_by)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(Json(json!(aggregation)))
}

#[derive(Debug, Deserialize)]
struct SnapshotsQuery {
    /// Maximum number of snapshots to return. Mirrors `/restore list [N]`.
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
struct SnapshotEntry {
    id: String,
    label: String,
    timestamp: i64,
}

async fn list_snapshots(
    State(state): State<RuntimeApiState>,
    Query(query): Query<SnapshotsQuery>,
) -> Result<Json<Vec<SnapshotEntry>>, ApiError> {
    Ok(Json(snapshot_entries_for_workspace(
        &state.workspace,
        query,
    )?))
}

async fn restore_snapshot(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    restore_snapshot_for_workspace(&state.workspace, &id)?;
    Ok(Json(json!({
        "restored": id,
    })))
}

fn restore_snapshot_for_workspace(workspace: &FsPath, id: &str) -> Result<(), ApiError> {
    let repo = crate::snapshot::SnapshotRepo::open_or_init(workspace)
        .map_err(|e| ApiError::internal(format!("Snapshot repo init failed: {e}")))?;
    let snapshot_id = crate::snapshot::SnapshotId(id.to_string());
    repo.restore(&snapshot_id)
        .map_err(|e| ApiError::internal(format!("Snapshot restore failed: {e}")))
}

fn snapshot_entries_for_workspace(
    workspace: &FsPath,
    query: SnapshotsQuery,
) -> Result<Vec<SnapshotEntry>, ApiError> {
    const DEFAULT_LIMIT: usize = 20;
    const MAX_LIMIT: usize = 100;

    let limit = match query.limit.unwrap_or(DEFAULT_LIMIT) {
        1..=MAX_LIMIT => query.limit.unwrap_or(DEFAULT_LIMIT),
        other => {
            return Err(ApiError::bad_request(format!(
                "limit must be between 1 and {MAX_LIMIT}; got {other}",
            )));
        }
    };
    let repo = crate::snapshot::SnapshotRepo::open_or_init(workspace)
        .map_err(|e| ApiError::internal(format!("Snapshot repo unavailable: {e}")))?;
    let snapshots = repo
        .list(limit)
        .map_err(|e| ApiError::internal(format!("Failed to list snapshots: {e}")))?;
    Ok(snapshots
        .into_iter()
        .map(|snapshot| SnapshotEntry {
            id: snapshot.id.as_str().to_string(),
            label: snapshot.label,
            timestamp: snapshot.timestamp,
        })
        .collect())
}

// ── Provider / Model catalog endpoints ──

/// Entry in `GET /v1/providers`.
///
/// Exposes the static provider registry so the GUI can render a dynamic
/// provider picker instead of hard-coding `deepseek` only. The `id` matches
/// `ApiProvider::as_str()` and is the value the GUI should send back via
/// `POST /v1/config { key: "provider", value: <id> }`.
#[derive(Debug, Clone, Serialize)]
struct ProviderEntry {
    /// Stable identifier — matches `ApiProvider::as_str()` and the TOML
    /// `provider = "<id>"` key. Use this as the canonical value when
    /// persisting or comparing.
    id: String,
    /// Human-friendly name for picker UIs (e.g. "DeepSeek", "OpenAI").
    display_name: String,
    /// Default base URL for this provider ( informational; the live base URL
    /// may be overridden in config.toml).
    default_base_url: String,
    /// Default model id for this provider, if any. Empty for pass-through
    /// providers (Ollama / Custom) that expose no built-in catalog.
    default_model: String,
    /// Whether this provider exposes a built-in model list. When false, the
    /// GUI should render a free-text input instead of calling
    /// `/v1/providers/{id}/models`.
    has_model_catalog: bool,
    /// API key environment variable candidates, e.g. `["DEEPSEEK_API_KEY"]`.
    /// The GUI may surface these in a tooltip when auth is missing.
    env_vars: Vec<String>,
    /// Current effective model for this route.
    model: String,
    /// Current effective endpoint for this route.
    base_url: String,
    /// Whether a usable credential (or an explicitly keyless route) exists.
    has_api_key: bool,
    /// Redacted credential, never the secret itself.
    masked_api_key: String,
    /// Whether this route owns a custom header map.
    has_custom_headers: bool,
    /// UI grouping derived from the shared provider registry.
    group: String,
    /// True when this entry is a user-managed named route.
    is_custom: bool,
    /// Effective auth mode, such as `api_key`, `oauth`, or `none`.
    auth_mode: String,
    /// Explicit API dialect selected for this route, when configured.
    wire: Option<String>,
    /// User-supplied context-window size for this route, when configured.
    /// The model catalog does not cover custom/aggregator routes, so this is
    /// what lets the UI show context usage instead of "unknown".
    context_window: Option<u32>,
    supports_connection_test: bool,
    supports_live_models: bool,
    supports_headers: bool,
    supports_multi_key: bool,
    /// Whether this route is enabled in the desktop/mobile model picker.
    enabled: bool,
    /// User-curated and catalog model ids available for this route.
    models: Vec<String>,
    /// Only the models explicitly curated by the user (without catalog rows).
    configured_models: Vec<String>,
    /// Optional user-facing description for named custom routes.
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ProvidersResponse {
    /// Currently active provider id (matches `GET /v1/config`'s `provider`).
    current: String,
    providers: Vec<ProviderEntry>,
}

/// Entry in `GET /v1/providers/{id}/models`.
#[derive(Debug, Clone, Serialize)]
struct ProviderModelEntry {
    /// Canonical model id (suitable for `default_text_model` or
    /// `POST /v1/threads/{id}` `model` field).
    id: String,
    /// Provider/model-specific reasoning controls from the shared catalog.
    /// Empty means the route has no authoritative effort ladder.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    reasoning_options: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    supports_reasoning: Option<bool>,
    /// Total context window in tokens, when the catalog declares one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_window: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
struct ProviderModelsResponse {
    provider: String,
    models: Vec<ProviderModelEntry>,
    source: String,
}

#[derive(Debug, Deserialize, Default)]
struct ProviderUpdateRequest {
    #[serde(default)]
    model_name: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    set_as_default: bool,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    models: Option<Vec<String>>,
    #[serde(default)]
    wire: Option<String>,
    /// Context-window size in tokens for this route.
    ///
    /// Custom and aggregator routes are absent from the built-in model
    /// catalog, so the UI has no way to show context usage for them unless the
    /// user supplies the number once here. The double option distinguishes
    /// "field absent" (leave unchanged) from "explicit null" (clear it).
    #[serde(default, deserialize_with = "deserialize_optional_u32_field")]
    context_window: Option<Option<u32>>,
}

/// Distinguish "field absent" from "field explicitly null" for an optional
/// numeric field, so a PATCH can clear a value without a magic sentinel.
fn deserialize_optional_u32_field<'de, D>(
    deserializer: D,
) -> Result<Option<Option<u32>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::<u32>::deserialize(deserializer)?))
}

#[derive(Debug, Deserialize, Default)]
struct CreateCustomProviderRequest {
    /// Stable id used as the `[providers.<id>]` table name.
    id: String,
    #[serde(default)]
    display_name: Option<String>,
    base_url: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    api_key_env: Option<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    models: Vec<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    wire: Option<String>,
}

#[derive(Debug, Serialize)]
struct CustomProviderMutationResponse {
    provider: String,
    message: String,
}

#[derive(Debug, Serialize)]
struct ProviderUpdateResponse {
    provider: String,
    model: String,
    base_url: String,
    key_saved: bool,
    set_as_default: bool,
    message: String,
}

#[derive(Debug, Deserialize, Default)]
struct ProviderProbeRequest {
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    timeout: Option<u64>,
}

#[derive(Debug, Serialize)]
struct ProviderProbeResponse {
    ok: bool,
    message: String,
    detail: Option<String>,
    latency_ms: Option<u128>,
}

#[derive(Debug, Deserialize, Default)]
struct ProviderHeadersRequest {
    #[serde(default)]
    headers: BTreeMap<String, String>,
}

fn provider_group(provider: ApiProvider) -> &'static str {
    match provider {
        ApiProvider::Ollama
        | ApiProvider::OllamaCloud
        | ApiProvider::Sglang
        | ApiProvider::Vllm
        | ApiProvider::Openmodel => "本地 / 自托管",
        ApiProvider::Deepseek
        | ApiProvider::DeepseekCN
        | ApiProvider::DeepseekAnthropic
        | ApiProvider::Openai
        | ApiProvider::Anthropic
        | ApiProvider::Xai
        | ApiProvider::Google
        | ApiProvider::Mistral => "国际服务",
        ApiProvider::NvidiaNim
        | ApiProvider::Openrouter
        | ApiProvider::Orcarouter
        | ApiProvider::Novita
        | ApiProvider::Fireworks
        | ApiProvider::Siliconflow
        | ApiProvider::SiliconflowCn
        | ApiProvider::Together
        | ApiProvider::Edenai
        | ApiProvider::Telecomjs
        | ApiProvider::Arcee => "聚合 / 中转",
        ApiProvider::Custom => "自定义",
        _ => "国内服务",
    }
}

fn provider_display_name(provider: ApiProvider, identity: &str) -> String {
    let base = provider.display_name();
    match identity {
        "modelstudio-token-plan" => format!("{base} · Token Plan / OpenAI"),
        "modelstudio-token-plan-anthropic" => format!("{base} · Token Plan / Anthropic"),
        "modelstudio-coding-plan" => format!("{base} · Coding Plan / OpenAI"),
        "modelstudio-coding-plan-anthropic" => format!("{base} · Coding Plan / Anthropic"),
        "deepseek-anthropic" => format!("{base} · Anthropic API"),
        "minimax-anthropic" => format!("{base} · Anthropic API"),
        _ => base.to_string(),
    }
}

fn mask_provider_key(key: &str) -> String {
    let key = key.trim();
    let chars: Vec<char> = key.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    if chars.len() <= 8 {
        return format!("{}...", chars.iter().take(2).collect::<String>());
    }
    format!(
        "{}...{}",
        chars.iter().take(4).collect::<String>(),
        chars[chars.len() - 4..].iter().collect::<String>()
    )
}

#[derive(Debug, Clone)]
struct RuntimeProviderRoute {
    provider: ApiProvider,
    identity: String,
}

impl RuntimeProviderRoute {
    fn id(&self) -> &str {
        &self.identity
    }
}

fn provider_route_config_for_identity(
    config: &Config,
    identity: &str,
) -> Config {
    let mut route = config.clone();
    route.provider = Some(identity.to_string());
    route
}

fn provider_entry_for_identity(
    config: &Config,
    active_provider: ApiProvider,
    active_identity: &str,
    provider: ApiProvider,
    identity: &str,
    display_name: &str,
) -> ProviderEntry {
    let route = provider_route_config_for_identity(config, identity);
    let route_config = route.provider_config_for(provider);
    // `Config::default_model()` resolves the active route's built-in default;
    // using it for every catalog row made an unconfigured OpenAI/Anthropic
    // entry appear to have the current DeepSeek model. Keep explicit
    // per-provider values, and only expose the active route's effective
    // fallback for display.
    let explicit_model = route_config
        .and_then(|entry| entry.model.clone())
        .or_else(|| {
            (provider == active_provider && identity == active_identity)
                .then(|| config.default_text_model.clone())
                .flatten()
        })
        .filter(|model| !model.trim().is_empty());
    let model = explicit_model
        .clone()
        .unwrap_or_else(|| {
            if provider == active_provider {
                route.default_model()
            } else {
                String::new()
            }
        });
    let base_url = route_config
        .and_then(|entry| entry.base_url.clone())
        .unwrap_or_else(|| {
            if provider == active_provider {
                route.deepseek_base_url()
            } else {
                provider.default_base_url().to_string()
            }
        });
    let has_api_key = crate::config::has_api_key_for(&route, provider);
    let key = has_api_key
        .then(|| route.deepseek_api_key_read_only().ok())
        .flatten()
        .filter(|key| !key.trim().is_empty());
    let has_custom_headers = if matches!(provider, ApiProvider::Deepseek | ApiProvider::DeepseekCN) {
        route.http_headers.as_ref().is_some_and(|headers| !headers.is_empty())
    } else {
        route
            .provider_config_for(provider)
            .and_then(|entry| entry.http_headers.as_ref())
            .is_some_and(|headers| !headers.is_empty())
    };
    let auth_mode = route
        .auth_mode_for_provider(provider)
        .unwrap_or_else(|| provider.credential_help().acquisition.as_str().to_string());
    let wire = route
        .provider_config_for(provider)
        .and_then(|entry| entry.wire.clone())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let has_model_catalog = !crate::provider_lake::all_catalog_models_for_provider(provider).is_empty();
    let default_model = if provider == ApiProvider::Custom {
        model.clone()
    } else {
        provider_default_model_for_api(config, active_provider, active_identity, provider, identity)
    };
    let default_base_url = if provider == ApiProvider::Custom {
        base_url.clone()
    } else {
        provider.default_base_url().to_string()
    };
    let custom_config = if provider == ApiProvider::Custom {
        route.provider_config_for(provider)
    } else {
        None
    };
    let display_name = custom_config
        .and_then(|entry| entry.display_name.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(display_name);
    let group = custom_config
        .and_then(|entry| entry.group.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| provider_group(provider));
    // New installations only expose routes that are configured (or the
    // currently active route) in the chat picker. Keyless local routes are
    // deliberately opt-in: `has_api_key` is true for `local_optional` so the
    // runtime can connect without credentials, but that must not make every
    // localhost service appear in a fresh install's model picker.
    let auth_is_keyless = matches!(auth_mode.as_str(), "none" | "local_optional");
    let enabled = route_config
        .and_then(|entry| entry.enabled)
        .unwrap_or(provider == active_provider || (has_api_key && !auth_is_keyless));
    let models = provider_models_for_api(
        config,
        active_provider,
        active_identity,
        provider,
        identity,
    );
    let mut configured_models = route_config
        .map(|entry| entry.models.clone())
        .unwrap_or_default();
    if let Some(model) = explicit_model {
        push_unique_model(&mut configured_models, &model);
    }
    let description = route_config
        .and_then(|entry| entry.description.clone())
        .filter(|value| !value.trim().is_empty());
    ProviderEntry {
        id: identity.to_string(),
        display_name: display_name.to_string(),
        default_base_url,
        default_model,
        has_model_catalog,
        env_vars: route
            .provider_config_for(provider)
            .and_then(|entry| entry.api_key_env.clone())
            .map(|name| vec![name])
            .unwrap_or_else(|| {
                provider
                    .env_vars()
                    .iter()
                    .map(std::string::ToString::to_string)
                    .collect()
            }),
        model,
        base_url,
        has_api_key,
        masked_api_key: key.as_deref().map(mask_provider_key).unwrap_or_default(),
        has_custom_headers,
        group: group.to_string(),
        is_custom: provider == ApiProvider::Custom,
        auth_mode,
        wire,
        context_window: route_config.and_then(|entry| entry.context_window),
        supports_connection_test: true,
        supports_live_models: true,
        supports_headers: true,
        supports_multi_key: false,
        enabled,
        models,
        configured_models,
        description,
    }
}

/// Build the one-row-per-vendor entry used by the desktop and mobile pickers.
///
/// Older configs can still select a dialect or plan-specific provider kind.
/// Keep that exact route for reading and persistence while exposing the
/// canonical catalog id to the UI, so those configs neither disappear nor
/// create duplicate rows.
fn provider_entry_for_catalog(
    config: &Config,
    active_provider: ApiProvider,
    active_identity: &str,
    catalog_provider: ApiProvider,
) -> ProviderEntry {
    let route_provider = if active_provider.catalog_identity() == catalog_provider {
        active_provider
    } else {
        catalog_provider
    };
    let route_identity = if route_provider == active_provider {
        active_identity
    } else {
        catalog_provider.as_str()
    };
    let mut entry = provider_entry_for_identity(
        config,
        active_provider,
        active_identity,
        route_provider,
        route_identity,
        &provider_display_name(catalog_provider, catalog_provider.as_str()),
    );
    entry.id = catalog_provider.as_str().to_string();
    entry.display_name = catalog_provider.display_name().to_string();
    entry.is_custom = false;
    entry
}

fn resolve_runtime_provider(config: &Config, id: &str) -> Result<RuntimeProviderRoute, ApiError> {
    let id = id.trim();
    if id.is_empty() {
        return Err(ApiError::bad_request("Provider id cannot be empty"));
    }

    // Exact custom table names are checked before built-in parsing. This
    // keeps a named route bound to its own table even when its spelling is
    // close to a built-in provider id.
    if let Some(entry) = config
        .providers
        .as_ref()
        .and_then(|providers| providers.custom_provider_config(id))
    {
        if !entry.is_openai_compatible_custom() {
            return Err(ApiError::bad_request(format!(
                "Custom provider '{id}' must set kind = \"openai-compatible\""
            )));
        }
        let identity = config
            .resolve_provider_identity(id)
            .map_err(ApiError::bad_request)?;
        return Ok(RuntimeProviderRoute {
            provider: ApiProvider::Custom,
            identity: identity.key,
        });
    }

    let provider = parse_runtime_provider(id)?;
    // A legacy config may currently run a dialect/plan-specific route while
    // the picker exposes only its canonical vendor row. Route edits and model
    // switches from that row must continue to target the exact active table.
    let active_provider = config.api_provider();
    if active_provider != provider
        && active_provider != ApiProvider::Custom
        && active_provider.catalog_identity() == provider.catalog_identity()
    {
        return Ok(RuntimeProviderRoute {
            provider: active_provider,
            identity: config.provider_identity_for(active_provider),
        });
    }
    let identity = config
        .resolve_provider_identity(&config.provider_identity_for(provider))
        .map_err(ApiError::bad_request)?;
    Ok(RuntimeProviderRoute {
        provider,
        identity: identity.key,
    })
}

fn push_unique_model(models: &mut Vec<String>, model: &str) {
    let model = model.trim();
    if !model.is_empty()
        && !models
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(model))
    {
        models.push(model.to_string());
    }
}

fn normalize_api_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn provider_uses_custom_route_for_api(
    config: &Config,
    provider: ApiProvider,
    identity: &str,
) -> bool {
    if provider == ApiProvider::Custom {
        return true;
    }
    provider_route_config_for_identity(config, identity)
        .provider_config_for(provider)
        .and_then(|entry| entry.base_url.as_deref())
        .is_some_and(|base_url| {
            normalize_api_base_url(base_url) != normalize_api_base_url(provider.default_base_url())
        })
}

fn provider_models_for_api(
    config: &Config,
    active_provider: ApiProvider,
    active_identity: &str,
    provider: ApiProvider,
    identity: &str,
) -> Vec<String> {
    let route = provider_route_config_for_identity(config, identity);
    let mut models = Vec::new();
    if let Some(model) = route
        .provider_config_for(provider)
        .and_then(|entry| entry.model.as_deref())
    {
        push_unique_model(&mut models, model);
    }
    if let Some(configured) = route.provider_config_for(provider) {
        for model in &configured.models {
            push_unique_model(&mut models, model);
        }
    }
    if provider == active_provider && identity == active_identity {
        let active_model = route.default_model();
        if !active_model.trim().eq_ignore_ascii_case("auto") {
            push_unique_model(&mut models, &active_model);
        }
        if route.model_ids_pass_through() {
            return models;
        }
    }
    if provider_uses_custom_route_for_api(config, provider, identity) {
        return models;
    }
    for model in crate::provider_lake::models_for_provider(
        config,
        active_provider,
        provider,
    ) {
        push_unique_model(&mut models, &model);
    }
    models
}

fn provider_model_entry(provider: ApiProvider, id: impl Into<String>) -> ProviderModelEntry {
    let id = id.into();
    let offering = crate::provider_lake::catalog_offering_for_model(provider, &id);
    ProviderModelEntry {
        id,
        reasoning_options: offering
            .as_ref()
            .map(|offering| offering.reasoning_options.clone())
            .unwrap_or_default(),
        supports_reasoning: offering.as_ref().and_then(|offering| offering.reasoning),
        context_window: offering
            .as_ref()
            .and_then(|offering| offering.limit.as_ref())
            .and_then(|limit| limit.context),
    }
}

fn provider_default_model_for_api(
    config: &Config,
    active_provider: ApiProvider,
    active_identity: &str,
    provider: ApiProvider,
    identity: &str,
) -> String {
    if provider == active_provider && identity == active_identity {
        return provider_route_config_for_identity(config, identity).default_model();
    }
    provider_models_for_api(config, active_provider, active_identity, provider, identity)
        .into_iter()
        .next()
        .unwrap_or_default()
}

async fn list_providers(
    State(state): State<RuntimeApiState>,
) -> Result<Json<ProvidersResponse>, ApiError> {
    let config = state.config.read().clone();
    let active_provider = config.api_provider();
    let active_identity = config.provider_identity_for(active_provider);
    // Picker ids are canonical catalog identities. Keep the exact active
    // identity only inside the runtime/config layer for legacy compatibility.
    let current = if active_provider == ApiProvider::Custom {
        active_identity.clone()
    } else {
        active_provider.catalog_identity().as_str().to_string()
    };
    let mut providers = Vec::new();
    for api_provider in ApiProvider::catalog() {
        if *api_provider == ApiProvider::Custom {
            continue;
        }
        providers.push(provider_entry_for_catalog(
            &config,
            active_provider,
            &active_identity,
            *api_provider,
        ));
    }
    if let Some(custom) = config.providers.as_ref().map(|providers| &providers.custom) {
        let mut custom_entries: Vec<_> = custom
            .iter()
            .filter(|(_, entry)| entry.is_openai_compatible_custom())
            .collect();
        custom_entries.sort_by_key(|(identity, entry)| (
            entry.display_name.as_deref().unwrap_or(*identity).to_ascii_lowercase(),
            (*identity).to_ascii_lowercase(),
        ));
        for (identity, entry) in custom_entries {
            if entry.is_openai_compatible_custom() {
                providers.push(provider_entry_for_identity(
                    &config,
                    active_provider,
                    &active_identity,
                    ApiProvider::Custom,
                    identity,
                    entry.display_name.as_deref().unwrap_or(identity),
                ));
            }
        }
    }
    if active_provider == ApiProvider::Custom
        && active_identity.eq_ignore_ascii_case(ApiProvider::Custom.as_str())
        && !providers.iter().any(|entry| entry.id == active_identity)
    {
        providers.push(provider_entry_for_identity(
            &config,
            active_provider,
            &active_identity,
            ApiProvider::Custom,
            &active_identity,
            "Custom (legacy)",
        ));
    }
    Ok(Json(ProvidersResponse { current, providers }))
}

/// Create a named OpenAI-compatible provider. This is the durable API used by
/// the desktop/mobile settings surfaces; the TUI's config editor remains
/// compatible because both paths write the same TOML shape.
async fn create_custom_provider(
    State(state): State<RuntimeApiState>,
    Json(req): Json<CreateCustomProviderRequest>,
) -> Result<Json<CustomProviderMutationResponse>, ApiError> {
    use crate::config_persistence;

    let id = req.id.trim();
    let base_url = validate_provider_base_url(&req.base_url)?;
    config_persistence::persist_custom_provider(
        state.config_path.as_deref(),
        id,
        &base_url,
        req.model.as_deref(),
        req.api_key_env.as_deref(),
    )
    .map_err(|error| ApiError::bad_request(error.to_string()))?;
    if let Some(wire) = req.wire.as_deref() {
        let normalized = wire.trim().to_ascii_lowercase().replace(['_', ' '], "-");
        let value = match normalized.as_str() {
            "openai" | "openai-compatible" | "chat-completions" | "completions" => "openai",
            "responses" | "openai-responses" | "responses-api" => "responses",
            "anthropic" | "anthropic-messages" | "messages" | "anthropic-compatible" => "anthropic",
            _ => return Err(ApiError::bad_request("wire must be openai, responses, or anthropic")),
        };
        config_persistence::persist_provider_wire_for_identity(
            state.config_path.as_deref(),
            ApiProvider::Custom,
            id,
            Some(value),
        )
        .map_err(|error| ApiError::internal(format!("Failed to save provider API format: {error}")))?;
    }
    config_persistence::persist_custom_provider_metadata(
        state.config_path.as_deref(),
        id,
        req.display_name.as_deref(),
        req.group.as_deref(),
    )
    .map_err(|error| ApiError::internal(format!("Failed to save provider metadata: {error}")))?;
    config_persistence::persist_provider_models_for_identity(
        state.config_path.as_deref(),
        ApiProvider::Custom,
        id,
        &req.models,
    )
    .map_err(|error| ApiError::internal(format!("Failed to save provider models: {error}")))?;
    if let Some(enabled) = req.enabled {
        config_persistence::persist_provider_enabled_for_identity(
            state.config_path.as_deref(),
            ApiProvider::Custom,
            id,
            enabled,
        )
        .map_err(|error| ApiError::internal(format!("Failed to save provider state: {error}")))?;
    }

    let mut reloaded = Config::load(state.config_path.clone(), state.config_profile.as_deref())
        .map_err(|error| ApiError::internal(format!("Failed to reload provider config: {error}")))?;
    if let Some(api_key) = req.api_key.as_deref().map(str::trim).filter(|key| !key.is_empty()) {
        let identity = reloaded
            .resolve_provider_identity(id)
            .map_err(ApiError::bad_request)?;
        let route = provider_route_config_for_identity(&reloaded, id);
        crate::config::save_api_key_for_identity(&identity, &route, api_key)
            .map_err(|error| ApiError::internal(format!("Failed to save provider API key: {error}")))?;
        reloaded = Config::load(state.config_path.clone(), state.config_profile.as_deref())
            .map_err(|error| ApiError::internal(format!("Failed to reload provider config: {error}")))?;
    }
    state
        .runtime_threads
        .reload_config(reloaded.clone())
        .await
        .map_err(|error| ApiError::bad_request(format!("Config reload rejected: {error}")))?;
    *state.config.write() = reloaded;
    Ok(Json(CustomProviderMutationResponse {
        provider: id.to_string(),
        message: format!("Custom provider '{id}' saved"),
    }))
}

async fn delete_custom_provider(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<CustomProviderMutationResponse>, ApiError> {
    use crate::config_persistence;
    {
        let config = state.config.read();
        config
            .providers
            .as_ref()
            .and_then(|providers| providers.custom_provider_config(&id))
            .ok_or_else(|| ApiError::not_found(format!("Custom provider '{id}' was not found")))?;
    }
    // Unload threads pinned to this route and clear their bindings BEFORE the
    // table is removed — otherwise the reload preflight rejects the whole
    // config update because a thread references the just-removed provider, and
    // since the removal is already persisted at that point, every later
    // provider operation would fail the same way until a restart. Detaching
    // first also means a refusal (a thread with a running turn) happens before
    // anything has changed.
    state
        .runtime_threads
        .detach_provider_route(&id)
        .await
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    config_persistence::delete_custom_provider(state.config_path.as_deref(), &id)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let reloaded = Config::load(state.config_path.clone(), state.config_profile.as_deref())
        .map_err(|error| ApiError::internal(format!("Failed to reload provider config: {error}")))?;
    state
        .runtime_threads
        .reload_config(reloaded.clone())
        .await
        .map_err(|error| ApiError::bad_request(format!("Config reload rejected: {error}")))?;
    *state.config.write() = reloaded;
    Ok(Json(CustomProviderMutationResponse {
        provider: id.clone(),
        message: format!("Custom provider '{id}' deleted"),
    }))
}

#[derive(Debug, Deserialize)]
struct ListProviderModelsParams {
    /// Optional filter: when provided, models whose id contains this
    /// substring (case-insensitive) are returned. Currently informational —
    /// the catalog is small enough to filter client-side.
    #[serde(default)]
    #[allow(dead_code)]
    filter: Option<String>,
}

async fn list_provider_models(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    _params: Query<ListProviderModelsParams>,
) -> Result<Json<ProviderModelsResponse>, ApiError> {
    let config = state.config.read().clone();
    let active_provider = config.api_provider();
    let active_identity = config.provider_identity_for(active_provider);
    let route = resolve_runtime_provider(&config, &id)?;
    let models = provider_models_for_api(
        &config,
        active_provider,
        &active_identity,
        route.provider,
        route.id(),
    )
        .into_iter()
        .map(|id| provider_model_entry(route.provider, id))
        .collect();
    Ok(Json(ProviderModelsResponse {
        provider: route.id().to_string(),
        models,
        source: "runtime_catalog".to_string(),
    }))
}

fn parse_runtime_provider(id: &str) -> Result<ApiProvider, ApiError> {
    let provider = ApiProvider::parse(id)
        .ok_or_else(|| ApiError::bad_request(format!("Unknown provider id '{id}'")))?;
    if provider == ApiProvider::DeepseekCN {
        return Err(ApiError::bad_request(
            "provider 'deepseek-cn' is a legacy alias; use 'deepseek' instead",
        ));
    }
    Ok(provider)
}

fn validate_provider_base_url(raw: &str) -> Result<String, ApiError> {
    let value = raw.trim().trim_end_matches('/');
    let parsed = reqwest::Url::parse(value)
        .map_err(|error| ApiError::bad_request(format!("Invalid provider base URL: {error}")))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(ApiError::bad_request(
            "Provider base URL must be an http(s) URL with a host",
        ));
    }
    Ok(value.to_string())
}

fn config_for_provider_request(
    config: &Config,
    route: &RuntimeProviderRoute,
    model: Option<&str>,
    base_url: Option<&str>,
    api_key: Option<&str>,
) -> Result<Config, ApiError> {
    let mut scoped = provider_route_config_for_identity(config, route.id());
    if let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) {
        let normalized = normalize_runtime_config_model(route.provider, model)?;
        scoped.set_provider_model_override(route.provider, Some(normalized));
    }
    if let Some(base_url) = base_url {
        scoped.set_provider_base_url_override(
            route.provider,
            Some(validate_provider_base_url(base_url)?),
        );
    }
    if let Some(api_key) = api_key.map(str::trim).filter(|key| !key.is_empty()) {
        scoped.set_provider_api_key_override(route.provider, Some(api_key.to_string()));
    }
    Ok(scoped)
}

/// Save one provider's model, endpoint, credential, and optional default
/// selection through the same Rust persistence paths used by the TUI.
async fn update_provider(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(req): Json<ProviderUpdateRequest>,
) -> Result<Json<ProviderUpdateResponse>, ApiError> {
    use crate::config_persistence;

    // Older desktop builds could create a named custom provider without the
    // now-required route kind. Repair that legacy shape before resolving the
    // route, otherwise the validation below rejects every later edit.
    let legacy_custom_provider = {
        let config = state.config.read();
        config
            .providers
            .as_ref()
            .and_then(|providers| providers.custom_provider_config(&id))
            .is_some_and(|entry| !entry.is_openai_compatible_custom())
    };
    if legacy_custom_provider {
        config_persistence::ensure_custom_provider_kind(state.config_path.as_deref(), &id)
            .map_err(|error| ApiError::internal(format!("Failed to repair provider kind: {error}")))?;
        let repaired = Config::load(state.config_path.clone(), state.config_profile.as_deref())
            .map_err(|error| ApiError::internal(format!("Failed to reload provider config: {error}")))?;
        *state.config.write() = repaired;
    }

    let (provider_route, identity, route) = {
        let config = state.config.read();
        let provider_route = resolve_runtime_provider(&config, &id)?;
        let route = config_for_provider_request(
            &config,
            &provider_route,
            req.model_name.as_deref(),
            req.base_url.as_deref(),
            req.api_key.as_deref(),
        )?;
        let identity = config
            .resolve_provider_identity(provider_route.id())
            .map_err(ApiError::bad_request)?;
        (provider_route, identity, route)
    };

    let model = req
        .model_name
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(|model| normalize_runtime_config_model(provider_route.provider, model))
        .transpose()?;
    if let Some(model) = model.as_deref() {
        config_persistence::persist_provider_model_key(
            state.config_path.as_deref(),
            provider_route.provider,
            &identity.key,
            model,
        )
        .map_err(|error| ApiError::internal(format!("Failed to save provider model: {error}")))?;
    }

    if let Some(base_url) = req.base_url.as_deref() {
        let value = base_url.trim();
        let value = (!value.is_empty()).then(|| validate_provider_base_url(value)).transpose()?;
        config_persistence::persist_provider_base_url_for_identity(
            state.config_path.as_deref(),
            provider_route.provider,
            &identity.key,
            value.as_deref(),
        )
        .map_err(|error| ApiError::internal(format!("Failed to save provider base URL: {error}")))?;
    }

    let key_saved = req
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(|key| {
            crate::config::save_api_key_for_identity(&identity, &route, key).map(|_| true)
        })
        .transpose()
        .map_err(|error| ApiError::internal(format!("Failed to save provider API key: {error}")))?
        .unwrap_or(false);

    if provider_route.provider == ApiProvider::Custom
        && (req.display_name.is_some() || req.group.is_some())
    {
        config_persistence::persist_custom_provider_metadata(
            state.config_path.as_deref(),
            &identity.key,
            req.display_name.as_deref(),
            req.group.as_deref(),
        )
        .map_err(|error| ApiError::internal(format!("Failed to save provider metadata: {error}")))?;
    }

    if let Some(enabled) = req.enabled {
        // Disabling is the "delete" path for built-in providers (the catalog
        // entry itself cannot be removed). Threads pinned to this route must
        // be detached BEFORE anything persists, or the reload preflight below
        // rejects the update and — with it — every later provider operation,
        // since a thread then references a route that may no longer resolve.
        if !enabled {
            state
                .runtime_threads
                .detach_provider_route(&identity.key)
                .await
                .map_err(|error| ApiError::bad_request(error.to_string()))?;
        }
        config_persistence::persist_provider_enabled_for_identity(
            state.config_path.as_deref(),
            provider_route.provider,
            &identity.key,
            enabled,
        )
        .map_err(|error| ApiError::internal(format!("Failed to save provider state: {error}")))?;
    }
    if let Some(models) = req.models.as_ref() {
        config_persistence::persist_provider_models_for_identity(
            state.config_path.as_deref(),
            provider_route.provider,
            &identity.key,
            models,
        )
        .map_err(|error| ApiError::internal(format!("Failed to save provider models: {error}")))?;
    }

    if let Some(wire) = req.wire.as_deref() {
        let normalized = wire.trim().to_ascii_lowercase().replace(['_', ' '], "-");
        let value = match normalized.as_str() {
            "openai" | "openai-compatible" | "chat-completions" | "completions" => "openai",
            "anthropic" | "anthropic-messages" | "messages" | "anthropic-compatible" => "anthropic",
            _ => return Err(ApiError::bad_request("wire must be openai, responses, or anthropic")),
        };
        config_persistence::persist_provider_wire_for_identity(
            state.config_path.as_deref(),
            provider_route.provider,
            &identity.key,
            Some(value),
        )
        .map_err(|error| ApiError::internal(format!("Failed to save provider API format: {error}")))?;
    }

    if let Some(context_window) = req.context_window {
        // A context window of 0 is meaningless — treat it as "clear", matching
        // the config layer's own validation (`parse_context_window`).
        let value = context_window.filter(|tokens| *tokens > 0);
        config_persistence::persist_provider_context_window_for_identity(
            state.config_path.as_deref(),
            provider_route.provider,
            &identity.key,
            value,
        )
        .map_err(|error| {
            ApiError::internal(format!("Failed to save provider context window: {error}"))
        })?;
    }

    if req.set_as_default {
        config_persistence::persist_root_string_key(
            state.config_path.as_deref(),
            "provider",
            &identity.key,
        )
        .map_err(|error| ApiError::internal(format!("Failed to set default provider: {error}")))?;
    }

    let reloaded = Config::load(state.config_path.clone(), state.config_profile.as_deref())
        .map_err(|error| ApiError::internal(format!("Failed to reload provider config: {error}")))?;
    state
        .runtime_threads
        .reload_config(reloaded.clone())
        .await
        .map_err(|error| ApiError::bad_request(format!("Config reload rejected: {error}")))?;
    {
        let mut config = state.config.write();
        *config = reloaded.clone();
    }

    let active = reloaded.api_provider();
    let active_identity = reloaded.provider_identity_for(active);
    Ok(Json(ProviderUpdateResponse {
        provider: active_identity.clone(),
        model: reloaded.default_model(),
        base_url: reloaded.deepseek_base_url(),
        key_saved,
        set_as_default: active == provider_route.provider && active_identity == provider_route.identity,
        message: format!("{} provider configuration saved", provider_route.id()),
    }))
}

async fn fetch_provider_models(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(req): Json<ProviderProbeRequest>,
) -> Result<Json<ProviderModelsResponse>, ApiError> {
    let provider_route = {
        let config = state.config.read();
        resolve_runtime_provider(&config, &id)?
    };
    let route = {
        let config = state.config.read();
        config_for_provider_request(
            &config,
            &provider_route,
            req.model.as_deref(),
            req.base_url.as_deref(),
            req.api_key.as_deref(),
        )?
    };
    let client = crate::client::DeepSeekClient::new(&route)
        .map_err(|error| ApiError::bad_request(format!("Unable to create provider client: {error}")))?;
    let timeout = req.timeout.unwrap_or(20).clamp(5, 120);
    let models = tokio::time::timeout(Duration::from_secs(timeout), client.list_models())
        .await
        .map_err(|_| ApiError::bad_request(format!("Fetching models timed out after {timeout}s")))?
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(Json(ProviderModelsResponse {
        provider: provider_route.id().to_string(),
        models: models
            .into_iter()
            .map(|model| provider_model_entry(provider_route.provider, model.id))
            .collect(),
        source: "provider_api".to_string(),
    }))
}

async fn test_provider_connection(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(req): Json<ProviderProbeRequest>,
) -> Result<Json<ProviderProbeResponse>, ApiError> {
    let provider_route = {
        let config = state.config.read();
        resolve_runtime_provider(&config, &id)?
    };
    let route = {
        let config = state.config.read();
        config_for_provider_request(
            &config,
            &provider_route,
            req.model.as_deref(),
            req.base_url.as_deref(),
            req.api_key.as_deref(),
        )?
    };
    let client = crate::client::DeepSeekClient::new(&route)
        .map_err(|error| ApiError::bad_request(format!("Unable to create provider client: {error}")))?;
    let timeout = req.timeout.unwrap_or(20).clamp(5, 120);
    let started = Instant::now();
    let result = tokio::time::timeout(Duration::from_secs(timeout), client.list_models()).await;
    let latency_ms = Some(started.elapsed().as_millis());
    match result {
        Ok(Ok(models)) => Ok(Json(ProviderProbeResponse {
            ok: true,
            message: format!("{} connection succeeded", provider_route.id()),
            detail: Some(format!("{} model(s) available", models.len())),
            latency_ms,
        })),
        Ok(Err(error)) => Ok(Json(ProviderProbeResponse {
            ok: false,
            message: format!("{} connection failed", provider_route.id()),
            detail: Some(error.to_string()),
            latency_ms,
        })),
        Err(_) => Ok(Json(ProviderProbeResponse {
            ok: false,
            message: format!("{} connection timed out", provider_route.id()),
            detail: Some(format!("The provider did not answer within {timeout}s")),
            latency_ms,
        })),
    }
}

async fn get_provider_headers(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let provider_route = {
        let config = state.config.read();
        resolve_runtime_provider(&config, &id)?
    };
    let config = state.config.read();
    let headers = if matches!(provider_route.provider, ApiProvider::Deepseek | ApiProvider::DeepseekCN) {
        config.http_headers.clone().unwrap_or_default()
    } else {
        provider_route_config_for_identity(&config, provider_route.id())
            .provider_config_for(provider_route.provider)
            .and_then(|entry| entry.http_headers.clone())
            .unwrap_or_default()
    };
    Ok(Json(json!({ "provider": provider_route.id(), "headers": headers })))
}

async fn set_provider_headers(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(req): Json<ProviderHeadersRequest>,
) -> Result<Json<Value>, ApiError> {
    use crate::config_persistence;

    let provider_route = {
        let config = state.config.read();
        resolve_runtime_provider(&config, &id)?
    };
    let mut headers = std::collections::HashMap::new();
    for (name, value) in req.headers {
        let name = name.trim();
        let value = value.trim();
        if name.is_empty() || value.is_empty() {
            continue;
        }
        HeaderName::from_bytes(name.as_bytes())
            .map_err(|error| ApiError::bad_request(format!("Invalid header name: {error}")))?;
        HeaderValue::from_str(value)
            .map_err(|error| ApiError::bad_request(format!("Invalid header value: {error}")))?;
        headers.insert(name.to_string(), value.to_string());
    }
    let identity = {
        let config = state.config.read();
        config
            .resolve_provider_identity(provider_route.id())
            .map_err(ApiError::bad_request)?
    };
    config_persistence::persist_provider_headers_for_identity(
        state.config_path.as_deref(),
        provider_route.provider,
        &identity.key,
        &headers,
    )
    .map_err(|error| ApiError::internal(format!("Failed to save provider headers: {error}")))?;
    let reloaded = Config::load(state.config_path.clone(), state.config_profile.as_deref())
        .map_err(|error| ApiError::internal(format!("Failed to reload provider config: {error}")))?;
    state
        .runtime_threads
        .reload_config(reloaded.clone())
        .await
        .map_err(|error| ApiError::bad_request(format!("Config reload rejected: {error}")))?;
    *state.config.write() = reloaded;
    Ok(Json(json!({
        "provider": provider_route.id(),
        "saved": true,
        "count": headers.len(),
    })))
}

/// Request body for `POST /v1/providers/{id}/switch`.
///
/// Mirrors the TUI's `AppAction::SwitchProvider { provider, model }` payload
/// (see `tui/ui.rs::switch_provider`). `model` is optional: when omitted,
/// the runtime resolves the active model from `[providers.<id>].model` (or
/// the provider's built-in default) and **does not** persist a `model` key,
/// so the user's per-provider config is preserved. When provided, the model
/// is normalized, persisted for the target provider, and (for DeepSeek
/// providers) also pinned as `default_text_model`.
#[derive(Debug, Deserialize, Default)]
struct SwitchProviderRequest {
    #[serde(default)]
    model: Option<String>,
}

/// Response for `POST /v1/providers/{id}/switch`.
#[derive(Debug, Serialize)]
struct SwitchProviderResponse {
    /// The provider id that was switched to (echoes the path).
    provider: String,
    /// The resolved active model after the switch. This is the model the
    /// runtime will use for new turns — either the user-supplied override
    /// or the value resolved from `[providers.<id>].model` / the
    /// provider's built-in default. The GUI should display *this* value,
    /// not `ProviderEntry.default_model`, to avoid showing the catalog
    /// default when the user has configured a different model.
    model: String,
    /// Human-readable status message for logging/toasts.
    message: String,
    /// Whether the new provider + model were persisted to config.toml.
    persisted: bool,
}

/// `POST /v1/providers/{id}/switch` — switch the active provider, optionally
/// overriding the model.
///
/// This is the GUI-facing counterpart of the TUI's `/provider` slash command
/// (`commands/groups/core/provider.rs`) and `AppAction::SwitchProvider`
/// (`tui/ui.rs::switch_provider`). It exists so the GUI does not have to
/// simulate the switch with multiple `POST /v1/config` calls + a reload,
/// which historically led to two bugs:
///
/// 1. The GUI persisted `model = <catalog default>` even when the user
///    clicked the picker without choosing a model, clobbering a user-set
///    `[providers.<id>].model` (e.g. `glm-2` overwritten with
///    `deepseek-v4-pro`).
/// 2. The GUI then displayed the catalog default instead of the actually
///    resolved model, because it never asked the backend what model was
///    selected.
///
/// Persistence mirrors `switch_provider` (ui.rs:9390-9410):
/// - `provider` is always persisted (root `provider` key).
/// - `model` is persisted **only** when `model_override.is_some()`, via
///   `persist_provider_model_key` (writes `[providers.<id>].model`, or the
///   root `default_text_model` for DeepSeek). The `Settings` provider-model
///   map is updated the same way, including the DeepSeek-specific
///   `default_model` pin.
/// - Config is reloaded from disk and synced to active engines via
///   `runtime_threads.reload_config`, exactly like `POST /v1/config/reload`.
async fn switch_provider(
    State(state): State<RuntimeApiState>,
    Path(id): Path<String>,
    Json(req): Json<SwitchProviderRequest>,
) -> Result<Json<SwitchProviderResponse>, ApiError> {
    use crate::config_persistence;

    let target_route = {
        let config = state.config.read();
        resolve_runtime_provider(&config, &id)?
    };
    let target = target_route.provider;

    // Normalize the optional model override against the *target* provider.
    // Mirrors `set_config`'s `model` branch, which validates against the
    // active route — except here we validate against the target provider,
    // because the active route is about to change.
    let model_override: Option<String> = match req.model.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(raw) => Some(normalize_runtime_config_model(target, raw)?),
    };

    // Resolve the target provider identity *before* mutating config, so
    // persistence uses the same key the TUI's switch_provider would.
    let provider_identity = target_route.identity.clone();

    // Persist `provider` (always) + `model` (only when explicitly given).
    // This is the critical TUI-parity rule: a bare `/provider <id>` (no
    // model arg) MUST NOT write a `model` key, otherwise the user's
    // per-provider `[providers.<id>].model` config gets overwritten with
    // whatever the runtime resolves as the default.
    config_persistence::persist_root_string_key(
        state.config_path.as_deref(),
        "provider",
        &provider_identity,
    )
    .map_err(|e| ApiError::internal(format!("Failed to persist provider: {e}")))?;

    if let Some(ref model) = model_override {
        config_persistence::persist_provider_model_key(
            state.config_path.as_deref(),
            target,
            &provider_identity,
            model,
        )
        .map_err(|e| ApiError::internal(format!("Failed to persist model: {e}")))?;

        // Mirror the TUI's Settings update (ui.rs:9398-9406): record the
        // provider→model mapping, and for DeepSeek also pin the global
        // `default_model`. Failures here are non-fatal — the config.toml
        // write above is the source of truth.
        let _ = crate::settings::Settings::transact(|settings| {
            settings.set_model_for_provider(&provider_identity, model);
            if matches!(target, ApiProvider::Deepseek | ApiProvider::DeepseekCN) {
                let _ = settings.set("default_model", model);
            }
            Ok(())
        });
    }

    // Reload config from disk and sync to active engines. This matches
    // `POST /v1/config/reload` exactly: load → validate thread routes →
    // swap in the new config. A failure here means an active thread's
    // route is invalid under the new provider — surface it so the GUI can
    // tell the user to fix their config.
    let reloaded = Config::load(state.config_path.clone(), state.config_profile.as_deref())
        .map_err(|e| ApiError::internal(format!("Failed to reload config: {e}")))?;
    state
        .runtime_threads
        .reload_config(reloaded.clone())
        .await
        .map_err(|err| ApiError::bad_request(format!("Config reload rejected: {err}")))?;
    {
        let mut config = state.config.write();
        *config = reloaded;
    }

    // Read the resolved active model + provider from the freshly reloaded
    // config. This is the value the GUI must display — NOT the catalog
    // default and NOT the previously-active model.
    let (active_provider, active_identity, active_model) = {
        let config = state.config.read();
        let active_provider = config.api_provider();
        (
            active_provider,
            config.provider_identity_for(active_provider),
            config.default_model(),
        )
    };

    let message = if model_override.is_some() {
        format!(
            "Provider switched to {} (model: {}).",
            active_identity,
            active_model
        )
    } else {
        format!(
            "Provider switched to {} (model: {}, resolved from config).",
            active_identity,
            active_model
        )
    };

    Ok(Json(SwitchProviderResponse {
        provider: provider_identity,
        model: active_model,
        message,
        persisted: true,
    }))
}

// ── Config endpoints ──

const MAX_RUNTIME_UPLOAD_SIZE: usize = 10 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct UploadFileBody {
    filename: String,
    #[serde(default)]
    content_type: Option<String>,
    data_base64: String,
}

#[derive(Debug, Deserialize)]
struct UploadFilesRequest {
    files: Vec<UploadFileBody>,
}

fn runtime_upload_dir() -> Result<PathBuf, ApiError> {
    // Embedded Tauri/Android runtimes set HAKUS_HOME to their private app
    // data directory. Keep uploads under that same root so the uninstall
    // prompt and full user-data wipe cover attachments as well.
    let home = hakus_config::hakus_home()
        .map_err(|error| ApiError::internal(format!("Unable to resolve Hakus home: {error}")))?;
    let dir = home.join("uploads");
    fs::create_dir_all(&dir).map_err(|e| ApiError::internal(format!("Failed to create upload directory: {e}")))?;
    Ok(dir)
}

fn safe_upload_filename(name: &str) -> String {
    let candidate = FsPath::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("upload.bin")
        .trim();
    let mut safe: String = candidate
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ' ') { ch } else { '_' })
        .collect();
    if safe.is_empty() { safe = "upload.bin".to_string(); }
    safe.chars().take(180).collect()
}

fn upload_metadata(file_id: &str, filename: &str, size: usize, content_type: &str, data: &[u8]) -> Value {
    let extension = FsPath::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    let is_text = matches!(extension.as_deref(), Some("txt" | "md" | "py" | "js" | "ts" | "json" | "yaml" | "yml" | "xml" | "html" | "css" | "java" | "c" | "cpp" | "go" | "rs" | "rb" | "sh" | "sql"))
        || content_type.starts_with("text/");
    let text_preview = if is_text {
        std::str::from_utf8(data).ok().map(|text| text.chars().take(2000).collect::<String>())
    } else { None };
    json!({
        "file_id": file_id,
        "filename": filename,
        "size": size,
        "content_type": content_type,
        "text_preview": text_preview,
        "is_text": is_text,
    })
}

async fn upload_files(
    Json(req): Json<UploadFilesRequest>,
) -> Result<Json<Value>, ApiError> {
    if req.files.is_empty() {
        return Ok(Json(json!({ "files": [] })));
    }
    let dir = runtime_upload_dir()?;
    let mut result = Vec::with_capacity(req.files.len());
    for file in req.files {
        let data = base64::engine::general_purpose::STANDARD
            .decode(file.data_base64.trim())
            .map_err(|_| ApiError::bad_request(format!("Invalid base64 for {}", file.filename)))?;
        if data.len() > MAX_RUNTIME_UPLOAD_SIZE {
            return Err(ApiError::bad_request(format!("{} exceeds the 10 MB upload limit", file.filename)));
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let filename = safe_upload_filename(&file.filename);
        let path = dir.join(format!("{id}_{filename}"));
        fs::write(&path, &data).map_err(|e| ApiError::internal(format!("Failed to save upload: {e}")))?;
        result.push(upload_metadata(&id, &filename, data.len(), file.content_type.as_deref().unwrap_or("application/octet-stream"), &data));
    }
    Ok(Json(json!({ "files": result })))
}

async fn list_files() -> Result<Json<Value>, ApiError> {
    let dir = runtime_upload_dir()?;
    let mut files = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| ApiError::internal(format!("Failed to list uploads: {e}")))? {
        let entry = entry.map_err(|e| ApiError::internal(format!("Failed to inspect upload: {e}")))?;
        let path = entry.path();
        if !path.is_file() { continue; }
        let name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default();
        let Some((id, filename)) = name.split_once('_') else { continue; };
        if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) { continue; }
        let data = fs::read(&path).unwrap_or_default();
        let size = data.len();
        files.push(upload_metadata(id, filename, size, "application/octet-stream", &data));
    }
    files.sort_by_key(|value| {
        std::cmp::Reverse(
            value
                .get("file_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        )
    });
    Ok(Json(json!({ "files": files })))
}

async fn get_file(Path(id): Path<String>) -> Result<Response, ApiError> {
    if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request("Invalid file_id"));
    }
    let dir = runtime_upload_dir()?;
    let prefix = format!("{id}_");
    let path = fs::read_dir(&dir)
        .map_err(|e| ApiError::internal(format!("Failed to list uploads: {e}")))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .find(|path| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(&prefix)))
        .ok_or_else(|| ApiError { status: StatusCode::NOT_FOUND, message: "File not found".to_string() })?;
    let bytes = fs::read(&path).map_err(|e| ApiError::internal(format!("Failed to read upload: {e}")))?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response())
}

async fn delete_file(Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request("Invalid file_id"));
    }
    let dir = runtime_upload_dir()?;
    let prefix = format!("{id}_");
    let path = fs::read_dir(&dir)
        .map_err(|e| ApiError::internal(format!("Failed to list uploads: {e}")))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .find(|path| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(&prefix)));
    let Some(path) = path else {
        return Err(ApiError { status: StatusCode::NOT_FOUND, message: "File not found".to_string() });
    };
    fs::remove_file(path).map_err(|e| ApiError::internal(format!("Failed to delete upload: {e}")))?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct TtsRequestBody {
    text: String,
    #[serde(default)]
    voice: Option<String>,
    #[serde(default)]
    speed: Option<f32>,
    #[serde(default)]
    instruction: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VoiceCloneRequestBody {
    audio_base64: String,
    #[serde(default)]
    filename: Option<String>,
}

fn runtime_voice_clone_dir() -> Result<PathBuf, ApiError> {
    let Some(log_dir) = crate::runtime_log::log_directory() else {
        return Err(ApiError::internal("Unable to resolve Hakus home"));
    };
    let dir = log_dir
        .parent()
        .unwrap_or_else(|| FsPath::new("."))
        .join("voice");
    fs::create_dir_all(&dir)
        .map_err(|error| ApiError::internal(format!("Failed to create voice directory: {error}")))?;
    Ok(dir)
}

fn runtime_voice_clone_file(voice_id: &str) -> Result<PathBuf, ApiError> {
    if !voice_id.starts_with("hakus-clone-")
        || !voice_id["hakus-clone-".len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(ApiError::bad_request("Invalid voice clone id"));
    }
    let dir = runtime_voice_clone_dir()?;
    ["wav", "mp3"]
        .iter()
        .map(|extension| dir.join(format!("{voice_id}.{extension}")))
        .find(|path| path.exists())
        .ok_or_else(|| ApiError { status: StatusCode::NOT_FOUND, message: "Voice clone sample not found".to_string() })
}

async fn clone_voice(
    Json(req): Json<VoiceCloneRequestBody>,
) -> Result<Json<Value>, ApiError> {
    let audio = base64::engine::general_purpose::STANDARD
        .decode(req.audio_base64.trim())
        .map_err(|_| ApiError::bad_request("Invalid audio base64"))?;
    if audio.is_empty() {
        return Err(ApiError::bad_request("Audio cannot be empty"));
    }
    if audio.len() > MAX_RUNTIME_UPLOAD_SIZE {
        return Err(ApiError::bad_request("Audio exceeds the 10 MB limit"));
    }
    let extension = req
        .filename
        .as_deref()
        .and_then(|name| FsPath::new(name).extension().and_then(|value| value.to_str()))
        .unwrap_or("wav")
        .to_ascii_lowercase();
    if extension != "wav" && extension != "mp3" {
        return Err(ApiError::bad_request("Only WAV or MP3 voice samples are supported"));
    }
    let voice_id = format!("hakus-clone-{}", uuid::Uuid::new_v4().simple());
    let dir = runtime_voice_clone_dir()?;
    let path = dir.join(format!("{voice_id}.{extension}"));
    fs::write(&path, audio)
        .map_err(|error| ApiError::internal(format!("Failed to save voice sample: {error}")))?;
    fs::write(dir.join("active_voice_id"), &voice_id)
        .map_err(|error| ApiError::internal(format!("Failed to save voice clone status: {error}")))?;
    Ok(Json(json!({
        "status": "completed",
        "voice_id": voice_id,
        "message": "声音样本已保存，可直接用于 MiMo voice-clone TTS",
    })))
}

async fn clone_voice_status() -> Result<Json<Value>, ApiError> {
    let dir = runtime_voice_clone_dir()?;
    let status_path = dir.join("active_voice_id");
    let Some(voice_id) = fs::read_to_string(&status_path)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(Json(json!({ "status": "pending", "voice_id": null })));
    };
    Ok(Json(json!({ "status": "completed", "voice_id": voice_id })))
}

async fn text_to_speech(
    State(state): State<RuntimeApiState>,
    Json(req): Json<TtsRequestBody>,
) -> Result<Response, ApiError> {
    let config = state.config.read().clone();
    let client = crate::client::DeepSeekClient::new(&config)
        .map_err(|error| ApiError::bad_request(format!("Unable to create speech client: {error}")))?;
    let model = config.default_model();
    let voice = if let Some(voice_id) = req.voice.as_deref().filter(|voice| voice.starts_with("hakus-clone-")) {
        let path = runtime_voice_clone_file(voice_id)?;
        let clone_uri = crate::tools::speech::encode_voice_clone_sample_data_uri(&path)
            .map_err(|error| ApiError::bad_request(format!("Unable to load voice clone sample: {error}")))?;
        Some(clone_uri)
    } else {
        req.voice
    };
    let response = client
        .synthesize_speech(crate::client::SpeechSynthesisRequest {
            model,
            text: req.text,
            instruction: req.instruction,
            audio_format: "mp3".to_string(),
            voice,
        })
        .await
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let content_type = if response.audio_format.eq_ignore_ascii_case("wav") { "audio/wav" } else { "audio/mpeg" };
    let _ = req.speed; // MiMo controls prosody through its instruction surface.
    Ok(([(header::CONTENT_TYPE, content_type)], response.audio_bytes).into_response())
}

async fn list_tts_voices() -> Json<Value> {
    Json(json!({ "voices": ["default"] }))
}

#[derive(Debug, Deserialize)]
struct AsrRequestBody {
    audio_base64: String,
    #[serde(default)]
    language: Option<String>,
}

async fn transcribe_voice(
    State(state): State<RuntimeApiState>,
    Json(req): Json<AsrRequestBody>,
) -> Result<Json<Value>, ApiError> {
    let audio = base64::engine::general_purpose::STANDARD
        .decode(req.audio_base64.trim())
        .map_err(|_| ApiError::bad_request("Invalid audio base64"))?;
    if audio.len() > MAX_RUNTIME_UPLOAD_SIZE {
        return Err(ApiError::bad_request("Audio exceeds the 10 MB limit"));
    }
    let config = state.config.read().clone();
    let api_key = config
        .deepseek_api_key()
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    if api_key.trim().is_empty() {
        return Err(ApiError::bad_request("No API key configured for voice transcription"));
    }
    let data_url = format!("data:audio/wav;base64,{}", base64::engine::general_purpose::STANDARD.encode(audio));
    let language = req.language.unwrap_or_else(|| "auto".to_string());
    let body = json!({
        "model": "mimo-v2.5-asr",
        "messages": [{ "role": "user", "content": [{ "type": "input_audio", "input_audio": { "data": data_url } }] }],
        "asr_options": { "language": language },
    });
    let response = crate::tls::reqwest_client()
        .post(format!("{}/chat/completions", config.deepseek_base_url().trim_end_matches('/')))
        .bearer_auth(api_key)
        .json(&body)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|error| ApiError::bad_request(format!("Voice transcription request failed: {error}")))?;
    let status = response.status();
    let payload: Value = response.json().await.map_err(|error| ApiError::bad_request(format!("Invalid transcription response: {error}")))?;
    if !status.is_success() {
        return Err(ApiError::bad_request(format!("Voice transcription failed with HTTP {status}")));
    }
    let text = payload.pointer("/choices/0/message/content").and_then(Value::as_str).unwrap_or("").trim().to_string();
    Ok(Json(json!({ "text": text })))
}

/// GUI-relevant config snapshot returned by `GET /v1/config`.
#[derive(Debug, Clone, Serialize)]
struct GuiConfigResponse {
    model: String,
    provider: String,
    approval_mode: String,
    reasoning_effort: String,
    auto_compact: bool,
    cost_currency: String,
    default_mode: String,
    default_model: String,
    base_url: String,
    allow_shell: bool,
    mcp_config_path: String,
    subagents_enabled: bool,
    subagents_max_depth: u32,
    /// Maximum concurrent sub-agents. Sub-agents share the provider's rate
    /// limit, so lowering this is the main lever against 429s on
    /// aggregator/proxy routes.
    subagents_max_concurrent: u32,
    /// Retry policy for provider requests, surfaced so users on rate-limited
    /// routes can widen it without hand-editing `config.toml`.
    retry_enabled: bool,
    retry_max_retries: u32,
    retry_initial_delay: f64,
    retry_max_delay: f64,
    show_thinking: bool,
    thinking_default_expanded: bool,
    thinking_highlight: bool,
    show_tool_details: bool,
    inline_diffs: String,
    locale: String,
    max_history: usize,
    workspace_follow_symlinks: bool,
    calm_mode: bool,
    sandbox_mode: String,
    strict_tool_mode: bool,
    memory_enabled: bool,
    search_provider: String,
    prompt_suggestion: bool,
}

/// Request body for `POST /v1/config` (set a single config key).
#[derive(Debug, Deserialize)]
struct SetConfigRequest {
    key: String,
    value: String,
    #[serde(default)]
    persist: bool,
}

/// Response for `POST /v1/config` (set a single config key).
#[derive(Debug, Serialize)]
struct SetConfigResponse {
    key: String,
    value: String,
    message: String,
    persisted: bool,
    requires_reload: bool,
}

fn persist_runtime_tui_setting(key: &str, value: &str) -> Result<(), ApiError> {
    // Validate against a throwaway copy first, so an invalid value is still a
    // 400 rather than an internal error raised from inside the transaction.
    let mut probe = crate::settings::Settings::load_persisted()
        .map_err(|e| ApiError::internal(format!("Failed to load settings: {e}")))?;
    probe
        .set(key, value)
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    // The write itself re-applies the key inside `Settings::transact`, so it
    // cannot save the stale snapshot above over a concurrent writer's field.
    crate::settings::Settings::transact(|settings| settings.set(key, value))
        .map_err(|e| ApiError::internal(format!("Failed to save settings: {e}")))
}

/// Response for `POST /v1/config/reload`.
#[derive(Debug, Serialize)]
struct ReloadConfigResponse {
    message: String,
}

async fn get_config(
    State(state): State<RuntimeApiState>,
) -> Result<Json<GuiConfigResponse>, ApiError> {
    let config = state.config.read();
    let settings = crate::settings::Settings::load_persisted().unwrap_or_default();
    let mcp_config_path = config.mcp_config_path().display().to_string();

    let model = config.default_model();

    let provider = config.provider_identity_for(config.api_provider());

    let approval_mode = config
        .approval_policy
        .as_deref()
        .unwrap_or("suggest")
        .to_string();
    let reasoning_effort = config.reasoning_effort().unwrap_or("auto").to_string();
    let cost_currency = settings.cost_currency.clone();
    let default_mode = settings.default_mode.as_str().to_string();
    // This field is the legacy root DeepSeek fallback, not the active
    // provider model above. Keeping the two explicit prevents a Z.ai model
    // update from silently rewriting a future DeepSeek route.
    let default_model = config
        .default_text_model
        .clone()
        .unwrap_or_else(|| DEFAULT_TEXT_MODEL.to_string());
    let base_url = config.deepseek_base_url().to_string();

    Ok(Json(GuiConfigResponse {
        model,
        provider,
        approval_mode,
        reasoning_effort,
        auto_compact: settings.auto_compact,
        cost_currency,
        default_mode,
        default_model,
        base_url,
        allow_shell: config.allow_shell(),
        mcp_config_path,
        subagents_enabled: config.subagents_enabled(),
        subagents_max_depth: config.subagent_max_spawn_depth(),
        subagents_max_concurrent: config.max_subagents() as u32,
        // Report the values actually in effect: an unset `[retry]` table means
        // the built-in defaults are running, and the UI should show those
        // rather than blanks.
        retry_enabled: config.retry.as_ref().and_then(|r| r.enabled).unwrap_or(true),
        retry_max_retries: config.retry.as_ref().and_then(|r| r.max_retries).unwrap_or(3),
        retry_initial_delay: config.retry.as_ref().and_then(|r| r.initial_delay).unwrap_or(1.0),
        retry_max_delay: config.retry.as_ref().and_then(|r| r.max_delay).unwrap_or(60.0),
        show_thinking: settings.show_thinking,
        thinking_default_expanded: settings.thinking_default_expanded,
        thinking_highlight: settings.thinking_highlight,
        show_tool_details: settings.show_tool_details,
        inline_diffs: settings.inline_diffs.clone(),
        locale: settings.locale.clone(),
        max_history: settings.max_input_history,
        workspace_follow_symlinks: settings.workspace_follow_symlinks,
        calm_mode: settings.calm_mode,
        sandbox_mode: config
            .sandbox_mode
            .clone()
            .unwrap_or_else(|| "workspace-write".to_string()),
        strict_tool_mode: config.strict_tool_mode.unwrap_or(false),
        memory_enabled: config.memory_enabled(),
        search_provider: config.search_provider().as_str().to_string(),
        prompt_suggestion: config.prompt_suggestion_enabled(),
    }))
}

async fn set_config(
    State(state): State<RuntimeApiState>,
    Json(req): Json<SetConfigRequest>,
) -> Result<Json<SetConfigResponse>, ApiError> {
    use crate::config_persistence;

    let key = req.key.to_lowercase();
    let mut value = req.value;
    let persist = req.persist;

    // Validate model keys even for dry-run requests. Model ids are provider
    // owned; accepting a DeepSeek id while Z.ai is active creates a saved
    // route that cannot execute after reload.
    let active_route = {
        let config = state.config.read();
        let provider = config.api_provider();
        (provider, config.provider_identity_for(provider))
    };
    match key.as_str() {
        "model" => {
            value = normalize_runtime_config_model(active_route.0, &value)?;
        }
        "default_model" => {
            value = normalize_runtime_config_model(ApiProvider::Deepseek, &value)?;
        }
        _ => {}
    }

    // All persisted config keys require a reload to take effect in the
    // runtime (including syncing to active engines). The caller should
    // POST /v1/config/reload after persisting.
    let requires_reload = persist;

    // Handle persistence directly via config_persistence.
    // The runtime's in-memory state is NOT mutated here; the caller
    // should POST /v1/config/reload after persisting to apply changes.
    if persist {
        let config_path = state.config_path.as_deref();
        let result: anyhow::Result<PathBuf> = match key.as_str() {
            "model" => config_persistence::persist_provider_model_key(
                config_path,
                active_route.0,
                &active_route.1,
                &value,
            ),
            "default_model" => config_persistence::persist_root_string_key(
                config_path,
                "default_text_model",
                &value,
            ),
            "reasoning_effort" => {
                config_persistence::persist_root_string_key(config_path, "reasoning_effort", &value)
            }
            "approval_mode" | "approval_policy" => {
                config_persistence::persist_root_string_key(config_path, "approval_policy", &value)
            }
            "base_url" => config_persistence::persist_root_string_key(
                config_path,
                "deepseek_base_url",
                &value,
            ),
            "provider" => {
                // Validate the provider id against the static registry so the
                // GUI gets a clear error instead of silently persisting an
                // unknown value that `Config::api_provider()` would later
                // ignore (falling back to DeepSeek).
                let parsed = ApiProvider::parse(&value).ok_or_else(|| {
                    ApiError::bad_request(format!(
                        "Unknown provider '{value}'. Call GET /v1/providers for the list of supported ids."
                    ))
                })?;
                let result =
                    config_persistence::persist_root_string_key(config_path, "provider", &value);
                if result.is_ok() {
                    // Keep the in-memory provider in step with the persisted
                    // value so a following set_config(model) resolves the new
                    // provider's table instead of clobbering the previous
                    // provider's root default_text_model (#4658 follow-up).
                    state.config.write().provider = Some(parsed.as_str().to_string());
                }
                result
            }
            "provider_url" | "provider_base_url" => {
                let provider = state.config.read().api_provider();
                config_persistence::persist_provider_base_url_key(config_path, provider, &value)
            }
            "cost_currency"
            | "default_mode"
            | "auto_compact"
            | "show_thinking"
            | "thinking_default_expanded"
            | "thinking_highlight"
            | "show_tool_details"
            | "inline_diffs"
            | "calm_mode"
            | "workspace_follow_symlinks"
            | "locale"
            | "max_history" => {
                persist_runtime_tui_setting(&key, &value)?;
                return Ok(Json(SetConfigResponse {
                    key,
                    value,
                    message: "Config persisted. Call /v1/config/reload to apply.".to_string(),
                    persisted: true,
                    requires_reload,
                }));
            }
            "allow_shell" => {
                let enabled = value.parse::<bool>().map_err(|_| {
                    ApiError::bad_request(format!(
                        "Invalid value '{value}' for allow_shell: expected 'true' or 'false'"
                    ))
                })?;
                config_persistence::persist_root_bool_key(config_path, "allow_shell", enabled)
            }
            "mcp_config_path" => {
                config_persistence::persist_root_string_key(config_path, "mcp_config_path", &value)
            }
            "subagents_enabled" => {
                let enabled = value.parse::<bool>().map_err(|_| {
                    ApiError::bad_request(format!(
                        "Invalid value '{value}' for subagents_enabled: expected 'true' or 'false'"
                    ))
                })?;
                config_persistence::persist_subagents_bool_key(config_path, "enabled", enabled)
            }
            "subagents_max_depth" => {
                let raw = value.parse::<u64>().map_err(|_| {
                    ApiError::bad_request(format!(
                        "Invalid value '{value}' for subagents_max_depth: expected a non-negative integer"
                    ))
                })?;
                let clamped = raw.min(u64::from(hakus_config::MAX_SPAWN_DEPTH_CEILING));
                config_persistence::persist_subagents_integer_key(config_path, "max_depth", clamped)
            }
            // Sub-agents share the provider's rate limit. Lowering concurrency
            // is the main lever against 429s on aggregator/proxy routes, so it
            // needs to be reachable without hand-editing config.toml.
            "subagents_max_concurrent" => {
                let raw = value.parse::<u64>().map_err(|_| {
                    ApiError::bad_request(format!(
                        "Invalid value '{value}' for subagents_max_concurrent: expected a positive integer"
                    ))
                })?;
                let clamped = raw.clamp(1, crate::MAX_SUBAGENTS as u64);
                config_persistence::persist_subagents_integer_key(
                    config_path,
                    "max_concurrent",
                    clamped,
                )
            }
            "retry_enabled" => {
                let enabled = value.parse::<bool>().map_err(|_| {
                    ApiError::bad_request(format!(
                        "Invalid value '{value}' for retry_enabled: expected 'true' or 'false'"
                    ))
                })?;
                config_persistence::persist_table_bool_key(config_path, "retry", "enabled", enabled)
            }
            "retry_max_retries" => {
                let raw = value.parse::<u64>().map_err(|_| {
                    ApiError::bad_request(format!(
                        "Invalid value '{value}' for retry_max_retries: expected a non-negative integer"
                    ))
                })?;
                // 20 attempts at the exponential ceiling would outlast any
                // reasonable turn; cap so a typo cannot wedge the runtime.
                let clamped = raw.min(20);
                config_persistence::persist_table_integer_key(
                    config_path,
                    "retry",
                    "max_retries",
                    clamped,
                )
            }
            "retry_initial_delay" => {
                let parsed = value.parse::<f64>().map_err(|_| {
                    ApiError::bad_request(format!(
                        "Invalid value '{value}' for retry_initial_delay: expected seconds as a number"
                    ))
                })?;
                if !parsed.is_finite() || parsed < 0.0 {
                    return Err(ApiError::bad_request(
                        "retry_initial_delay must be a non-negative number of seconds",
                    ));
                }
                config_persistence::persist_table_float_key(
                    config_path,
                    "retry",
                    "initial_delay",
                    parsed.min(300.0),
                )
            }
            "retry_max_delay" => {
                let parsed = value.parse::<f64>().map_err(|_| {
                    ApiError::bad_request(format!(
                        "Invalid value '{value}' for retry_max_delay: expected seconds as a number"
                    ))
                })?;
                if !parsed.is_finite() || parsed <= 0.0 {
                    return Err(ApiError::bad_request(
                        "retry_max_delay must be a positive number of seconds",
                    ));
                }
                config_persistence::persist_table_float_key(
                    config_path,
                    "retry",
                    "max_delay",
                    parsed.min(600.0),
                )
            }
            "sandbox_mode" => {
                let normalized = match value.to_lowercase().as_str() {
                    "none" | "off" | "disabled" => "none".to_string(),
                    "opensandbox" | "external-sandbox" | "external" => "opensandbox".to_string(),
                    "workspace-write" | "workspace_write" => "workspace-write".to_string(),
                    "read-only" | "read_only" => "read-only".to_string(),
                    "danger-full-access" | "danger_full_access" | "full" => {
                        "danger-full-access".to_string()
                    }
                    "workspace" | "workspace-read-write" | "workspace_read_write" => {
                        "workspace-write".to_string()
                    }
                    _ => {
                        return Err(ApiError::bad_request(format!(
                            "Invalid sandbox_mode '{value}'. Supported: none, read-only, workspace-write, danger-full-access, opensandbox"
                        )));
                    }
                };
                config_persistence::persist_root_string_key(
                    config_path,
                    "sandbox_mode",
                    &normalized,
                )
            }
            "strict_tool_mode" => {
                let enabled = value.parse::<bool>().map_err(|_| {
                    ApiError::bad_request(format!(
                        "Invalid value '{value}' for strict_tool_mode: expected 'true' or 'false'"
                    ))
                })?;
                config_persistence::persist_root_bool_key(config_path, "strict_tool_mode", enabled)
            }
            "memory_enabled" => {
                let enabled = value.parse::<bool>().map_err(|_| {
                    ApiError::bad_request(format!(
                        "Invalid value '{value}' for memory_enabled: expected 'true' or 'false'"
                    ))
                })?;
                config_persistence::persist_table_bool_key(
                    config_path,
                    "memory",
                    "enabled",
                    enabled,
                )
            }
            "search_provider" => {
                let normalized = value.to_lowercase();
                config_persistence::persist_table_string_key(
                    config_path,
                    "search",
                    "provider",
                    &normalized,
                )
            }
            "prompt_suggestion" => {
                let enabled = value.parse::<bool>().map_err(|_| {
                    ApiError::bad_request(format!(
                        "Invalid value '{value}' for prompt_suggestion: expected 'true' or 'false'"
                    ))
                })?;
                config_persistence::persist_root_bool_key(config_path, "prompt_suggestion", enabled)
            }
            _ => {
                return Err(ApiError::bad_request(format!(
                    "Unknown config key '{key}'. Supported keys: model, default_model, reasoning_effort, approval_mode, base_url, provider, provider_url, cost_currency, default_mode, auto_compact, allow_shell, mcp_config_path, show_thinking, thinking_default_expanded, thinking_highlight, show_tool_details, inline_diffs, locale, max_history, calm_mode, workspace_follow_symlinks, subagents_enabled, subagents_max_depth, sandbox_mode, strict_tool_mode, memory_enabled, search_provider, prompt_suggestion"
                )));
            }
        };

        if let Err(e) = result {
            return Err(ApiError::internal(format!(
                "Failed to persist config key '{key}': {e}"
            )));
        }
    }

    Ok(Json(SetConfigResponse {
        key,
        value,
        message: if persist {
            "Config persisted. Call /v1/config/reload to apply.".to_string()
        } else {
            "Config not persisted (add persist: true to save)".to_string()
        },
        persisted: persist,
        requires_reload,
    }))
}

/// `DELETE /v1/config/credentials` — clear every stored provider credential
/// without discarding model routes, provider metadata, or the workspace.
///
/// First-run uses this narrower operation when a platform restore brings back
/// an old secret. The key itself is never sent to the client and the user's
/// explicit model/provider choices remain available for confirmation.
fn clear_runtime_provider_credentials(state: &RuntimeApiState) -> Result<(), ApiError> {
    let config_path = config_persistence::config_toml_path(state.config_path.as_deref())
        .map_err(|error| ApiError::internal(format!("Failed to resolve config path: {error}")))?;
    if config_path.exists() {
        config_persistence::mutate_config_document(&config_path, |document| {
            config_persistence::remove_document_key_recursive(
                document.as_table_mut(),
                "api_key",
            );
            config_persistence::remove_document_key_recursive(
                document.as_table_mut(),
                "api_keys",
            );
            config_persistence::unset_document_value(
                document,
                &["providers", "xai", "oauth_credential_generation"],
            )?;
            config_persistence::unset_document_value(
                document,
                &["providers", "xai", "auth_mode"],
            )?;
            config_persistence::unset_document_value(
                document,
                &["providers", "xai", "external_credentials"],
            )?;
            Ok(())
        })
        .map_err(|error| ApiError::internal(format!("Failed to clear config credentials: {error}")))?;
    }

    // Delete durable slots directly instead of going through the CLI logout
    // helper, whose xAI revocation transaction opens the credentials
    // directory even on a fresh install that has none.
    let secrets = hakus_secrets::Secrets::auto_detect();
    let mut slots = BTreeSet::new();
    let mut failures = Vec::new();
    for provider in ApiProvider::all() {
        let slot = crate::config::provider_secret_store_slot(*provider);
        if !slots.insert(slot) {
            continue;
        }
        match secrets.get(slot) {
            Ok(Some(value)) if !value.trim().is_empty() => {
                if let Err(error) = secrets.delete(slot) {
                    failures.push(format!("{slot}: {error}"));
                }
            }
            Ok(_) => {}
            Err(error) => failures.push(format!("{slot}: {error}")),
        }
    }
    if !failures.is_empty() {
        return Err(ApiError::internal(format!(
            "Failed to clear stored provider credentials: {}",
            failures.join(", ")
        )));
    }

    // xAI OAuth files are separate from API-key slots. Skip the lifecycle
    // lock entirely when no owned file exists; otherwise remove every valid
    // Hakus-owned generation.
    if let Ok(directory) = hakus_config::xai_oauth_credentials_dir() {
        let has_owned_file = fs::read_dir(directory)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .any(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name == "xai-auth.json"
                    || (name.starts_with("xai-auth-") && name.ends_with(".json"))
            });
        if has_owned_file {
            hakus_config::clear_all_xai_oauth_credentials().map_err(|error| {
                ApiError::internal(format!("Failed to clear xAI OAuth credentials: {error}"))
            })?;
        }
    }

    Ok(())
}

async fn clear_runtime_credentials(
    State(state): State<RuntimeApiState>,
) -> Result<Json<Value>, ApiError> {
    clear_runtime_provider_credentials(&state)?;

    let reloaded = Config::load(state.config_path.clone(), state.config_profile.as_deref())
        .map_err(|error| ApiError::internal(format!("Failed to reload provider config: {error}")))?;
    state
        .runtime_threads
        .reload_config(reloaded.clone())
        .await
        .map_err(|error| ApiError::bad_request(format!("Config reload rejected: {error}")))?;
    *state.config.write() = reloaded;

    Ok(Json(json!({ "credentials_cleared": true })))
}

/// `DELETE /v1/config/user-data` — clear Runtime-owned configuration and
/// credentials without touching the user's selected workspace directory.
///
/// The desktop/mobile clients clear sessions, projects, memory and logs in
/// their respective stores. This endpoint handles the Rust-owned remainder:
/// provider routes/models, default selections, API keys, and TUI preferences.
/// It intentionally removes only files in Hakus' managed state locations;
/// arbitrary paths referenced by a workspace or MCP configuration are never
/// recursively deleted.
async fn clear_user_config(
    State(state): State<RuntimeApiState>,
) -> Result<Json<Value>, ApiError> {
    clear_runtime_provider_credentials(&state)?;

    // Reset the active config document to an empty TOML document instead of
    // deleting its parent directory. The next load recreates only defaults.
    let config_path = config_persistence::config_toml_path(state.config_path.as_deref())
        .map_err(|error| ApiError::internal(format!("Failed to resolve config path: {error}")))?;
    if config_path.exists() {
        config_persistence::mutate_config_document(&config_path, |document| {
            *document = toml_edit::DocumentMut::new();
            Ok(())
        })
            .map_err(|error| ApiError::internal(format!("Failed to clear config: {error}")))?;
    }
    // The TOML writer keeps a one-time `.bak` beside the config. That backup
    // is useful for migration, but it is still user data and must not survive
    // an explicit wipe.
    if let (Some(parent), Some(file_name)) = (config_path.parent(), config_path.file_name()) {
        let mut backup_name = file_name.to_os_string();
        backup_name.push(".bak");
        let backup_path = parent.join(backup_name);
        if backup_path.exists() {
            fs::remove_file(&backup_path).map_err(|error| {
                ApiError::internal(format!("Failed to clear config backup: {error}"))
            })?;
        }
    }

    // TUI preferences are separate from config.toml and can otherwise make a
    // fresh initialization look partially restored. Missing files are fine.
    for path in [
        crate::settings::Settings::path().ok(),
        crate::settings::TuiPrefs::path().ok(),
    ]
    .into_iter()
    .flatten()
    {
        if path.exists() {
            fs::remove_file(&path).map_err(|error| {
                ApiError::internal(format!("Failed to clear settings file {}: {error}", path.display()))
            })?;
        }
    }

    // Audit and tracing logs are managed under Hakus' own state root. Empty
    // active files in place so open handles remain valid on Windows; rotate
    // files are safe to remove.
    if let Some(path) = crate::audit::audit_log_path() {
        if path.exists() {
            fs::write(&path, []).map_err(|error| {
                ApiError::internal(format!("Failed to clear audit log: {error}"))
            })?;
        }
        for suffix in [".1", ".2"] {
            let mut rotated_name = path
                .file_name()
                .map(std::ffi::OsString::from)
                .unwrap_or_else(|| std::ffi::OsString::from("audit.log"));
            rotated_name.push(suffix);
            let rotated = path
                .parent()
                .unwrap_or_else(|| FsPath::new("."))
                .join(rotated_name);
            if rotated.exists() {
                fs::remove_file(rotated).map_err(|error| {
                    ApiError::internal(format!("Failed to clear rotated audit log: {error}"))
                })?;
            }
        }
    }
    if let Some(log_dir) = crate::runtime_log::log_directory() {
        if let Ok(entries) = fs::read_dir(log_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let _ = fs::write(path, []);
                }
            }
        }
    }

    let reloaded = Config::load(state.config_path.clone(), state.config_profile.as_deref())
        .map_err(|error| ApiError::internal(format!("Failed to reload empty config: {error}")))?;
    state
        .runtime_threads
        .reload_config(reloaded.clone())
        .await
        .map_err(|error| ApiError::bad_request(format!("Config reload rejected: {error}")))?;
    *state.config.write() = reloaded;

    Ok(Json(json!({
        "cleared": true,
        "config": config_path.display().to_string(),
        "workspace_preserved": true,
    })))
}

#[derive(Debug, Deserialize)]
struct ImportConfigRequest {
    config: Value,
}

#[derive(Debug, Serialize)]
struct ImportConfigResponse {
    applied: Vec<String>,
    ignored: Vec<String>,
    reloaded: bool,
}

/// Import the portable GUI configuration projection. Secrets are deliberately
/// excluded from `GET /v1/config`; provider credentials continue to be managed
/// through the provider endpoints and the OS credential store.
async fn import_config(
    State(state): State<RuntimeApiState>,
    Json(req): Json<ImportConfigRequest>,
) -> Result<Json<ImportConfigResponse>, ApiError> {
    let object = req
        .config
        .as_object()
        .ok_or_else(|| ApiError::bad_request("config must be an object"))?;
    let mut values: Vec<(String, String)> = Vec::new();
    let mut ignored = Vec::new();

    let mut push_value = |key: &str, value: Option<&Value>| {
        if let Some(value) = value {
            if let Some(text) = value.as_str() {
                values.push((key.to_string(), text.to_string()));
            } else if let Some(boolean) = value.as_bool() {
                values.push((key.to_string(), boolean.to_string()));
            } else if let Some(number) = value.as_number() {
                values.push((key.to_string(), number.to_string()));
            } else {
                ignored.push(key.to_string());
            }
        }
    };

    // Accept both the native flat projection and the legacy nested AppConfig
    // shape used by the desktop backup dialog.
    push_value("provider", object.get("provider"));
    push_value("model", object.get("model"));
    push_value("default_model", object.get("default_model"));
    for key in [
        "reasoning_effort", "approval_mode", "approval_policy", "base_url",
        "provider_url", "provider_base_url", "cost_currency", "default_mode",
        "auto_compact", "allow_shell", "mcp_config_path", "subagents_enabled",
        "subagents_max_depth", "show_thinking", "thinking_default_expanded",
        "thinking_highlight", "show_tool_details", "inline_diffs", "locale",
        "max_history", "calm_mode", "workspace_follow_symlinks", "sandbox_mode",
        "strict_tool_mode", "memory_enabled", "search_provider", "prompt_suggestion",
    ] {
        push_value(key, object.get(key));
    }
    if let Some(model) = object.get("model").and_then(Value::as_object) {
        push_value("provider", model.get("provider"));
        push_value("model", model.get("model_name").or_else(|| model.get("model")));
        push_value("base_url", model.get("base_url"));
    }

    // De-duplicate while preserving the import order, with provider first so
    // model validation uses the intended route.
    let mut seen = BTreeSet::new();
    values.retain(|(key, _)| seen.insert(key.clone()));
    let mut applied = Vec::new();
    for (key, value) in values {
        let _ = set_config(
            State(state.clone()),
            Json(SetConfigRequest {
                key: key.clone(),
                value,
                persist: true,
            }),
        )
        .await?;
        applied.push(key);
    }
    let reloaded = if applied.is_empty() {
        false
    } else {
        let _ = reload_config(State(state)).await?;
        true
    };
    Ok(Json(ImportConfigResponse {
        applied,
        ignored,
        reloaded,
    }))
}

fn normalize_runtime_config_model(provider: ApiProvider, value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    validate_route(provider, value).map_err(ApiError::bad_request)?;
    if value.eq_ignore_ascii_case("auto") {
        return Ok("auto".to_string());
    }
    normalize_model_name_for_provider(provider, value).ok_or_else(|| {
        ApiError::bad_request(format!(
            "Invalid model '{value}' for provider '{}'.",
            provider.as_str()
        ))
    })
}

async fn reload_config(
    State(state): State<RuntimeApiState>,
) -> Result<Json<ReloadConfigResponse>, ApiError> {
    let reloaded = Config::load(state.config_path.clone(), state.config_profile.as_deref())
        .map_err(|e| ApiError::internal(format!("Failed to reload config: {e}")))?;
    state
        .runtime_threads
        .reload_config(reloaded.clone())
        .await
        .map_err(|err| ApiError::bad_request(format!("Config reload rejected: {err}")))?;
    {
        let mut config = state.config.write();
        *config = reloaded;
    }
    Ok(Json(ReloadConfigResponse {
        message: "Config reloaded from disk; new turns will resolve the updated provider routes"
            .to_string(),
    }))
}

// ── Memory inspection and lifecycle endpoints ──

/// Maximum summary length returned per entry. Bounds the API surface so raw
/// private text cannot exfiltrate through JSON responses.
const MEMORY_SUMMARY_MAX_CHARS: usize = 300;
/// Default result cap for `GET /v1/memory`.
const MEMORY_LIST_DEFAULT_LIMIT: usize = 50;
/// Hard ceiling — protects against oversized responses.
const MEMORY_LIST_MAX_LIMIT: usize = 200;

/// Typed, redacted projection of a single native memory entry.
///
/// Raw file-system paths are never exposed; `scope` and `workspace_id` (a
/// SHA-256 digest of the repository origin URL, not a local path) give
/// managed clients enough provenance to reason about each entry.
#[derive(Debug, Serialize)]
struct MemoryEntryRecord {
    /// SQLite row id. Stable across reindexes unless the source Markdown
    /// file is cleared and rewritten.
    id: i64,
    /// `"global"` or `"workspace"`.
    scope: &'static str,
    /// SHA-256 digest of the repository origin URL for workspace-scoped
    /// entries; `null` for global entries.
    workspace_id: Option<String>,
    /// Bounded plain-text summary (max `MEMORY_SUMMARY_MAX_CHARS` chars).
    /// Truncated with `…` when the source text is longer. Never contains
    /// raw prompt or turn content.
    summary: String,
    /// `true` when the source Markdown file has been modified since the
    /// entry was last indexed.
    stale: bool,
    /// 1-based start line in the source Markdown file.
    line_start: usize,
    /// 1-based end line in the source Markdown file.
    line_end: usize,
    /// `"active"` or `"stale"` (human-readable alias for `stale`).
    status: &'static str,
}

#[derive(Debug, Deserialize)]
struct ListMemoryQuery {
    /// Filter by scope: `"global"`, `"workspace"`, or `"all"` (default).
    scope: Option<String>,
    /// FTS search query (max 256 chars). When absent all entries for the
    /// requested scope are returned in insertion order.
    q: Option<String>,
    /// Maximum entries to return (default 50, max 200).
    limit: Option<usize>,
}

/// Request body for `POST /v1/memory`.
#[derive(Debug, Deserialize)]
struct CreateMemoryRequest {
    /// The memory note text (max 64 KiB after normalisation).
    text: String,
    /// `"global"` (default) or `"workspace"`.
    #[serde(default)]
    scope: String,
}

/// Query params for `DELETE /v1/memory`.
#[derive(Debug, Deserialize)]
struct ClearMemoryQuery {
    /// One of `"global"`, `"workspace"`, or `"all"`. Required.
    scope: String,
}

/// Build a `NativeMemoryStore` rooted at the same location the TUI uses.
/// Mirrors `native_store()` in `commands/groups/memory/memory.rs`.
fn native_store_for_state(state: &RuntimeApiState) -> crate::native_memory::NativeMemoryStore {
    let memory_path = state.config.read().memory_path();
    if let Some(store) = crate::native_memory::NativeMemoryStore::from_global_path(&memory_path) {
        return store;
    }
    let root = memory_path
        .parent()
        .unwrap_or_else(|| FsPath::new("."))
        .join("memory");
    crate::native_memory::NativeMemoryStore::new(root)
}

/// Derive a scope label from a source path relative to the store root.
/// Returns `"global"`, `"workspace"`, or `"unknown"`.
fn scope_label_for_source(source: &FsPath, store_root: &FsPath) -> &'static str {
    let Ok(rel) = source.strip_prefix(store_root) else {
        return "unknown";
    };
    match rel.components().next().and_then(|c| c.as_os_str().to_str()) {
        Some("global") => "global",
        Some("workspace") => "workspace",
        _ => "unknown",
    }
}

/// Extract the workspace_id component from a workspace-scoped source path.
fn workspace_id_for_source(source: &FsPath, store_root: &FsPath) -> Option<String> {
    let rel = source.strip_prefix(store_root).ok()?;
    let mut comps = rel.components();
    if comps.next()?.as_os_str().to_str()? != "workspace" {
        return None;
    }
    Some(comps.next()?.as_os_str().to_str()?.to_string())
}

/// Convert a `MemoryHit` into a redacted, bounded `MemoryEntryRecord`.
fn memory_hit_to_record(
    hit: crate::native_memory::MemoryHit,
    store_root: &FsPath,
) -> MemoryEntryRecord {
    let scope = scope_label_for_source(&hit.source, store_root);
    let workspace_id = workspace_id_for_source(&hit.source, store_root);
    let summary = truncate_text(&hit.text, MEMORY_SUMMARY_MAX_CHARS);
    let status = if hit.stale { "stale" } else { "active" };
    MemoryEntryRecord {
        id: hit.id,
        scope,
        workspace_id,
        summary,
        stale: hit.stale,
        line_start: hit.line_start,
        line_end: hit.line_end,
        status,
    }
}

/// Resolve a scope query parameter into a `MemoryScope` filter and an
/// optional workspace_id.  `"all"` / absent → `(None, None)`.
fn resolve_memory_scope(
    scope_param: &Option<String>,
    workspace: &FsPath,
) -> Result<(Option<crate::native_memory::MemoryScope>, Option<String>), ApiError> {
    match scope_param.as_deref().unwrap_or("all").trim() {
        "all" | "" => Ok((None, None)),
        "global" => Ok((Some(crate::native_memory::MemoryScope::Global), None)),
        "workspace" => {
            let workspace_id = crate::native_memory::NativeMemoryStore::workspace_id(workspace)
                .map_err(|e| ApiError::internal(format!("resolve workspace id: {e}")))?;
            Ok((
                Some(crate::native_memory::MemoryScope::Workspace),
                workspace_id,
            ))
        }
        other => Err(ApiError::bad_request(format!(
            "Invalid scope '{other}': expected one of all, global, workspace"
        ))),
    }
}

/// `GET /v1/memory` — list memory entries with optional scope and FTS
/// filtering.
///
/// Query params:
/// - `scope` — `"global"`, `"workspace"`, or `"all"` (default)
/// - `q` — FTS search query (max 256 chars; omit to list all)
/// - `limit` — max results (default 50, max 200)
async fn list_memory(
    State(state): State<RuntimeApiState>,
    Query(query): Query<ListMemoryQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = match query.limit.unwrap_or(MEMORY_LIST_DEFAULT_LIMIT) {
        0 => {
            return Err(ApiError::bad_request("limit must be at least 1"));
        }
        n if n > MEMORY_LIST_MAX_LIMIT => {
            return Err(ApiError::bad_request(format!(
                "limit must be at most {MEMORY_LIST_MAX_LIMIT}; got {n}"
            )));
        }
        n => n,
    };

    let store = native_store_for_state(&state);
    let root = store.root().to_path_buf();
    let (scope_filter, workspace_id) = resolve_memory_scope(&query.scope, &state.workspace)?;

    let hits = if let Some(ref q) = query.q {
        let q = q.trim();
        if q.is_empty() || q.chars().count() > 256 {
            return Err(ApiError::bad_request("q must be 1–256 characters"));
        }
        match scope_filter {
            None => store.search(q, limit),
            Some(crate::native_memory::MemoryScope::Global) => store.search(q, limit).map(|h| {
                h.into_iter()
                    .filter(|h| scope_label_for_source(&h.source, &root) == "global")
                    .collect()
            }),
            Some(crate::native_memory::MemoryScope::Workspace) => store
                .search_for_workspace(&state.workspace, q, limit)
                .map(|h| {
                    h.into_iter()
                        .filter(|h| scope_label_for_source(&h.source, &root) == "workspace")
                        .collect()
                }),
        }
    } else {
        store.list_all(scope_filter, workspace_id.as_deref(), limit)
    }
    .map_err(|e| ApiError::internal(format!("memory list error: {e}")))?;

    let entries: Vec<MemoryEntryRecord> = hits
        .into_iter()
        .map(|h| memory_hit_to_record(h, &root))
        .collect();
    let total = entries.len();
    Ok(Json(json!({ "entries": entries, "total": total })))
}

/// `GET /v1/memory/{id}` — inspect a single memory entry.
///
/// The lookup is scoped to global memory plus the current repository's
/// workspace memory; numeric IDs from a different machine or repository
/// will not resolve.
async fn get_memory_entry(
    State(state): State<RuntimeApiState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let store = native_store_for_state(&state);
    let root = store.root().to_path_buf();
    let hit = store
        .get_for_workspace(&state.workspace, id)
        .map_err(|e| ApiError::internal(format!("memory lookup error: {e}")))?
        .ok_or_else(|| ApiError::not_found(format!("memory entry '{id}' not found")))?;
    let entry = memory_hit_to_record(hit, &root);
    Ok(Json(json!({ "entry": entry })))
}

/// `POST /v1/memory` — append a new memory entry.
///
/// The note is treated as user data (lower authority than instructions).
/// Requires the standard Runtime auth token when auth is configured.
async fn create_memory_entry(
    State(state): State<RuntimeApiState>,
    Json(req): Json<CreateMemoryRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let scope_str = if req.scope.is_empty() {
        "global"
    } else {
        req.scope.as_str()
    };
    let scope = match scope_str.trim() {
        "global" => crate::native_memory::MemoryScope::Global,
        "workspace" => crate::native_memory::MemoryScope::Workspace,
        other => {
            return Err(ApiError::bad_request(format!(
                "Invalid scope '{other}': expected 'global' or 'workspace'"
            )));
        }
    };
    let workspace_id = if scope == crate::native_memory::MemoryScope::Workspace {
        let id = crate::native_memory::NativeMemoryStore::workspace_id(&state.workspace)
            .map_err(|e| ApiError::internal(format!("resolve workspace id: {e}")))?
            .ok_or_else(|| {
                ApiError::bad_request(
                    "workspace scope requires a git repository with a remote origin",
                )
            })?;
        Some(id)
    } else {
        None
    };
    let store = native_store_for_state(&state);
    let root = store.root().to_path_buf();
    let hit = store
        .remember(scope, workspace_id.as_deref(), &req.text)
        .map_err(|e| ApiError::bad_request(format!("memory create error: {e}")))?;
    let entry = memory_hit_to_record(hit, &root);
    Ok((StatusCode::CREATED, Json(json!({ "entry": entry }))))
}

/// `DELETE /v1/memory` — clear all memory entries for the given scope.
///
/// The `scope` query parameter is required: `"global"`, `"workspace"`, or
/// `"all"`.  This is a destructive, non-reversible operation.
async fn clear_memory(
    State(state): State<RuntimeApiState>,
    Query(query): Query<ClearMemoryQuery>,
) -> Result<Json<Value>, ApiError> {
    let (scope_filter, workspace_id) = resolve_memory_scope(&Some(query.scope), &state.workspace)?;
    let store = native_store_for_state(&state);
    store
        .delete_all(scope_filter, workspace_id.as_deref())
        .map_err(|e| ApiError::internal(format!("memory clear error: {e}")))?;
    Ok(Json(json!({ "cleared": true })))
}

const MOBILE_HTML: &str = include_str!("runtime_mobile.html");

/// Built-in dev origins always allowed by the runtime API (whalescale#255).
const DEFAULT_CORS_ORIGINS: &[&str] = &[
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "tauri://localhost",
];

fn cors_layer(extra_origins: &[String]) -> CorsLayer {
    let mut origins: Vec<HeaderValue> = DEFAULT_CORS_ORIGINS
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();
    for raw in extra_origins {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        match HeaderValue::from_str(trimmed) {
            Ok(value) if !origins.contains(&value) => origins.push(value),
            Ok(_) => {}
            Err(err) => tracing::warn!(
                "Ignoring invalid CORS origin '{trimmed}': {err}; expected scheme://host[:port]"
            ),
        }
    }
    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::ACCEPT,
            HeaderName::from_static("x-hakus-runtime-token"),
            HeaderName::from_static("x-deepseek-runtime-token"),
        ])
}

fn map_task_err(err: anyhow::Error) -> ApiError {
    let message = err.to_string();
    if message.contains("not found") {
        ApiError::not_found(message)
    } else {
        ApiError::bad_request(message)
    }
}

fn map_automation_err(err: anyhow::Error) -> ApiError {
    let message = err.to_string();
    if message.contains("Failed to read automation")
        || message.contains("No such file or directory")
    {
        ApiError::not_found(message)
    } else {
        ApiError::bad_request(message)
    }
}

fn map_thread_err(err: anyhow::Error) -> ApiError {
    let message = err.to_string();
    let lower = message.to_ascii_lowercase();
    if (lower.starts_with("thread '") && lower.ends_with("' not found"))
        || lower.starts_with("thread not found:")
    {
        ApiError::not_found(message)
    } else if message.contains("already has an active turn")
        || message.contains("has an active turn")
        || message.contains("No active turn")
        || message.contains("is not active")
    {
        ApiError {
            status: StatusCode::CONFLICT,
            message,
        }
    } else if crate::runtime_threads::is_runtime_store_failure(&message) {
        // Store/filesystem faults are backend failures, not request errors —
        // reporting them as 400 made the GUI label them "请求参数错误".
        ApiError::internal(message)
    } else {
        ApiError::bad_request(message)
    }
}

fn map_agent_mail_err(err: anyhow::Error) -> ApiError {
    let message = err.to_string();
    let lower = message.to_ascii_lowercase();
    if lower.contains("ownership denied") {
        ApiError::forbidden(message)
    } else if lower.contains("already exists with different delivery intent") {
        ApiError::conflict(message)
    } else if (lower.contains("failed to read agent mail envelope")
        && lower.contains("no such file"))
        || (lower.starts_with("thread '") && lower.ends_with("' not found"))
    {
        ApiError::not_found(message)
    } else {
        ApiError::bad_request(message)
    }
}

#[derive(Debug, Clone)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }

    fn not_implemented(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_IMPLEMENTED,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({
                "error": {
                    "message": self.message,
                    "status": self.status.as_u16(),
                }
            })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests;
