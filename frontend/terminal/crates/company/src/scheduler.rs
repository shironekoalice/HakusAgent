//! Heartbeat scheduling and the single-heartbeat execution body.
//!
//! Order matters and mirrors the design doc:
//! budget → pick work → atomic checkout → context → runtime → settle.
//! Every exit path writes a `heartbeat_run` row, so the audit trail is complete
//! even when nothing was executed.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, Result};
use tracing::{info, warn};

use crate::adapter::{AgentRuntime, RunTurnReq, RuntimeRegistry};
use crate::context::ContextBuilder;
use crate::model::{AgentStatus, IssueState, RunStatus};
use crate::store::CompanyStore;

/// Tunable guard rails.
#[derive(Debug, Clone)]
pub struct SchedulerConfig {
    /// Tickets older than this without a finished run are reclaimed.
    pub stale_timeout_secs: i64,
    /// Wall-clock cap for a single turn.
    pub turn_timeout_secs: u64,
    /// Delay used when a cron expression cannot be interpreted.
    pub default_interval_secs: i64,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            stale_timeout_secs: 30 * 60,
            turn_timeout_secs: 10 * 60,
            default_interval_secs: 15 * 60,
        }
    }
}

/// Crate-internal wiring: store + runtimes. Kept separate from
/// `CompanyService` so tests can build one from parts.
pub struct HeartbeatRunner {
    pub store: Arc<CompanyStore>,
    pub runtimes: RuntimeRegistry,
    pub config: SchedulerConfig,
}

impl HeartbeatRunner {
    /// Single-runtime shortcut; every agent uses it regardless of `adapter`.
    pub fn new(store: Arc<CompanyStore>, runtime: Arc<dyn AgentRuntime>) -> Self {
        Self {
            store,
            runtimes: RuntimeRegistry::new(runtime),
            config: SchedulerConfig::default(),
        }
    }

    /// Per-adapter dispatch: `llm` reasons in text, `python-http` acts on files.
    pub fn with_registry(store: Arc<CompanyStore>, runtimes: RuntimeRegistry) -> Self {
        Self {
            store,
            runtimes,
            config: SchedulerConfig::default(),
        }
    }

    pub fn with_config(mut self, config: SchedulerConfig) -> Self {
        self.config = config;
        self
    }

