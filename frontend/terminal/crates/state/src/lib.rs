//! Persistent state management for conversation threads, messages, and jobs.
//!
//! The [`StateStore`] is the primary entry point, backed by a SQLite database and an
//! append-only JSONL session index file. It provides CRUD operations for:
//!
//! - **Threads** — conversation metadata, archival, and session indexing.
//! - **Messages** — append-only message storage with tree-structured branching.
//! - **Checkpoints** — named state snapshots for restoring conversation progress.
//! - **Jobs** — background task tracking with status and progress.
//! - **Dynamic tools** — per-thread tool registrations.
//! - **Runtime ledger** — versioned append-only events with per-session cursors
//!   and a checksum-bound importer for legacy Python JSONL.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

/// Serializes all `session_index.jsonl` read/append/compact/rename operations so
/// concurrent `StateStore` clones cannot interleave an append with a compaction
/// rename and silently drop entries.
static SESSION_INDEX_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

use anyhow::{Context, Result};
use chrono::{TimeZone, Utc};
use hakus_paths::{HAKUS_APP_DIR, hakus_home_override};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

// Re-export protocol's ThreadStatus so callers in the state crate and
// external consumers (e.g. core) can reference a single canonical definition.
pub use hakus_protocol::ThreadStatus;

/// Indicates how a session was initiated.
///
/// Serialized as lowercase snake_case strings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionSource {
    /// Started by a user interacting with the CLI.
    Interactive,
    /// Resumed from a previously persisted session.
    Resume,
    /// Created by forking an existing conversation at a specific message.
    Fork,
    /// Initiated programmatically via the API.
    Api,
    /// Source is unknown or unspecified.
    Unknown,
}

/// Metadata for a persisted conversation thread.
///
/// Each thread represents a single conversation session and stores its
/// configuration, git context, and current status.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadMetadata {
    /// Unique identifier for this thread.
    pub id: String,
    /// Optional filesystem path to the rollout (JSONL transcript) file.
    pub rollout_path: Option<PathBuf>,
    /// Short preview or summary of the thread content.
    pub preview: String,
    /// Whether this thread is ephemeral (not persisted long-term).
    pub ephemeral: bool,
    /// Identifier of the model provider used for this thread (e.g. `"openai"`).
    pub model_provider: String,
    /// Unix timestamp (seconds) when the thread was created.
    pub created_at: i64,
    /// Unix timestamp (seconds) of the most recent update to the thread.
    pub updated_at: i64,
    /// Current lifecycle status of the thread.
    pub status: ThreadStatus,
    /// Optional filesystem path associated with the thread working context.
    pub path: Option<PathBuf>,
    /// Working directory that was active when the thread was created.
    pub cwd: PathBuf,
    /// Version of the CLI that created this thread.
    pub cli_version: String,
    /// How this session was initiated.
    pub source: SessionSource,
    /// User-assigned display name for the thread.
    pub name: Option<String>,
    /// Serialized sandbox policy applied to this thread, if any.
    pub sandbox_policy: Option<String>,
    /// Approval mode configured for tool calls in this thread.
    pub approval_mode: Option<String>,
    /// Whether the thread has been archived.
    pub archived: bool,
    /// Unix timestamp (seconds) when the thread was archived, or `None` if not archived.
    pub archived_at: Option<i64>,
    /// Git commit SHA of the working tree when the thread was created.
    pub git_sha: Option<String>,
    /// Git branch checked out when the thread was created.
    pub git_branch: Option<String>,
    /// URL of the git remote origin, if available.
    pub git_origin_url: Option<String>,
    /// Memory mode configured for this thread (e.g. `"local"`, `"remote"`).
    pub memory_mode: Option<String>,
    /// ID of the current leaf message in the conversation tree.
    pub current_leaf_id: Option<i64>,
}

/// A dynamically registered tool associated with a thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamicToolRecord {
    /// Ordinal position of this tool in the thread tool list.
    pub position: i64,
    /// Unique name identifying the tool.
    pub name: String,
    /// Human-readable description of what the tool does.
    pub description: Option<String>,
    /// JSON Schema describing the tool input parameters.
    pub input_schema: Value,
}

/// A single message entry in a conversation thread.
///
/// Messages form a tree structure via [`parent_entry_id`](Self::parent_entry_id),
/// enabling conversation branching and forking.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageRecord {
    /// Auto-incremented unique identifier for this message.
    pub id: i64,
    /// ID of the thread this message belongs to.
    pub thread_id: String,
    /// Role of the message sender (e.g. `"user"`, `"assistant"`, `"system"`).
    pub role: String,
    /// Text content of the message.
    pub content: String,
    /// Optional structured item payload (tool calls, tool results, etc.).
    pub item: Option<Value>,
    /// Unix timestamp (seconds) when the message was created.
    pub created_at: i64,
    /// ID of the parent message, forming a tree structure. `None` for root messages.
    pub parent_entry_id: Option<i64>,
}

/// An event submitted to the canonical runtime ledger without a client-owned
/// sequence number. The state store allocates `seq` atomically per session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LedgerEventAppend {
    pub event_id: String,
    pub session_id: String,
    pub event_type: String,
    pub workspace_id: Option<String>,
    pub turn_id: Option<String>,
    pub correlation_id: Option<String>,
    pub parent_event_id: Option<String>,
    pub actor: Value,
    pub visibility: String,
    pub payload: Value,
    pub timestamp: String,
}

/// A canonical event returned by the ledger after sequence allocation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LedgerEventRecord {
    pub event_id: String,
    pub session_id: String,
    pub seq: u64,
    pub event_type: String,
    pub workspace_id: Option<String>,
    pub turn_id: Option<String>,
    pub correlation_id: Option<String>,
    pub parent_event_id: Option<String>,
    pub actor: Value,
    pub visibility: String,
    pub payload: Value,
    pub timestamp: String,
}

/// Result of a read-only ledger integrity check.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LedgerVerification {
    pub session_id: String,
    pub event_count: u64,
    pub last_seq: u64,
    pub contiguous: bool,
}

/// Aggregate counters used by Runtime diagnostics. The values are deliberately
/// read-only and do not expose event payloads or credential-shaped fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LedgerStats {
    pub event_count: u64,
    pub session_count: u64,
}

/// One session whose ledger sequence is not contiguous.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LedgerIntegrityFailure {
    pub session_id: String,
    pub event_count: u64,
    pub last_seq: u64,
}

/// Result of verifying every ledger session.
///
/// Only failures carry per-session detail, so a healthy store produces a small
/// response while a damaged one names the sessions to investigate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct LedgerIntegrityReport {
    pub sessions_verified: u64,
    pub events_verified: u64,
    pub non_contiguous: Vec<LedgerIntegrityFailure>,
}

impl LedgerIntegrityReport {
    /// True when every verified session's sequence was contiguous.
    pub fn is_healthy(&self) -> bool {
        self.non_contiguous.is_empty()
    }
}

/// Summary returned by the one-way legacy JSONL importer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LedgerImportSummary {
    pub session_id: String,
    pub source_path: PathBuf,
    pub source_sha256: String,
    pub imported: u64,
    pub skipped: u64,
}

/// Summary returned by importing Python's SQLite session projection and its
/// optional JSON checkpoint file into the Rust state boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LegacySessionImportSummary {
    pub target_session_id: String,
    pub source_session_id: String,
    pub source_sha256: String,
    pub imported_messages: u64,
    pub skipped_messages: u64,
    pub imported_checkpoints: u64,
    pub skipped_checkpoints: u64,
}

/// One session inside a discovered legacy Python store.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LegacyDiscoveredSession {
    pub session_id: String,
    pub title: String,
    pub provider: Option<String>,
    pub message_count: u64,
    /// Milliseconds since the Unix epoch, as the legacy store records them.
    pub created_at: i64,
    pub updated_at: i64,
}

/// A legacy Python session store found on the search path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LegacyDiscoveredStore {
    pub path: PathBuf,
    /// On-disk size, so a person can tell a real store from a stub.
    pub size_bytes: u64,
    /// `Some` when a sibling `checkpoints.json` exists next to the store.
    pub checkpoint_path: Option<PathBuf>,
    pub sessions: Vec<LegacyDiscoveredSession>,
}

/// A `sessions.db` that was found but cannot be read as a legacy store.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LegacyRejectedStore {
    pub path: PathBuf,
    pub reason: String,
}

/// The read-only result of scanning for legacy Python session stores.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct LegacyDiscovery {
    pub stores: Vec<LegacyDiscoveredStore>,
    pub rejected: Vec<LegacyRejectedStore>,
}

impl LegacyDiscovery {
    /// Total sessions across every readable store.
    pub fn total_sessions(&self) -> u64 {
        self.stores
            .iter()
            .map(|store| store.sessions.len() as u64)
            .sum()
    }

    /// Total messages across every readable store.
    pub fn total_messages(&self) -> u64 {
        self.stores
            .iter()
            .flat_map(|store| store.sessions.iter())
            .map(|session| session.message_count)
            .sum()
    }
}

/// Read one legacy store's session list without modifying it.
///
/// The schema is checked before any row is read: a SQLite file that is not a
/// Python session store must be rejected as such, not reported as an empty
/// store a caller might then "import" nothing from.
fn read_legacy_session_store(path: &Path) -> Result<LegacyDiscoveredStore> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("failed to stat {}", path.display()))?;
    let source = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("failed to open {}", path.display()))?;
    for table in ["sessions", "messages"] {
        let present: Option<String> = source
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |row| row.get(0),
            )
            .optional()
            .with_context(|| format!("failed to inspect {}", path.display()))?;
        if present.is_none() {
            anyhow::bail!("not a legacy session store: no `{table}` table");
        }
    }
    let mut statement = source
        .prepare(
            r#"
            SELECT s.id, s.title, s.provider, s.created_at, s.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id)
            FROM sessions s
            ORDER BY s.updated_at DESC, s.id ASC
            "#,
        )
        .context("failed to prepare legacy session discovery query")?;
    let sessions = statement
        .query_map([], |row| {
            Ok(LegacyDiscoveredSession {
                session_id: row.get(0)?,
                title: row.get(1)?,
                provider: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                message_count: u64::try_from(row.get::<_, i64>(5)?).unwrap_or(0),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .with_context(|| format!("failed to read sessions from {}", path.display()))?;
    let checkpoint_path = {
        let sibling = path.with_file_name("checkpoints.json");
        sibling.is_file().then_some(sibling)
    };
    Ok(LegacyDiscoveredStore {
        path: path.to_path_buf(),
        size_bytes: metadata.len(),
        checkpoint_path,
        sessions,
    })
}

type RawLedgerEvent = (
    String,
    String,
    i64,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    String,
);

fn decode_ledger_event(raw: RawLedgerEvent) -> Result<LedgerEventRecord> {
    let (
        event_id,
        session_id,
        seq,
        event_type,
        workspace_id,
        turn_id,
        correlation_id,
        parent_event_id,
        actor_json,
        visibility,
        payload_json,
        timestamp,
    ) = raw;
    Ok(LedgerEventRecord {
        event_id,
        session_id,
        seq: u64::try_from(seq).context("ledger sequence is negative")?,
        event_type,
        workspace_id,
        turn_id,
        correlation_id,
        parent_event_id,
        actor: serde_json::from_str(&actor_json).context("invalid ledger actor JSON")?,
        visibility,
        payload: serde_json::from_str(&payload_json).context("invalid ledger payload JSON")?,
        timestamp,
    })
}

/// Validate the stable envelope shape before an event becomes durable. The
/// registry is intentionally additive: unknown event names remain replayable
/// for forward compatibility, while the core runtime events cannot silently
/// lose the payload needed by desktop projections.
fn validate_ledger_payload(event_type: &str, payload: &Value) -> Result<()> {
    let object = payload
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("ledger payload for {event_type} must be a JSON object"))?;
    let required: &[&str] = match event_type {
        "thread.started" | "thread.updated" => &["thread"],
        "turn.started" | "turn.completed" | "turn.failed" | "turn.canceled" => &["turn"],
        "item.started" | "item.completed" | "item.failed" => &["item"],
        "item.delta" => &["delta", "kind"],
        _ => &[],
    };
    for key in required {
        if !object.contains_key(*key) {
            anyhow::bail!("ledger payload for {event_type} is missing '{key}'");
        }
    }
    Ok(())
}

/// A named checkpoint capturing the state of a thread at a point in time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointRecord {
    /// ID of the thread this checkpoint belongs to.
    pub thread_id: String,
    /// Unique identifier for this checkpoint within its thread.
    pub checkpoint_id: String,
    /// Serialized state snapshot stored as a JSON value.
    pub state: Value,
    /// Unix timestamp (seconds) when the checkpoint was created or last updated.
    pub created_at: i64,
}

/// Status of a background job.
///
/// Serialized as lowercase snake_case strings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStateStatus {
    /// Job is waiting to be executed.
    Queued,
    /// Job is currently executing.
    Running,
    /// Job has been temporarily paused.
    Paused,
    /// Job has finished successfully.
    Completed,
    /// Job has failed with an error.
    Failed,
    /// Job was cancelled before completion.
    Cancelled,
}

/// Persisted state of a background job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobStateRecord {
    /// Unique identifier for the job.
    pub id: String,
    /// Human-readable name describing the job.
    pub name: String,
    /// Current lifecycle status of the job.
    pub status: JobStateStatus,
    /// Completion progress as a percentage (0--100), if available.
    pub progress: Option<u8>,
    /// Optional detail message providing additional status information.
    pub detail: Option<String>,
    /// Unix timestamp (seconds) when the job was created.
    pub created_at: i64,
    /// Unix timestamp (seconds) of the most recent status update.
    pub updated_at: i64,
}

/// Persisted lifecycle status for a thread goal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadGoalStatus {
    /// Goal is active and should continue receiving work.
    Active,
    /// Goal is paused by the user.
    Paused,
    /// Goal is blocked and cannot make meaningful progress.
    Blocked,
    /// Goal stopped because account/service usage limits were reached.
    UsageLimited,
    /// Goal stopped because its explicit token budget was reached.
    BudgetLimited,
    /// Goal has been completed.
    Complete,
}

/// Persisted goal state attached to a thread.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadGoalRecord {
    /// Thread this goal belongs to.
    pub thread_id: String,
    /// Stable identifier for this goal revision.
    pub goal_id: String,
    /// User-visible objective.
    pub objective: String,
    /// Current lifecycle status.
    pub status: ThreadGoalStatus,
    /// Optional token budget requested by the user.
    pub token_budget: Option<i64>,
    /// Tokens consumed while pursuing the goal.
    pub tokens_used: i64,
    /// Elapsed wall-clock work time in seconds.
    pub time_used_seconds: i64,
    /// Durable continuation passes dispatched for this objective.
    pub continuation_count: i64,
    /// Unix timestamp (seconds) when the goal was created.
    pub created_at: i64,
    /// Unix timestamp (seconds) when the goal was last updated.
    pub updated_at: i64,
}

/// Filters for listing conversation threads.
#[derive(Debug, Clone)]
pub struct ThreadListFilters {
    /// Whether to include archived threads in the results.
    pub include_archived: bool,
    /// Maximum number of threads to return. Defaults to 50.
    pub limit: Option<usize>,
}

