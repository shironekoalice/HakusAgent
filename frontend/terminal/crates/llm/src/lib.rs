//! Streaming LLM client with two wire formats.
//!
//! Deliberately small: the TUI's client (250 KB, provider-specific quirks for a
//! dozen vendors) is not reusable outside that crate, and `hakus-core` has no
//! HTTP client at all. This crate covers the two wire protocols that nearly
//! every vendor implements — OpenAI `/chat/completions` and Anthropic
//! `/v1/messages` — and leaves provider *catalogue* resolution to
//! `hakus-config` integration later.

pub mod pricing;

use std::time::Duration;

pub use pricing::Price;

use anyhow::{Context as _, Result, bail};
use futures_util::StreamExt as _;
use serde::Serialize;
use serde_json::{Value, json};
use tracing::warn;

static TLS_INIT: std::sync::Once = std::sync::Once::new();

/// Install a rustls crypto provider exactly once.
///
/// The workspace builds reqwest with `rustls-no-provider`, so constructing a
/// `Client` without this panics at runtime. Call before any reqwest client is
/// built — including ones owned by other crates.
pub fn ensure_tls_provider() {
    TLS_INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Which request/response dialect the endpoint speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WireFormat {
    /// `/chat/completions` — OpenAI, DeepSeek, Moonshot/Kimi, ZAI, Minimax,
    /// Qwen, vLLM, Ollama and friends.
    #[default]
    OpenAi,
    /// `/v1/messages` — Anthropic and Anthropic-compatible gateways.
    Anthropic,
}

impl WireFormat {
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "anthropic" => WireFormat::Anthropic,
            _ => WireFormat::OpenAi,
        }
    }
}

/// Everything needed to call one endpoint.
#[derive(Debug, Clone)]
pub struct LlmRoute {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub wire: WireFormat,
    pub timeout_secs: u64,
}

impl LlmRoute {
    /// Build from environment, so the company daemon needs no config plumbing:
    /// `HAKUS_LLM_BASE_URL`, `HAKUS_LLM_API_KEY`, `HAKUS_LLM_MODEL`,
    /// `HAKUS_LLM_WIRE` (`openai` | `anthropic`).
    pub fn from_env() -> Result<Self> {
        let base_url = std::env::var("HAKUS_LLM_BASE_URL")
            .unwrap_or_else(|_| "https://api.deepseek.com/v1".to_string());
        let api_key = std::env::var("HAKUS_LLM_API_KEY").unwrap_or_default();
        let model =
            std::env::var("HAKUS_LLM_MODEL").unwrap_or_else(|_| "deepseek-chat".to_string());
        let wire = WireFormat::parse(&std::env::var("HAKUS_LLM_WIRE").unwrap_or_default());
        if api_key.trim().is_empty() {
            bail!("HAKUS_LLM_API_KEY is not set");
        }
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
            model,
            wire,
            timeout_secs: 600,
        })
    }

    pub fn new(base_url: &str, api_key: &str, model: &str, wire: WireFormat) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
            model: model.to_string(),
            wire,
            timeout_secs: 600,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

impl ChatMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: content.into(),
        }
    }
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: Role::System,
            content: content.into(),
        }
    }
}

/// Token accounting for one turn.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Default)]
pub struct ChatReply {
    pub text: String,
    pub usage: Usage,
    pub model: String,
}

/// Streaming client. Cheap to clone (shares the reqwest pool).
#[derive(Clone)]
pub struct LlmClient {
    route: LlmRoute,
    client: reqwest::Client,
}

impl LlmClient {
    pub fn new(route: LlmRoute) -> Self {
        ensure_tls_provider();
        Self {
            route,
            client: reqwest::Client::new(),
        }
    }

    pub fn route(&self) -> &LlmRoute {
        &self.route
    }

    /// Run one turn, invoking `on_delta` as text arrives.
    pub async fn chat<F>(&self, system: &str, user: &str, mut on_delta: F) -> Result<ChatReply>
    where
        F: FnMut(&str),
    {
        match self.route.wire {
            WireFormat::OpenAi => self.chat_openai(system, user, &mut on_delta).await,
            WireFormat::Anthropic => self.chat_anthropic(system, user, &mut on_delta).await,
        }
    }

