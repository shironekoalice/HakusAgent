//! Company-scale multi-agent orchestration control plane.
//!
//! Layering deliberately mirrors Paperclip: this crate **orchestrates** agents,
//! it never executes them. Execution lives behind the [`adapter::AgentRuntime`]
//! trait so any runtime (today: the Python `hakusai_server`) can be plugged in.
//!
//! ```text
//! scheduler -> budget -> pick_work -> atomic checkout -> context -> runtime -> settle
//! ```

pub mod adapter;
pub mod context;
pub mod decision;
pub mod model;
pub mod scheduler;
pub mod schema;
pub mod store;

pub use adapter::{
    AgentRuntime, HttpPythonRuntime, MockRuntime, NativeLlmRuntime, RunTurnOut, RunTurnReq,
    RuntimeRegistry,
};
pub use context::ContextBuilder;
pub use decision::{Action, Applied, Decision};
pub use model::{
    AgentRow, AgentStatus, CompanyRow, CostEventRow, GoalKind, GoalRow, HeartbeatRow,
    HeartbeatRunRow, IssueRow, IssueState, RunStatus,
};
pub use scheduler::{HeartbeatRunner, SchedulerConfig};
pub use store::NewIssue;
pub use store::{CompanyStore, StoreError};

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context as _, Result};

/// Home directory for all company data (`~/.hakus/company.sqlite`).
pub fn company_db_path() -> Result<PathBuf> {
    let base = hakus_paths::hakus_home()
        .map_err(|e| anyhow::anyhow!("resolve hakus home: {e}"))?
        .context("no hakus home directory available")?;
    Ok(base.join("company.sqlite"))
}

/// Wiring root for the control plane: persistence + execution runtime.
pub struct CompanyService {
    pub store: Arc<CompanyStore>,
    pub runtime: Arc<dyn AgentRuntime>,
}

impl CompanyService {
    pub fn new(store: Arc<CompanyStore>, runtime: Arc<dyn AgentRuntime>) -> Self {
        Self { store, runtime }
    }

    /// Open (and migrate) the default database.
    pub fn open_default(runtime: Arc<dyn AgentRuntime>) -> Result<Self> {
        let path = company_db_path()?;
        let store = CompanyStore::open(&path)?;
        Ok(Self::new(Arc::new(store), runtime))
    }
}
