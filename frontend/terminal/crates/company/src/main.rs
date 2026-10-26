//! `hakus-company` CLI — operate an agent company from the terminal.
//!
//! M1 scope: create a company, hire agents, file tickets, run one heartbeat,
//! and (M2) keep a daemon ticking. Later this folds into `hakus company …`.

use std::sync::Arc;

use anyhow::{Result, bail};
use clap::{Parser, Subcommand};

use hakus_company::adapter::{
    AgentRuntime, HttpPythonRuntime, MockRuntime, NativeLlmRuntime, RuntimeRegistry,
};
use hakus_company::scheduler::HeartbeatRunner;
use hakus_company::{CompanyStore, NewIssue, company_db_path};

#[derive(Parser, Debug)]
#[command(
    name = "hakus-company",
    version,
    about = "Company-scale multi-agent orchestration"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Create a company.
    Init {
        #[arg(long)]
        name: String,
        #[arg(long, default_value = "")]
        mission: String,
    },
    /// Hire an agent.
    Hire {
        #[arg(long)]
        company: String,
        #[arg(long)]
        name: String,
        #[arg(long, default_value = "engineer")]
        role: String,
        /// Parent agent id (reporting line).
        #[arg(long)]
        parent: Option<String>,
        /// Execution runtime: `llm` (default, text only) or `python-http` (tools).
        #[arg(long, value_parser = ["llm", "python-http", "mock"], default_value = "llm")]
        adapter: String,
        /// Monthly budget in cents; 0 disables the guard.
        #[arg(long, default_value_t = 0)]
        budget_cents: i64,
        /// Register a heartbeat, e.g. "*/15 * * * *".
        #[arg(long)]
        cron: Option<String>,
    },
    /// File a ticket.
    Issue {
        #[arg(long)]
        company: String,
        #[arg(long)]
        title: String,
        #[arg(long, default_value = "")]
        body: String,
        #[arg(long)]
        goal: Option<String>,
        #[arg(long)]
        assignee: Option<String>,
        /// Assign to the first active agent with this role.
        #[arg(long)]
        role: Option<String>,
        /// Parent ticket: makes this a delegated sub-ticket (depth + 1).
        #[arg(long)]
        parent: Option<String>,
    },
    /// Print the ticket board.
    Board {
        #[arg(long)]
        company: String,
    },
    /// Print the org chart with each agent's open tickets.
    Tree {
        #[arg(long)]
        company: String,
    },
    /// List pending approvals.
    Approvals {
        #[arg(long)]
        company: String,
    },
    /// Approve a pending request (human gate).
    Approve {
        #[arg(long)]
        id: String,
        #[arg(long)]
        by: Option<String>,
        #[arg(long)]
        reason: Option<String>,
    },
    /// Reject a pending request.
    Reject {
        #[arg(long)]
        id: String,
        #[arg(long)]
        by: Option<String>,
        #[arg(long)]
        reason: Option<String>,
    },
    /// Run exactly one heartbeat for an agent (id or name).
    Run {
        #[arg(long)]
        agent: String,
        /// `native` (direct LLM call, default), `python` (legacy AgentCore),
        /// or `mock` (offline).
        #[arg(long, value_parser = ["native", "python", "mock"], default_value = "native")]
        mode: String,
        #[arg(long)]
        base_url: Option<String>,
    },
    /// Keep ticking until interrupted.
    Daemon {
        #[arg(long, default_value_t = 30)]
        poll: u64,
        #[arg(long, default_value_t = 0)]
        rounds: u64,
        #[arg(long, value_parser = ["native", "python", "mock"], default_value = "native")]
        mode: String,
        #[arg(long)]
        base_url: Option<String>,
    },
    /// List heartbeats / runs for an agent.
    Log {
        #[arg(long)]
        agent: Option<String>,
        #[arg(long, default_value_t = 20)]
        limit: i64,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();
    let path = company_db_path()?;
    let store = Arc::new(CompanyStore::open(&path)?);
    println!("db: {}", path.display());

    match cli.cmd {
        Cmd::Init { name, mission } => {
            let c = store.create_company(&name, &mission)?;
            println!("created company {} ({})", c.name, c.id);
        }
        Cmd::Hire {
            company,
            name,
            role,
            parent,
            adapter,
            budget_cents,
            cron,
        } => {
            let agent = store.create_agent(
                &company,
                &name,
                &role,
                parent.as_deref(),
                &adapter,
                "{}",
                budget_cents,
            )?;
            println!(
                "hired {} <{}> {} [{}]",
                agent.name, agent.role, agent.id, agent.adapter
            );
            if let Some(cron) = cron {
                let hb = store.create_heartbeat(&agent.id, &cron)?;
                println!("heartbeat {} ({})", hb.id, hb.cron);
            }
        }
        Cmd::Issue {
            company,
            title,
            body,
            goal,
            assignee,
            parent: parent_issue,
            role,
        } => {
            let assignee_id = match (&assignee, &role) {
                (Some(id), _) => Some(id.clone()),
                (None, Some(role)) => store
                    .find_agent_by_role(&company, role)?
                    .map(|a| a.id)
                    .or_else(|| {
                        println!("warn: no active agent with role {role}, leaving unassigned");
                        None
                    }),
                _ => None,
            };
            let depth = parent_issue
                .as_deref()
                .and_then(|p| store.get_issue(p).ok().flatten())
                .map(|p| p.depth + 1)
                .unwrap_or(0);
            let issue = store.create_issue(NewIssue {
                company_id: &company,
                goal_id: goal.as_deref(),
                parent_issue_id: parent_issue.as_deref(),
                title: &title,
                body: &body,
                assignee_agent_id: assignee_id.as_deref(),
                created_by_agent_id: None,
                billing_code: "",
                depth,
            })?;
            println!(
                "created issue {} [{}] depth={}",
                issue.id, issue.state, issue.depth
            );
        }
        Cmd::Board { company } => {
            print_board(&store, &company)?;
        }
        Cmd::Tree { company } => {
            print_tree(&store, &company)?;
        }
        Cmd::Approvals { company } => {
            let pending = store.list_approvals(&company, Some("pending"))?;
            if pending.is_empty() {
                println!("(no pending approvals)");
            }
            for a in pending {
                println!(
                    "{:<28} {:<14} subject={} by={}",
                    a.id,
                    a.kind,
                    a.subject_id,
                    a.requested_by.unwrap_or_default()
                );
            }
        }
        Cmd::Approve { id, by, reason } => {
            decide_approval(&store, &id, true, by.as_deref(), reason.as_deref())?;
        }
        Cmd::Reject { id, by, reason } => {
            decide_approval(&store, &id, false, by.as_deref(), reason.as_deref())?;
        }
        Cmd::Run {
            agent,
            mode,
            base_url,
        } => {
            let runner = runner(store.clone(), &mode, base_url)?;
            let agent_row = resolve_agent(&store, &agent)?;
            let status = runner.run_agent(&agent_row.id).await?;
            println!("heartbeat -> {}", status.as_str());
            print_last_run(&store, &agent_row.id)?;
        }
        Cmd::Daemon {
            poll,
            rounds,
            mode,
            base_url,
        } => {
            let runner = runner(store.clone(), &mode, base_url)?;
            if rounds == 0 {
                runner.daemon(poll).await?;
            } else {
                for i in 1..=rounds {
                    let n = runner.tick().await?;
                    println!("round {i}: {n} heartbeat(s)");
                    if i < rounds {
                        tokio::time::sleep(std::time::Duration::from_secs(poll)).await;
                    }
                }
            }
        }
        Cmd::Log { agent, limit } => {
            let runs = store.list_runs(agent.as_deref(), limit)?;
            for r in runs {
                println!(
                    "{:<28} {:<16} in={:<6} out={:<6} {}",
                    r.id,
                    r.status,
                    r.input_tokens,
                    r.output_tokens,
                    r.error.clone().unwrap_or_default()
                );
            }
        }
    }
    Ok(())
}