impl Default for ThreadListFilters {
    fn default() -> Self {
        Self {
            include_archived: false,
            limit: Some(50),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionIndexEntry {
    thread_id: String,
    thread_name: Option<String>,
    updated_at: i64,
    rollout_path: Option<PathBuf>,
}

/// Rewrite the session index once the append-only log grows large enough that
/// full-file scans become costly. Lookups already dedupe by thread id, so
/// compaction keeps only the latest entry per thread.
fn session_index_compact_line_threshold() -> usize {
    if cfg!(test) { 5 } else { 5_000 }
}

/// Persistent storage for conversation threads, messages, checkpoints, and jobs.
///
/// Backed by a SQLite database and an append-only JSONL session index file.
/// The database schema is automatically initialized and migrated on [`open`](Self::open).
///
/// HakusAgent 对齐：Python `hakus.checkpoint.CheckpointManager` 的持久化对应物
/// 是本类型的 `save_checkpoint` / checkpoint 查询族方法（SQLite 落盘；Python
/// 侧为内存+文件）。新代码可用别名 [`CheckpointManager`]。
#[derive(Debug, Clone)]
pub struct StateStore {
    db_path: PathBuf,
    session_index_path: PathBuf,
    // Single long-lived connection shared by all clones. SQLite pragmas are
    // per-connection, so opening once in `open` and applying them there keeps
    // every operation consistent without re-opening the database per call.
    conn: Arc<Mutex<Connection>>,
}

/// HakusAgent 对齐别名：`hakus.checkpoint.CheckpointManager`。见 [`StateStore`]。
pub type CheckpointManager = StateStore;

impl StateStore {
    /// Open (or create) a state store at the given database path.
    ///
    /// If `path` is `None`, the default location (`~/.hakus/state.db`, with
    /// `~/.hakus/state.db` is used.
    /// The database schema is created automatically if it does not exist.
    pub fn open(path: Option<PathBuf>) -> Result<Self> {
        let db_path = path.unwrap_or_else(default_state_db_path);
        let session_index_path = db_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("session_index.jsonl");
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create state directory {}", parent.display())
            })?;
        }
        let conn = Connection::open(&db_path)
            .with_context(|| format!("failed to open state db {}", db_path.display()))?;
        Self::configure_connection(&conn, &db_path)?;
        Self::init_schema(&conn)?;
        Ok(Self {
            db_path,
            session_index_path,
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Apply connection-level SQLite settings that must hold for every open.
    ///
    /// Enables WAL so readers and writers from concurrent CodeWhale processes
    /// do not block each other as aggressively as the default rollback journal,
    /// and sets a multi-second busy timeout so a second process retries on
    /// `SQLITE_BUSY` instead of failing immediately (issue #4734).
    fn configure_connection(conn: &Connection, db_path: &Path) -> Result<()> {
        // Install our wait policy before touching database-level settings or
        // schema. Connection::open may currently provide a dependency default,
        // but StateStore must not rely on that incidental behavior.
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .with_context(|| format!("failed to set busy_timeout for {}", db_path.display()))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .with_context(|| format!("failed to enable foreign keys for {}", db_path.display()))?;

        // WAL persists in the database header, so established stores need no
        // write-like journal transition on every process start. Fresh or
        // explicitly downgraded stores still transition once, and we verify
        // SQLite accepted the requested mode instead of silently retaining the
        // previous one (for example on an unsupported VFS).
        let journal_mode: String = conn
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .with_context(|| format!("failed to read journal mode for {}", db_path.display()))?;
        if !journal_mode.eq_ignore_ascii_case("wal") {
            let configured_mode: String = conn
                .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
                .with_context(|| format!("failed to enable WAL for {}", db_path.display()))?;
            if !configured_mode.eq_ignore_ascii_case("wal") {
                anyhow::bail!(
                    "failed to enable WAL for {}: SQLite retained journal mode {configured_mode}",
                    db_path.display()
                );
            }
        }
        Ok(())
    }

    /// Returns the filesystem path of the underlying SQLite database.
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// Append one event and allocate its per-session sequence in the same
    /// SQLite write transaction. Clients must never provide a sequence.
    pub fn append_ledger_event(&self, event: &LedgerEventAppend) -> Result<LedgerEventRecord> {
        if event.event_id.trim().is_empty() {
            anyhow::bail!("ledger event_id cannot be empty");
        }
        if event.session_id.trim().is_empty() {
            anyhow::bail!("ledger session_id cannot be empty");
        }
        if event.event_type.trim().is_empty() {
            anyhow::bail!("ledger event_type cannot be empty");
        }
        if event.visibility.trim().is_empty() {
            anyhow::bail!("ledger visibility cannot be empty");
        }
        validate_ledger_payload(&event.event_type, &event.payload)?;

        let actor = redact_legacy_value(event.actor.clone());
        let payload = redact_legacy_value(event.payload.clone());
        let actor_json =
            serde_json::to_string(&actor).context("failed to serialize ledger event actor")?;
        let payload_json =
            serde_json::to_string(&payload).context("failed to serialize ledger event payload")?;
        let mut conn = self.conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("failed to begin ledger append transaction")?;

        // Event IDs are the migration idempotency boundary. A retry after a
        // process restart must return the original record instead of turning a
        // durable event into a shadow-write error.
        if let Some(existing) = tx
            .query_row(
                r#"
                SELECT event_id, session_id, seq, event_type, workspace_id, turn_id,
                       correlation_id, parent_event_id, actor_json, visibility,
                       payload_json, timestamp
                FROM ledger_events
                WHERE event_id = ?1
                "#,
                params![event.event_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, String>(10)?,
                        row.get::<_, String>(11)?,
                    ))
                },
            )
            .optional()
            .context("failed to check ledger event idempotency")?
        {
            let existing = decode_ledger_event(existing)?;
            if existing.session_id != event.session_id
                || existing.event_type != event.event_type
                || existing.payload != payload
            {
                anyhow::bail!(
                    "ledger event_id '{}' already exists with different content",
                    event.event_id
                );
            }
            tx.commit().context("failed to finish idempotent ledger append")?;
            return Ok(existing);
        }
        let next_seq: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM ledger_events WHERE session_id = ?1",
                params![event.session_id],
                |row| row.get(0),
            )
            .context("failed to allocate ledger event sequence")?;
        tx.execute(
            r#"
            INSERT INTO ledger_events (
                event_id, session_id, seq, event_type, workspace_id, turn_id,
                correlation_id, parent_event_id, actor_json, visibility,
                payload_json, timestamp
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            "#,
            params![
                event.event_id,
                event.session_id,
                next_seq,
                event.event_type,
                event.workspace_id,
                event.turn_id,
                event.correlation_id,
                event.parent_event_id,
                actor_json,
                event.visibility,
                payload_json,
                event.timestamp,
            ],
        )
        .context("failed to append ledger event")?;
        tx.commit().context("failed to commit ledger event")?;

        Ok(LedgerEventRecord {
            event_id: event.event_id.clone(),
            session_id: event.session_id.clone(),
            seq: u64::try_from(next_seq).context("ledger sequence overflow")?,
            event_type: event.event_type.clone(),
            workspace_id: event.workspace_id.clone(),
            turn_id: event.turn_id.clone(),
            correlation_id: event.correlation_id.clone(),
            parent_event_id: event.parent_event_id.clone(),
            actor,
            visibility: event.visibility.clone(),
            payload,
            timestamp: event.timestamp.clone(),
        })
    }

    /// Read canonical events after an optional per-session sequence cursor.
    pub fn list_ledger_events(
        &self,
        session_id: &str,
        after_seq: u64,
        limit: usize,
    ) -> Result<Vec<LedgerEventRecord>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT event_id, session_id, seq, event_type, workspace_id, turn_id,
                   correlation_id, parent_event_id, actor_json, visibility,
                   payload_json, timestamp
            FROM ledger_events
            WHERE session_id = ?1 AND seq > ?2
            ORDER BY seq ASC
            LIMIT ?3
            "#,
        )?;
        let rows = stmt.query_map(params![session_id, after_seq as i64, limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
            ))
        })?;
        let mut events = Vec::new();
        for row in rows {
            let raw = row?;
            events.push(decode_ledger_event(raw)?);
        }
        Ok(events)
    }

    /// Verify sequence continuity and JSON integrity without mutating state.
    pub fn verify_ledger(&self, session_id: &str) -> Result<LedgerVerification> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT seq, event_type, actor_json, payload_json FROM ledger_events WHERE session_id = ?1 ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        let mut expected = 1_u64;
        let mut count = 0_u64;
        for row in rows {
            let (seq, event_type, actor_json, payload_json) = row?;
            let seq = u64::try_from(seq).context("ledger sequence is negative")?;
            if seq != expected {
                anyhow::bail!(
                    "ledger sequence gap for session {}: expected {}, found {}",
                    session_id,
                    expected,
                    seq
                );
            }
            serde_json::from_str::<Value>(&actor_json)
                .context("ledger actor_json is not valid JSON")?;
            let payload = serde_json::from_str::<Value>(&payload_json)
                .context("ledger payload_json is not valid JSON")?;
            validate_ledger_payload(&event_type, &payload)?;
            expected = expected.saturating_add(1);
            count = count.saturating_add(1);
        }
        Ok(LedgerVerification {
            session_id: session_id.to_string(),
            event_count: count,
            last_seq: count,
            contiguous: true,
        })
    }

    /// Return aggregate ledger counters for diagnostics and migration rollout.
    pub fn ledger_stats(&self) -> Result<LedgerStats> {
        let conn = self.conn()?;
        let (event_count, session_count): (i64, i64) = conn.query_row(
            "SELECT COUNT(*), COUNT(DISTINCT session_id) FROM ledger_events",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(LedgerStats {
            event_count: u64::try_from(event_count).context("ledger event count is negative")?,
            session_count: u64::try_from(session_count)
                .context("ledger session count is negative")?,
        })
    }

    /// Verify every session's ledger and summarize the result.
    ///
    /// Diagnostics need to answer "is the canonical log trustworthy right now"
    /// without reading the whole log back: this verifies each session and
    /// reports only the ones that fail, plus the totals. A healthy store is
    /// therefore a small response, and a damaged one names exactly which
    /// sessions to look at.
    pub fn verify_all_ledgers(&self) -> Result<LedgerIntegrityReport> {
        // `conn()` returns a mutex guard, and `verify_ledger` takes the same
        // mutex. The session list must therefore be collected and the guard
        // released *before* the per-session verification runs, or the second
        // lock is a self-deadlock.
        let session_ids = {
            let conn = self.conn()?;
            let mut statement = conn.prepare(
                "SELECT DISTINCT session_id FROM ledger_events ORDER BY session_id ASC",
            )?;
            let session_ids = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            session_ids
        };

        let mut sessions_verified = 0_u64;
        let mut events_verified = 0_u64;
        let mut non_contiguous = Vec::new();
        for session_id in session_ids {
            // `verify_ledger` *fails* on a gap rather than returning
            // `contiguous: false`, and a gap is precisely what this report
            // exists to describe. A broken session is therefore recorded as a
            // finding, not propagated: one damaged session must not hide the
            // state of every other one.
            match self.verify_ledger(&session_id) {
                Ok(verification) => {
                    sessions_verified = sessions_verified.saturating_add(1);
                    events_verified = events_verified.saturating_add(verification.event_count);
                    if !verification.contiguous {
                        non_contiguous.push(LedgerIntegrityFailure {
                            session_id,
                            event_count: verification.event_count,
                            last_seq: verification.last_seq,
                        });
                    }
                }
                Err(error) => {
                    let (event_count, last_seq) = self
                        .ledger_bounds(&session_id)
                        .unwrap_or((0, 0));
                    sessions_verified = sessions_verified.saturating_add(1);
                    events_verified = events_verified.saturating_add(event_count);
                    non_contiguous.push(LedgerIntegrityFailure {
                        session_id: session_id.clone(),
                        event_count,
                        last_seq,
                    });
                    tracing::warn!(
                        session_id = %session_id,
                        error = %error,
                        "canonical ledger session failed verification"
                    );
                }
            }
        }
        Ok(LedgerIntegrityReport {
            sessions_verified,
            events_verified,
            non_contiguous,
        })
    }

    /// Event count and highest sequence for one session, for reporting a
    /// session whose verification failed.
    fn ledger_bounds(&self, session_id: &str) -> Result<(u64, u64)> {
        let conn = self.conn()?;
        let (count, last): (i64, Option<i64>) = conn.query_row(
            "SELECT COUNT(*), MAX(seq) FROM ledger_events WHERE session_id = ?1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok((
            u64::try_from(count).unwrap_or(0),
            u64::try_from(last.unwrap_or(0)).unwrap_or(0),
        ))
    }

    /// Import a legacy Python session JSONL file exactly once per event.
    ///
    /// Event ids include the source checksum and line number, making retries
    /// idempotent while preserving a source fingerprint for migration audit.
    /// The legacy file is never modified and remains available for rollback.
    pub fn import_legacy_jsonl(
        &self,
        session_id: &str,
        source_path: &Path,
    ) -> Result<LedgerImportSummary> {
        let bytes = fs::read(source_path).with_context(|| {
            format!("failed to read legacy event log {}", source_path.display())
        })?;
        let source_sha256 = format!("sha256:{}", hex_digest(&bytes));
        let text = String::from_utf8(bytes).context("legacy event log is not UTF-8")?;
        let mut imported = 0_u64;
        let mut skipped = 0_u64;
        for (line_index, line) in text.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let payload: Value = match serde_json::from_str::<Value>(line) {
                Ok(value) if value.is_object() => value,
                Ok(_) | Err(_) => {
                    skipped = skipped.saturating_add(1);
                    continue;
                }
            };
            let event_type = legacy_event_type(payload.get("type").and_then(Value::as_str));
            let payload = redact_legacy_value(payload);
            let event_id = format!(
                "legacy_{}_{}",
                source_sha256.trim_start_matches("sha256:"),
                line_index
            );
            if self.ledger_event_exists(&event_id)? {
                skipped = skipped.saturating_add(1);
                continue;
            }
            let turn_id = payload
                .get("turn")
                .and_then(Value::as_i64)
                .map(|turn| format!("legacy-turn-{turn}"));
            let workspace_id = payload
                .get("working_dir")
                .and_then(Value::as_str)
                .map(str::to_string);
            let timestamp = legacy_timestamp(payload.get("ts").and_then(Value::as_f64));
            self.append_ledger_event(&LedgerEventAppend {
                event_id,
                session_id: session_id.to_string(),
                event_type: event_type.to_string(),
                workspace_id,
                turn_id,
                correlation_id: Some(source_sha256.clone()),
                parent_event_id: None,
                actor: serde_json::json!({
                    "kind": "legacy_python",
                    "id": "session_log"
                }),
                visibility: "model_and_ui".to_string(),
                payload,
                timestamp,
            })?;
            imported = imported.saturating_add(1);
        }
        self.record_compat_imported_events(imported)?;
        Ok(LedgerImportSummary {
            session_id: session_id.to_string(),
            source_path: source_path.to_path_buf(),
            source_sha256,
            imported,
            skipped,
        })
    }

    /// Increment the persisted counter of canonical events imported from
    /// Python compatibility sources (Phase 0 migration metric). The count
    /// survives restarts because it lives in the state database, not in
    /// process memory.
    pub fn record_compat_imported_events(&self, count: u64) -> Result<()> {
        if count == 0 {
            return Ok(());
        }
        let conn = self.conn()?;
        conn.execute(
            "UPDATE migration_metrics SET value = value + ?1 WHERE key = 'compat_imported_events'",
            params![i64::try_from(count).unwrap_or(i64::MAX)],
        )
        .context("failed to record compat imported events")?;
        Ok(())
    }

    /// Persisted count of canonical events imported from Python
    /// compatibility sources. Zero until an import has happened; never
    /// decremented — it is a migration-progress metric, not a live count.
    pub fn compat_imported_event_count(&self) -> Result<u64> {
        let conn = self.conn()?;
        let value: i64 = conn
            .query_row(
                "SELECT value FROM migration_metrics WHERE key = 'compat_imported_events'",
                [],
                |row| row.get(0),
            )
            .optional()
            .context("failed to read compat imported event count")?
            .unwrap_or(0);
        Ok(u64::try_from(value).unwrap_or(0))
    }

    /// Discover the legacy Python session stores a migration could import.
    ///
    /// Discovery is deliberately read-only and bounded: each candidate root is
    /// inspected for a `sessions.db`, its schema is checked before any row is
    /// read, and every session is reported with the counts a person needs to
    /// decide what to import. Nothing is written and no source is modified, so a
    /// caller can show this summary and only then choose to import.
    ///
    /// A file that is not a legacy session store — missing tables, unreadable,
    /// or not SQLite at all — is reported as a rejected candidate rather than
    /// failing the whole scan, because a stale or unrelated `sessions.db` on the
    /// search path must not hide the real one.
    pub fn discover_legacy_session_stores(&self, roots: &[PathBuf]) -> LegacyDiscovery {
        let mut stores = Vec::new();
        let mut rejected = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for root in roots {
            let candidate = if root.file_name().is_some_and(|name| name == "sessions.db") {
                root.clone()
            } else {
                root.join("sessions.db")
            };
            // Canonicalize so the same store reached through two roots (for
            // example `~/.hakus` and a symlink to it) is reported once.
            let key = fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
            if !seen.insert(key) {
                continue;
            }
            if !candidate.is_file() {
                continue;
            }
            match read_legacy_session_store(&candidate) {
                Ok(store) => stores.push(store),
                Err(error) => rejected.push(LegacyRejectedStore {
                    path: candidate,
                    reason: format!("{error:#}"),
                }),
            }
        }
        stores.sort_by(|left, right| left.path.cmp(&right.path));
        rejected.sort_by(|left, right| left.path.cmp(&right.path));
        LegacyDiscovery { stores, rejected }
    }

    /// Import one Python sessions.db session and its optional checkpoint
    /// bundle. The source connection is read-only and every row is guarded by
    /// a checksum/source-id marker in the target database, so retries after a
    /// crash are safe and deterministic.
    pub fn import_legacy_session_db(
        &self,
        target_session_id: &str,
        source_path: &Path,
        source_session_id: &str,
        checkpoint_path: Option<&Path>,
    ) -> Result<LegacySessionImportSummary> {
        if target_session_id.trim().is_empty() || source_session_id.trim().is_empty() {
            anyhow::bail!("target_session_id and source_session_id cannot be empty");
        }
        let source_bytes = fs::read(source_path).with_context(|| {
            format!("failed to read legacy session database {}", source_path.display())
        })?;
        let source_sha256 = format!("sha256:{}", hex_digest(&source_bytes));
        let source = Connection::open_with_flags(source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .with_context(|| {
                format!("failed to open legacy session database {}", source_path.display())
            })?;

        let session = source
            .query_row(
                "SELECT title, provider, created_at, updated_at FROM sessions WHERE id = ?1",
                params![source_session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .with_context(|| format!("failed to read legacy session {source_session_id}"))?
            .ok_or_else(|| anyhow::anyhow!("legacy session {source_session_id} was not found"))?;

        if self.get_thread(target_session_id)?.is_none() {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            self.upsert_thread(&ThreadMetadata {
                id: target_session_id.to_string(),
                rollout_path: None,
                preview: session.0.clone(),
                ephemeral: false,
                model_provider: session.1.clone().unwrap_or_else(|| "unknown".to_string()),
                created_at: normalize_legacy_timestamp(session.2),
                updated_at: normalize_legacy_timestamp(session.3),
                status: ThreadStatus::Idle,
                path: None,
                cwd,
                cli_version: env!("CARGO_PKG_VERSION").to_string(),
                source: SessionSource::Api,
                name: Some(session.0.clone()),
                sandbox_policy: None,
                approval_mode: None,
                archived: false,
                archived_at: None,
                git_sha: None,
                git_branch: None,
                git_origin_url: None,
                memory_mode: None,
                current_leaf_id: None,
            })?;
        }

        let mut message_stmt = source
            .prepare(
                "SELECT id, role, content, reasoning, tool_calls_json, input_tokens, output_tokens, error, created_at, updated_at FROM messages WHERE session_id = ?1 ORDER BY created_at ASC, id ASC",
            )
            .context("failed to prepare legacy message import query")?;
        let messages = message_stmt
            .query_map(params![source_session_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(message_stmt);

        let mut imported_messages = 0_u64;
        let mut skipped_messages = 0_u64;
        for (
            source_id,
            role,
            content,
            reasoning,
            tool_calls_json,
            input_tokens,
            output_tokens,
            error,
            created_at,
            updated_at,
        ) in messages
        {
            let mut item = serde_json::Map::new();
            item.insert("legacy_source_id".to_string(), Value::String(source_id.clone()));
            if let Some(value) = reasoning {
                item.insert("reasoning".to_string(), Value::String(value));
            }
            if let Some(value) = tool_calls_json {
                if let Ok(value) = serde_json::from_str::<Value>(&value) {
                    item.insert("tool_calls".to_string(), redact_legacy_value(value));
                }
            }
            if let Some(value) = input_tokens {
                item.insert("input_tokens".to_string(), Value::from(value));
            }
            if let Some(value) = output_tokens {
                item.insert("output_tokens".to_string(), Value::from(value));
            }
            if let Some(value) = error {
                item.insert("error".to_string(), Value::String(value));
            }
            let imported = self.import_legacy_message_once(
                &source_sha256,
                target_session_id,
                &source_id,
                &role,
                &content,
                Value::Object(item),
                normalize_legacy_timestamp(updated_at.max(created_at)),
            )?;
            if imported {
                imported_messages = imported_messages.saturating_add(1);
            } else {
                skipped_messages = skipped_messages.saturating_add(1);
            }
        }

        let mut imported_checkpoints = 0_u64;
        let mut skipped_checkpoints = 0_u64;
        if let Some(checkpoint_path) = checkpoint_path {
            let checkpoint_bytes = fs::read(checkpoint_path).with_context(|| {
                format!("failed to read legacy checkpoint {}", checkpoint_path.display())
            })?;
            let checkpoint_source = format!(
                "{}|sha256:{}",
                source_sha256,
                hex_digest(&checkpoint_bytes)
            );
            let raw: Value = serde_json::from_slice(&checkpoint_bytes).with_context(|| {
                format!("failed to parse legacy checkpoint {}", checkpoint_path.display())
            })?;
            let checkpoints = raw
                .get("checkpoints")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for (checkpoint_id, checkpoint) in checkpoints {
                let created_at = checkpoint
                    .get("timestamp")
                    .and_then(Value::as_f64)
                    .map(|value| value as i64)
                    .unwrap_or_else(|| Utc::now().timestamp());
                let state = redact_legacy_value(checkpoint);
                if self.import_legacy_checkpoint_once(
                    &checkpoint_source,
                    target_session_id,
                    &checkpoint_id,
                    &state,
                    created_at,
                )? {
                    imported_checkpoints = imported_checkpoints.saturating_add(1);
                } else {
                    skipped_checkpoints = skipped_checkpoints.saturating_add(1);
                }
            }
        }

        self.record_compat_imported_events(
            imported_messages.saturating_add(imported_checkpoints),
        )?;
        Ok(LegacySessionImportSummary {
            target_session_id: target_session_id.to_string(),
            source_session_id: source_session_id.to_string(),
            source_sha256,
            imported_messages,
            skipped_messages,
            imported_checkpoints,
            skipped_checkpoints,
        })
    }

    fn import_legacy_message_once(
        &self,
        source_sha256: &str,
        session_id: &str,
        source_id: &str,
        role: &str,
        content: &str,
        item: Value,
        created_at: i64,
    ) -> Result<bool> {
        let mut conn = self.conn()?;
        let tx = conn
            .transaction()
            .context("failed to begin legacy message import")?;
        if tx
            .query_row(
                "SELECT 1 FROM legacy_imports WHERE source_sha256 = ?1 AND source_kind = 'message' AND source_id = ?2",
                params![source_sha256, source_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some()
        {
            tx.commit()?;
            return Ok(false);
        }
        let current_leaf_id: Option<i64> = tx.query_row(
            "SELECT current_leaf_id FROM threads WHERE id = ?1",
            params![session_id],
            |row| row.get(0),
        )?;
        let item_json = serde_json::to_string(&redact_legacy_value(item))?;
        let message_id: i64 = tx.query_row(
            "INSERT INTO messages(thread_id, role, content, item_json, created_at, parent_entry_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id",
            params![session_id, role, content, item_json, created_at, current_leaf_id],
            |row| row.get(0),
        )?;
        tx.execute(
            "UPDATE threads SET current_leaf_id = ?1, updated_at = MAX(updated_at, ?2) WHERE id = ?3",
            params![message_id, created_at, session_id],
        )?;
        let next_seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM ledger_events WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )?;
        let event_id = format!(
            "legacy_{}_message_{}",
            source_sha256.trim_start_matches("sha256:"),
            hex_digest(source_id.as_bytes())
        );
        let payload_json = serde_json::to_string(&redact_legacy_value(json!({
            "source_kind": "message",
            "source_id": source_id,
            "message_id": message_id,
            "role": role,
            "content": content,
        })))?;
        tx.execute(
            "INSERT INTO ledger_events(event_id, session_id, seq, event_type, workspace_id, turn_id, correlation_id, parent_event_id, actor_json, visibility, payload_json, timestamp) VALUES (?1, ?2, ?3, 'extension_event', NULL, NULL, ?4, NULL, ?5, 'model_and_ui', ?6, ?7)",
            params![
                event_id,
                session_id,
                next_seq,
                source_sha256,
                r#"{"kind":"legacy_python","id":"session_store"}"#,
                payload_json,
                legacy_timestamp(Some(created_at as f64)),
            ],
        )?;
        tx.execute(
            "INSERT INTO legacy_imports(source_sha256, source_kind, source_id, session_id, target_id, created_at) VALUES (?1, 'message', ?2, ?3, ?4, ?5)",
            params![source_sha256, source_id, session_id, message_id.to_string(), Utc::now().timestamp()],
        )?;
        tx.commit()
            .context("failed to commit legacy message import")?;
        Ok(true)
    }

    fn import_legacy_checkpoint_once(
        &self,
        source_sha256: &str,
        session_id: &str,
        checkpoint_id: &str,
        state: &Value,
        created_at: i64,
    ) -> Result<bool> {
        let mut conn = self.conn()?;
        let tx = conn
            .transaction()
            .context("failed to begin legacy checkpoint import")?;
        if tx
            .query_row(
                "SELECT 1 FROM legacy_imports WHERE source_sha256 = ?1 AND source_kind = 'checkpoint' AND source_id = ?2",
                params![source_sha256, checkpoint_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some()
        {
            tx.commit()?;
            return Ok(false);
        }
        let state_json = serde_json::to_string(state)?;
        tx.execute(
            "INSERT INTO checkpoints(thread_id, checkpoint_id, state_json, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(thread_id, checkpoint_id) DO UPDATE SET state_json = excluded.state_json, created_at = excluded.created_at",
            params![session_id, checkpoint_id, state_json, created_at],
        )?;
        let next_seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM ledger_events WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )?;
        let event_id = format!(
            "legacy_{}_checkpoint_{}",
            source_sha256.trim_start_matches("sha256:"),
            hex_digest(checkpoint_id.as_bytes())
        );
        let payload_json = serde_json::to_string(&redact_legacy_value(json!({
            "source_kind": "checkpoint",
            "checkpoint_id": checkpoint_id,
            "base_seq": next_seq.saturating_sub(1),
        })))?;
        tx.execute(
            "INSERT INTO ledger_events(event_id, session_id, seq, event_type, workspace_id, turn_id, correlation_id, parent_event_id, actor_json, visibility, payload_json, timestamp) VALUES (?1, ?2, ?3, 'checkpoint_created', NULL, NULL, ?4, NULL, ?5, 'model_and_ui', ?6, ?7)",
            params![
                event_id,
                session_id,
                next_seq,
                source_sha256,
                r#"{"kind":"legacy_python","id":"checkpoint"}"#,
                payload_json,
                legacy_timestamp(Some(created_at as f64)),
            ],
        )?;
        tx.execute(
            "INSERT INTO legacy_imports(source_sha256, source_kind, source_id, session_id, target_id, created_at) VALUES (?1, 'checkpoint', ?2, ?3, ?4, ?5)",
            params![source_sha256, checkpoint_id, session_id, checkpoint_id, Utc::now().timestamp()],
        )?;
        tx.commit()
            .context("failed to commit legacy checkpoint import")?;
        Ok(true)
    }

    fn ledger_event_exists(&self, event_id: &str) -> Result<bool> {
        let conn = self.conn()?;
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM ledger_events WHERE event_id = ?1 LIMIT 1",
                params![event_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(exists.is_some())
    }

    fn conn(&self) -> Result<MutexGuard<'_, Connection>> {
        // Poisoning means a panic mid-operation; any open transaction was
        // rolled back when it dropped, but surface the condition rather than
        // silently continuing on a connection whose state we can't vouch for.
        self.conn
            .lock()
            .map_err(|_| anyhow::anyhow!("state db connection mutex poisoned"))
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        let mut user_version: u32 = conn.query_row("PRAGMA user_version;", [], |row| row.get(0))?;
        if user_version == 0 {
            // Guard each ALTER: a database restored with a v0 header (or
            // stamped by a racing process that crashed before setting
            // user_version) can already carry these columns, and an
            // unguarded ADD COLUMN aborts the whole open with
            // "duplicate column name".
            let add_parent_entry_id = if column_exists(conn, "messages", "parent_entry_id")? {
                ""
            } else {
                "ALTER TABLE messages ADD COLUMN parent_entry_id INTEGER NULL;"
            };
            let add_current_leaf_id = if column_exists(conn, "threads", "current_leaf_id")? {
                ""
            } else {
                "ALTER TABLE threads ADD COLUMN current_leaf_id INTEGER NULL;"
            };
            conn.execute_batch(&format!(
                r#"
                BEGIN;
                CREATE TABLE IF NOT EXISTS threads (
                    id TEXT PRIMARY KEY,
                    rollout_path TEXT,
                    preview TEXT NOT NULL,
                    ephemeral INTEGER NOT NULL,
                    model_provider TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    path TEXT,
                    cwd TEXT NOT NULL,
                    cli_version TEXT NOT NULL,
                    source TEXT NOT NULL,
                    title TEXT,
                    sandbox_policy TEXT,
                    approval_mode TEXT,
                    archived INTEGER NOT NULL DEFAULT 0,
                    archived_at INTEGER,
                    git_sha TEXT,
                    git_branch TEXT,
                    git_origin_url TEXT,
                    memory_mode TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_threads_archived_at ON threads(archived_at DESC);
                CREATE INDEX IF NOT EXISTS idx_threads_archived_updated ON threads(archived, updated_at DESC);

                CREATE TABLE IF NOT EXISTS thread_dynamic_tools (
                    thread_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT,
                    input_schema TEXT NOT NULL,
                    PRIMARY KEY (thread_id, position),
                    FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    thread_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    item_json TEXT,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_messages_thread_created_at ON messages(thread_id, created_at ASC);

                CREATE TABLE IF NOT EXISTS checkpoints (
                    thread_id TEXT NOT NULL,
                    checkpoint_id TEXT NOT NULL,
                    state_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(thread_id, checkpoint_id),
                    FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_checkpoints_thread_created_at ON checkpoints(thread_id, created_at DESC);

                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    progress INTEGER,
                    detail TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs(updated_at DESC);

                -- Add parent_entry_id column, and set to last message before current message
                {add_parent_entry_id}
                UPDATE messages
                    SET parent_entry_id = (
                        SELECT m2.id
                        FROM messages m2
                        WHERE m2.thread_id = messages.thread_id
                            AND (
                                m2.created_at < messages.created_at
                                OR (
                                    m2.created_at = messages.created_at
                                    AND m2.id < messages.id
                                )
                            )
                        ORDER BY m2.created_at DESC, m2.id DESC
                        LIMIT 1
                    );
                CREATE INDEX IF NOT EXISTS idx_messages_parent_entry_id ON messages(parent_entry_id);

                -- Add current_leaf_id column, and set to last message in thread
                {add_current_leaf_id}
                UPDATE threads
                    SET current_leaf_id = (
                        SELECT m.id
                        FROM messages m
                        WHERE m.thread_id = threads.id
                        ORDER BY m.id DESC
                        LIMIT 1
                    );

                PRAGMA user_version = 1;
                COMMIT;
                "#
            ))
            .context("failed to initialize thread schema")?;
            user_version = 1;
        }
        if user_version < 2 {
            conn.execute_batch(
                r#"
                BEGIN;
                CREATE TABLE IF NOT EXISTS workflow_runs (
                    id TEXT PRIMARY KEY,
                    workflow_id TEXT NOT NULL,
                    goal TEXT NOT NULL,
                    status TEXT NOT NULL,
                    input_hash TEXT,
                    started_at INTEGER NOT NULL,
                    completed_at INTEGER,
                    metadata_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_started_at
                    ON workflow_runs(status, started_at DESC);
                CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_started_at
                    ON workflow_runs(workflow_id, started_at DESC);

                CREATE TABLE IF NOT EXISTS branch_runs (
                    id TEXT PRIMARY KEY,
                    workflow_run_id TEXT NOT NULL,
                    branch_id TEXT NOT NULL,
                    node_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    started_at INTEGER NOT NULL,
                    completed_at INTEGER,
                    result_json TEXT NOT NULL DEFAULT '{}',
                    FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_branch_runs_workflow_run_id
                    ON branch_runs(workflow_run_id);
                CREATE INDEX IF NOT EXISTS idx_branch_runs_branch_id
                    ON branch_runs(branch_id);

                CREATE TABLE IF NOT EXISTS leaf_runs (
                    id TEXT PRIMARY KEY,
                    workflow_run_id TEXT NOT NULL,
                    branch_run_id TEXT,
                    leaf_id TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    input_hash TEXT,
                    status TEXT NOT NULL,
                    output_json TEXT NOT NULL DEFAULT '{}',
                    artifacts_json TEXT NOT NULL DEFAULT '[]',
                    started_at INTEGER NOT NULL,
                    completed_at INTEGER,
                    FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY(branch_run_id) REFERENCES branch_runs(id) ON DELETE SET NULL
                );
                CREATE INDEX IF NOT EXISTS idx_leaf_runs_workflow_run_id
                    ON leaf_runs(workflow_run_id);
                CREATE INDEX IF NOT EXISTS idx_leaf_runs_replay_lookup
                    ON leaf_runs(workflow_run_id, leaf_id, input_hash);

                CREATE TABLE IF NOT EXISTS control_node_runs (
                    id TEXT PRIMARY KEY,
                    workflow_run_id TEXT NOT NULL,
                    node_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    selected_children_json TEXT NOT NULL DEFAULT '[]',
                    result_json TEXT NOT NULL DEFAULT '{}',
                    started_at INTEGER NOT NULL,
                    completed_at INTEGER,
                    FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_control_node_runs_workflow_run_id
                    ON control_node_runs(workflow_run_id);
                CREATE INDEX IF NOT EXISTS idx_control_node_runs_node_id
                    ON control_node_runs(node_id);

                CREATE TABLE IF NOT EXISTS teacher_candidates (
                    id TEXT PRIMARY KEY,
                    workflow_run_id TEXT NOT NULL,
                    control_node_run_id TEXT NOT NULL,
                    candidate_id TEXT NOT NULL,
                    branch_run_id TEXT,
                    score REAL,
                    passed INTEGER,
                    rationale_json TEXT NOT NULL DEFAULT '{}',
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY(control_node_run_id) REFERENCES control_node_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY(branch_run_id) REFERENCES branch_runs(id) ON DELETE SET NULL
                );
                CREATE INDEX IF NOT EXISTS idx_teacher_candidates_workflow_run_id
                    ON teacher_candidates(workflow_run_id);
                CREATE INDEX IF NOT EXISTS idx_teacher_candidates_control_node_run_id
                    ON teacher_candidates(control_node_run_id);

                PRAGMA user_version = 2;
                COMMIT;
                "#,
            )
            .context("failed to initialize workflow trace schema")?;
            user_version = 2;
        }
        if user_version < 3 {
            conn.execute_batch(
                r#"
                BEGIN;
                CREATE TABLE IF NOT EXISTS thread_goals (
                    thread_id TEXT PRIMARY KEY NOT NULL,
                    goal_id TEXT NOT NULL,
                    objective TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN (
                        'active',
                        'paused',
                        'blocked',
                        'usage_limited',
                        'budget_limited',
                        'complete'
                    )),
                    token_budget INTEGER,
                    tokens_used INTEGER NOT NULL DEFAULT 0,
                    time_used_seconds INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
                );

                PRAGMA user_version = 3;
                COMMIT;
                "#,
            )
            .context("failed to initialize thread goal schema")?;
            user_version = 3;
        }
        if user_version < 4 {
            // Same restore/race guard as the v0 block: the column may
            // already exist even though the header predates version 4.
            let add_continuation_count = if column_exists(
                conn,
                "thread_goals",
                "continuation_count",
            )? {
                ""
            } else {
                "ALTER TABLE thread_goals\n                    ADD COLUMN continuation_count INTEGER NOT NULL DEFAULT 0;"
            };
            conn.execute_batch(&format!(
                r#"
                BEGIN;
                {add_continuation_count}

                PRAGMA user_version = 4;
                COMMIT;
                "#
            ))
            .context("failed to initialize thread goal continuation schema")?;
        }
        if user_version < 5 {
            conn.execute_batch(
                r#"
                BEGIN;
                CREATE TABLE IF NOT EXISTS ledger_events (
                    event_id TEXT PRIMARY KEY NOT NULL,
                    session_id TEXT NOT NULL,
                    seq INTEGER NOT NULL CHECK(seq > 0),
                    event_type TEXT NOT NULL,
                    workspace_id TEXT,
                    turn_id TEXT,
                    correlation_id TEXT,
                    parent_event_id TEXT,
                    actor_json TEXT NOT NULL,
                    visibility TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    UNIQUE(session_id, seq)
                );
                CREATE INDEX IF NOT EXISTS idx_ledger_events_session_seq
                    ON ledger_events(session_id, seq ASC);
                CREATE INDEX IF NOT EXISTS idx_ledger_events_turn
                    ON ledger_events(turn_id, seq ASC);
                PRAGMA user_version = 5;
                COMMIT;
                "#,
            )
            .context("failed to initialize runtime ledger schema")?;
        }
        if user_version < 6 {
            conn.execute_batch(
                r#"
                BEGIN;
                CREATE TABLE IF NOT EXISTS legacy_imports (
                    source_sha256 TEXT NOT NULL,
                    source_kind TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(source_sha256, source_kind, source_id)
                );
                CREATE INDEX IF NOT EXISTS idx_legacy_imports_session
                    ON legacy_imports(session_id, source_kind);
                PRAGMA user_version = 6;
                COMMIT;
                "#,
            )
            .context("failed to initialize legacy import schema")?;
        }
        if user_version < 7 {
            conn.execute_batch(
                r#"
                BEGIN;
                CREATE TABLE IF NOT EXISTS migration_metrics (
                    key TEXT PRIMARY KEY,
                    value INTEGER NOT NULL
                );
                INSERT OR IGNORE INTO migration_metrics(key, value)
                    VALUES ('compat_imported_events', 0);
                PRAGMA user_version = 7;
                COMMIT;
                "#,
            )
            .context("failed to initialize migration metrics schema")?;
        }
        Ok(())
    }

    /// Insert or update thread metadata.
    ///
    /// This does **not** update `current_leaf_id`; use [`append_message`](Self::append_message)
    /// or [`set_current_leaf_id`](Self::set_current_leaf_id) for that.
    pub fn upsert_thread(&self, thread: &ThreadMetadata) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            r#"
            INSERT INTO threads (
                id, rollout_path, preview, ephemeral, model_provider, created_at, updated_at, status, path, cwd,
                cli_version, source, title, sandbox_policy, approval_mode, archived, archived_at,
                git_sha, git_branch, git_origin_url, memory_mode
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                ?18, ?19, ?20, ?21
            )
            ON CONFLICT(id) DO UPDATE SET
                rollout_path=excluded.rollout_path,
                preview=excluded.preview,
                ephemeral=excluded.ephemeral,
                model_provider=excluded.model_provider,
                created_at=excluded.created_at,
                updated_at=excluded.updated_at,
                status=excluded.status,
                path=excluded.path,
                cwd=excluded.cwd,
                cli_version=excluded.cli_version,
                source=excluded.source,
                title=excluded.title,
                sandbox_policy=excluded.sandbox_policy,
                approval_mode=excluded.approval_mode,
                archived=excluded.archived,
                archived_at=excluded.archived_at,
                git_sha=excluded.git_sha,
                git_branch=excluded.git_branch,
                git_origin_url=excluded.git_origin_url,
                memory_mode=excluded.memory_mode
            "#,
            params![
                thread.id,
                path_to_opt_string(thread.rollout_path.as_deref()),
                thread.preview,
                bool_to_i64(thread.ephemeral),
                thread.model_provider,
                thread.created_at,
                thread.updated_at,
                thread_status_to_str(&thread.status),
                path_to_opt_string(thread.path.as_deref()),
                thread.cwd.display().to_string(),
                thread.cli_version,
                session_source_to_str(&thread.source),
                thread.name,
                thread.sandbox_policy,
                thread.approval_mode,
                bool_to_i64(thread.archived),
                thread.archived_at,
                thread.git_sha,
                thread.git_branch,
                thread.git_origin_url,
                thread.memory_mode,
            ],
        )
        .context("failed to upsert thread metadata")?;

        self.append_thread_name(
            &thread.id,
            thread.name.clone(),
            thread.updated_at,
            thread.rollout_path.clone(),
        )?;
        Ok(())
    }

    /// Retrieve a single thread by its ID.
    ///
    /// Returns `None` if no thread with the given ID exists.
    pub fn get_thread(&self, id: &str) -> Result<Option<ThreadMetadata>> {
        let conn = self.conn()?;
        conn.query_row(
            r#"
            SELECT id, rollout_path, preview, ephemeral, model_provider, created_at, updated_at, status, path, cwd,
                   cli_version, source, title, sandbox_policy, approval_mode, archived, archived_at,
                   git_sha, git_branch, git_origin_url, memory_mode, current_leaf_id
            FROM threads
            WHERE id = ?1
            "#,
            params![id],
            row_to_thread,
        )
        .optional()
        .context("failed to read thread")
    }

    /// List threads ordered by most recently updated.
    ///
    /// Use [`ThreadListFilters`] to control whether archived threads are included
    /// and the maximum number of results returned.
    pub fn list_threads(&self, filters: ThreadListFilters) -> Result<Vec<ThreadMetadata>> {
        let conn = self.conn()?;
        let sql = if filters.include_archived {
            "SELECT id, rollout_path, preview, ephemeral, model_provider, created_at, updated_at, status, path, cwd, cli_version, source, title, sandbox_policy, approval_mode, archived, archived_at, git_sha, git_branch, git_origin_url, memory_mode, current_leaf_id FROM threads ORDER BY updated_at DESC LIMIT ?1"
        } else {
            "SELECT id, rollout_path, preview, ephemeral, model_provider, created_at, updated_at, status, path, cwd, cli_version, source, title, sandbox_policy, approval_mode, archived, archived_at, git_sha, git_branch, git_origin_url, memory_mode, current_leaf_id FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?1"
        };

        let mut stmt = conn.prepare(sql).context("failed to prepare list query")?;
        let limit = i64::try_from(filters.limit.unwrap_or(50)).unwrap_or(50);
        let mut rows = stmt
            .query(params![limit])
            .context("failed to query threads")?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().context("failed to iterate thread rows")? {
            out.push(row_to_thread(row)?);
        }
        Ok(out)
    }

    /// Archive a thread, setting its status to [`ThreadStatus::Archived`] and
    /// recording the current timestamp.
    pub fn mark_archived(&self, id: &str) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE threads SET archived = 1, archived_at = ?2, status = ?3 WHERE id = ?1",
            params![
                id,
                Utc::now().timestamp(),
                thread_status_to_str(&ThreadStatus::Archived)
            ],
        )
        .context("failed to archive thread")?;
        Ok(())
    }

    /// Unarchive a thread, removing the archived flag and clearing `archived_at`.
    pub fn mark_unarchived(&self, id: &str) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE threads SET archived = 0, archived_at = NULL, status = CASE WHEN status = ?2 THEN ?3 ELSE status END WHERE id = ?1",
            params![
                id,
                thread_status_to_str(&ThreadStatus::Archived),
                thread_status_to_str(&ThreadStatus::Idle),
            ],
        )
        .context("failed to unarchive thread")?;
        Ok(())
    }

    /// Permanently delete a thread and all of its associated data
    /// (messages, checkpoints, dynamic tools) via cascading foreign keys.
    pub fn delete_thread(&self, id: &str) -> Result<()> {
        let conn = self.conn()?;
        conn.execute("DELETE FROM threads WHERE id = ?1", params![id])
            .context("failed to delete thread")?;
        Ok(())
    }

    /// Set the memory mode for a thread.
    ///
    /// Pass `None` to clear the memory mode.
    pub fn set_thread_memory_mode(&self, id: &str, mode: Option<&str>) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE threads SET memory_mode = ?2 WHERE id = ?1",
            params![id, mode],
        )
        .context("failed to update thread memory mode")?;
        Ok(())
    }

    /// Get the memory mode configured for a thread.
    ///
    /// Returns `None` if the thread does not exist or has no memory mode set.
    pub fn get_thread_memory_mode(&self, id: &str) -> Result<Option<String>> {
        let conn = self.conn()?;
        conn.query_row(
            "SELECT memory_mode FROM threads WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .context("failed to read thread memory mode")
        .map(Option::flatten)
    }

    /// Insert or replace the persisted goal for a thread.
    pub fn upsert_thread_goal(&self, goal: &ThreadGoalRecord) -> Result<()> {
        let conn = self.conn()?;
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM threads WHERE id = ?1",
                params![goal.thread_id],
                |row| row.get(0),
            )
            .optional()
            .context("failed to verify thread before saving goal")?;
        if exists.is_none() {
            anyhow::bail!("thread {} not found", goal.thread_id);
        }

        conn.execute(
            r#"
            INSERT INTO thread_goals (
                thread_id, goal_id, objective, status, token_budget, tokens_used,
                time_used_seconds, continuation_count, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(thread_id) DO UPDATE SET
                goal_id=excluded.goal_id,
                objective=excluded.objective,
                status=excluded.status,
                token_budget=excluded.token_budget,
                tokens_used=excluded.tokens_used,
                time_used_seconds=excluded.time_used_seconds,
                continuation_count=excluded.continuation_count,
                created_at=excluded.created_at,
                updated_at=excluded.updated_at
            "#,
            params![
                goal.thread_id,
                goal.goal_id,
                goal.objective,
                thread_goal_status_to_str(&goal.status),
                goal.token_budget,
                goal.tokens_used,
                goal.time_used_seconds,
                goal.continuation_count,
                goal.created_at,
                goal.updated_at,
            ],
        )
        .context("failed to upsert thread goal")?;
        Ok(())
    }

    /// Accrue additional token and wall-clock usage onto a thread's persisted goal.
    ///
    /// This is the durable, additive accounting path for the persistent goal loop: it
    /// increments `tokens_used` and `time_used_seconds` in a single atomic SQL `UPDATE`
    /// (`col = col + ?`) so concurrent accruals do not race a read-modify-write. The
    /// goal's `updated_at` is advanced to the larger of its current value and `now`,
    /// keeping the timestamp monotonic even if a stale `now` is supplied.
    ///
    /// `token_delta` and `time_delta_seconds` are added on the database side; callers
    /// should pass non-negative deltas (negative values are accepted and will decrement,
    /// which is intentionally left to the caller's discretion).
    ///
    /// Returns the updated [`ThreadGoalRecord`], or `Ok(None)` if the thread has no
    /// persisted goal. Unlike [`upsert_thread_goal`](Self::upsert_thread_goal) this never
    /// creates a goal row; it only accumulates onto an existing one.
    pub fn record_thread_goal_usage(
        &self,
        thread_id: &str,
        token_delta: i64,
        time_delta_seconds: i64,
        now: i64,
    ) -> Result<Option<ThreadGoalRecord>> {
        let conn = self.conn()?;
        let changed = conn
            .execute(
                r#"
                UPDATE thread_goals
                SET tokens_used = tokens_used + ?2,
                    time_used_seconds = time_used_seconds + ?3,
                    updated_at = MAX(updated_at, ?4)
                WHERE thread_id = ?1
                "#,
                params![thread_id, token_delta, time_delta_seconds, now],
            )
            .context("failed to record thread goal usage")?;
        if changed == 0 {
            return Ok(None);
        }
        Self::read_thread_goal(&conn, thread_id)
    }

    /// Increment the durable cross-turn continuation counter for a thread goal.
    ///
    /// The older TUI continuation guard is scoped to one engine turn. This
    /// counter is intentionally persisted so a resumed goal loop can feed
    /// `goal_loop::decide_continuation` with the true cross-turn count.
    pub fn record_thread_goal_continuation(
        &self,
        thread_id: &str,
        now: i64,
    ) -> Result<Option<ThreadGoalRecord>> {
        let conn = self.conn()?;
        let changed = conn
            .execute(
                r#"
                UPDATE thread_goals
                SET continuation_count = continuation_count + 1,
                    updated_at = MAX(updated_at, ?2)
                WHERE thread_id = ?1
                "#,
                params![thread_id, now],
            )
            .context("failed to record thread goal continuation")?;
        if changed == 0 {
            return Ok(None);
        }
        Self::read_thread_goal(&conn, thread_id)
    }

    /// Retrieve the persisted goal for a thread.
    pub fn get_thread_goal(&self, thread_id: &str) -> Result<Option<ThreadGoalRecord>> {
        let conn = self.conn()?;
        Self::read_thread_goal(&conn, thread_id)
    }

    /// Read a goal on an already-held connection. The `record_*` mutators call
    /// this instead of [`Self::get_thread_goal`], which would re-lock the
    /// connection mutex and self-deadlock.
    fn read_thread_goal(conn: &Connection, thread_id: &str) -> Result<Option<ThreadGoalRecord>> {
        conn.query_row(
            r#"
            SELECT thread_id, goal_id, objective, status, token_budget, tokens_used,
                   time_used_seconds, continuation_count, created_at, updated_at
            FROM thread_goals
            WHERE thread_id = ?1
            "#,
            params![thread_id],
            row_to_thread_goal,
        )
        .optional()
        .context("failed to read thread goal")
    }

    /// Delete the persisted goal for a thread.
    pub fn delete_thread_goal(&self, thread_id: &str) -> Result<bool> {
        let conn = self.conn()?;
        let changed = conn
            .execute(
                "DELETE FROM thread_goals WHERE thread_id = ?1",
                params![thread_id],
            )
            .context("failed to delete thread goal")?;
        Ok(changed > 0)
    }

    /// List all leaf messages in a thread.
    ///
    /// A leaf message is one that has no other message referencing it as a parent.
    /// In a branching conversation tree, there may be multiple leaf messages.
    pub fn list_leaf_messages(&self, thread_id: &str) -> Result<Vec<MessageRecord>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT m1.id, m1.thread_id, m1.role, m1.content, m1.item_json, m1.created_at, m1.parent_entry_id
                FROM messages m1
                LEFT JOIN messages m2 ON m1.id = m2.parent_entry_id
                WHERE m1.thread_id = ?1 AND m2.id IS NULL
                "#,
            )
            .context("failed to prepare message listing query")?;
        let mut rows = stmt
            .query(params![thread_id])
            .with_context(|| format!("failed to list leaf messages for thread {thread_id}"))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().context("failed to iterate message rows")? {
            let item_json: Option<String> = row.get(4).context("failed to read item json")?;
            let item = item_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .with_context(|| {
                    format!("failed to parse message item json in thread {thread_id}")
                })?;
            out.push(MessageRecord {
                id: row.get(0).context("failed to read message id")?,
                thread_id: row.get(1).context("failed to read message thread id")?,
                role: row.get(2).context("failed to read message role")?,
                content: row.get(3).context("failed to read message content")?,
                item,
                created_at: row.get(5).context("failed to read message timestamp")?,
                parent_entry_id: row.get(6).context("failed to read parent entry id")?,
            });
        }
        Ok(out)
    }

    /// Update the current leaf message pointer for a thread.
    ///
    /// This controls which branch of the conversation tree is considered active
    /// when listing messages via [`list_messages`](Self::list_messages).
    pub fn set_current_leaf_id(&self, thread_id: &str, current_leaf_id: &str) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE threads SET current_leaf_id = ?1 WHERE id = ?2",
            params![current_leaf_id, thread_id],
        )
        .context("failed to update thread current leaf id")?;
        Ok(())
    }

    /// Replace the dynamic tools for a thread.
    ///
    /// All existing dynamic tools for the thread are deleted and replaced with the
    /// provided list. The operation is performed within a transaction.
    pub fn persist_dynamic_tools(
        &self,
        thread_id: &str,
        tools: &[DynamicToolRecord],
    ) -> Result<()> {
        let mut conn = self.conn()?;
        let tx = conn
            .transaction()
            .context("failed to begin dynamic tools transaction")?;
        tx.execute(
            "DELETE FROM thread_dynamic_tools WHERE thread_id = ?1",
            params![thread_id],
        )
        .context("failed to clear dynamic tools")?;
        for tool in tools {
            tx.execute(
                "INSERT INTO thread_dynamic_tools(thread_id, position, name, description, input_schema) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    thread_id,
                    tool.position,
                    tool.name,
                    tool.description,
                    tool.input_schema.to_string()
                ],
            )
            .with_context(|| format!("failed to persist dynamic tool {}", tool.name))?;
        }
        tx.commit().context("failed to commit dynamic tools")?;
        Ok(())
    }

    /// Retrieve all dynamic tools registered for a thread, ordered by position.
    pub fn get_dynamic_tools(&self, thread_id: &str) -> Result<Vec<DynamicToolRecord>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT position, name, description, input_schema FROM thread_dynamic_tools WHERE thread_id = ?1 ORDER BY position ASC",
            )
            .context("failed to prepare get dynamic tools query")?;
        let mut rows = stmt
            .query(params![thread_id])
            .context("failed to query dynamic tools")?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().context("failed to iterate dynamic tools")? {
            let input_schema_raw: String =
                row.get(3).context("failed to read tool input schema")?;
            let input_schema: Value =
                serde_json::from_str(&input_schema_raw).with_context(|| {
                    format!("failed to parse input schema for dynamic tool in thread {thread_id}")
                })?;
            out.push(DynamicToolRecord {
                position: row.get(0).context("failed to read tool position")?,
                name: row.get(1).context("failed to read tool name")?,
                description: row.get(2).context("failed to read tool description")?,
                input_schema,
            });
        }
        Ok(out)
    }

    /// Append a new message to a thread.
    ///
    /// The message is linked to the thread's current leaf as its parent, and the
    /// thread's `current_leaf_id` is updated to the new message. Returns the ID
    /// of the newly created message.
    pub fn append_message(
        &self,
        thread_id: &str,
        role: &str,
        content: &str,
        item: Option<Value>,
    ) -> Result<i64> {
        let mut conn = self.conn()?;
        let created_at = Utc::now().timestamp();
        let item_json = item
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .context("failed to serialize message item payload")?;

        let tx = conn
            .transaction()
            .context("failed to begin append message transaction")?;

        let current_leaf_id: Option<i64> = tx
            .query_row(
                "SELECT current_leaf_id FROM threads WHERE id = ?1",
                params![thread_id],
                |row| row.get(0),
            )
            .with_context(|| {
                format!("failed to query thread current leaf id for thread {thread_id}")
            })?;

        let next_leaf_id: i64 = tx.query_row(
            r#"
                INSERT INTO messages(thread_id, role, content, item_json, created_at, parent_entry_id)
                SELECT ?1, ?2, ?3, ?4, ?5, ?6
                RETURNING id
            "#, params![thread_id, role, content, item_json, created_at, current_leaf_id], |row| row.get(0)
        ).with_context(|| format!("failed to append message for thread {thread_id}"))?;

        tx.execute(
            r#"
            UPDATE threads
            SET current_leaf_id = ?1
            WHERE id = ?2;
            "#,
            params![next_leaf_id, thread_id],
        )
        .with_context(|| {
            format!("failed to update thread current leaf id for thread {thread_id}")
        })?;

        tx.commit()
            .context("failed to commit append message transaction")?;

        Ok(next_leaf_id)
    }

    /// List messages in the current conversation branch, walking backwards from
    /// the thread's `current_leaf_id`.
    ///
    /// Messages are returned in chronological order (oldest first). The `limit`
    /// parameter caps how many ancestor messages are traversed; it defaults to 500.
    pub fn list_messages(
        &self,
        thread_id: &str,
        limit: Option<usize>,
    ) -> Result<Vec<MessageRecord>> {
        let conn = self.conn()?;
        let limit = i64::try_from(limit.unwrap_or(500)).unwrap_or(500);
        let mut stmt = conn
            .prepare(
                r#"
                WITH RECURSIVE
                    leaf_id AS (
                        SELECT current_leaf_id FROM threads WHERE id = ?1
                    ),
                    ancestors AS (
                        SELECT id, thread_id, role, content, item_json, created_at, parent_entry_id, 0 AS depth
                        FROM messages
                        WHERE id = (SELECT current_leaf_id FROM leaf_id)

                        UNION ALL

                        SELECT m.id, m.thread_id, m.role, m.content, m.item_json, m.created_at, m.parent_entry_id, a.depth + 1
                        FROM messages m
                        JOIN ancestors a ON m.id = a.parent_entry_id
                        WHERE a.depth < ?2
                    )
                    SELECT id, thread_id, role, content, item_json, created_at, parent_entry_id FROM ancestors
                    ORDER BY depth DESC
                "#
            )
            .context("failed to prepare message listing query")?;
        let mut rows = stmt
            .query(params![thread_id, limit - 1])
            .with_context(|| format!("failed to list messages for thread {thread_id}"))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().context("failed to iterate message rows")? {
            let item_json: Option<String> = row.get(4).context("failed to read item json")?;
            let item = item_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .with_context(|| {
                    format!("failed to parse message item json in thread {thread_id}")
                })?;
            out.push(MessageRecord {
                id: row.get(0).context("failed to read message id")?,
                thread_id: row.get(1).context("failed to read message thread id")?,
                role: row.get(2).context("failed to read message role")?,
                content: row.get(3).context("failed to read message content")?,
                item,
                created_at: row.get(5).context("failed to read message timestamp")?,
                parent_entry_id: row.get(6).context("failed to read parent entry id")?,
            });
        }
        Ok(out)
    }

    /// Fork the conversation at a specific message.
    ///
    /// Creates a new message whose parent is `message_id` and updates the thread's
    /// `current_leaf_id` to the new message. Returns the ID of the new message.
    /// This enables branching conversations from any point in the history.
    pub fn fork_at_message(
        &self,
        message_id: &str,
        role: &str,
        content: &str,
        item: Option<Value>,
    ) -> Result<i64> {
        let mut conn = self.conn()?;
        let created_at = Utc::now().timestamp();
        let item_json = item
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .context("failed to serialize message item payload")?;

        let tx = conn
            .transaction()
            .context("failed to begin fork message transaction")?;

        let thread_id: String = tx
            .query_row(
                "SELECT thread_id FROM messages WHERE id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .with_context(|| format!("failed to query thread id for message {message_id}"))?;

        let next_leaf_id: i64 = tx.query_row(
            r#"
                INSERT INTO messages(thread_id, role, content, item_json, created_at, parent_entry_id)
                SELECT ?1, ?2, ?3, ?4, ?5, ?6
                RETURNING id
            "#, params![thread_id, role, content, item_json, created_at, message_id], |row| row.get(0)
        ).with_context(|| format!("failed to fork at message for thread {thread_id:?}"))?;

        tx.execute(
            r#"
            UPDATE threads
            SET current_leaf_id = ?1
            WHERE id = ?2;
            "#,
            params![next_leaf_id, thread_id],
        )
        .with_context(|| {
            format!("failed to update thread current leaf id for thread {thread_id:?}")
        })?;

        tx.commit()
            .context("failed to commit fork message transaction")?;

        Ok(next_leaf_id)
    }

    /// Delete all messages belonging to a thread and reset its `current_leaf_id`.
    ///
    /// Returns the number of messages deleted.
    pub fn clear_messages(&self, thread_id: &str) -> Result<usize> {
        let mut conn = self.conn()?;
        let tx = conn
            .transaction()
            .context("failed to begin clear messages transaction")?;

        tx.execute(
            r#"
            UPDATE threads
            SET current_leaf_id = NULL
            WHERE id = ?1;
            "#,
            params![thread_id],
        )
        .with_context(|| format!("failed to clear messages for thread {thread_id}"))?;
        let result = tx
            .execute(
                r#"
                DELETE FROM messages WHERE thread_id = ?1
                "#,
                params![thread_id],
            )
            .with_context(|| format!("failed to clear messages for thread {thread_id}"))?;
        tx.commit()
            .context("failed to commit clear messages transaction")?;

        Ok(result)
    }

    /// Save (or update) a named checkpoint for a thread.
    ///
    /// If a checkpoint with the same `thread_id` and `checkpoint_id` already exists,
    /// its state and timestamp are overwritten.
    pub fn save_checkpoint(
        &self,
        thread_id: &str,
        checkpoint_id: &str,
        state: &Value,
    ) -> Result<()> {
        let conn = self.conn()?;
        let state_json =
            serde_json::to_string(state).context("failed to encode checkpoint state")?;
        conn.execute(
            r#"
            INSERT INTO checkpoints(thread_id, checkpoint_id, state_json, created_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(thread_id, checkpoint_id) DO UPDATE SET
                state_json = excluded.state_json,
                created_at = excluded.created_at
            "#,
            params![thread_id, checkpoint_id, state_json, Utc::now().timestamp()],
        )
        .with_context(|| {
            format!("failed to save checkpoint {checkpoint_id} for thread {thread_id}")
        })?;
        Ok(())
    }

    /// Load a checkpoint for a thread.
    ///
    /// If `checkpoint_id` is provided, loads that specific checkpoint. Otherwise,
    /// loads the most recently created checkpoint for the thread. Returns `None`
    /// if no matching checkpoint exists.
    pub fn load_checkpoint(
        &self,
        thread_id: &str,
        checkpoint_id: Option<&str>,
    ) -> Result<Option<CheckpointRecord>> {
        let conn = self.conn()?;
        if let Some(checkpoint_id) = checkpoint_id {
            let row = conn
                .query_row(
                    "SELECT thread_id, checkpoint_id, state_json, created_at FROM checkpoints WHERE thread_id = ?1 AND checkpoint_id = ?2",
                    params![thread_id, checkpoint_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )
                .optional()
                .with_context(|| {
                    format!("failed to load checkpoint {checkpoint_id} for thread {thread_id}")
                })?;
            if let Some((thread_id, checkpoint_id, state_json, created_at)) = row {
                let state = parse_checkpoint_state(&state_json)?;
                return Ok(Some(CheckpointRecord {
                    thread_id,
                    checkpoint_id,
                    state,
                    created_at,
                }));
            }
            return Ok(None);
        }

        let row = conn
            .query_row(
                "SELECT thread_id, checkpoint_id, state_json, created_at FROM checkpoints WHERE thread_id = ?1 ORDER BY created_at DESC LIMIT 1",
                params![thread_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .with_context(|| format!("failed to load latest checkpoint for thread {thread_id}"))?;
        if let Some((thread_id, checkpoint_id, state_json, created_at)) = row {
            let state = parse_checkpoint_state(&state_json)?;
            return Ok(Some(CheckpointRecord {
                thread_id,
                checkpoint_id,
                state,
                created_at,
            }));
        }
        Ok(None)
    }

    /// List checkpoints for a thread, ordered by creation time (newest first).
    ///
    /// The `limit` parameter caps the number of results and defaults to 100.
    pub fn list_checkpoints(
        &self,
        thread_id: &str,
        limit: Option<usize>,
    ) -> Result<Vec<CheckpointRecord>> {
        let conn = self.conn()?;
        let limit = i64::try_from(limit.unwrap_or(100)).unwrap_or(100);
        let mut stmt = conn
            .prepare(
                "SELECT thread_id, checkpoint_id, state_json, created_at FROM checkpoints WHERE thread_id = ?1 ORDER BY created_at DESC LIMIT ?2",
            )
            .context("failed to prepare checkpoint list query")?;
        let mut rows = stmt
            .query(params![thread_id, limit])
            .with_context(|| format!("failed to list checkpoints for thread {thread_id}"))?;

        let mut out = Vec::new();
        while let Some(row) = rows.next().context("failed to iterate checkpoint rows")? {
            let state_json: String = row.get(2).context("failed to read checkpoint state json")?;
            let state = parse_checkpoint_state(&state_json)?;
            out.push(CheckpointRecord {
                thread_id: row.get(0).context("failed to read checkpoint thread id")?,
                checkpoint_id: row.get(1).context("failed to read checkpoint id")?,
                state,
                created_at: row.get(3).context("failed to read checkpoint timestamp")?,
            });
        }
        Ok(out)
    }

    /// Delete a specific checkpoint from a thread.
    pub fn delete_checkpoint(&self, thread_id: &str, checkpoint_id: &str) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "DELETE FROM checkpoints WHERE thread_id = ?1 AND checkpoint_id = ?2",
            params![thread_id, checkpoint_id],
        )
        .with_context(|| {
            format!("failed to delete checkpoint {checkpoint_id} for thread {thread_id}")
        })?;
        Ok(())
    }

    /// Insert or update a background job record.
    pub fn upsert_job(&self, job: &JobStateRecord) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            r#"
            INSERT INTO jobs(id, name, status, progress, detail, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                status = excluded.status,
                progress = excluded.progress,
                detail = excluded.detail,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at
            "#,
            params![
                job.id,
                job.name,
                job_state_status_to_str(&job.status),
                job.progress.map(i64::from),
                job.detail,
                job.created_at,
                job.updated_at
            ],
        )
        .with_context(|| format!("failed to upsert job {}", job.id))?;
        Ok(())
    }

    /// Retrieve a single job by its ID.
    ///
    /// Returns `None` if no job with the given ID exists.
    pub fn get_job(&self, id: &str) -> Result<Option<JobStateRecord>> {
        let conn = self.conn()?;
        conn.query_row(
            "SELECT id, name, status, progress, detail, created_at, updated_at FROM jobs WHERE id = ?1",
            params![id],
            |row| {
                let status_raw: String = row.get(2)?;
                let progress: Option<i64> = row.get(3)?;
                Ok(JobStateRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    status: job_state_status_from_str(&status_raw),
                    progress: progress.and_then(|v| u8::try_from(v).ok()),
                    detail: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .optional()
        .with_context(|| format!("failed to read job {id}"))
    }

    /// List jobs ordered by most recently updated.
    ///
    /// The `limit` parameter caps the number of results and defaults to 100.
    pub fn list_jobs(&self, limit: Option<usize>) -> Result<Vec<JobStateRecord>> {
        let conn = self.conn()?;
        let limit = i64::try_from(limit.unwrap_or(100)).unwrap_or(100);
        let mut stmt = conn
            .prepare(
                "SELECT id, name, status, progress, detail, created_at, updated_at FROM jobs ORDER BY updated_at DESC LIMIT ?1",
            )
            .context("failed to prepare job list query")?;
        let mut rows = stmt
            .query(params![limit])
            .context("failed to query persisted jobs")?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().context("failed to iterate persisted jobs")? {
            let status_raw: String = row.get(2).context("failed to read job status")?;
            let progress: Option<i64> = row.get(3).context("failed to read job progress")?;
            out.push(JobStateRecord {
                id: row.get(0).context("failed to read job id")?,
                name: row.get(1).context("failed to read job name")?,
                status: job_state_status_from_str(&status_raw),
                progress: progress.and_then(|v| u8::try_from(v).ok()),
                detail: row.get(4).context("failed to read job detail")?,
                created_at: row.get(5).context("failed to read job created_at")?,
                updated_at: row.get(6).context("failed to read job updated_at")?,
            });
        }
        Ok(out)
    }

    /// Permanently delete a job record.
    pub fn delete_job(&self, id: &str) -> Result<()> {
        let conn = self.conn()?;
        conn.execute("DELETE FROM jobs WHERE id = ?1", params![id])
            .with_context(|| format!("failed to delete job {id}"))?;
        Ok(())
    }

    /// Look up the rollout file path for a thread by its ID.
    pub fn find_rollout_path_by_id(&self, id: &str) -> Result<Option<PathBuf>> {
        let conn = self.conn()?;
        conn.query_row(
            "SELECT rollout_path FROM threads WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .context("failed to lookup rollout path")
        .map(|opt| opt.flatten().map(PathBuf::from))
    }

    /// Append an entry to the JSONL session index file.
    ///
    /// The session index is an append-only log that maps thread IDs to their names,
    /// update timestamps, and rollout paths. It is used for fast name-based lookups
    /// without opening the SQLite database.
    pub fn append_thread_name(
        &self,
        thread_id: &str,
        thread_name: Option<String>,
        updated_at: i64,
        rollout_path: Option<PathBuf>,
    ) -> Result<()> {
        // Hold the index lock for the entire append + compaction so a concurrent
        // `StateStore` clone cannot rename the index while we are appending.
        let _guard = SESSION_INDEX_LOCK.lock().unwrap();
        if let Some(parent) = self.session_index_path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!(
                    "failed to create session index directory {}",
                    parent.display()
                )
            })?;
        }
        let entry = SessionIndexEntry {
            thread_id: thread_id.to_string(),
            thread_name,
            updated_at,
            rollout_path,
        };
        let encoded =
            serde_json::to_string(&entry).context("failed to serialize session index entry")?;
        // Append and compaction share one lock. Compaction rewrites the file
        // from a snapshot and renames over it, so an append landing between
        // that snapshot and the rename would be discarded — silently, since
        // the append already returned success to its caller.
        self.with_session_index_lock(|| {
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.session_index_path)
                .with_context(|| {
                    format!(
                        "failed to open session index {}",
                        self.session_index_path.display()
                    )
                })?;
            writeln!(file, "{encoded}").context("failed to append session index entry")?;
            // Durability: without this a crash mid-write can leave a torn
            // final line. Reads tolerate one (see `session_index_map`), but
            // not losing the entry beats recovering from having lost it.
            file.sync_data()
                .context("failed to flush session index entry")?;
            drop(file);
            self.compact_session_index_locked()
        })
    }

    /// Run `operation` holding the exclusive session-index lock.
    ///
    /// The lock is an adjacent `.lock` file rather than the index itself, so
    /// compaction's rename cannot pull the lock out from under a waiter. This
    /// mirrors the discipline `hakus-config` uses for `config.toml`.
    fn with_session_index_lock<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        if let Some(parent) = self.session_index_path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!(
                    "failed to create session index directory {}",
                    parent.display()
                )
            })?;
        }
        let lock_path = self.session_index_path.with_extension("jsonl.lock");
        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            // The file is only a lock handle; its contents are never read and
            // truncating it would race other holders for no benefit.
            .truncate(false)
            .open(&lock_path)
            .with_context(|| {
                format!("failed to open session index lock {}", lock_path.display())
            })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            lock_file
                .set_permissions(fs::Permissions::from_mode(0o600))
                .with_context(|| {
                    format!(
                        "failed to secure session index lock {}",
                        lock_path.display()
                    )
                })?;
        }
        let mut lock = fd_lock::RwLock::new(lock_file);
        let _guard = lock
            .write()
            .with_context(|| format!("failed to lock session index {}", lock_path.display()))?;
        operation()
    }

    /// Find the display name for a thread by its ID, using the session index.
    ///
    /// Returns `None` if the thread is not in the index or has no name.
    pub fn find_thread_name_by_id(&self, thread_id: &str) -> Result<Option<String>> {
        let map = self.session_index_map()?;
        Ok(map
            .get(thread_id)
            .and_then(|entry| entry.thread_name.clone()))
    }

    /// Look up display names for multiple thread IDs at once.
    ///
    /// Returns a map from thread ID to its name (which may be `None`).
    pub fn find_thread_names_by_ids(
        &self,
        ids: &[String],
    ) -> Result<HashMap<String, Option<String>>> {
        let map = self.session_index_map()?;
        let mut out = HashMap::new();
        for id in ids {
            let name = map.get(id).and_then(|entry| entry.thread_name.clone());
            out.insert(id.clone(), name);
        }
        Ok(out)
    }

    /// Find the rollout path for a thread by its display name (case-insensitive).
    ///
    /// If multiple threads share the same name, the most recently updated one is returned.
    /// Returns `None` if no matching thread is found.
    pub fn find_thread_path_by_name_str(&self, name: &str) -> Result<Option<PathBuf>> {
        let map = self.session_index_map()?;
        let matched = map
            .values()
            .filter(|entry| {
                entry
                    .thread_name
                    .as_deref()
                    .is_some_and(|n| n.eq_ignore_ascii_case(name))
            })
            .max_by_key(|entry| entry.updated_at);
        Ok(matched.and_then(|entry| entry.rollout_path.clone()))
    }

    /// Compact the session index. The caller must already hold the lock from
    /// [`Self::with_session_index_lock`]: this reads a snapshot and renames a
    /// rewritten file over the live one, and an append interleaved between
    /// those two steps is lost.
    fn compact_session_index_locked(&self) -> Result<()> {
        if !self.session_index_path.exists() {
            return Ok(());
        }
        let line_count = BufReader::new(
            OpenOptions::new()
                .read(true)
                .open(&self.session_index_path)
                .with_context(|| {
                    format!(
                        "failed to read session index {}",
                        self.session_index_path.display()
                    )
                })?,
        )
        .lines()
        .filter(|line| {
            line.as_ref()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        })
        .count();
        if line_count <= session_index_compact_line_threshold() {
            return Ok(());
        }

        let latest = self.session_index_map()?;
        let compact_path = self.session_index_path.with_extension("jsonl.compact");
        {
            let mut file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&compact_path)
                .with_context(|| {
                    format!(
                        "failed to open compact session index {}",
                        compact_path.display()
                    )
                })?;
            for entry in latest.values() {
                let encoded = serde_json::to_string(entry)
                    .context("failed to serialize compact session index entry")?;
                writeln!(file, "{encoded}")
                    .context("failed to write compact session index entry")?;
            }
        }
        // The snapshot is written but the live file is still the old one:
        // this is the window an unsynchronized appender would write into and
        // lose. Tests widen it deliberately to prove the lock closes it.
        #[cfg(test)]
        tests::compaction_midpoint(&self.session_index_path);
        fs::rename(&compact_path, &self.session_index_path).with_context(|| {
            format!(
                "failed to replace session index {}",
                self.session_index_path.display()
            )
        })?;
        Ok(())
    }

    #[cfg(test)]
    fn session_index_line_count(&self) -> Result<usize> {
        if !self.session_index_path.exists() {
            return Ok(0);
        }
        Ok(BufReader::new(
            OpenOptions::new()
                .read(true)
                .open(&self.session_index_path)
                .with_context(|| {
                    format!(
                        "failed to read session index {}",
                        self.session_index_path.display()
                    )
                })?,
        )
        .lines()
        .filter(|line| {
            line.as_ref()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        })
        .count())
    }

    fn session_index_map(&self) -> Result<HashMap<String, SessionIndexEntry>> {
        if !self.session_index_path.exists() {
            return Ok(HashMap::new());
        }
        let file = OpenOptions::new()
            .read(true)
            .open(&self.session_index_path)
            .with_context(|| {
                format!(
                    "failed to read session index {}",
                    self.session_index_path.display()
                )
            })?;
        let reader = BufReader::new(file);
        let mut latest = HashMap::<String, SessionIndexEntry>::new();
        for line in reader.lines() {
            let line = line.context("failed to read session index line")?;
            if line.trim().is_empty() {
                continue;
            }
            // Skip a line we can't parse instead of failing the whole read.
            // An append that was interrupted mid-write leaves a torn final
            // line; aborting here broke every thread-name lookup, and because
            // compaction reads through this same function, the index could
            // never repair itself either — the file stayed broken until
            // someone deleted it by hand.
            match serde_json::from_str::<SessionIndexEntry>(&line) {
                Ok(parsed) => {
                    latest.insert(parsed.thread_id.clone(), parsed);
                }
                Err(err) => {
                    tracing::warn!(
                        "skipping unparseable session index entry in {}: {err}",
                        self.session_index_path.display()
                    );
                }
            }
        }
        Ok(latest)
    }
}

