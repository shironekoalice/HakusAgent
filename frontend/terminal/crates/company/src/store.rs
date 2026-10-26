//! SQLite persistence for the control plane.
//!
//! All queries live here so the invariant that matters most — atomic ticket
//! checkout — has exactly one implementation (see [`CompanyStore::checkout_issue`]).

use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context as _, Result};
use rusqlite::{Connection, params};
use uuid::Uuid;

use crate::model::{
    AgentRow, AgentStatus, ApprovalRow, ApprovalStatus, CompanyRow, CostEventRow, GoalRow,
    HeartbeatRow, HeartbeatRunRow, IssueRow, IssueState, RunStatus,
};
use crate::schema;

pub type StoreResult<T> = Result<T, rusqlite::Error>;

/// Fields needed to file a ticket.
#[derive(Debug, Clone, Default)]
pub struct NewIssue<'a> {
    pub company_id: &'a str,
    pub goal_id: Option<&'a str>,
    pub parent_issue_id: Option<&'a str>,
    pub title: &'a str,
    pub body: &'a str,
    pub assignee_agent_id: Option<&'a str>,
    pub created_by_agent_id: Option<&'a str>,
    pub billing_code: &'a str,
    pub depth: i64,
}

impl<'a> NewIssue<'a> {
    pub fn new(company_id: &'a str, title: &'a str) -> Self {
        Self {
            company_id,
            title,
            ..Default::default()
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("agent not found: {0}")]
    AgentNotFound(String),
}

/// Thin wrapper over a single SQLite connection. `Mutex` because rusqlite's
/// `Connection` is `Send` but not `Sync`.
pub struct CompanyStore {
    conn: Mutex<Connection>,
}

impl CompanyStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let mut conn =
            Connection::open(path).with_context(|| format!("open {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "busy_timeout", 5000i64)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        schema::migrate(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_in_memory() -> StoreResult<Self> {
        let mut conn = Connection::open_in_memory()?;
        schema::migrate(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn now_secs() -> i64 {
        chrono::Utc::now().timestamp()
    }

    fn new_id(prefix: &str) -> String {
        format!("{}_{}", prefix, Uuid::new_v4().simple())
    }

    // ── company ─────────────────────────────────────────────────────────────

    pub fn create_company(&self, name: &str, mission: &str) -> StoreResult<CompanyRow> {
        let row = CompanyRow {
            id: Self::new_id("cmp"),
            name: name.to_string(),
            mission: mission.to_string(),
            status: "active".to_string(),
            created_at: Self::now_secs(),
        };
        self.conn().execute(
            "INSERT INTO company (id, name, mission, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![row.id, row.name, row.mission, row.status, row.created_at],
        )?;
        Ok(row)
    }

    pub fn get_company(&self, id: &str) -> StoreResult<Option<CompanyRow>> {
        self.conn()
            .query_row(
                "SELECT * FROM company WHERE id=?1",
                params![id],
                CompanyRow::from_row,
            )
            .optional()
    }

    pub fn list_companies(&self) -> StoreResult<Vec<CompanyRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM company ORDER BY created_at DESC")?;
        let rows = stmt
            .query_map([], CompanyRow::from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ── agents ──────────────────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    pub fn create_agent(
        &self,
        company_id: &str,
        name: &str,
        role: &str,
        parent_agent_id: Option<&str>,
        adapter: &str,
        adapter_config: &str,
        budget_monthly_cents: i64,
    ) -> StoreResult<AgentRow> {
        let row = AgentRow {
            id: Self::new_id("agt"),
            company_id: company_id.to_string(),
            name: name.to_string(),
            role: role.to_string(),
            title: String::new(),
            parent_agent_id: parent_agent_id.map(str::to_string),
            adapter: adapter.to_string(),
            adapter_config: adapter_config.to_string(),
            runtime_session_id: None,
            status: AgentStatus::Active.as_str().to_string(),
            budget_monthly_cents,
            created_at: Self::now_secs(),
        };
        self.conn().execute(
            "INSERT INTO agent (id, company_id, name, role, title, parent_agent_id, adapter,
                                adapter_config, runtime_session_id, status, budget_monthly_cents, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                row.id,
                row.company_id,
                row.name,
                row.role,
                row.title,
                row.parent_agent_id,
                row.adapter,
                row.adapter_config,
                row.runtime_session_id,
                row.status,
                row.budget_monthly_cents,
                row.created_at
            ],
        )?;
        Ok(row)
    }

    pub fn get_agent(&self, id: &str) -> StoreResult<Option<AgentRow>> {
        self.conn()
            .query_row(
                "SELECT * FROM agent WHERE id=?1",
                params![id],
                AgentRow::from_row,
            )
            .optional()
    }

    pub fn list_agents(&self, company_id: &str) -> StoreResult<Vec<AgentRow>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT * FROM agent WHERE company_id=?1 ORDER BY created_at")?;
        let rows = stmt
            .query_map(params![company_id], AgentRow::from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Persist the runtime session id so subsequent heartbeats keep context.
    pub fn set_agent_session(&self, id: &str, session: &str) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE agent SET runtime_session_id=?2 WHERE id=?1",
            params![id, session],
        )?;
        Ok(())
    }

    pub fn set_agent_status(&self, id: &str, status: AgentStatus) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE agent SET status=?2 WHERE id=?1",
            params![id, status.as_str()],
        )?;
        Ok(())
    }

