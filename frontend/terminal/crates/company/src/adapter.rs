//! Execution runtime boundary.
//!
//! The control plane never runs agents itself — that is Paperclip's central
//! architectural claim, and after the 2026-09-21 spike it is also a hard
//! constraint: `hakus-core`'s `handle_prompt` is a stub, while the Python
//! `hakusai_server` actually streams turns. Anything implementing
//! [`AgentRuntime`] can back a heartbeat.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context as _, Result};
use async_trait::async_trait;
use serde_json::Value;
use tracing::warn;

use crate::model::AgentRow;

/// A turn to execute inside an existing runtime session.
#[derive(Debug, Clone)]
pub struct RunTurnReq {
    pub session_id: String,
    pub prompt: String,
    pub provider: Option<String>,
    pub run_mode: Option<String>,
}

/// Accumulated result of one turn.
#[derive(Debug, Clone, Default)]
pub struct RunTurnOut {
    pub text: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// `true` when the runtime asked a human to approve something mid-turn.
    pub approval_required: bool,
}

#[async_trait]
pub trait AgentRuntime: Send + Sync {
    /// Resolve (creating if needed) the session this agent keeps across runs.
    async fn ensure_session(&self, agent: &AgentRow) -> Result<String>;
    async fn run_turn(&self, req: RunTurnReq) -> Result<RunTurnOut>;
}

// ── Python backend over HTTP ────────────────────────────────────────────────

fn default_base_url() -> String {
    std::env::var("HAKUS_PY_BASE").unwrap_or_else(|_| "http://127.0.0.1:8000".to_string())
}

/// Talks to `hakusai_server`'s `/api/chat/stream` SSE endpoint.
pub struct HttpPythonRuntime {
    base_url: String,
    client: reqwest::Client,
}

impl HttpPythonRuntime {
    pub fn new(base_url: Option<String>) -> Self {
        // reqwest panics without a crypto provider; see hakus_llm::ensure_tls_provider.
        hakus_llm::ensure_tls_provider();
        Self {
            base_url: base_url
                .unwrap_or_else(default_base_url)
                .trim_end_matches('/')
                .to_string(),
            client: reqwest::Client::new(),
        }
    }

    pub fn from_env() -> Self {
        Self::new(None)
    }

    fn endpoint(&self) -> String {
        format!("{}/api/chat/stream", self.base_url)
    }
}

#[async_trait]
impl AgentRuntime for HttpPythonRuntime {
    async fn ensure_session(&self, agent: &AgentRow) -> Result<String> {
        if let Some(existing) = &agent.runtime_session_id {
            return Ok(existing.clone());
        }
        Ok(format!("company-agent-{}", agent.id))
    }

    async fn run_turn(&self, req: RunTurnReq) -> Result<RunTurnOut> {
        let mut body = HashMap::new();
        body.insert("message", Value::String(req.prompt.clone()));
        body.insert("session_id", Value::String(req.session_id.clone()));
        body.insert("stream", Value::Bool(true));
        if let Some(p) = &req.provider {
            body.insert("provider", Value::String(p.clone()));
        }
        if let Some(m) = &req.run_mode {
            body.insert("run_mode", Value::String(m.clone()));
        }

        let res = self
            .client
            .post(self.endpoint())
            .json(&body)
            .send()
            .await
            .with_context(|| format!("calling {}", self.endpoint()))?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "python backend returned {status}: {}",
                text.chars().take(300).collect::<String>()
            );
        }

        use futures_util::StreamExt as _;
        let mut stream = res.bytes_stream();
        let mut out = RunTurnOut::default();
        let mut buf = String::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("reading SSE chunk")?;
            buf.push_str(&String::from_utf8_lossy(&chunk));
            // SSE frames are separated by a blank line.
            while let Some(pos) = buf.find("\n\n") {
                let frame = buf[..pos].to_string();
                buf = buf[pos + 2..].to_string();
                apply_frame(&mut out, &frame);
            }
        }
        Ok(out)
    }
}