/// Resolve the default SQLite state path without opening or creating it.
///
/// An explicit `HAKUS_HOME` always yields `<override>/state.db` and blocks
/// canonical state root. No legacy product directory is consulted.
#[must_use]
pub fn default_state_db_path() -> PathBuf {
    // $HAKUS_HOME is a hard override of the base data directory.
    if let Some(overridden) = hakus_home_override().ok().flatten() {
        return overridden.join("state.db");
    }
    hakus_paths::hakus_home()
        .ok()
        .flatten()
        .unwrap_or_else(|| PathBuf::from(HAKUS_APP_DIR))
        .join("state.db")
}

fn bool_to_i64(value: bool) -> i64 {
    if value { 1 } else { 0 }
}

/// Whether `table` currently has a column named `column`.
///
/// Used to guard `ALTER TABLE ... ADD COLUMN` migrations so they are
/// idempotent. Both identifiers are compile-time literals at every call
/// site, never user input. A missing table reports `false`, matching the
/// fresh-database case where the migration must still run.
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn i64_to_bool(value: i64) -> bool {
    value != 0
}

fn thread_status_to_str(status: &ThreadStatus) -> &'static str {
    match status {
        ThreadStatus::Running => "running",
        ThreadStatus::Idle => "idle",
        ThreadStatus::Completed => "completed",
        ThreadStatus::Failed => "failed",
        ThreadStatus::Paused => "paused",
        ThreadStatus::Archived => "archived",
    }
}