    // ── goals ───────────────────────────────────────────────────────────────

    pub fn create_goal(
        &self,
        company_id: &str,
        parent_id: Option<&str>,
        kind: &str,
        title: &str,
        description: &str,
    ) -> StoreResult<GoalRow> {
        let row = GoalRow {
            id: Self::new_id("goal"),
            company_id: company_id.to_string(),
            parent_id: parent_id.map(str::to_string),
            kind: kind.to_string(),
            title: title.to_string(),
            description: description.to_string(),
        };
        self.conn().execute(
            "INSERT INTO goal (id, company_id, parent_id, kind, title, description)
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                row.id,
                row.company_id,
                row.parent_id,
                row.kind,
                row.title,
                row.description
            ],
        )?;
        Ok(row)
    }

    /// Walk `goal.parent_id` upward, returning root-first order (mission → … → goal).
    pub fn goal_chain(&self, goal_id: Option<&str>) -> StoreResult<Vec<GoalRow>> {
        let mut out = Vec::new();
        let mut cursor = goal_id.map(str::to_string);
        let conn = self.conn();
        while let Some(id) = cursor {
            let row: Option<GoalRow> = conn
                .query_row(
                    "SELECT * FROM goal WHERE id=?1",
                    params![id],
                    GoalRow::from_row,
                )
                .optional()?;
            match row {
                Some(g) => {
                    cursor = g.parent_id.clone();
                    out.push(g);
                }
                None => break,
            }
        }
        out.reverse();
        Ok(out)
    }

    // ── issues ──────────────────────────────────────────────────────────────

    pub fn create_issue(&self, new: NewIssue<'_>) -> StoreResult<IssueRow> {
        let now = Self::now_secs();
        let row = IssueRow {
            id: Self::new_id("iss"),
            company_id: new.company_id.to_string(),
            goal_id: new.goal_id.map(str::to_string),
            parent_issue_id: new.parent_issue_id.map(str::to_string),
            title: new.title.to_string(),
            body: new.body.to_string(),
            state: IssueState::Todo.as_str().to_string(),
            assignee_agent_id: new.assignee_agent_id.map(str::to_string),
            created_by_agent_id: new.created_by_agent_id.map(str::to_string),
            billing_code: new.billing_code.to_string(),
            depth: new.depth,
            checkout_run_id: None,
            checkout_at: None,
            created_at: now,
            updated_at: now,
        };
        self.conn().execute(
            "INSERT INTO issue (id, company_id, goal_id, parent_issue_id, title, body, state,
                                assignee_agent_id, created_by_agent_id, billing_code, depth,
                                checkout_run_id, checkout_at, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![
                row.id,
                row.company_id,
                row.goal_id,
                row.parent_issue_id,
                row.title,
                row.body,
                row.state,
                row.assignee_agent_id,
                row.created_by_agent_id,
                row.billing_code,
                row.depth,
                row.checkout_run_id,
                row.checkout_at,
                row.created_at,
                row.updated_at
            ],
        )?;
        Ok(row)
    }

    /// Tickets delegated out of `issue_id`, oldest first.
    pub fn list_children(&self, issue_id: &str) -> StoreResult<Vec<IssueRow>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT * FROM issue WHERE parent_issue_id=?1 ORDER BY created_at")?;
        stmt.query_map(params![issue_id], IssueRow::from_row)?
            .collect::<Result<Vec<_>, _>>()
    }

    /// First agent in the company holding this role — how a delegation by role
    /// finds a body.
    pub fn find_agent_by_role(
        &self,
        company_id: &str,
        role: &str,
    ) -> StoreResult<Option<AgentRow>> {
        self.conn()
            .query_row(
                "SELECT * FROM agent WHERE company_id=?1 AND role=?2 AND status='active'
                 ORDER BY created_at LIMIT 1",
                params![company_id, role],
                AgentRow::from_row,
            )
            .optional()
    }

    pub fn reassign_issue(&self, issue_id: &str, assignee: Option<&str>) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE issue SET assignee_agent_id=?2, updated_at=?3 WHERE id=?1",
            params![issue_id, assignee, Self::now_secs()],
        )?;
        Ok(())
    }

    // ── approvals ───────────────────────────────────────────────────────────

    pub fn request_approval(
        &self,
        company_id: &str,
        kind: &str,
        subject_id: &str,
        payload: &str,
        requested_by: Option<&str>,
    ) -> StoreResult<ApprovalRow> {
        let row = ApprovalRow {
            id: Self::new_id("apv"),
            company_id: company_id.to_string(),
            kind: kind.to_string(),
            subject_id: subject_id.to_string(),
            payload: payload.to_string(),
            status: ApprovalStatus::Pending.as_str().to_string(),
            requested_by: requested_by.map(str::to_string),
            decided_by: None,
            reason: None,
            created_at: Self::now_secs(),
            decided_at: None,
        };
        self.conn().execute(
            "INSERT INTO approval (id, company_id, kind, subject_id, payload, status,
                                   requested_by, decided_by, reason, created_at, decided_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                row.id,
                row.company_id,
                row.kind,
                row.subject_id,
                row.payload,
                row.status,
                row.requested_by,
                row.decided_by,
                row.reason,
                row.created_at,
                row.decided_at
            ],
        )?;
        Ok(row)
    }

    pub fn list_approvals(
        &self,
        company_id: &str,
        status: Option<&str>,
    ) -> StoreResult<Vec<ApprovalRow>> {
        let conn = self.conn();
        match status {
            Some(s) => {
                let mut stmt = conn.prepare(
                    "SELECT * FROM approval WHERE company_id=?1 AND status=?2 ORDER BY created_at",
                )?;
                stmt.query_map(params![company_id, s], ApprovalRow::from_row)?
                    .collect::<Result<Vec<_>, _>>()
            }
            None => {
                let mut stmt =
                    conn.prepare("SELECT * FROM approval WHERE company_id=?1 ORDER BY created_at")?;
                stmt.query_map(params![company_id], ApprovalRow::from_row)?
                    .collect::<Result<Vec<_>, _>>()
            }
        }
    }

    /// Human decision on a pending request. Returns the updated row.
    pub fn decide_approval(
        &self,
        approval_id: &str,
        approved: bool,
        reason: Option<&str>,
    ) -> StoreResult<Option<ApprovalRow>> {
        let status = if approved {
            ApprovalStatus::Approved
        } else {
            ApprovalStatus::Rejected
        };
        let changed = self.conn().execute(
            "UPDATE approval SET status=?2, reason=?3, decided_at=?4
             WHERE id=?1 AND status='pending'",
            params![approval_id, status.as_str(), reason, Self::now_secs()],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.approval(approval_id)
    }

    pub fn approval(&self, approval_id: &str) -> StoreResult<Option<ApprovalRow>> {
        self.conn()
            .query_row(
                "SELECT * FROM approval WHERE id=?1",
                params![approval_id],
                ApprovalRow::from_row,
            )
            .optional()
    }

    pub fn get_issue(&self, id: &str) -> StoreResult<Option<IssueRow>> {
        self.conn()
            .query_row(
                "SELECT * FROM issue WHERE id=?1",
                params![id],
                IssueRow::from_row,
            )
            .optional()
    }

    pub fn list_board(&self, company_id: &str, state: Option<&str>) -> StoreResult<Vec<IssueRow>> {
        let conn = self.conn();
        match state {
            Some(s) => {
                let mut stmt = conn.prepare(
                    "SELECT * FROM issue WHERE company_id=?1 AND state=?2 ORDER BY updated_at DESC",
                )?;
                stmt.query_map(params![company_id, s], IssueRow::from_row)?
                    .collect::<Result<Vec<_>, _>>()
            }
            None => {
                let mut stmt = conn
                    .prepare("SELECT * FROM issue WHERE company_id=?1 ORDER BY updated_at DESC")?;
                stmt.query_map(params![company_id], IssueRow::from_row)?
                    .collect::<Result<Vec<_>, _>>()
            }
        }
    }

    /// Claim a ticket. Returns `true` only when this caller won the race.
    ///
    /// SQLite serialises writers, so the conditional UPDATE *is* the mutex —
    /// two concurrent heartbeats can never both see `changes() == 1`.
    pub fn checkout_issue(&self, issue_id: &str, run_id: &str) -> StoreResult<bool> {
        let now = Self::now_secs();
        let changed = self.conn().execute(
            "UPDATE issue SET state='in_progress', checkout_run_id=?2, checkout_at=?3, updated_at=?3
             WHERE id=?1 AND state IN ('todo','blocked')",
            params![issue_id, run_id, now],
        )?;
        Ok(changed == 1)
    }

    pub fn set_issue_state(&self, issue_id: &str, state: IssueState) -> StoreResult<()> {
        let now = Self::now_secs();
        self.conn().execute(
            "UPDATE issue SET state=?2, updated_at=?3 WHERE id=?1",
            params![issue_id, state.as_str(), now],
        )?;
        Ok(())
    }

    /// Pick the next actionable ticket for an agent: own assignment first,
    /// then unassigned work (anyone may claim it).
    pub fn pick_work(&self, agent_id: &str, company_id: &str) -> StoreResult<Option<IssueRow>> {
        let conn = self.conn();
        let assigned = conn
            .query_row(
                "SELECT * FROM issue WHERE assignee_agent_id=?1 AND company_id=?2
                 AND state IN ('todo','blocked') ORDER BY created_at LIMIT 1",
                params![agent_id, company_id],
                IssueRow::from_row,
            )
            .optional()?;
        if assigned.is_some() {
            return Ok(assigned);
        }
        conn.query_row(
            "SELECT * FROM issue WHERE company_id=?2 AND assignee_agent_id IS NULL
             AND state IN ('todo','blocked') ORDER BY created_at LIMIT 1",
            params![agent_id, company_id],
            IssueRow::from_row,
        )
        .optional()
    }

    pub fn add_comment(
        &self,
        issue_id: &str,
        author_agent_id: Option<&str>,
        body: &str,
    ) -> StoreResult<()> {
        self.conn().execute(
            "INSERT INTO issue_comment (id, issue_id, author_agent_id, body, created_at)
             VALUES (?1,?2,?3,?4,?5)",
            params![
                Self::new_id("cmt"),
                issue_id,
                author_agent_id,
                body,
                Self::now_secs()
            ],
        )?;
        Ok(())
    }

    pub fn list_comments(&self, issue_id: &str) -> StoreResult<Vec<(Option<String>, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT author_agent_id, body FROM issue_comment WHERE issue_id=?1 ORDER BY created_at",
        )?;
        let rows = stmt
            .query_map(params![issue_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ── heartbeats ──────────────────────────────────────────────────────────

    pub fn create_heartbeat(&self, agent_id: &str, cron: &str) -> StoreResult<HeartbeatRow> {
        let row = HeartbeatRow {
            id: Self::new_id("hb"),
            agent_id: agent_id.to_string(),
            cron: cron.to_string(),
            enabled: true,
            last_run_at: None,
            next_run_at: Some(Self::now_secs()),
        };
        self.conn().execute(
            "INSERT INTO heartbeat (id, agent_id, cron, enabled, last_run_at, next_run_at)
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                row.id,
                row.agent_id,
                row.cron,
                1i64,
                row.last_run_at,
                row.next_run_at
            ],
        )?;
        Ok(row)
    }

    pub fn list_heartbeats(&self, agent_id: &str) -> StoreResult<Vec<HeartbeatRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM heartbeat WHERE agent_id=?1")?;
        stmt.query_map(params![agent_id], HeartbeatRow::from_row)?
            .collect::<Result<Vec<_>, _>>()
    }

    pub fn due_heartbeats(&self, now: i64) -> StoreResult<Vec<HeartbeatRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT * FROM heartbeat WHERE enabled=1 AND (next_run_at IS NULL OR next_run_at<=?1)",
        )?;
        stmt.query_map(params![now], HeartbeatRow::from_row)?
            .collect::<Result<Vec<_>, _>>()
    }

    pub fn touch_heartbeat(&self, id: &str, last_run_at: i64, next_run_at: i64) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE heartbeat SET last_run_at=?2, next_run_at=?3 WHERE id=?1",
            params![id, last_run_at, next_run_at],
        )?;
        Ok(())
    }

    // ── runs & costs ────────────────────────────────────────────────────────

    pub fn insert_run(
        &self,
        heartbeat_id: Option<&str>,
        agent_id: &str,
    ) -> StoreResult<HeartbeatRunRow> {
        let row = HeartbeatRunRow {
            id: Self::new_id("run"),
            heartbeat_id: heartbeat_id.map(str::to_string),
            agent_id: agent_id.to_string(),
            issue_id: None,
            status: "running".to_string(),
            input_tokens: 0,
            output_tokens: 0,
            cost_cents: 0,
            output: String::new(),
            error: None,
            started_at: Self::now_secs(),
            finished_at: None,
        };
        self.conn().execute(
            "INSERT INTO heartbeat_run (id, heartbeat_id, agent_id, issue_id, status, input_tokens,
                                        output_tokens, cost_cents, output, error, started_at, finished_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                row.id,
                row.heartbeat_id,
                row.agent_id,
                row.issue_id,
                row.status,
                row.input_tokens,
                row.output_tokens,
                row.cost_cents,
                row.output,
                row.error,
                row.started_at,
                row.finished_at
            ],
        )?;
        Ok(row)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn finish_run(
        &self,
        run_id: &str,
        status: RunStatus,
        input_tokens: i64,
        output_tokens: i64,
        cost_cents: i64,
        output: &str,
        error: Option<&str>,
    ) -> StoreResult<()> {
        let now = Self::now_secs();
        self.conn().execute(
            "UPDATE heartbeat_run SET status=?2, input_tokens=?3, output_tokens=?4, cost_cents=?5,
                                      output=?6, error=?7, finished_at=?8
             WHERE id=?1",
            params![
                run_id,
                status.as_str(),
                input_tokens,
                output_tokens,
                cost_cents,
                output,
                error,
                now
            ],
        )?;
        Ok(())
    }

    pub fn attach_run_issue(&self, run_id: &str, issue_id: &str) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE heartbeat_run SET issue_id=?2 WHERE id=?1",
            params![run_id, issue_id],
        )?;
        Ok(())
    }

    pub fn list_runs(
        &self,
        agent_id: Option<&str>,
        limit: i64,
    ) -> StoreResult<Vec<HeartbeatRunRow>> {
        let conn = self.conn();
        match agent_id {
            Some(a) => {
                let mut stmt = conn.prepare(
                    "SELECT * FROM heartbeat_run WHERE agent_id=?1 ORDER BY started_at DESC LIMIT ?2",
                )?;
                stmt.query_map(params![a, limit], HeartbeatRunRow::from_row)?
                    .collect::<Result<Vec<_>, _>>()
            }
            None => {
                let mut stmt =
                    conn.prepare("SELECT * FROM heartbeat_run ORDER BY started_at DESC LIMIT ?1")?;
                stmt.query_map(params![limit], HeartbeatRunRow::from_row)?
                    .collect::<Result<Vec<_>, _>>()
            }
        }
    }

    pub fn add_cost_event(
        &self,
        company_id: &str,
        agent_id: Option<&str>,
        issue_id: Option<&str>,
        run_id: Option<&str>,
        billing_code: &str,
        model: &str,
        input_tokens: i64,
        output_tokens: i64,
        cost_cents: i64,
    ) -> StoreResult<CostEventRow> {
        let row = CostEventRow {
            id: Self::new_id("cost"),
            company_id: company_id.to_string(),
            agent_id: agent_id.map(str::to_string),
            issue_id: issue_id.map(str::to_string),
            run_id: run_id.map(str::to_string),
            billing_code: billing_code.to_string(),
            model: model.to_string(),
            input_tokens,
            output_tokens,
            cost_cents,
            created_at: Self::now_secs(),
        };
        self.conn().execute(
            "INSERT INTO cost_event (id, company_id, agent_id, issue_id, run_id, billing_code,
                                     model, input_tokens, output_tokens, cost_cents, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                row.id,
                row.company_id,
                row.agent_id,
                row.issue_id,
                row.run_id,
                row.billing_code,
                row.model,
                row.input_tokens,
                row.output_tokens,
                row.cost_cents,
                row.created_at
            ],
        )?;
        Ok(row)
    }

    /// Spend attributed to this agent in the current calendar month (cents).
    pub fn monthly_cost_cents(&self, agent_id: &str) -> StoreResult<i64> {
        use chrono::{Datelike, NaiveDate, TimeZone as _, Utc};
        let now = Utc::now();
        let month_start = NaiveDate::from_ymd_opt(now.year(), now.month(), 1)
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .map(|dt| Utc.from_utc_datetime(&dt).timestamp())
            .unwrap_or(0);
        self.conn()
            .query_row(
                "SELECT COALESCE(SUM(cost_cents),0) FROM cost_event WHERE agent_id=?1 AND created_at>=?2",
                params![agent_id, month_start],
                |r| r.get(0),
            )
            .optional()
            .map(|v: Option<i64>| v.unwrap_or(0))
    }

    // ── guard rails ─────────────────────────────────────────────────────────

    /// Reclaim tickets that have been `in_progress` for longer than
    /// `timeout_secs` without producing a run — Paperclip's worst failure mode
    /// is the silent dead state, so this runs every scheduler tick.
    pub fn reclaim_stale(&self, timeout_secs: i64) -> StoreResult<usize> {
        let cutoff = Self::now_secs() - timeout_secs;
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id FROM issue WHERE state='in_progress' AND checkout_at IS NOT NULL
             AND checkout_at < ?1",
        )?;
        let ids: Vec<String> = stmt
            .query_map(params![cutoff], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        drop(conn);

        let mut reclaimed = 0usize;
        for id in ids {
            let run_missing = {
                let issue = self.get_issue(&id)?;
                match issue.and_then(|i| i.checkout_run_id) {
                    None => true,
                    Some(run_id) => {
                        let finished: Option<i64> = self
                            .conn()
                            .query_row(
                                "SELECT finished_at FROM heartbeat_run WHERE id=?1",
                                params![run_id],
                                |r| r.get(0),
                            )
                            .optional()?
                            .flatten();
                        finished.is_some()
                    }
                }
            };
            if run_missing {
                continue;
            }
            self.set_issue_state(&id, IssueState::Todo)?;
            reclaimed += 1;
        }
        Ok(reclaimed)
    }
}