/// Runtime selection: native (direct LLM call) → python (legacy AgentCore) → mock.
///
/// `native` mode registers every adapter so a single company can mix a
/// text-only `llm` employee with a tool-capable `python-http` one.
fn runner(
    store: Arc<CompanyStore>,
    mode: &str,
    base_url: Option<String>,
) -> Result<HeartbeatRunner> {
    match mode {
        "mock" => Ok(HeartbeatRunner::new(
            store,
            Arc::new(MockRuntime::default()),
        )),
        "python" => Ok(HeartbeatRunner::new(
            store,
            Arc::new(HttpPythonRuntime::new(base_url)),
        )),
        _ => {
            let native: Arc<dyn AgentRuntime> =
                Arc::new(NativeLlmRuntime::from_env(SYSTEM_PROMPT)?);
            let registry = RuntimeRegistry::new(native.clone())
                .with("llm", native)
                .with("mock", Arc::new(MockRuntime::default()))
                .with("python-http", Arc::new(HttpPythonRuntime::new(base_url)));
            Ok(HeartbeatRunner::with_registry(store, registry))
        }
    }
}

fn agent_name(store: &CompanyStore, id: Option<&str>) -> String {
    match id {
        Some(id) => store
            .get_agent(id)
            .ok()
            .flatten()
            .map(|a| format!("{}<{}>", a.name, a.role))
            .unwrap_or_else(|| id.to_string()),
        None => "待认领".to_string(),
    }
}

