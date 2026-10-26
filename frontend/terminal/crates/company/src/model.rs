//! Row types for the company control plane.
//!
//! Rows mirror the SQLite schema in [`crate::schema`] one-to-one; every table
//! has exactly one struct here.

use rusqlite::Row;

/// Lifecycle of an agent's participation in the company.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentStatus {
    Active,
    Paused,
}

impl AgentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentStatus::Active => "active",
            AgentStatus::Paused => "paused",
        }
    }

    pub fn parse(s: &str) -> Self {
        if s == "paused" {
            AgentStatus::Paused
        } else {
            AgentStatus::Active
        }
    }
}

/// Ticket state machine. Unlike UI labels, every state carries execution
/// semantics — see the design doc for the table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueState {
    Backlog,
    Todo,
    InProgress,
    Blocked,
    InReview,
    Done,
}

impl IssueState {
    pub fn as_str(self) -> &'static str {
        match self {
            IssueState::Backlog => "backlog",
            IssueState::Todo => "todo",
            IssueState::InProgress => "in_progress",
            IssueState::Blocked => "blocked",
            IssueState::InReview => "in_review",
            IssueState::Done => "done",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "todo" => IssueState::Todo,
            "in_progress" => IssueState::InProgress,
            "blocked" => IssueState::Blocked,
            "in_review" => IssueState::InReview,
            "done" => IssueState::Done,
            _ => IssueState::Backlog,
        }
    }

    /// States from which an agent may claim the ticket.
    pub fn claimable(self) -> bool {
        matches!(self, IssueState::Todo | IssueState::Blocked)
    }
}

/// Outcome of one heartbeat invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    Ok,
    SkippedBudget,
    NoWork,
    CheckoutLost,
    Error,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Ok => "ok",
            RunStatus::SkippedBudget => "skipped_budget",
            RunStatus::NoWork => "no_work",
            RunStatus::CheckoutLost => "checkout_lost",
            RunStatus::Error => "error",
        }
    }
}

/// Position of a goal in the mission → milestone chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalKind {
    Mission,
    Goal,
    Project,
    Milestone,
}

impl GoalKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GoalKind::Mission => "mission",
            GoalKind::Goal => "goal",
            GoalKind::Project => "project",
            GoalKind::Milestone => "milestone",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "mission" => GoalKind::Mission,
            "goal" => GoalKind::Goal,
            "project" => GoalKind::Project,
            _ => GoalKind::Milestone,
        }
    }
}

/// Governance gate for high-impact actions (hiring, budget changes, deletes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Rejected,
}

impl ApprovalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalStatus::Pending => "pending",
            ApprovalStatus::Approved => "approved",
            ApprovalStatus::Rejected => "rejected",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "approved" => ApprovalStatus::Approved,
            "rejected" => ApprovalStatus::Rejected,
            _ => ApprovalStatus::Pending,
        }
    }
}

// ── rows ────────────────────────────────────────────────────────────────────

pub struct CompanyRow {
    pub id: String,
    pub name: String,
    pub mission: String,
    pub status: String,
    pub created_at: i64,
}

impl CompanyRow {
    pub fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            name: r.get("name")?,
            mission: r.get("mission")?,
            status: r.get("status")?,
            created_at: r.get("created_at")?,
        })
    }
}

pub struct AgentRow {
    pub id: String,
    pub company_id: String,
    pub name: String,
    pub role: String,
    pub title: String,
    pub parent_agent_id: Option<String>,
    pub adapter: String,
    pub adapter_config: String,
    pub runtime_session_id: Option<String>,
    pub status: String,
    pub budget_monthly_cents: i64,
    pub created_at: i64,
}

impl AgentRow {
    pub fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            company_id: r.get("company_id")?,
            name: r.get("name")?,
            role: r.get("role")?,
            title: r.get("title")?,
            parent_agent_id: r.get("parent_agent_id")?,
            adapter: r.get("adapter")?,
            adapter_config: r.get("adapter_config")?,
            runtime_session_id: r.get("runtime_session_id")?,
            status: r.get("status")?,
            budget_monthly_cents: r.get("budget_monthly_cents")?,
            created_at: r.get("created_at")?,
        })
    }

    pub fn is_active(&self) -> bool {
        AgentStatus::parse(&self.status) == AgentStatus::Active
    }
}

pub struct GoalRow {
    pub id: String,
    pub company_id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub description: String,
}