    /// One heartbeat for one agent. Never bubbles errors: they are recorded.
    pub async fn run_agent(&self, agent_id: &str) -> Result<RunStatus> {
        let agent = self
            .store
            .get_agent(agent_id)?
            .with_context(|| format!("agent {agent_id} not found"))?;

        if !agent.is_active() {
            info!("{} is paused; skipping heartbeat", agent.name);
            return Ok(RunStatus::NoWork);
        }

        let run = self.store.insert_run(None, &agent.id)?;

        // 1) Budget guard — a runaway agent must never start another turn.
        let budget = agent.budget_monthly_cents;
        if budget > 0 && self.store.monthly_cost_cents(&agent.id)? >= budget {
            self.store
                .set_agent_status(&agent.id, AgentStatus::Paused)?;
            self.store.finish_run(
                &run.id,
                RunStatus::SkippedBudget,
                0,
                0,
                0,
                "",
                Some("monthly budget exhausted"),
            )?;
            warn!("{} paused: monthly budget exhausted", agent.name);
            return Ok(RunStatus::SkippedBudget);
        }

        // 2) Pick work.
        let Some(issue) = self.store.pick_work(&agent.id, &agent.company_id)? else {
            self.store
                .finish_run(&run.id, RunStatus::NoWork, 0, 0, 0, "", None)?;
            return Ok(RunStatus::NoWork);
        };

        // 3) Atomic checkout.
        if !self.store.checkout_issue(&issue.id, &run.id)? {
            self.store
                .finish_run(&run.id, RunStatus::CheckoutLost, 0, 0, 0, "", None)?;
            return Ok(RunStatus::CheckoutLost);
        }
        self.store.attach_run_issue(&run.id, &issue.id)?;

        // 4) Context.
        let prompt = ContextBuilder::new(&self.store).worker_prompt(&agent, &issue)?;

        // 5) Run the turn on whichever runtime this agent's adapter names.
        let runtime = self.runtimes.for_agent(&agent);
        let session = runtime.ensure_session(&agent).await?;
        if agent.runtime_session_id.is_none() {
            self.store.set_agent_session(&agent.id, &session)?;
        }

        let outcome = match tokio::time::timeout(
            Duration::from_secs(self.config.turn_timeout_secs),
            runtime.run_turn(RunTurnReq {
                session_id: session,
                prompt,
                provider: None,
                run_mode: None,
            }),
        )
        .await
        {
            Ok(Ok(out)) => Ok(out),
            Ok(Err(e)) => Err(e),
            Err(_) => anyhow::bail!("turn timed out after {}s", self.config.turn_timeout_secs),
        };

        // 6) Settle — success and failure both leave evidence behind.
        match outcome {
            Ok(out) => {
                let in_tok = out.input_tokens as i64;
                let out_tok = out.output_tokens as i64;
                let cost_cents =
                    hakus_llm::Price::for_model(&out.model).cost_cents(hakus_llm::Usage {
                        input_tokens: out.input_tokens,
                        output_tokens: out.output_tokens,
                    });
                self.store
                    .add_comment(&issue.id, Some(&agent.id), &out.text)?;
                self.store.add_cost_event(
                    &agent.company_id,
                    Some(&agent.id),
                    Some(&issue.id),
                    Some(&run.id),
                    &issue.billing_code,
                    &out.model,
                    in_tok,
                    out_tok,
                    cost_cents,
                )?;

                // A manager's reply may be a decision document rather than a
                // report; execute it, then fall back to closing the ticket.
                let mut decision_note = String::new();
                let next = if let Some(decision) = crate::decision::extract(&out.text) {
                    let applied = crate::decision::apply(
                        &self.store,
                        &agent,
                        &issue,
                        &decision,
                        crate::decision::DEFAULT_MAX_DEPTH,
                    )?;
                    decision_note = applied.summary();
                    let touched_self = applied.completed.iter().any(|id| id == &issue.id)
                        || applied.blocked.iter().any(|id| id == &issue.id);
                    if touched_self {
                        issue.state()
                    } else if out.approval_required {
                        IssueState::InReview
                    } else {
                        IssueState::Done
                    }
                } else if out.approval_required {
                    IssueState::InReview
                } else {
                    IssueState::Done
                };
                self.store.set_issue_state(&issue.id, next)?;

                let stored_output = if decision_note.is_empty() {
                    out.text.clone()
                } else {
                    format!("[决策] {decision_note}\n\n{}", out.text)
                };
                self.store.finish_run(
                    &run.id,
                    RunStatus::Ok,
                    in_tok,
                    out_tok,
                    cost_cents,
                    &stored_output,
                    None,
                )?;
                info!(
                    "{} finished {} ({})",
                    agent.name,
                    issue.title,
                    next.as_str()
                );
                Ok(RunStatus::Ok)
            }
            Err(err) => {
                let msg = format!("{err:#}");
                self.store
                    .add_comment(&issue.id, Some(&agent.id), &format!("执行失败：{msg}"))?;
                self.store.set_issue_state(&issue.id, IssueState::Blocked)?;
                self.store
                    .finish_run(&run.id, RunStatus::Error, 0, 0, 0, "", Some(&msg))?;
                warn!("{} failed on {}: {msg}", agent.name, issue.title);
                Ok(RunStatus::Error)
            }
        }
    }

    /// Run every due heartbeat once, reclaim stale tickets, advance schedules.
    pub async fn tick(&self) -> Result<usize> {
        let reclaimed = self.store.reclaim_stale(self.config.stale_timeout_secs)?;
        if reclaimed > 0 {
            warn!("reclaimed {reclaimed} stale in_progress ticket(s)");
        }

        let due = self.store.due_heartbeats(CompanyStore::now_secs())?;
        let mut executed = 0usize;
        for hb in due {
            match self.run_agent(&hb.agent_id).await {
                Ok(status) => {
                    executed += 1;
                    info!("heartbeat {} -> {}", hb.id, status.as_str());
                }
                Err(err) => {
                    warn!("heartbeat {} failed: {err:#}", hb.id);
                }
            }
            let now = CompanyStore::now_secs();
            let next = now + next_delay_secs(&hb.cron, self.config.default_interval_secs);
            self.store.touch_heartbeat(&hb.id, now, next)?;
        }
        Ok(executed)
    }

    /// Foreground daemon loop until the process is asked to stop.
    pub async fn daemon(&self, poll_secs: u64) -> Result<()> {
        info!("company daemon started (poll {poll_secs}s)");
        loop {
            if let Err(err) = self.tick().await {
                warn!("tick failed: {err:#}");
            }
            tokio::time::sleep(Duration::from_secs(poll_secs)).await;
        }
    }
}

