//! Structured decisions: how a manager's turn turns into organisational action.
//!
//! A native LLM employee cannot call tools, so delegation happens through its
//! *output*: if the reply parses as a decision document, it is executed as a
//! set of actions; otherwise it is kept as a plain work report. That fallback is
//! deliberate — a manager that rambles must not break the company.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::model::{AgentRow, IssueRow, IssueState};
use crate::store::{CompanyStore, NewIssue};

/// Delegation is capped so a runaway manager cannot grow the tree forever.
pub const DEFAULT_MAX_DEPTH: i64 = 3;

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct Decision {
    #[serde(default)]
    pub commentary: Option<String>,
    #[serde(default)]
    pub actions: Vec<Action>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    /// Delegate work: file a child ticket, usually for someone else.
    CreateIssue {
        title: String,
        #[serde(default)]
        body: Option<String>,
        #[serde(default)]
        assignee_role: Option<String>,
        #[serde(default)]
        assignee_agent_id: Option<String>,
        #[serde(default)]
        goal_id: Option<String>,
    },
    Complete {
        issue_id: String,
        #[serde(default)]
        summary: Option<String>,
    },
    Block {
        issue_id: String,
        #[serde(default)]
        reason: Option<String>,
    },
    /// Escalate to the reporting line — the only legitimate way to refuse work.
    Escalate {
        issue_id: String,
        #[serde(default)]
        reason: Option<String>,
    },
}

impl Action {
    pub fn kind(&self) -> &'static str {
        match self {
            Action::CreateIssue { .. } => "create_issue",
            Action::Complete { .. } => "complete",
            Action::Block { .. } => "block",
            Action::Escalate { .. } => "escalate",
        }
    }
}

/// Pull the first JSON object out of a model reply.
///
/// Tolerates ```json fences and surrounding prose, which is what models emit in
/// practice.
pub fn extract(text: &str) -> Option<Decision> {
    let cleaned = text.replace("```json", "\n").replace("```", "\n");
    let start = cleaned.find('{')?;
    // Walk to the matching brace so trailing prose does not break parsing.
    let bytes = cleaned.as_bytes();
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    let mut end = None;
    for (i, b) in bytes.iter().enumerate().skip(start) {
        let c = *b as char;
        if in_str {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(i);
                    break;
                }
            }
            _ => {}
        }
    }
    let slice = &cleaned[start..=end?];
    serde_json::from_str::<Decision>(slice).ok()
}

/// What applying a decision actually did — logged into comments and run output.
#[derive(Debug, Default, Clone)]
pub struct Applied {
    pub created: Vec<String>,
    pub completed: Vec<String>,
    pub blocked: Vec<String>,
    pub escalated: Vec<String>,
    pub notes: Vec<String>,
}

impl Applied {
    pub fn is_empty(&self) -> bool {
        self.created.is_empty()
            && self.completed.is_empty()
            && self.blocked.is_empty()
            && self.escalated.is_empty()
    }

    pub fn summary(&self) -> String {
        let mut parts = Vec::new();
        if !self.created.is_empty() {
            parts.push(format!("创建 {} 个工单", self.created.len()));
        }
        if !self.completed.is_empty() {
            parts.push(format!("完成 {}", self.completed.len()));
        }
        if !self.blocked.is_empty() {
            parts.push(format!("阻塞 {}", self.blocked.len()));
        }
        if !self.escalated.is_empty() {
            parts.push(format!("升级 {}", self.escalated.len()));
        }
        if parts.is_empty() {
            "无组织动作".to_string()
        } else {
            parts.join(" · ")
        }
    }
}