/// Route one SSE `data:` frame into the accumulator.
fn apply_frame(out: &mut RunTurnOut, frame: &str) {
    for line in frame.lines() {
        let Some(payload) = line.strip_prefix("data:") else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(payload.trim()) else {
            warn!("ignoring malformed SSE payload");
            continue;
        };
        let etype = value
            .get("event_type")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        match etype {
            "text_delta" => {
                if let Some(t) = value
                    .get("content")
                    .or_else(|| value.get("text"))
                    .and_then(|v| v.as_str())
                {
                    out.text.push_str(t);
                }
            }
            "token_usage" => {
                out.input_tokens += value
                    .get("input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                out.output_tokens += value
                    .get("output_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
            }
            "turn_completed" => {
                if out.text.is_empty() {
                    if let Some(c) = value.get("content").and_then(|v| v.as_str()) {
                        out.text.push_str(c);
                    }
                }
                if let Some(m) = value.get("model").and_then(|v| v.as_str()) {
                    out.model = m.to_string();
                }
            }
            "turn_failed" => {
                let msg = value
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("turn failed");
                out.text.push_str(&format!("\n[turn_failed] {msg}"));
            }
            "approval_required" => out.approval_required = true,
            _ => {}
        }
    }
}

// ── native runtime：直连 provider，不经 Python ───────────────────────────────

/// Runs turns by calling an LLM endpoint directly with `hakus-llm`.
///
/// This is the mid/long-term path: no Python process, no agent framework. The
/// trade-off is that these employees can only *talk* — they have no tools, no
/// approvals and no checkpointing until `hakus-core` grows a real turn loop.
pub struct NativeLlmRuntime {
    client: hakus_llm::LlmClient,
    system_prompt: String,
}

impl NativeLlmRuntime {
    pub fn from_env(system_prompt: impl Into<String>) -> anyhow::Result<Self> {
        let route = hakus_llm::LlmRoute::from_env()?;
        Ok(Self {
            client: hakus_llm::LlmClient::new(route),
            system_prompt: system_prompt.into(),
        })
    }

    pub fn new(client: hakus_llm::LlmClient, system_prompt: impl Into<String>) -> Self {
        Self {
            client,
            system_prompt: system_prompt.into(),
        }
    }
}

#[async_trait]
impl AgentRuntime for NativeLlmRuntime {
    async fn ensure_session(&self, agent: &AgentRow) -> Result<String> {
        if let Some(existing) = &agent.runtime_session_id {
            return Ok(existing.clone());
        }
        Ok(format!("llm-session-{}", agent.id))
    }

    async fn run_turn(&self, req: RunTurnReq) -> Result<RunTurnOut> {
        let reply = self
            .client
            .chat(&self.system_prompt, &req.prompt, |_| {})
            .await
            .context("native llm turn")?;
        Ok(RunTurnOut {
            text: reply.text,
            model: reply.model,
            input_tokens: reply.usage.input_tokens,
            output_tokens: reply.usage.output_tokens,
            approval_required: false,
        })
    }
}

// ── runtime registry：按 agent.adapter 分派 ──────────────────────────────────

/// Picks the execution runtime for each agent.
///
/// This is what lets one company mix employees: an `llm` agent reasons in text,
/// a `python-http` agent actually edits files, and tests use `mock`.
pub struct RuntimeRegistry {
    by_adapter: HashMap<String, Arc<dyn AgentRuntime>>,
    default: Arc<dyn AgentRuntime>,
}

impl RuntimeRegistry {
    pub fn new(default: Arc<dyn AgentRuntime>) -> Self {
        Self {
            by_adapter: HashMap::new(),
            default,
        }
    }

    /// Register a runtime for an `agent.adapter` value.
    pub fn with(mut self, adapter: &str, runtime: Arc<dyn AgentRuntime>) -> Self {
        self.by_adapter.insert(adapter.to_string(), runtime);
        self
    }

    pub fn for_agent(&self, agent: &AgentRow) -> Arc<dyn AgentRuntime> {
        self.by_adapter
            .get(&agent.adapter)
            .cloned()
            .unwrap_or_else(|| self.default.clone())
    }
}

// ── offline double used by tests ────────────────────────────────────────────

/// Deterministic runtime that replays a canned list of replies in order.
///
/// Used to drive multi-agent scenarios offline: the manager's reply can be a
/// decision document, the worker's a plain report.
pub struct ScriptedRuntime {
    replies: std::sync::Mutex<std::collections::VecDeque<String>>,
    pub model: String,
}

impl ScriptedRuntime {
    pub fn new(replies: Vec<String>) -> Self {
        Self {
            replies: std::sync::Mutex::new(replies.into()),
            model: "scripted".to_string(),
        }
    }
}

#[async_trait]
impl AgentRuntime for ScriptedRuntime {
    async fn ensure_session(&self, agent: &AgentRow) -> Result<String> {
        Ok(format!("scripted-{}", agent.id))
    }

    async fn run_turn(&self, _req: RunTurnReq) -> Result<RunTurnOut> {
        let next = self
            .replies
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pop_front()
            .unwrap_or_else(|| "(no scripted reply left)".to_string());
        Ok(RunTurnOut {
            text: next,
            model: self.model.clone(),
            input_tokens: 100,
            output_tokens: 40,
            approval_required: false,
        })
    }
}

/// Deterministic runtime so heartbeats can be tested without a model.
pub struct MockRuntime {
    pub reply: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl Default for MockRuntime {
    fn default() -> Self {
        Self {
            reply: "mock turn complete".to_string(),
            input_tokens: 11,
            output_tokens: 7,
        }
    }
}

#[async_trait]
impl AgentRuntime for MockRuntime {
    async fn ensure_session(&self, agent: &AgentRow) -> Result<String> {
        Ok(format!("mock-session-{}", agent.id))
    }

    async fn run_turn(&self, _req: RunTurnReq) -> Result<RunTurnOut> {
        Ok(RunTurnOut {
            text: self.reply.clone(),
            model: "mock".to_string(),
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            approval_required: false,
        })
    }
}