impl GoalRow {
    pub fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            company_id: r.get("company_id")?,
            parent_id: r.get("parent_id")?,
            kind: r.get("kind")?,
            title: r.get("title")?,
            description: r.get("description")?,
        })
    }
}

pub struct IssueRow {
    pub id: String,
    pub company_id: String,
    pub goal_id: Option<String>,
    /// Delegation tree: the ticket this one was split out of.
    pub parent_issue_id: Option<String>,
    pub title: String,
    pub body: String,
    pub state: String,
    pub assignee_agent_id: Option<String>,
    pub created_by_agent_id: Option<String>,
    pub billing_code: String,
    pub depth: i64,
    pub checkout_run_id: Option<String>,
    pub checkout_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl IssueRow {
    pub fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            company_id: r.get("company_id")?,
            goal_id: r.get("goal_id")?,
            parent_issue_id: r.get("parent_issue_id")?,
            title: r.get("title")?,
            body: r.get("body")?,
            state: r.get("state")?,
            assignee_agent_id: r.get("assignee_agent_id")?,
            created_by_agent_id: r.get("created_by_agent_id")?,
            billing_code: r.get("billing_code")?,
            depth: r.get("depth")?,
            checkout_run_id: r.get("checkout_run_id")?,
            checkout_at: r.get("checkout_at")?,
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
        })
    }

    pub fn state(&self) -> IssueState {
        IssueState::parse(&self.state)
    }
}

pub struct HeartbeatRow {
    pub id: String,
    pub agent_id: String,
    pub cron: String,
    pub enabled: bool,
    pub last_run_at: Option<i64>,
    pub next_run_at: Option<i64>,
}

impl HeartbeatRow {
    pub fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            agent_id: r.get("agent_id")?,
            cron: r.get("cron")?,
            enabled: r.get::<_, i64>("enabled")? != 0,
            last_run_at: r.get("last_run_at")?,
            next_run_at: r.get("next_run_at")?,
        })
    }
}

pub struct HeartbeatRunRow {
    pub id: String,
    pub heartbeat_id: Option<String>,
    pub agent_id: String,
    pub issue_id: Option<String>,
    pub status: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_cents: i64,
    pub output: String,
    pub error: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

impl HeartbeatRunRow {
    pub fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            heartbeat_id: r.get("heartbeat_id")?,
            agent_id: r.get("agent_id")?,
            issue_id: r.get("issue_id")?,
            status: r.get("status")?,
            input_tokens: r.get("input_tokens")?,
            output_tokens: r.get("output_tokens")?,
            cost_cents: r.get("cost_cents")?,
            output: r.get("output")?,
            error: r.get("error")?,
            started_at: r.get("started_at")?,
            finished_at: r.get("finished_at")?,
        })
    }
}

pub struct ApprovalRow {
    pub id: String,
    pub company_id: String,
    /// e.g. `hire_agent`, `change_budget`, `delete_issue`.
    pub kind: String,
    pub subject_id: String,
    pub payload: String,
    pub status: String,
    pub requested_by: Option<String>,
    pub decided_by: Option<String>,
    pub reason: Option<String>,
    pub created_at: i64,
    pub decided_at: Option<i64>,
}

impl ApprovalRow {
    pub fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            company_id: r.get("company_id")?,
            kind: r.get("kind")?,
            subject_id: r.get("subject_id")?,
            payload: r.get("payload")?,
            status: r.get("status")?,
            requested_by: r.get("requested_by")?,
            decided_by: r.get("decided_by")?,
            reason: r.get("reason")?,
            created_at: r.get("created_at")?,
            decided_at: r.get("decided_at")?,
        })
    }

    pub fn status(&self) -> ApprovalStatus {
        ApprovalStatus::parse(&self.status)
    }
}

pub struct CostEventRow {
    pub id: String,
    pub company_id: String,
    pub agent_id: Option<String>,
    pub issue_id: Option<String>,
    pub run_id: Option<String>,
    pub billing_code: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_cents: i64,
    pub created_at: i64,
}

impl CostEventRow {
    pub fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            company_id: r.get("company_id")?,
            agent_id: r.get("agent_id")?,
            issue_id: r.get("issue_id")?,
            run_id: r.get("run_id")?,
            billing_code: r.get("billing_code")?,
            model: r.get("model")?,
            input_tokens: r.get("input_tokens")?,
            output_tokens: r.get("output_tokens")?,
            cost_cents: r.get("cost_cents")?,
            created_at: r.get("created_at")?,
        })
    }
}