fn thread_status_from_str(value: &str) -> ThreadStatus {
    match value {
        "running" => ThreadStatus::Running,
        "idle" => ThreadStatus::Idle,
        "completed" => ThreadStatus::Completed,
        "failed" => ThreadStatus::Failed,
        "paused" => ThreadStatus::Paused,
        "archived" => ThreadStatus::Archived,
        _ => ThreadStatus::Idle,
    }
}

fn session_source_to_str(source: &SessionSource) -> &'static str {
    match source {
        SessionSource::Interactive => "interactive",
        SessionSource::Resume => "resume",
        SessionSource::Fork => "fork",
        SessionSource::Api => "api",
        SessionSource::Unknown => "unknown",
    }
}

fn session_source_from_str(value: &str) -> SessionSource {
    match value {
        "interactive" => SessionSource::Interactive,
        "resume" => SessionSource::Resume,
        "fork" => SessionSource::Fork,
        "api" => SessionSource::Api,
        _ => SessionSource::Unknown,
    }
}

fn path_to_opt_string(path: Option<&Path>) -> Option<String> {
    path.map(|p| p.display().to_string())
}

fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn legacy_event_type(value: Option<&str>) -> &'static str {
    match value.unwrap_or("extension_event") {
        "turn_start" => "turn_started",
        "text_delta" | "reasoning" => "model_delta",
        "tool_call_started" => "tool_call_started",
        "tool_call_finished" => "tool_call_finished",
        "turn_completed" => "turn_completed",
        "turn_failed" => "turn_failed",
        "cancelled" => "turn_cancelled",
        "token_usage" => "model_request_settled",
        "extension_event" => "extension_event",
        _ => "extension_event",
    }
}