// Small helper so the `.optional()` calls above read cleanly.
trait OptionalExt<T> {
    fn optional(self) -> StoreResult<Option<T>>;
}

impl<T> OptionalExt<T> for rusqlite::Result<T> {
    fn optional(self) -> StoreResult<Option<T>> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (CompanyStore, CompanyRow, AgentRow) {
        let store = CompanyStore::open_in_memory().unwrap();
        let company = store.create_company("Acme", "Build things").unwrap();
        let agent = store
            .create_agent(&company.id, "Alice", "ceo", None, "llm", "{}", 10_000)
            .unwrap();
        (store, company, agent)
    }

    #[test]
    fn checkout_is_exclusive() {
        let (store, company, agent) = fixture();
        let issue = store
            .create_issue(NewIssue {
                assignee_agent_id: Some(&agent.id),
                ..NewIssue::new(&company.id, "first")
            })
            .unwrap();

        assert!(store.checkout_issue(&issue.id, "run_a").unwrap());
        // Second claimant loses even though it targets the same row.
        assert!(!store.checkout_issue(&issue.id, "run_b").unwrap());
        assert_eq!(
            store.get_issue(&issue.id).unwrap().unwrap().state,
            "in_progress"
        );
    }

    #[test]
    fn pick_work_prefers_own_assignment() {
        let (store, company, agent) = fixture();
        store
            .create_issue(NewIssue::new(&company.id, "unassigned"))
            .unwrap();
        let mine = store
            .create_issue(NewIssue {
                assignee_agent_id: Some(&agent.id),
                ..NewIssue::new(&company.id, "mine")
            })
            .unwrap();
        let picked = store.pick_work(&agent.id, &company.id).unwrap().unwrap();
        assert_eq!(picked.id, mine.id);
    }

    #[test]
    fn goal_chain_is_root_first() {
        let store = CompanyStore::open_in_memory().unwrap();
        let company = store.create_company("Acme", "m").unwrap();
        let mission = store
            .create_goal(&company.id, None, "mission", "Miss", "")
            .unwrap();
        let project = store
            .create_goal(&company.id, Some(&mission.id), "project", "Proj", "")
            .unwrap();
        let chain = store.goal_chain(Some(&project.id)).unwrap();
        assert_eq!(chain.len(), 2);
        assert_eq!(chain[0].id, mission.id);
        assert_eq!(chain[1].id, project.id);
    }

    #[test]
    fn monthly_cost_starts_at_zero() {
        let (_store, _company, agent) = fixture();
        let store = CompanyStore::open_in_memory().unwrap();
        assert_eq!(store.monthly_cost_cents(&agent.id).unwrap(), 0);
    }
}