/// Execute every action of a decision on behalf of `actor`.
pub fn apply(
    store: &CompanyStore,
    actor: &AgentRow,
    issue: &IssueRow,
    decision: &Decision,
    max_depth: i64,
) -> Result<Applied> {
    let mut applied = Applied::default();

    if let Some(note) = decision
        .commentary
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        store.add_comment(&issue.id, Some(&actor.id), note.trim())?;
    }

    for action in &decision.actions {
        match action {
            Action::CreateIssue {
                title,
                body,
                assignee_role,
                assignee_agent_id,
                goal_id,
            } => {
                let child_depth = issue.depth + 1;
                if child_depth > max_depth {
                    // Refused: depth is exhausted, so this belongs to the manager.
                    applied.notes.push(format!("委托深度超限，已升级：{title}"));
                    escalate(
                        store,
                        actor,
                        issue,
                        &format!("委托深度已达上限（{max_depth}）：{title}"),
                    )?;
                    applied.escalated.push(issue.id.clone());
                    continue;
                }

                let assignee = resolve_assignee(
                    store,
                    actor,
                    assignee_agent_id.as_deref(),
                    assignee_role.as_deref(),
                )?;
                let billing = if issue.billing_code.trim().is_empty() {
                    actor.id.clone()
                } else {
                    issue.billing_code.clone()
                };
                let child = store.create_issue(NewIssue {
                    company_id: &actor.company_id,
                    goal_id: goal_id.as_deref().or(issue.goal_id.as_deref()),
                    parent_issue_id: Some(&issue.id),
                    title,
                    body: body.as_deref().unwrap_or(""),
                    assignee_agent_id: assignee.as_deref(),
                    created_by_agent_id: Some(&actor.id),
                    billing_code: &billing,
                    depth: child_depth,
                })?;
                let who = assignee.unwrap_or_else(|| "待认领".to_string());
                store.add_comment(
                    &issue.id,
                    Some(&actor.id),
                    &format!("已委托给 {who}：{}", child.title),
                )?;
                applied.created.push(child.id);
            }

            Action::Complete { issue_id, summary } => {
                if let Some(text) = summary.as_deref().filter(|s| !s.trim().is_empty()) {
                    store.add_comment(issue_id, Some(&actor.id), text.trim())?;
                }
                store.set_issue_state(issue_id, IssueState::Done)?;
                applied.completed.push(issue_id.clone());
            }

            Action::Block { issue_id, reason } => {
                let text = reason.as_deref().unwrap_or("被阻塞，等待外部条件");
                store.add_comment(issue_id, Some(&actor.id), &format!("阻塞：{text}"))?;
                store.set_issue_state(issue_id, IssueState::Blocked)?;
                applied.blocked.push(issue_id.clone());
            }

            Action::Escalate { issue_id, reason } => {
                let text = reason.as_deref().unwrap_or("升级给经理决定");
                escalate_on(store, actor, issue_id, text)?;
                applied.escalated.push(issue_id.clone());
            }
        }
    }

    Ok(applied)
}

/// Assignee resolution: explicit id wins, then role lookup, else nobody.
fn resolve_assignee(
    store: &CompanyStore,
    actor: &AgentRow,
    explicit: Option<&str>,
    role: Option<&str>,
) -> Result<Option<String>> {
    if let Some(id) = explicit {
        if store.get_agent(id)?.is_some() {
            return Ok(Some(id.to_string()));
        }
    }
    if let Some(role) = role {
        if let Some(found) = store.find_agent_by_role(&actor.company_id, role)? {
            return Ok(Some(found.id));
        }
    }
    Ok(None)
}

fn escalate(store: &CompanyStore, actor: &AgentRow, issue: &IssueRow, reason: &str) -> Result<()> {
    escalate_on(store, actor, &issue.id, reason)
}