fn print_board(store: &CompanyStore, company_id: &str) -> Result<()> {
    let issues = store.list_board(company_id, None)?;
    if issues.is_empty() {
        println!("(empty board)");
        return Ok(());
    }
    // Grouped by state so the operator can see where work is piling up.
    let order = [
        "in_progress",
        "blocked",
        "in_review",
        "todo",
        "backlog",
        "done",
    ];
    for state in order {
        let group: Vec<_> = issues.iter().filter(|i| i.state == state).collect();
        if group.is_empty() {
            continue;
        }
        println!("── {state} ({}) ──", group.len());
        for issue in group {
            let who = agent_name(store, issue.assignee_agent_id.as_deref());
            let depth = if issue.depth > 0 {
                format!(" d{}", issue.depth)
            } else {
                String::new()
            };
            println!("  [{:<17}] {}{}  {}", who, depth, "", issue.title);
        }
    }
    Ok(())
}

/// Org chart, depth-first, with each agent's open ticket count.
fn print_tree(store: &CompanyStore, company_id: &str) -> Result<()> {
    let agents = store.list_agents(company_id)?;
    let issues = store.list_board(company_id, None)?;
    let roots: Vec<_> = agents
        .iter()
        .filter(|a| a.parent_agent_id.is_none())
        .collect();

    fn walk(
        store: &CompanyStore,
        agents: &[hakus_company::model::AgentRow],
        issues: &[hakus_company::model::IssueRow],
        node: &hakus_company::model::AgentRow,
        depth: usize,
    ) {
        let open = issues
            .iter()
            .filter(|i| {
                i.assignee_agent_id.as_deref() == Some(node.id.as_str()) && i.state != "done"
            })
            .count();
        println!(
            "{}{} <{}> [{}] · {} 待办",
            "  ".repeat(depth),
            node.name,
            node.role,
            node.adapter,
            open
        );
        for child in agents
            .iter()
            .filter(|a| a.parent_agent_id.as_deref() == Some(node.id.as_str()))
        {
            walk(store, agents, issues, child, depth + 1);
        }
    }

    if roots.is_empty() {
        println!("(no agents)");
    }
    for root in roots {
        walk(store, &agents, &issues, root, 0);
    }
    Ok(())
}

fn decide_approval(
    store: &CompanyStore,
    id: &str,
    approved: bool,
    by: Option<&str>,
    reason: Option<&str>,
) -> Result<()> {
    match store.decide_approval(id, approved, reason)? {
        Some(row) => {
            println!(
                "{} {} ({}) by {}",
                if approved { "approved" } else { "rejected" },
                row.id,
                row.kind,
                by.unwrap_or("human")
            );
            Ok(())
        }
        None => bail!("no pending approval with id {id}"),
    }
}

/// Standing instructions every employee works under.
const SYSTEM_PROMPT: &str = "\
You are an employee of an AI company. You receive one ticket at a time together
with the company mission and the goal chain that explains why the ticket exists.
Do the work described by the ticket and report the result. If you cannot finish,
state precisely what is missing and what you completed. If you believe the ticket
should not be done at all, do not cancel it yourself — explain your objection and
escalate to your manager.";

/// Accept either an agent id or a unique (or first-matching) agent name.
fn resolve_agent(store: &CompanyStore, needle: &str) -> Result<hakus_company::model::AgentRow> {
    if let Some(row) = store.get_agent(needle)? {
        return Ok(row);
    }
    for company in store.list_companies()? {
        for agent in store.list_agents(&company.id)? {
            if agent.name == needle || agent.role == needle {
                return Ok(agent);
            }
        }
    }
    bail!("no agent matching {needle:?}")
}

fn print_last_run(store: &CompanyStore, agent_id: &str) -> Result<()> {
    let runs = store.list_runs(Some(agent_id), 1)?;
    if let Some(r) = runs.first() {
        let preview: String = r.output.chars().take(240).collect();
        println!(
            "run {}: {} · {} tok",
            r.id,
            r.status,
            r.input_tokens + r.output_tokens
        );
        if !preview.trim().is_empty() {
            println!("--- output ---\n{preview}");
        }
    }
    Ok(())
}

/// Logs stay quiet unless the operator asks for them.
fn init_tracing() {
    let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "warn".to_string());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(filter))
        .try_init();
}