fn redact_legacy_value(value: Value) -> Value {
    match value {
        Value::Object(mut object) => {
            for (key, value) in object.iter_mut() {
                let normalized = key.to_ascii_lowercase();
                if [
                    "api_key",
                    "apikey",
                    "authorization",
                    "password",
                    "private_key",
                    "secret",
                    "token",
                ]
                .iter()
                .any(|needle| normalized.contains(needle))
                {
                    *value = Value::String("[REDACTED]".to_string());
                } else {
                    *value = redact_legacy_value(value.take());
                }
            }
            Value::Object(object)
        }
        Value::Array(values) => Value::Array(values.into_iter().map(redact_legacy_value).collect()),
        other => other,
    }
}

fn legacy_timestamp(ts: Option<f64>) -> String {
    ts.and_then(|value| {
        if !value.is_finite() || value < 0.0 {
            return None;
        }
        let seconds = value.trunc() as i64;
        let nanos = ((value.fract() * 1_000_000_000.0).round() as u32).min(999_999_999);
        Utc.timestamp_opt(seconds, nanos)
            .single()
            .map(|timestamp| timestamp.to_rfc3339())
    })
    .unwrap_or_else(|| Utc::now().to_rfc3339())
}

fn normalize_legacy_timestamp(ts: i64) -> i64 {
    // Python session_store stores milliseconds while the Rust state schema
    // stores Unix seconds. Keep already-second values unchanged for fixtures
    // and older exports.
    let ts = if ts > 10_000_000_000 {
        ts / 1_000
    } else {
        ts
    };
    ts.max(0)
}