/// Hand a ticket to the actor's manager. With no manager, park it for humans.
fn escalate_on(store: &CompanyStore, actor: &AgentRow, issue_id: &str, reason: &str) -> Result<()> {
    match actor
        .parent_agent_id
        .as_deref()
        .and_then(|p| store.get_agent(p).ok().flatten())
    {
        Some(manager) => {
            store.reassign_issue(issue_id, Some(&manager.id))?;
            store.set_issue_state(issue_id, IssueState::Blocked)?;
            store.add_comment(
                issue_id,
                Some(&actor.id),
                &format!("升级给 {}（{}）：{reason}", manager.name, manager.role),
            )?;
        }
        None => {
            // Top of the org chart: a human has to decide.
            store.set_issue_state(issue_id, IssueState::InReview)?;
            store.add_comment(
                issue_id,
                Some(&actor.id),
                &format!("已升级给董事会（无上级），等待人工裁决：{reason}"),
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn company() -> (CompanyStore, AgentRow, AgentRow, IssueRow) {
        let store = CompanyStore::open_in_memory().unwrap();
        let c = store.create_company("Acme", "ship it").unwrap();
        let ceo = store
            .create_agent(&c.id, "Alice", "ceo", None, "llm", "{}", 0)
            .unwrap();
        let eng = store
            .create_agent(&c.id, "Bob", "engineer", Some(&ceo.id), "llm", "{}", 0)
            .unwrap();
        let issue = store
            .create_issue(NewIssue {
                assignee_agent_id: Some(&ceo.id),
                ..NewIssue::new(&c.id, "ship v1")
            })
            .unwrap();
        (store, ceo, eng, issue)
    }

    #[test]
    fn extracts_json_from_fenced_prose() {
        let text = "Here is my plan:\n```json\n{\"actions\":[{\"kind\":\"complete\",\"issue_id\":\"iss_1\"}]}\n```\nthanks";
        let d = extract(text).expect("parsed");
        assert_eq!(d.actions.len(), 1);
        assert_eq!(d.actions[0].kind(), "complete");
    }

    #[test]
    fn extraction_fails_gracefully_on_prose() {
        assert!(extract("I could not do the work because the API is down.").is_none());
    }

    #[test]
    fn delegate_by_role_creates_child_ticket() {
        let (store, ceo, eng, issue) = company();
        let decision = Decision {
            commentary: Some("splitting the work".into()),
            actions: vec![Action::CreateIssue {
                title: "implement importer".into(),
                body: Some("csv only".into()),
                assignee_role: Some("engineer".into()),
                assignee_agent_id: None,
                goal_id: None,
            }],
        };
        let applied = apply(&store, &ceo, &issue, &decision, DEFAULT_MAX_DEPTH).unwrap();
        assert_eq!(applied.created.len(), 1);

        let child = store.get_issue(&applied.created[0]).unwrap().unwrap();
        assert_eq!(child.assignee_agent_id.as_deref(), Some(eng.id.as_str()));
        assert_eq!(child.parent_issue_id.as_deref(), Some(issue.id.as_str()));
        assert_eq!(child.depth, 1);
        // Cost is attributed back to the delegating manager.
        assert_eq!(child.billing_code, ceo.id);

        let kids = store.list_children(&issue.id).unwrap();
        assert_eq!(kids.len(), 1);
        // The parent is left open so the manager can review the result.
        assert_eq!(store.get_issue(&issue.id).unwrap().unwrap().state, "todo");
    }

    #[test]
    fn depth_ceiling_escalates_instead_of_delegating() {
        let (store, ceo, _eng, issue) = company();
        let deep = store
            .create_issue(NewIssue {
                company_id: &ceo.company_id,
                title: "already deep",
                depth: DEFAULT_MAX_DEPTH,
                assignee_agent_id: Some(&ceo.id),
                ..NewIssue::new(&ceo.company_id, "already deep")
            })
            .unwrap();
        let decision = Decision {
            commentary: None,
            actions: vec![Action::CreateIssue {
                title: "one level too far".into(),
                body: None,
                assignee_role: None,
                assignee_agent_id: None,
                goal_id: None,
            }],
        };
        let applied = apply(&store, &ceo, &deep, &decision, DEFAULT_MAX_DEPTH).unwrap();
        assert!(applied.created.is_empty());
        assert_eq!(applied.escalated.len(), 1);
        // CEO has no manager → ticket parks for a human.
        assert_eq!(
            store.get_issue(&deep.id).unwrap().unwrap().state,
            "in_review"
        );
        let _ = issue;
    }

    #[test]
    fn escalate_moves_ticket_to_manager() {
        let (store, ceo, eng, issue) = company();
        let eng_issue = store
            .create_issue(NewIssue {
                company_id: &ceo.company_id,
                title: "cannot finish",
                assignee_agent_id: Some(&eng.id),
                ..NewIssue::new(&ceo.company_id, "cannot finish")
            })
            .unwrap();
        let decision = Decision {
            commentary: None,
            actions: vec![Action::Escalate {
                issue_id: eng_issue.id.clone(),
                reason: Some("ticket looks unnecessary".into()),
            }],
        };
        apply(&store, &eng, &eng_issue, &decision, DEFAULT_MAX_DEPTH).unwrap();
        let after = store.get_issue(&eng_issue.id).unwrap().unwrap();
        assert_eq!(after.assignee_agent_id.as_deref(), Some(ceo.id.as_str()));
        assert_eq!(after.state, "blocked");
        let _ = issue;
    }
}