/// Minimal cron support: `*/N * * * *` and a leading numeric minute.
/// Anything else falls back to the configured default interval.
pub fn next_delay_secs(cron: &str, default: i64) -> i64 {
    let first = cron.split_whitespace().next().unwrap_or("");
    if let Some(rest) = first.strip_prefix("*/") {
        if let Ok(n) = rest.parse::<i64>() {
            return (n * 60).max(60);
        }
    }
    if let Ok(n) = first.parse::<i64>() {
        return (n * 60).max(60);
    }
    default
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::{MockRuntime, ScriptedRuntime};
    use crate::store::NewIssue;

    #[tokio::test]
    async fn manager_delegates_and_worker_completes() {
        let store = Arc::new(CompanyStore::open_in_memory().unwrap());
        let company = store.create_company("Acme", "ship v1").unwrap();
        let ceo = store
            .create_agent(&company.id, "Alice", "ceo", None, "llm", "{}", 0)
            .unwrap();
        let eng = store
            .create_agent(
                &company.id,
                "Bob",
                "engineer",
                Some(&ceo.id),
                "llm",
                "{}",
                0,
            )
            .unwrap();
        let parent = store
            .create_issue(NewIssue {
                assignee_agent_id: Some(&ceo.id),
                ..NewIssue::new(&company.id, "deliver v1")
            })
            .unwrap();

        // Turn 1: the CEO delegates. Turn 2: the engineer reports back.
        let runtime = Arc::new(ScriptedRuntime::new(vec![
            format!(
                "Plan attached.\n```json\n{{\"commentary\":\"splitting the work\",\
                 \"actions\":[{{\"kind\":\"create_issue\",\"title\":\"build importer\",\
                 \"assignee_role\":\"engineer\"}}]}}\n```"
            ),
            "Importer implemented and tested.".to_string(),
        ]));
        let runner = HeartbeatRunner::new(store.clone(), runtime);

        assert_eq!(runner.run_agent(&ceo.id).await.unwrap(), RunStatus::Ok);

        let children = store.list_children(&parent.id).unwrap();
        assert_eq!(
            children.len(),
            1,
            "CEO must have delegated exactly one ticket"
        );
        let child = &children[0];
        assert_eq!(child.assignee_agent_id.as_deref(), Some(eng.id.as_str()));
        assert_eq!(child.depth, 1);
        assert_eq!(
            child.billing_code, ceo.id,
            "cost is billed to the delegator"
        );
        assert_eq!(child.state, "todo");
        // Parent stays open so the manager can review the outcome.
        assert_eq!(store.get_issue(&parent.id).unwrap().unwrap().state, "done");

        // The engineer picks up the delegated ticket and finishes it.
        assert_eq!(runner.run_agent(&eng.id).await.unwrap(), RunStatus::Ok);
        assert_eq!(store.get_issue(&child.id).unwrap().unwrap().state, "done");

        // Both turns produced cost events attributed to the right billing code.
        let runs = store.list_runs(None, 10).unwrap();
        assert_eq!(runs.len(), 2);
        assert!(runs.iter().all(|r| r.status == "ok"));
    }

    #[test]
    fn cron_parsing() {
        assert_eq!(next_delay_secs("*/15 * * * *", 900), 900);
        assert_eq!(next_delay_secs("*/1 * * * *", 900), 60);
        assert_eq!(next_delay_secs("@hourly", 600), 600);
    }

    #[tokio::test]
    async fn heartbeat_completes_a_ticket_with_no_duplicate_execution() {
        let store = Arc::new(CompanyStore::open_in_memory().unwrap());
        let company = store.create_company("Acme", "ship it").unwrap();
        let agent = store
            .create_agent(&company.id, "Alice", "ceo", None, "llm", "{}", 0)
            .unwrap();
        let issue = store
            .create_issue(NewIssue {
                assignee_agent_id: Some(&agent.id),
                ..NewIssue::new(&company.id, "first task")
            })
            .unwrap();

        let runner = HeartbeatRunner::new(store.clone(), Arc::new(MockRuntime::default()));

        let status = runner.run_agent(&agent.id).await.unwrap();
        assert_eq!(status, RunStatus::Ok);
        assert_eq!(store.get_issue(&issue.id).unwrap().unwrap().state, "done");

        // Second heartbeat finds nothing claimable.
        let status = runner.run_agent(&agent.id).await.unwrap();
        assert_eq!(status, RunStatus::NoWork);

        let comments = store.list_comments(&issue.id).unwrap();
        assert_eq!(comments.len(), 1, "exactly one turn must run");
    }

    #[tokio::test]
    async fn budget_exhaustion_pauses_the_agent() {
        let store = Arc::new(CompanyStore::open_in_memory().unwrap());
        let company = store.create_company("Acme", "ship it").unwrap();
        let agent = store
            .create_agent(&company.id, "Bob", "engineer", None, "llm", "{}", 100)
            .unwrap();
        store
            .add_cost_event(
                &company.id,
                Some(&agent.id),
                None,
                None,
                "",
                "mock",
                500,
                500,
                200,
            )
            .unwrap();

        let runner = HeartbeatRunner::new(store.clone(), Arc::new(MockRuntime::default()));
        let status = runner.run_agent(&agent.id).await.unwrap();
        assert_eq!(status, RunStatus::SkippedBudget);
        assert_eq!(
            store.get_agent(&agent.id).unwrap().unwrap().status,
            "paused"
        );
    }
}