fn parse_checkpoint_state(state_json: &str) -> Result<Value> {
    serde_json::from_str(state_json).context("failed to parse checkpoint state json")
}

fn job_state_status_to_str(status: &JobStateStatus) -> &'static str {
    match status {
        JobStateStatus::Queued => "queued",
        JobStateStatus::Running => "running",
        JobStateStatus::Paused => "paused",
        JobStateStatus::Completed => "completed",
        JobStateStatus::Failed => "failed",
        JobStateStatus::Cancelled => "cancelled",
    }
}

fn job_state_status_from_str(value: &str) -> JobStateStatus {
    match value {
        "queued" => JobStateStatus::Queued,
        "running" => JobStateStatus::Running,
        "paused" => JobStateStatus::Paused,
        "completed" => JobStateStatus::Completed,
        "failed" => JobStateStatus::Failed,
        "cancelled" => JobStateStatus::Cancelled,
        _ => JobStateStatus::Queued,
    }
}

fn thread_goal_status_to_str(status: &ThreadGoalStatus) -> &'static str {
    match status {
        ThreadGoalStatus::Active => "active",
        ThreadGoalStatus::Paused => "paused",
        ThreadGoalStatus::Blocked => "blocked",
        ThreadGoalStatus::UsageLimited => "usage_limited",
        ThreadGoalStatus::BudgetLimited => "budget_limited",
        ThreadGoalStatus::Complete => "complete",
    }
}

fn thread_goal_status_from_str(value: &str) -> ThreadGoalStatus {
    match value {
        "active" => ThreadGoalStatus::Active,
        "paused" => ThreadGoalStatus::Paused,
        "blocked" => ThreadGoalStatus::Blocked,
        "usage_limited" => ThreadGoalStatus::UsageLimited,
        "budget_limited" => ThreadGoalStatus::BudgetLimited,
        "complete" => ThreadGoalStatus::Complete,
        // Fail closed: an unknown or corrupted persisted value must never
        // resurrect a self-driving goal. The user can inspect and explicitly
        // resume a paused goal after repairing or replacing the record.
        _ => ThreadGoalStatus::Paused,
    }
}