    async fn chat_openai<F>(&self, system: &str, user: &str, on_delta: &mut F) -> Result<ChatReply>
    where
        F: FnMut(&str),
    {
        let mut messages = Vec::new();
        if !system.trim().is_empty() {
            messages.push(json!({ "role": "system", "content": system }));
        }
        messages.push(json!({ "role": "user", "content": user }));

        let body = json!({
            "model": self.route.model,
            "messages": messages,
            "stream": true,
            "stream_options": { "include_usage": true },
        });

        let res = self
            .post(
                &format!("{}/chat/completions", self.route.base_url),
                &body,
                &[("authorization", format!("Bearer {}", self.route.api_key))],
            )
            .await?;

        let mut reply = ChatReply {
            model: self.route.model.clone(),
            ..Default::default()
        };
        Self::consume_sse(res, |payload| {
            if let Some(usage) = payload.get("usage") {
                reply.usage.input_tokens += usage
                    .get("prompt_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                reply.usage.output_tokens += usage
                    .get("completion_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
            }
            if let Some(delta) = payload
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("delta"))
                .and_then(|d| d.get("content"))
                .and_then(|v| v.as_str())
            {
                reply.text.push_str(delta);
                on_delta(delta);
            }
            if let Some(model) = payload.get("model").and_then(|v| v.as_str()) {
                if !model.is_empty() {
                    reply.model = model.to_string();
                }
            }
        })
        .await?;
        Ok(reply)
    }

    async fn chat_anthropic<F>(
        &self,
        system: &str,
        user: &str,
        on_delta: &mut F,
    ) -> Result<ChatReply>
    where
        F: FnMut(&str),
    {
        let body = json!({
            "model": self.route.model,
            "max_tokens": 8192,
            "system": system,
            "messages": [{ "role": "user", "content": user }],
            "stream": true,
        });

        let res = self
            .post(
                &format!("{}/v1/messages", self.route.base_url),
                &body,
                &[
                    ("x-api-key", self.route.api_key.clone()),
                    ("anthropic-version", "2023-06-01".to_string()),
                ],
            )
            .await?;

        let mut reply = ChatReply {
            model: self.route.model.clone(),
            ..Default::default()
        };
        Self::consume_sse(res, |payload| {
            let etype = payload
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            match etype {
                "message_start" => {
                    if let Some(u) = payload.pointer("/message/usage") {
                        reply.usage.input_tokens +=
                            u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    }
                    if let Some(m) = payload.pointer("/message/model").and_then(|v| v.as_str()) {
                        reply.model = m.to_string();
                    }
                }
                "content_block_delta" => {
                    if let Some(t) = payload.pointer("/delta/text").and_then(|v| v.as_str()) {
                        reply.text.push_str(t);
                        on_delta(t);
                    }
                }
                "message_delta" => {
                    if let Some(u) = payload.get("usage") {
                        reply.usage.output_tokens +=
                            u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    }
                }
                _ => {}
            }
        })
        .await?;
        Ok(reply)
    }

    async fn post(
        &self,
        url: &str,
        body: &Value,
        headers: &[(&str, String)],
    ) -> Result<reqwest::Response> {
        let mut req = self
            .client
            .post(url)
            .timeout(Duration::from_secs(self.route.timeout_secs))
            .header("content-type", "application/json");
        for (k, v) in headers {
            req = req.header(*k, v);
        }
        let res = req
            .body(serde_json::to_vec(body)?)
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            bail!("llm endpoint returned {status}: {}", truncate(&text, 400));
        }
        Ok(res)
    }

    /// Read an SSE body and hand each `data:` payload to `sink`.
    async fn consume_sse<F>(res: reqwest::Response, mut sink: F) -> Result<()>
    where
        F: FnMut(&Value),
    {
        let mut stream = res.bytes_stream();
        let mut buf = String::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("reading SSE chunk")?;
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buf.find("\n\n") {
                let frame = buf[..pos].to_string();
                buf = buf[pos + 2..].to_string();
                for line in frame.lines() {
                    let Some(payload) = line.strip_prefix("data:") else {
                        continue;
                    };
                    let payload = payload.trim();
                    if payload == "[DONE]" {
                        return Ok(());
                    }
                    match serde_json::from_str::<Value>(payload) {
                        Ok(value) => sink(&value),
                        Err(err) => warn!("ignoring malformed SSE frame: {err}"),
                    }
                }
            }
        }
        Ok(())
    }
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_format_parsing() {
        assert_eq!(WireFormat::parse("openai"), WireFormat::OpenAi);
        assert_eq!(WireFormat::parse("Anthropic"), WireFormat::Anthropic);
        assert_eq!(WireFormat::parse(""), WireFormat::OpenAi);
    }

    #[test]
    fn route_trims_trailing_slash() {
        let r = LlmRoute::new("https://api.example.com/v1/", "k", "m", WireFormat::OpenAi);
        assert_eq!(r.base_url, "https://api.example.com/v1");
    }
}