fn row_to_thread(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadMetadata> {
    let status_raw: String = row.get(7)?;
    let source_raw: String = row.get(11)?;
    let rollout_path: Option<String> = row.get(1)?;
    let path: Option<String> = row.get(8)?;
    Ok(ThreadMetadata {
        id: row.get(0)?,
        rollout_path: rollout_path.map(PathBuf::from),
        preview: row.get(2)?,
        ephemeral: i64_to_bool(row.get(3)?),
        model_provider: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        status: thread_status_from_str(&status_raw),
        path: path.map(PathBuf::from),
        cwd: PathBuf::from(row.get::<_, String>(9)?),
        cli_version: row.get(10)?,
        source: session_source_from_str(&source_raw),
        name: row.get(12)?,
        sandbox_policy: row.get(13)?,
        approval_mode: row.get(14)?,
        archived: i64_to_bool(row.get(15)?),
        archived_at: row.get(16)?,
        git_sha: row.get(17)?,
        git_branch: row.get(18)?,
        git_origin_url: row.get(19)?,
        memory_mode: row.get(20)?,
        current_leaf_id: row.get(21)?,
    })
}

fn row_to_thread_goal(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadGoalRecord> {
    let status_raw: String = row.get(3)?;
    Ok(ThreadGoalRecord {
        thread_id: row.get(0)?,
        goal_id: row.get(1)?,
        objective: row.get(2)?,
        status: thread_goal_status_from_str(&status_raw),
        token_budget: row.get(4)?,
        tokens_used: row.get(5)?,
        time_used_seconds: row.get(6)?,
        continuation_count: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Barrier, Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn temp_state_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "hakus-state-{name}-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create temp state dir");
        dir
    }

    fn temp_state_store(name: &str) -> StateStore {
        let dir = temp_state_dir(name);
        StateStore::open(Some(dir.join("state.db"))).expect("open state store")
    }

    fn test_thread(id: &str) -> ThreadMetadata {
        ThreadMetadata {
            id: id.to_string(),
            rollout_path: None,
            preview: "test thread".to_string(),
            ephemeral: false,
            model_provider: "deepseek".to_string(),
            created_at: 10,
            updated_at: 10,
            status: ThreadStatus::Running,
            path: None,
            cwd: PathBuf::from("/tmp/hakus"),
            cli_version: "0.0.0-test".to_string(),
            source: SessionSource::Interactive,
            name: None,
            sandbox_policy: None,
            approval_mode: None,
            archived: false,
            archived_at: None,
            git_sha: None,
            git_branch: None,
            git_origin_url: None,
            memory_mode: None,
            current_leaf_id: None,
        }
    }

    fn test_goal(thread_id: &str, objective: &str) -> ThreadGoalRecord {
        ThreadGoalRecord {
            thread_id: thread_id.to_string(),
            goal_id: "goal-1".to_string(),
            objective: objective.to_string(),
            status: ThreadGoalStatus::Active,
            token_budget: Some(123),
            tokens_used: 7,
            time_used_seconds: 11,
            continuation_count: 0,
            created_at: 100,
            updated_at: 101,
        }
    }

    #[test]
    fn unknown_persisted_goal_status_fails_closed() {
        assert_eq!(
            thread_goal_status_from_str("future_or_corrupt_status"),
            ThreadGoalStatus::Paused
        );
    }

    #[test]
    fn thread_goal_crud_round_trips_and_replaces() {
        let store = temp_state_store("thread-goal-crud");
        store
            .upsert_thread(&test_thread("thread-1"))
            .expect("upsert thread");

        let goal = test_goal("thread-1", "Ship v0.8.59");
        store.upsert_thread_goal(&goal).expect("upsert goal");
        assert_eq!(
            store
                .get_thread_goal("thread-1")
                .expect("read goal")
                .as_ref(),
            Some(&goal)
        );

        let mut replacement = test_goal("thread-1", "Ship v0.8.59 safely");
        replacement.goal_id = "goal-2".to_string();
        replacement.status = ThreadGoalStatus::BudgetLimited;
        replacement.token_budget = None;
        replacement.updated_at = 202;
        store
            .upsert_thread_goal(&replacement)
            .expect("replace goal");
        assert_eq!(
            store.get_thread_goal("thread-1").expect("read replacement"),
            Some(replacement)
        );

        assert!(store.delete_thread_goal("thread-1").expect("delete goal"));
        assert!(
            store
                .get_thread_goal("thread-1")
                .expect("read empty")
                .is_none()
        );
        assert!(!store.delete_thread_goal("thread-1").expect("delete empty"));
    }

    #[test]
    fn thread_goal_requires_existing_thread() {
        let store = temp_state_store("thread-goal-missing-thread");
        let err = store
            .upsert_thread_goal(&test_goal("missing-thread", "nope"))
            .expect_err("goal without a thread should fail");
        assert!(err.to_string().contains("thread missing-thread not found"));
    }

    #[test]
    fn delete_thread_cascades_child_rows() {
        let store = temp_state_store("thread-delete-cascade");
        store
            .upsert_thread(&test_thread("thread-1"))
            .expect("upsert thread");
        store
            .append_message("thread-1", "user", "hello", None)
            .expect("append message");
        store
            .save_checkpoint("thread-1", "checkpoint-1", &serde_json::json!({"ok": true}))
            .expect("save checkpoint");
        store
            .persist_dynamic_tools(
                "thread-1",
                &[DynamicToolRecord {
                    position: 0,
                    name: "test_tool".to_string(),
                    description: Some("test".to_string()),
                    input_schema: serde_json::json!({"type": "object"}),
                }],
            )
            .expect("persist dynamic tools");
        store
            .upsert_thread_goal(&test_goal("thread-1", "Ship v0.8.67"))
            .expect("upsert goal");

        store.delete_thread("thread-1").expect("delete thread");

        let conn = store.conn().expect("conn");
        for table in [
            "messages",
            "checkpoints",
            "thread_dynamic_tools",
            "thread_goals",
        ] {
            let sql = format!("SELECT COUNT(*) FROM {table} WHERE thread_id = ?1");
            let count: i64 = conn
                .query_row(&sql, params!["thread-1"], |row| row.get(0))
                .expect("count child rows");
            assert_eq!(count, 0, "{table} row survived thread deletion");
        }
    }

    #[test]
    fn state_store_reuses_one_connection_across_operations_and_clones() {
        let store = temp_state_store("conn-reuse");
        {
            let conn = store.conn().expect("conn");
            conn.execute_batch("CREATE TEMP TABLE conn_reuse_probe(id INTEGER);")
                .expect("create temp table");
        }
        // TEMP tables are visible only on the connection that created them, so
        // seeing the probe again — through a clone, after real operations ran —
        // proves the store holds one long-lived connection instead of
        // reopening the database (and reapplying pragmas) per call.
        let clone = store.clone();
        clone
            .upsert_thread(&test_thread("thread-conn-reuse"))
            .expect("upsert thread");
        let conn = clone.conn().expect("conn");
        let probe_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_temp_master WHERE name = 'conn_reuse_probe'",
                [],
                |row| row.get(0),
            )
            .expect("query temp master");
        assert_eq!(
            probe_count, 1,
            "temp table not visible: a fresh connection was opened"
        );
        // The pragma applied once at open still governs the shared connection.
        let foreign_keys: i64 = conn
            .query_row("PRAGMA foreign_keys;", [], |row| row.get(0))
            .expect("read foreign_keys pragma");
        assert_eq!(foreign_keys, 1);
        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode;", [], |row| row.get(0))
            .expect("read journal_mode pragma");
        assert_eq!(
            journal_mode.to_ascii_lowercase(),
            "wal",
            "open should enable WAL for multi-process readers/writers"
        );
    }

    #[test]
    fn connection_setup_waits_for_database_lock_before_enabling_wal() {
        let dir = temp_state_dir("locked-open");
        let db_path = dir.join("state.db");

        let candidate = Connection::open(&db_path).expect("open candidate connection");
        // Do not let rusqlite's current default mask StateStore's own setup
        // contract: configure_connection must install the wait policy before
        // it performs any operation that can need a database lock.
        candidate
            .busy_timeout(Duration::ZERO)
            .expect("disable dependency default timeout");
        let blocker = Connection::open(&db_path).expect("open blocking connection");
        let (locked_tx, locked_rx) = mpsc::sync_channel(0);
        let blocker_thread = thread::spawn(move || {
            blocker
                .execute_batch("BEGIN EXCLUSIVE;")
                .expect("acquire exclusive database lock");
            locked_tx.send(()).expect("announce database lock");
            thread::sleep(Duration::from_millis(200));
            blocker
                .execute_batch("COMMIT;")
                .expect("release exclusive database lock");
        });

        locked_rx.recv().expect("wait for database lock");
        StateStore::configure_connection(&candidate, &db_path)
            .expect("connection setup should wait for the brief database lock");
        blocker_thread.join().expect("blocking thread panicked");

        let journal_mode: String = candidate
            .query_row("PRAGMA journal_mode;", [], |row| row.get(0))
            .expect("read journal_mode");
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");

        drop(candidate);
        let _ = fs::remove_dir_all(dir);
    }

    /// A second process must wait for a brief active writer instead of
    /// surfacing SQLITE_BUSY (#4734).
    ///
    /// The lock handoff is explicit: unlike a race between many autocommit
    /// writes, this proves the busy timeout while keeping the contention
    /// duration below its documented five-second bound on every platform.
    #[test]
    fn second_connection_waits_for_active_writer() {
        let dir = temp_state_dir("concurrent-write");
        let db_path = dir.join("state.db");

        let store_a = StateStore::open(Some(db_path.clone())).expect("open store a");
        let store_b = StateStore::open(Some(db_path.clone())).expect("open store b");
        let (locked_tx, locked_rx) = mpsc::sync_channel(0);
        let (release_tx, release_rx) = mpsc::sync_channel(0);

        let writer_a = thread::spawn(move || {
            let conn = store_a.conn().expect("connection a");
            conn.execute_batch(
                r#"
                BEGIN IMMEDIATE;
                INSERT INTO jobs(id, name, status, created_at, updated_at)
                VALUES ('job-a', 'writer-a', 'running', 0, 0);
                "#,
            )
            .expect("writer a should acquire the database write lock");
            locked_tx.send(()).expect("announce active writer");
            release_rx.recv().expect("wait to release active writer");
            conn.execute_batch("COMMIT;")
                .expect("writer a should commit");
        });

        locked_rx.recv().expect("wait for active writer");
        let (attempting_tx, attempting_rx) = mpsc::sync_channel(0);
        let writer_b = thread::spawn(move || {
            attempting_tx.send(()).expect("announce second write");
            store_b.upsert_job(&JobStateRecord {
                id: "job-b".to_string(),
                name: "writer-b".to_string(),
                status: JobStateStatus::Running,
                progress: None,
                detail: Some("waited for writer a".to_string()),
                created_at: 1,
                updated_at: 1,
            })
        });

        attempting_rx.recv().expect("wait for second write attempt");
        thread::sleep(Duration::from_millis(100));
        assert!(
            !writer_b.is_finished(),
            "second writer should still be waiting while the first holds the lock"
        );
        release_tx.send(()).expect("release active writer");
        writer_a.join().expect("writer a panicked");
        writer_b
            .join()
            .expect("writer b panicked")
            .expect("writer b should succeed after the lock is released");

        let store = StateStore::open(Some(db_path)).expect("reopen for verify");
        let listed = store.list_jobs(Some(2)).expect("list jobs");
        assert_eq!(listed.len(), 2, "both writers should persist their jobs");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn migration_runs_cleanly_when_schema_predates_user_version_header() {
        // Simulate a restore (or a racing process that crashed before
        // stamping user_version): the on-disk schema is fully migrated but
        // the header still says 0. The v0 block used to re-run unconditional
        // ADD COLUMN statements and abort the open with
        // "duplicate column name".
        let dir = temp_state_dir("migration-v0-idempotent");
        let db_path = dir.join("state.db");
        drop(StateStore::open(Some(db_path.clone())).expect("initial open"));
        {
            let conn = Connection::open(&db_path).expect("raw connection");
            conn.pragma_update(None, "user_version", 0)
                .expect("reset user_version");
        }

        let store = StateStore::open(Some(db_path.clone())).expect("reopen with v0 header");
        store
            .upsert_thread(&test_thread("thread-migrated"))
            .expect("write after guarded migration");

        // Reopening again (now stamped at the current version) still works.
        drop(store);
        let store = StateStore::open(Some(db_path)).expect("third open");
        let persisted = store
            .get_thread("thread-migrated")
            .expect("read after reopen");
        assert!(persisted.is_some());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ledger_allocates_sequences_and_verifies_replay() {
        let store = temp_state_store("ledger-sequences");
        let event = |id: &str, payload: Value| LedgerEventAppend {
            event_id: id.to_string(),
            session_id: "session-ledger".to_string(),
            event_type: "user_input_submitted".to_string(),
            workspace_id: None,
            turn_id: None,
            correlation_id: Some("corr-1".to_string()),
            parent_event_id: None,
            actor: json!({"kind": "user", "id": "desktop"}),
            visibility: "model_and_ui".to_string(),
            payload,
            timestamp: "2026-10-03T00:00:00Z".to_string(),
        };

        let first = store
            .append_ledger_event(&event("evt-1", json!({"content": "one"})))
            .expect("append first ledger event");
        let second = store
            .append_ledger_event(&event("evt-2", json!({"content": "two"})))
            .expect("append second ledger event");
        assert_eq!(first.seq, 1);
        assert_eq!(second.seq, 2);

        let replay = store
            .list_ledger_events("session-ledger", 1, 50)
            .expect("read ledger tail");
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0], second);

        let verification = store
            .verify_ledger("session-ledger")
            .expect("verify ledger");
        assert_eq!(verification.event_count, 2);
        assert_eq!(verification.last_seq, 2);
        assert!(verification.contiguous);
    }

    /// Append a minimal legal ledger event to `session`.
    fn append_test_ledger_event(store: &StateStore, session: &str, id: &str) {
        store
            .append_ledger_event(&LedgerEventAppend {
                event_id: id.to_string(),
                session_id: session.to_string(),
                event_type: "user_input_submitted".to_string(),
                workspace_id: None,
                turn_id: None,
                correlation_id: None,
                parent_event_id: None,
                actor: json!({"kind": "user", "id": "desktop"}),
                visibility: "model_and_ui".to_string(),
                payload: json!({"content": "hi"}),
                timestamp: "2026-10-03T00:00:00Z".to_string(),
            })
            .expect("append ledger event");
    }

    /// A healthy store verifies every session and reports no failures.
    #[test]
    fn ledger_integrity_report_summarizes_healthy_sessions() {
        let store = temp_state_store("ledger-integrity-healthy");
        append_test_ledger_event(&store, "session-a", "evt-a1");
        append_test_ledger_event(&store, "session-a", "evt-a2");
        append_test_ledger_event(&store, "session-b", "evt-b1");

        let report = store.verify_all_ledgers().expect("verify all ledgers");
        assert_eq!(report.sessions_verified, 2);
        assert_eq!(report.events_verified, 3);
        assert!(report.non_contiguous.is_empty(), "{report:#?}");
        assert!(report.is_healthy());

        // A store with no events is healthy and empty, not an error.
        let empty = temp_state_store("ledger-integrity-empty");
        let empty_report = empty.verify_all_ledgers().expect("verify empty store");
        assert_eq!(empty_report.sessions_verified, 0);
        assert!(empty_report.is_healthy());
    }

    /// A session with a sequence gap is named in the report, and the healthy
    /// sessions around it are still counted.
    #[test]
    fn ledger_integrity_report_names_a_non_contiguous_session() {
        let store = temp_state_store("ledger-integrity-gap");
        append_test_ledger_event(&store, "session-good", "evt-good");
        append_test_ledger_event(&store, "session-gap", "evt-gap-1");
        append_test_ledger_event(&store, "session-gap", "evt-gap-2");

        // Delete a middle event's row to create a real sequence gap, the way a
        // torn write or an out-of-band edit would.
        {
            let conn = store.conn().expect("open store connection");
            conn.execute(
                "DELETE FROM ledger_events WHERE session_id = 'session-gap' AND seq = 1",
                [],
            )
            .expect("remove the gap event");
        }

        // The single-session verify fails outright on a gap; the report has to
        // turn that into a finding rather than failing the whole scan.
        assert!(
            store.verify_ledger("session-gap").is_err(),
            "a gap is a verification error at the single-session level"
        );

        let report = store.verify_all_ledgers().expect("verify all ledgers");
        assert_eq!(report.sessions_verified, 2, "both sessions are still read");
        assert_eq!(
            report.events_verified, 2,
            "the surviving events are still counted"
        );
        assert!(!report.is_healthy());
        assert_eq!(report.non_contiguous.len(), 1, "{report:#?}");
        assert_eq!(report.non_contiguous[0].session_id, "session-gap");
        assert_eq!(report.non_contiguous[0].event_count, 1);
        assert_eq!(report.non_contiguous[0].last_seq, 2);
    }

    #[test]
    fn ledger_rejects_empty_identity_before_mutation() {
        let store = temp_state_store("ledger-validation");
        let invalid = LedgerEventAppend {
            event_id: String::new(),
            session_id: "session-ledger".to_string(),
            event_type: "test".to_string(),
            workspace_id: None,
            turn_id: None,
            correlation_id: None,
            parent_event_id: None,
            actor: json!({}),
            visibility: "model_and_ui".to_string(),
            payload: json!({}),
            timestamp: "2026-10-03T00:00:00Z".to_string(),
        };
        let error = store
            .append_ledger_event(&invalid)
            .expect_err("empty event id must be rejected");
        assert!(error.to_string().contains("event_id"));
        assert_eq!(
            store
                .verify_ledger("session-ledger")
                .expect("verify empty ledger")
                .event_count,
            0
        );
    }

    #[test]
    fn ledger_registry_rejects_incomplete_core_payloads() {
        let store = temp_state_store("ledger-payload-registry");
        let invalid = LedgerEventAppend {
            event_id: "evt-invalid-payload".to_string(),
            session_id: "session-ledger".to_string(),
            event_type: "item.delta".to_string(),
            workspace_id: None,
            turn_id: Some("turn-1".to_string()),
            correlation_id: None,
            parent_event_id: None,
            actor: json!({"kind": "runtime", "id": "rust"}),
            visibility: "model_and_ui".to_string(),
            payload: json!({"delta": "partial"}),
            timestamp: "2026-10-03T00:00:00Z".to_string(),
        };
        let error = store
            .append_ledger_event(&invalid)
            .expect_err("item.delta without kind must be rejected");
        assert!(error.to_string().contains("missing 'kind'"));
        assert_eq!(
            store
                .verify_ledger("session-ledger")
                .expect("verify empty payload-registry ledger")
                .event_count,
            0
        );
    }

    #[test]
    fn ledger_retry_is_idempotent_and_conflicting_reuse_is_rejected() {
        let store = temp_state_store("ledger-idempotency");
        let event = LedgerEventAppend {
            event_id: "evt-retry".to_string(),
            session_id: "session-retry".to_string(),
            event_type: "turn_started".to_string(),
            workspace_id: None,
            turn_id: Some("turn-1".to_string()),
            correlation_id: Some("corr-1".to_string()),
            parent_event_id: None,
            actor: json!({"kind": "runtime", "id": "rust"}),
            visibility: "model_and_ui".to_string(),
            payload: json!({"prompt": "hello"}),
            timestamp: "2026-10-03T00:00:00Z".to_string(),
        };

        let first = store
            .append_ledger_event(&event)
            .expect("append initial event");
        let retry = store
            .append_ledger_event(&event)
            .expect("retry should return the original event");
        assert_eq!(retry, first);
        assert_eq!(
            store
                .verify_ledger("session-retry")
                .expect("verify idempotent ledger")
                .event_count,
            1
        );

        let mut conflicting = event;
        conflicting.payload = json!({"prompt": "different"});
        let error = store
            .append_ledger_event(&conflicting)
            .expect_err("reusing an event id with different content must fail");
        assert!(error.to_string().contains("already exists with different content"));
    }

    #[test]
    fn legacy_jsonl_import_is_checksum_bound_and_idempotent() {
        let dir = temp_state_dir("ledger-import");
        let store = StateStore::open(Some(dir.join("state.db"))).expect("open store");
        let source = dir.join("session_log.jsonl");
        fs::write(
            &source,
            concat!(
                "{\"type\":\"turn_start\",\"ts\":1735689600.5,\"turn\":1,\"working_dir\":\"C:/workspace\",\"api_key\":\"legacy-secret\"}\n",
                "{\"type\":\"text_delta\",\"ts\":1735689601,\"turn\":1,\"text\":\"hello\"}\n",
                "not-json\n"
            ),
        )
        .expect("write legacy log");

        let first = store
            .import_legacy_jsonl("session-import", &source)
            .expect("import legacy log");
        assert_eq!(first.imported, 2);
        assert_eq!(first.skipped, 1);
        assert!(first.source_sha256.starts_with("sha256:"));
        assert_eq!(
            store
                .verify_ledger("session-import")
                .expect("verify imported ledger")
                .event_count,
            2
        );

        let second = store
            .import_legacy_jsonl("session-import", &source)
            .expect("retry import legacy log");
        assert_eq!(second.imported, 0);
        assert_eq!(second.skipped, 3);
        // The persisted compat-import metric counts only newly imported
        // events; the idempotent retry adds nothing.
        assert_eq!(
            store
                .compat_imported_event_count()
                .expect("compat imported event count"),
            2
        );
        let events = store
            .list_ledger_events("session-import", 0, 50)
            .expect("read imported events");
        assert_eq!(events[0].event_type, "turn_started");
        assert_eq!(events[0].payload["api_key"], "[REDACTED]");
        assert_eq!(events[1].event_type, "model_delta");

        let _ = fs::remove_dir_all(dir);
    }

    /// The compat-import metric is persisted: it survives a store reopen and
    /// counts only newly imported canonical events (Phase 0 metric).
    #[test]
    fn compat_imported_event_count_is_persisted_across_reopen() {
        let dir = temp_state_dir("compat-import-metric");
        let db = dir.join("state.db");
        {
            let store = StateStore::open(Some(db.clone())).expect("open store");
            let source = dir.join("session_log.jsonl");
            fs::write(
                &source,
                "{\"type\":\"turn_start\",\"ts\":1,\"turn\":1}\n{\"type\":\"text_delta\",\"ts\":2,\"turn\":1,\"text\":\"x\"}\n",
            )
            .expect("write legacy log");
            let summary = store
                .import_legacy_jsonl("session-metric", &source)
                .expect("import legacy log");
            assert_eq!(summary.imported, 2);
            assert_eq!(
                store.compat_imported_event_count().expect("count"),
                2,
                "the counter must reflect the import before any reopen"
            );
        }
        {
            let store = StateStore::open(Some(db)).expect("reopen store");
            assert_eq!(
                store.compat_imported_event_count().expect("count"),
                2,
                "the counter must survive a restart"
            );
        }
        let _ = fs::remove_dir_all(dir);
    }

    /// Write a minimal legacy Python session store at `path`.
    fn write_legacy_store(path: &Path, sessions: &[(&str, &str, i64)]) {
        let conn = Connection::open(path).expect("open legacy fixture");
        conn.execute_batch(
            r#"
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                reasoning TEXT,
                tool_calls_json TEXT,
                input_tokens INTEGER,
                output_tokens INTEGER,
                error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            "#,
        )
        .expect("create legacy schema");
        for (index, (id, title, updated_at)) in sessions.iter().enumerate() {
            conn.execute(
                "INSERT INTO sessions VALUES (?1, ?2, 'openai', ?3, ?4)",
                params![id, title, updated_at, updated_at],
            )
            .expect("insert legacy session");
            // Two messages each, so the count a caller sees is not a constant.
            for offset in 0..2 {
                conn.execute(
                    "INSERT INTO messages VALUES (?1, ?2, 'user', 'hi', NULL, NULL, NULL, NULL, NULL, ?3, ?3)",
                    params![
                        format!("{id}-m{offset}"),
                        id,
                        updated_at + i64::try_from(index).unwrap_or(0)
                    ],
                )
                .expect("insert legacy message");
            }
        }
    }

    /// Discovery reports what a migration could import without importing it.
    #[test]
    fn legacy_discovery_reports_sessions_without_importing() {
        let dir = temp_state_dir("legacy-discovery");
        let store_dir = dir.join("previous-install");
        fs::create_dir_all(&store_dir).expect("create previous install dir");
        let source_path = store_dir.join("sessions.db");
        write_legacy_store(
            &source_path,
            &[("python-a", "Older chat", 1_735_689_600_000), ("python-b", "Newer chat", 1_735_689_900_000)],
        );
        // A sibling checkpoint bundle is reported, not parsed.
        let checkpoint = store_dir.join("checkpoints.json");
        fs::write(&checkpoint, "{}").expect("write checkpoint sibling");

        let target = StateStore::open(Some(dir.join("state.db"))).expect("open target state");
        let discovery = target.discover_legacy_session_stores(&[store_dir.clone()]);

        assert_eq!(discovery.stores.len(), 1, "one store: {discovery:#?}");
        assert!(discovery.rejected.is_empty(), "{discovery:#?}");
        let store = &discovery.stores[0];
        assert_eq!(store.path, source_path);
        assert!(store.size_bytes > 0);
        assert_eq!(store.checkpoint_path.as_deref(), Some(checkpoint.as_path()));
        // Newest first, so a migration surface can lead with the current chat.
        let ids = store
            .sessions
            .iter()
            .map(|session| session.session_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["python-b", "python-a"]);
        assert_eq!(store.sessions[0].message_count, 2);
        assert_eq!(discovery.total_sessions(), 2);
        assert_eq!(discovery.total_messages(), 4);

        // Nothing was imported: discovery is a summary, not a migration.
        assert!(
            target.list_messages("python-a", None).unwrap().is_empty(),
            "discovery must not import"
        );

        let _ = fs::remove_dir_all(dir);
    }

    /// A `sessions.db` that is not a legacy store is reported as rejected, and
    /// does not hide a real store found through another root.
    #[test]
    fn legacy_discovery_rejects_a_foreign_database_and_keeps_scanning() {
        let dir = temp_state_dir("legacy-discovery-reject");
        let decoy = dir.join("decoy");
        let real = dir.join("real");
        fs::create_dir_all(&decoy).expect("create decoy dir");
        fs::create_dir_all(&real).expect("create real dir");

        // A SQLite file with unrelated tables.
        let decoy_path = decoy.join("sessions.db");
        Connection::open(&decoy_path)
            .expect("open decoy")
            .execute_batch("CREATE TABLE unrelated (id TEXT PRIMARY KEY);")
            .expect("create decoy schema");
        let real_path = real.join("sessions.db");
        write_legacy_store(&real_path, &[("python-real", "Real", 1_735_689_600_000)]);

        let target = StateStore::open(Some(dir.join("state.db"))).expect("open target state");
        let discovery = target.discover_legacy_session_stores(&[decoy.clone(), real.clone()]);

        assert_eq!(discovery.stores.len(), 1, "{discovery:#?}");
        assert_eq!(discovery.stores[0].path, real_path);
        assert_eq!(discovery.rejected.len(), 1, "{discovery:#?}");
        assert_eq!(discovery.rejected[0].path, decoy_path);
        assert!(
            discovery.rejected[0].reason.contains("not a legacy session store"),
            "unexpected reason: {}",
            discovery.rejected[0].reason
        );

        // The same store reached twice is reported once.
        let deduped = target.discover_legacy_session_stores(&[real.clone(), real.clone()]);
        assert_eq!(deduped.stores.len(), 1, "{deduped:#?}");

        let _ = fs::remove_dir_all(dir);
    }

    /// A missing root is not an error: an install that never had Python data
    /// must produce an empty summary, not a failure.
    #[test]
    fn legacy_discovery_treats_a_missing_root_as_empty() {
        let dir = temp_state_dir("legacy-discovery-missing");
        let target = StateStore::open(Some(dir.join("state.db"))).expect("open target state");
        let discovery =
            target.discover_legacy_session_stores(&[dir.join("no-such-install")]);
        assert!(discovery.stores.is_empty());
        assert!(discovery.rejected.is_empty());
        assert_eq!(discovery.total_sessions(), 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_session_state_imports_messages_and_checkpoints_once() {
        let dir = temp_state_dir("session-state-import");
        let source_path = dir.join("sessions.db");
        let source = Connection::open(&source_path).expect("open source session db");
        source
            .execute_batch(
                r#"
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    provider TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    reasoning TEXT,
                    tool_calls_json TEXT,
                    input_tokens INTEGER,
                    output_tokens INTEGER,
                    error TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                INSERT INTO sessions VALUES ('python-1', 'Imported chat', 'openai', 1735689600000, 1735689602000);
                INSERT INTO messages VALUES ('m-1', 'python-1', 'user', 'hello', NULL, NULL, 3, NULL, NULL, 1735689600000, 1735689600000);
                INSERT INTO messages VALUES ('m-2', 'python-1', 'assistant', 'world', 'reasoning', '[{"name":"tool"}]', NULL, 5, NULL, 1735689601000, 1735689601000);
                "#,
            )
            .expect("create source session fixture");
        drop(source);

        let checkpoint_path = dir.join("python-1.json");
        fs::write(
            &checkpoint_path,
            r#"{"session_id":"python-1","checkpoints":{"cp-1":{"messages":[{"role":"user","content":"hello"}],"dynamic_context":{"cwd":"C:/workspace"},"timestamp":1735689602.0,"metadata":{"trigger":"after_turn","api_key":"secret"}}},"order":["cp-1"]}"#,
        )
        .expect("write checkpoint fixture");

        let store = StateStore::open(Some(dir.join("state.db"))).expect("open target state");
        let first = store
            .import_legacy_session_db(
                "rust-target",
                &source_path,
                "python-1",
                Some(&checkpoint_path),
            )
            .expect("import legacy session state");
        assert_eq!(first.imported_messages, 2);
        assert_eq!(first.imported_checkpoints, 1);
        assert_eq!(store.list_messages("rust-target", None).unwrap().len(), 2);
        let checkpoint = store
            .load_checkpoint("rust-target", Some("cp-1"))
            .expect("load imported checkpoint")
            .expect("checkpoint exists");
        assert_eq!(checkpoint.state["metadata"]["api_key"], "[REDACTED]");

        let second = store
            .import_legacy_session_db(
                "rust-target",
                &source_path,
                "python-1",
                Some(&checkpoint_path),
            )
            .expect("retry legacy session state import");
        assert_eq!(second.imported_messages, 0);
        assert_eq!(second.skipped_messages, 2);
        assert_eq!(second.imported_checkpoints, 0);
        assert_eq!(second.skipped_checkpoints, 1);
        assert_eq!(store.list_messages("rust-target", None).unwrap().len(), 2);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn record_thread_goal_usage_accumulates_tokens_and_time() {
        let store = temp_state_store("thread-goal-usage");
        store
            .upsert_thread(&test_thread("thread-1"))
            .expect("upsert thread");

        // Mirror the runtime, which creates goals with zeroed accounting.
        let mut goal = test_goal("thread-1", "Ship the persistent goal loop");
        goal.tokens_used = 0;
        goal.time_used_seconds = 0;
        goal.updated_at = 100;
        store.upsert_thread_goal(&goal).expect("upsert goal");

        // First accrual lands the deltas and advances updated_at.
        let after_first = store
            .record_thread_goal_usage("thread-1", 250, 12, 150)
            .expect("record usage")
            .expect("goal exists");
        assert_eq!(after_first.tokens_used, 250);
        assert_eq!(after_first.time_used_seconds, 12);
        assert_eq!(after_first.updated_at, 150);
        // Identity fields are preserved across accrual.
        assert_eq!(after_first.goal_id, goal.goal_id);
        assert_eq!(after_first.objective, goal.objective);
        assert_eq!(after_first.status, goal.status);
        assert_eq!(after_first.token_budget, goal.token_budget);
        assert_eq!(after_first.created_at, goal.created_at);
        assert_eq!(after_first.continuation_count, 0);

        // Second accrual adds on top of the first (additive, not replacing).
        let after_second = store
            .record_thread_goal_usage("thread-1", 75, 8, 200)
            .expect("record usage")
            .expect("goal exists");
        assert_eq!(after_second.tokens_used, 325);
        assert_eq!(after_second.time_used_seconds, 20);
        assert_eq!(after_second.updated_at, 200);

        // A stale `now` must not move updated_at backwards.
        let after_stale = store
            .record_thread_goal_usage("thread-1", 5, 1, 1)
            .expect("record usage")
            .expect("goal exists");
        assert_eq!(after_stale.tokens_used, 330);
        assert_eq!(after_stale.time_used_seconds, 21);
        assert_eq!(after_stale.updated_at, 200);

        // Read back through the normal getter to confirm durability.
        let persisted = store
            .get_thread_goal("thread-1")
            .expect("read goal")
            .expect("goal exists");
        assert_eq!(persisted.tokens_used, 330);
        assert_eq!(persisted.time_used_seconds, 21);
    }

    #[test]
    fn record_thread_goal_usage_returns_none_without_goal() {
        let store = temp_state_store("thread-goal-usage-missing");
        store
            .upsert_thread(&test_thread("thread-1"))
            .expect("upsert thread");
        // Thread exists but has no goal row yet: accrual is a no-op, not an error,
        // and must not create a goal.
        let result = store
            .record_thread_goal_usage("thread-1", 100, 5, 999)
            .expect("record usage on goalless thread");
        assert!(result.is_none());
        assert!(
            store
                .get_thread_goal("thread-1")
                .expect("read goal")
                .is_none()
        );
    }

    #[test]
    fn record_thread_goal_continuation_accumulates_durably() {
        let store = temp_state_store("thread-goal-continuation");
        store
            .upsert_thread(&test_thread("thread-1"))
            .expect("upsert thread");

        let mut goal = test_goal("thread-1", "Keep working across turns");
        goal.updated_at = 100;
        store.upsert_thread_goal(&goal).expect("upsert goal");

        let after_first = store
            .record_thread_goal_continuation("thread-1", 120)
            .expect("record continuation")
            .expect("goal exists");
        assert_eq!(after_first.continuation_count, 1);
        assert_eq!(after_first.tokens_used, goal.tokens_used);
        assert_eq!(after_first.time_used_seconds, goal.time_used_seconds);
        assert_eq!(after_first.updated_at, 120);

        let after_second = store
            .record_thread_goal_continuation("thread-1", 110)
            .expect("record second continuation")
            .expect("goal exists");
        assert_eq!(after_second.continuation_count, 2);
        assert_eq!(after_second.updated_at, 120);

        let persisted = store
            .get_thread_goal("thread-1")
            .expect("read goal")
            .expect("goal exists");
        assert_eq!(persisted.continuation_count, 2);
    }

    // ── $HAKUS_HOME override tests ──────────────────────────────
    //
    // These touch a process-global env var, so they serialize against each
    // other (and restore the prior value) to stay hermetic under parallel test
    // runs — the same concern AGENTS.md flags for config_command_allow_shell_*.

    static HAKUS_HOME_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct CodeWhaleHomeGuard {
        prior: Option<std::ffi::OsString>,
    }
    impl CodeWhaleHomeGuard {
        fn set(value: &str) -> Self {
            let prior = std::env::var_os("HAKUS_HOME");
            // SAFETY: serialised by HAKUS_HOME_TEST_LOCK.
            unsafe { std::env::set_var("HAKUS_HOME", value) };
            Self { prior }
        }
        fn remove() -> Self {
            let prior = std::env::var_os("HAKUS_HOME");
            // SAFETY: serialised by HAKUS_HOME_TEST_LOCK.
            unsafe { std::env::remove_var("HAKUS_HOME") };
            Self { prior }
        }
    }
    impl Drop for CodeWhaleHomeGuard {
        fn drop(&mut self) {
            // SAFETY: serialised by HAKUS_HOME_TEST_LOCK.
            unsafe {
                match &self.prior {
                    Some(value) => std::env::set_var("HAKUS_HOME", value),
                    None => std::env::remove_var("HAKUS_HOME"),
                }
            }
        }
    }

    #[test]
    fn hakus_home_override_returns_the_env_value_verbatim() {
        let _lock = HAKUS_HOME_TEST_LOCK.lock().unwrap();
        let override_path = std::env::temp_dir().join("cw-isolated-state");
        let _g = CodeWhaleHomeGuard::set(override_path.to_str().unwrap());
        // The env var IS the home dir — no ".hakus" appended. This matches
        // hakus_home() in config ($HAKUS_HOME=/x means home is /x).
        assert_eq!(
            hakus_home_override().unwrap().as_deref(),
            Some(override_path.as_path())
        );
    }

    #[test]
    fn hakus_home_override_none_when_unset() {
        let _lock = HAKUS_HOME_TEST_LOCK.lock().unwrap();
        let _g = CodeWhaleHomeGuard::remove();
        assert!(hakus_home_override().unwrap().is_none());
    }

    #[test]
    fn hakus_home_override_none_when_whitespace_only() {
        let _lock = HAKUS_HOME_TEST_LOCK.lock().unwrap();
        let _g = CodeWhaleHomeGuard::set("   ");
        assert!(
            hakus_home_override().unwrap().is_none(),
            "whitespace-only HAKUS_HOME must not establish isolation"
        );
    }

    #[test]
    fn default_state_db_path_uses_hakus_home_when_set() {
        let _lock = HAKUS_HOME_TEST_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "cw-home-state-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _g = CodeWhaleHomeGuard::set(dir.to_str().unwrap());
        // Hard override: the DB is <HAKUS_HOME>/state.db, NOT
        // <HAKUS_HOME>/state.db is used exactly as configured.
        assert_eq!(default_state_db_path(), dir.join("state.db"));
    }

    #[test]
    fn load_checkpoint_propagates_invalid_state_json() {
        let store = temp_state_store("checkpoint-parse-error");
        store
            .upsert_thread(&test_thread("thread-1"))
            .expect("upsert thread");
        store
            .save_checkpoint("thread-1", "broken", &json!({"ok": true}))
            .expect("save checkpoint");

        {
            let conn = store.conn().expect("conn");
            conn.execute(
                "UPDATE checkpoints SET state_json = ?1 WHERE thread_id = ?2 AND checkpoint_id = ?3",
                params!["not-json", "thread-1", "broken"],
            )
            .expect("corrupt checkpoint");
        }

        let err = store
            .load_checkpoint("thread-1", Some("broken"))
            .expect_err("invalid checkpoint json should fail");
        assert!(
            err.to_string()
                .contains("failed to parse checkpoint state json")
        );
    }

    #[test]
    fn session_index_compacts_after_threshold() {
        let store = temp_state_store("session-index-compact");
        for idx in 0..6 {
            store
                .append_thread_name("thread-1", Some(format!("name-{idx}")), idx, None)
                .expect("append session index entry");
        }

        let line_count = store
            .session_index_line_count()
            .expect("count session index lines");
        assert_eq!(line_count, 1);

        let name = store
            .find_thread_name_by_id("thread-1")
            .expect("lookup thread name");
        assert_eq!(name.as_deref(), Some("name-5"));
    }

    #[test]
    fn session_index_read_skips_a_torn_line() {
        // #4735: a crash mid-append leaves a truncated final line. Failing the
        // whole read broke every thread-name lookup at once, and compaction
        // reads through the same path, so the index could not repair itself.
        let store = temp_state_store("session-index-torn");
        store
            .append_thread_name("thread-1", Some("first".to_string()), 1, None)
            .expect("append first entry");

        {
            let mut file = OpenOptions::new()
                .append(true)
                .open(&store.session_index_path)
                .expect("open session index");
            // A write cut off mid-JSON, exactly as a crash would leave it.
            writeln!(file, "{{\"thread_id\":\"thread-2\",\"thread_na").expect("write torn line");
        }

        store
            .append_thread_name("thread-3", Some("third".to_string()), 3, None)
            .expect("append third entry");

        assert_eq!(
            store
                .find_thread_name_by_id("thread-1")
                .expect("lookup thread-1")
                .as_deref(),
            Some("first"),
        );
        assert_eq!(
            store
                .find_thread_name_by_id("thread-3")
                .expect("lookup thread-3")
                .as_deref(),
            Some("third"),
        );
    }

    /// Hook fired by compaction between writing the snapshot and renaming it
    /// over the live index — the window a concurrent append can be lost in.
    /// Only the store whose path a test registered is affected, so tests
    /// running in parallel don't disturb each other.
    type MidpointHook = Box<dyn Fn() + Send + Sync>;
    static COMPACTION_MIDPOINT: Mutex<Option<(PathBuf, MidpointHook)>> = Mutex::new(None);

    /// Fires at most once: the racing append compacts too, and a hook that
    /// fired twice would re-enter the test's one-shot handshake.
    pub(super) fn compaction_midpoint(index_path: &Path) {
        let mut hook = COMPACTION_MIDPOINT.lock().expect("midpoint hook lock");
        let registered_for_this_store = match hook.as_ref() {
            Some((registered, _)) => registered == index_path,
            None => return,
        };
        if !registered_for_this_store {
            return;
        }
        let (_, callback) = hook.take().expect("presence checked above");
        drop(hook);
        callback();
    }

    #[test]
    fn session_index_compaction_does_not_drop_a_concurrent_append() {
        // #4736: compaction snapshots the file, rewrites it, and renames over
        // the live one. An append landing between those two steps used to
        // vanish — silently, since it had already returned success to its
        // caller. The shared lock serializes the two.
        //
        // The race is real but narrow, so the test drives it deterministically:
        // a hook at the compaction midpoint releases the appender and then
        // waits. Without the lock the appender writes into the doomed file and
        // the rename discards it; with the lock it blocks until compaction
        // finishes, and its entry survives.
        let store = Arc::new(temp_state_store("session-index-race"));
        let threshold = session_index_compact_line_threshold();

        // One line short of the threshold, so the next append compacts.
        for idx in 0..threshold {
            store
                .append_thread_name(
                    &format!("thread-{idx}"),
                    Some(format!("name-{idx}")),
                    1,
                    None,
                )
                .expect("append filler entry");
        }

        let appender_released = Arc::new(Barrier::new(2));
        {
            let released = Arc::clone(&appender_released);
            *COMPACTION_MIDPOINT.lock().expect("midpoint hook lock") = Some((
                store.session_index_path.clone(),
                Box::new(move || {
                    released.wait();
                    // Give the appender time to complete its write into the
                    // window. Under the fix it is blocked on the lock instead.
                    thread::sleep(Duration::from_millis(300));
                }),
            ));
        }

        let appender = {
            let store = Arc::clone(&store);
            let released = Arc::clone(&appender_released);
            thread::spawn(move || {
                released.wait();
                store
                    .append_thread_name("racer", Some("racer-name".to_string()), 2, None)
                    .expect("append racing entry");
            })
        };

        store
            .append_thread_name("trigger", Some("trigger-name".to_string()), 1, None)
            .expect("append entry that triggers compaction");
        appender.join().expect("appender thread");
        *COMPACTION_MIDPOINT.lock().expect("midpoint hook lock") = None;

        assert_eq!(
            store
                .find_thread_name_by_id("racer")
                .expect("lookup racer")
                .as_deref(),
            Some("racer-name"),
            "append was dropped by a concurrent compaction",
        );
        assert_eq!(
            store
                .find_thread_name_by_id("trigger")
                .expect("lookup trigger")
                .as_deref(),
            Some("trigger-name"),
        );
    }
}
