use super::*;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::StreamExt;

use crate::config::{Config, ProviderConfig, ProvidersConfig, RetryConfig};
use crate::models::Message;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

#[derive(Clone)]
struct RetryThenSuccess {
    attempts: Arc<AtomicUsize>,
    retry_status: u16,
    retry_body: &'static str,
}
impl Respond for RetryThenSuccess {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        if self.attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            let mut response =
                ResponseTemplate::new(self.retry_status).set_body_string(self.retry_body);
            if self.retry_status == 429 {
                response = response.insert_header("Retry-After", "0");
            }
            return response;
        }

        ResponseTemplate::new(200)
            .insert_header("Content-Type", "text/event-stream")
            .set_body_string("data: [DONE]\n\n")
    }
}

#[derive(Clone)]
struct AlwaysError {
    attempts: Arc<AtomicUsize>,
    status: u16,
    body: &'static str,
}

impl Respond for AlwaysError {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        ResponseTemplate::new(self.status).set_body_string(self.body)
    }
}

fn minimal_responses_request() -> MessageRequest {
    MessageRequest {
        model: "gpt-5.5".to_string(),
        messages: vec![Message {
            role: "user".to_string(),
            content: vec![ContentBlock::Text {
                text: "hello".to_string(),
                cache_control: None,
            }],
        }],
        max_tokens: 128,
        system: None,
        tools: None,
        tool_choice: None,
        metadata: None,
        thinking: None,
        reasoning_effort: None,
        stream: None,
        temperature: None,
        top_p: None,
    }
}






#[test]
fn responses_body_serializes_the_child_catalog_without_duplication() {
    // Mirror of the Anthropic contract: the real child catalog fixture
    // maps 1:1 into Responses function tools with one canonical `read` entry.
    // Skills are discoverable through tool_search, so the child wire catalog
    // carries no load_skill at all.
    let tools = crate::tools::subagent::kimi_general_child_request_tools_fixture();
    let mut request = minimal_responses_request();
    request.tools = Some(tools);
    let body = build_responses_body(&request);
    let serialized = body["tools"]
        .as_array()
        .expect("tools serialize as an array");
    let reads: Vec<_> = serialized
        .iter()
        .filter(|tool| tool["name"] == "read")
        .collect();
    assert_eq!(
        reads.len(),
        1,
        "exactly one canonical read definition reaches the Responses wire"
    );
    assert!(
        reads[0]["parameters"]["properties"].is_object(),
        "read keeps a valid parameters schema: {}",
        reads[0]
    );
    assert!(
        serialized.iter().all(|tool| tool["name"] != "load_skill"),
        "load_skill must not appear on the child Responses wire"
    );
}



#[test]
fn codex_reasoning_effort_uses_responses_labels() {
    assert_eq!(codex_responses_reasoning_effort("max"), Some("xhigh"));
    assert_eq!(codex_responses_reasoning_effort("maximum"), Some("xhigh"));
    assert_eq!(codex_responses_reasoning_effort("xhigh"), Some("xhigh"));
    assert_eq!(codex_responses_reasoning_effort("ultra"), Some("xhigh"));
    assert_eq!(codex_responses_reasoning_effort("ultracode"), Some("xhigh"));
    assert_eq!(codex_responses_reasoning_effort("high"), Some("high"));
    assert_eq!(codex_responses_reasoning_effort("medium"), Some("medium"));
    assert_eq!(codex_responses_reasoning_effort("minimal"), Some("low"));
    assert_eq!(codex_responses_reasoning_effort("auto"), Some("medium"));
    assert_eq!(codex_responses_reasoning_effort("off"), Some("low"));
}

#[test]
fn deepseek_flash_responses_body_uses_stateless_0731_contract() {
    let mut request = minimal_responses_request();
    request.model = "deepseek-v4-flash".to_string();
    request.reasoning_effort = Some("xhigh".to_string());
    request.temperature = Some(1.0);
    request.top_p = Some(0.95);
    request.messages.insert(
        0,
        Message {
            role: "assistant".to_string(),
            content: vec![ContentBlock::Thinking {
                thinking: "preserve this tool-loop reasoning".to_string(),
                signature: None,
                state: None,
            }],
        },
    );

    let body = build_responses_body_for_provider(&request, ApiProvider::Deepseek);

    assert_eq!(body["model"], "deepseek-v4-flash");
    assert_eq!(body["max_output_tokens"], 128);
    assert_eq!(body["temperature"], 1.0);
    assert!(
        (body["top_p"].as_f64().expect("top_p number") - 0.95).abs() < 1e-6,
        "{}",
        body["top_p"]
    );
    assert_eq!(body.pointer("/reasoning/effort"), Some(&json!("max")));
    assert!(body.pointer("/reasoning/summary").is_none());
    assert!(body.get("include").is_none());
    assert!(body.get("store").is_none());
    assert_eq!(
        body.pointer("/input/0/content/0/type"),
        Some(&json!("reasoning_text"))
    );
    assert_eq!(
        body.pointer("/input/0/content/0/text"),
        Some(&json!("preserve this tool-loop reasoning"))
    );
}



#[test]
fn deepseek_responses_reasoning_effort_uses_documented_labels() {
    assert_eq!(responses_reasoning_effort("low", true), Some("low"));
    assert_eq!(responses_reasoning_effort("medium", true), Some("high"));
    assert_eq!(responses_reasoning_effort("high", true), Some("high"));
    assert_eq!(responses_reasoning_effort("xhigh", true), Some("max"));
    assert_eq!(responses_reasoning_effort("max", true), Some("max"));
    // The off tier must disable thinking on the wire, not collapse into
    // low: DeepSeek documents `reasoning.effort: "none"` as the off value.
    assert_eq!(responses_reasoning_effort("off", true), Some("none"));
    assert_eq!(responses_reasoning_effort("disabled", true), Some("none"));
    assert_eq!(responses_reasoning_effort("none", true), Some("none"));
    assert_eq!(responses_reasoning_effort("false", true), Some("none"));
    // minimal stays a low tier for DeepSeek (undocumented label preserved
    // for Codex compatibility).
    assert_eq!(responses_reasoning_effort("minimal", true), Some("low"));
}

#[test]
fn codex_responses_body_uses_responses_reasoning_not_deepseek_thinking() {
    let request = MessageRequest {
        model: "gpt-5.5".to_string(),
        messages: vec![Message {
            role: "user".to_string(),
            content: vec![ContentBlock::Text {
                text: "hello".to_string(),
                cache_control: None,
            }],
        }],
        max_tokens: 128,
        system: None,
        tools: None,
        tool_choice: None,
        metadata: None,
        thinking: None,
        reasoning_effort: Some("max".to_string()),
        stream: None,
        temperature: None,
        top_p: None,
    };

    let body = build_responses_body(&request);

    assert_eq!(
        body.pointer("/reasoning/effort").and_then(Value::as_str),
        Some("xhigh")
    );
    assert_eq!(
        body.pointer("/reasoning/summary").and_then(Value::as_str),
        Some("auto")
    );
    assert!(body.get("thinking").is_none());
    assert!(body.get("reasoning_effort").is_none());
}

#[test]
fn responses_failed_event_reports_nested_error() {
    let event = json!({
        "type": "response.failed",
        "response": {
            "id": "resp_123",
            "error": {
                "code": "rate_limit_exceeded",
                "message": "Please retry later"
            }
        }
    });

    let (code, message) = responses_event_error_details(&event);

    assert_eq!(code, "rate_limit_exceeded");
    assert_eq!(message, "Please retry later");
}

#[test]
fn responses_incomplete_event_reports_reason() {
    let event = json!({
        "type": "response.incomplete",
        "response": {
            "id": "resp_123",
            "status": "incomplete",
            "error": null,
            "incomplete_details": {
                "reason": "content_filter"
            }
        }
    });

    let (code, message) = responses_event_error_details(&event);

    assert_eq!(code, "content_filter");
    assert_eq!(message, "response incomplete: content_filter");
}

#[test]
fn responses_incomplete_stop_reason_preserves_provider_reason() {
    assert_eq!(
        responses_stop_reason(
            &json!({
                "status": "incomplete",
                "incomplete_details": { "reason": "max_output_tokens" }
            }),
            false,
        ),
        "incomplete:max_output_tokens"
    );
    assert_eq!(
        responses_stop_reason(&json!({"status": "incomplete"}), false),
        "incomplete:max_tokens"
    );
}

#[test]
fn parse_responses_usage_derives_cache_miss_and_reasoning() {
    let usage = json!({
        "input_tokens": 1000,
        "output_tokens": 200,
        "input_tokens_details": { "cached_tokens": 600 },
        "output_tokens_details": { "reasoning_tokens": 120 }
    });

    let parsed = parse_responses_usage(&usage);

    assert_eq!(parsed.input_tokens, 1000);
    assert_eq!(parsed.output_tokens, 200);
    assert_eq!(parsed.prompt_cache_hit_tokens, Some(600));
    // Cache-miss is derived as input minus the cached hit when cached > 0.
    assert_eq!(parsed.prompt_cache_miss_tokens, Some(400));
    // Reasoning surfaces from output_tokens_details (Responses dialect).
    assert_eq!(parsed.reasoning_tokens, Some(120));

    // Without cached/reasoning details, the derived fields stay None.
    let bare = json!({ "input_tokens": 1000, "output_tokens": 200 });
    let parsed_bare = parse_responses_usage(&bare);
    assert_eq!(parsed_bare.prompt_cache_hit_tokens, None);
    assert_eq!(parsed_bare.prompt_cache_miss_tokens, None);
    assert_eq!(parsed_bare.reasoning_tokens, None);
}

#[test]
fn parse_responses_usage_saturates_u64_fields() {
    let parsed = parse_responses_usage(&json!({
        "input_tokens": u64::MAX,
        "output_tokens": u64::MAX,
        "input_tokens_details": { "cached_tokens": u64::MAX },
        "output_tokens_details": { "reasoning_tokens": u64::MAX }
    }));
    assert_eq!(parsed.input_tokens, u32::MAX);
    assert_eq!(parsed.output_tokens, u32::MAX);
    assert_eq!(parsed.prompt_cache_hit_tokens, Some(u32::MAX));
    assert_eq!(parsed.prompt_cache_miss_tokens, Some(0));
    assert_eq!(parsed.reasoning_tokens, Some(u32::MAX));
}

#[test]
fn parse_responses_usage_reads_deepseek_top_level_cache_fields() {
    // DeepSeek's Responses dialect reports cache telemetry as top-level
    // `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` with
    // `cache_write_tokens` nested under `input_tokens_details` -- none of
    // which the old parser read (it only looked at
    // `input_tokens_details.cached_tokens`, which DeepSeek leaves unset,
    // so every V4 Flash turn recorded cache_hit = None).
    let usage = json!({
        "input_tokens": 1_000,
        "output_tokens": 200,
        "prompt_cache_hit_tokens": 600,
        "prompt_cache_miss_tokens": 200,
        "input_tokens_details": { "cached_tokens": 999, "cache_write_tokens": 100 },
        "output_tokens_details": { "reasoning_tokens": 120 }
    });

    let parsed = parse_responses_usage(&usage);

    // Top-level DeepSeek fields win over the nested OpenAI-style shape,
    // and the explicit miss is trusted over the derived fallback.
    assert_eq!(parsed.prompt_cache_hit_tokens, Some(600));
    assert_eq!(parsed.prompt_cache_miss_tokens, Some(200));
    assert_eq!(parsed.prompt_cache_write_tokens, Some(100));
    // `input_tokens` remains the provider-reported total; the pricing
    // layer partitions it into hit / miss / write classes.
    assert_eq!(parsed.input_tokens, 1_000);
    assert_eq!(parsed.output_tokens, 200);
    assert_eq!(parsed.reasoning_tokens, Some(120));

    // The parsed fields must reach the pricing classes unchanged: 600 hit
    // at the cache-read rate, 100 write at the creation rate, and the
    // remaining 300 (200 reported miss + 100 uncategorized) at the miss
    // rate -- instead of the pre-fix all-raw-input miss billing.
    let classes = crate::pricing::token_usage_for_pricing(&parsed);
    assert_eq!(classes.input, 300);
    assert_eq!(classes.cache_read, 600);
    assert_eq!(classes.cache_write, 100);
}

#[test]
fn parse_responses_usage_keeps_old_shape_with_cache_write_fallback() {
    // OpenAI-style payloads still parse from `input_tokens_details` alone:
    // hit from `cached_tokens` (fallback), miss derived as input minus
    // hit, and the write class from `cache_write_tokens` when present.
    let usage = json!({
        "input_tokens": 1_000,
        "output_tokens": 200,
        "input_tokens_details": { "cached_tokens": 600, "cache_write_tokens": 100 }
    });

    let parsed = parse_responses_usage(&usage);

    assert_eq!(parsed.input_tokens, 1_000);
    assert_eq!(parsed.prompt_cache_hit_tokens, Some(600));
    assert_eq!(parsed.prompt_cache_miss_tokens, Some(400));
    assert_eq!(parsed.prompt_cache_write_tokens, Some(100));
    assert_eq!(parsed.reasoning_tokens, None);
}

/// Regression fixture for the reasoning double-billing bug: a real
/// Responses usage payload has to survive the whole way into the pricing
/// conversion without reasoning tokens being charged twice. OpenAI's
/// `output_tokens` is already the *total* billable completion count, with
/// `output_tokens_details.reasoning_tokens` a subset of it.
#[test]
fn responses_usage_reaches_pricing_conversion_without_double_billing_reasoning() {
    use crate::config::ApiProvider;
    use crate::pricing::{calculate_turn_cost_estimate_for_provider, token_usage_for_pricing};

    let usage = parse_responses_usage(&json!({
        "input_tokens": 10_000,
        "output_tokens": 4_000,
        "total_tokens": 14_000,
        "input_tokens_details": { "cached_tokens": 6_000 },
        "output_tokens_details": { "reasoning_tokens": 3_500 }
    }));

    let classes = token_usage_for_pricing(&usage);
    assert_eq!(classes.output, 4_000, "reasoning must not inflate output");
    assert_eq!(classes.input, 4_000);
    assert_eq!(classes.cache_read, 6_000);
    assert_eq!(classes.cache_write, 0);

    // gpt-5.5: 0.50 cache-read / 5.00 input / 30.00 output per million.
    let cost = calculate_turn_cost_estimate_for_provider(ApiProvider::Openai, "gpt-5.5", &usage)
        .expect("direct OpenAI route is priced");
    let expected = 0.006 * 0.50 + 0.004 * 5.00 + 0.004 * 30.00;
    assert!(
        (cost.usd - expected).abs() < 1e-12,
        "expected {expected}, got {}",
        cost.usd
    );

    // The bug charged the 3_500 reasoning tokens a second time at the
    // output rate; assert the difference explicitly so a reintroduction is
    // unambiguous rather than a silent number change.
    let double_billed = expected + 0.0035 * 30.00;
    assert!((cost.usd - double_billed).abs() > 1e-6);
}



#[test]
fn responses_function_tool_sanitizes_root_composition_schema() {
    let tool = Tool {
        tool_type: None,
        name: "web.run".to_string(),
        description: "Apply patch".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "patch": {"type": "string"},
                "replace": {"type": "array"},
                "changes": {"type": "array"}
            },
            "oneOf": [
                {"required": ["patch"]},
                {"required": ["replace"]},
                {"required": ["changes"]}
            ]
        }),
        allowed_callers: None,
        defer_loading: None,
        input_examples: None,
        strict: None,
        cache_control: None,
    };

    let payload = tool_to_responses_function(&tool);
    let parameters = &payload["parameters"];

    assert_eq!(payload["name"], to_api_tool_name("web.run"));
    assert_eq!(parameters["type"], "object");
    assert!(parameters.get("oneOf").is_none());
    assert!(parameters.get("anyOf").is_none());
    assert!(parameters.get("allOf").is_none());
    assert!(parameters.get("enum").is_none());
    assert!(parameters.get("not").is_none());
    assert!(parameters["properties"].get("patch").is_some());
    assert!(parameters["properties"].get("replace").is_some());
    assert!(parameters["properties"].get("changes").is_some());
    assert_eq!(
        payload["description"],
        "Apply patch\n\nExactly one of these parameter groups must be provided: `changes` | `patch` | `replace`."
    );
    assert!(tool.input_schema.get("oneOf").is_some());
}

#[test]
fn responses_function_tool_trims_description_before_constraint_note() {
    let tool = Tool {
        tool_type: None,
        name: "apply_patch".to_string(),
        description: "Apply patch\n".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "patch": {"type": "string"},
                "replace": {"type": "array"},
                "changes": {"type": "array"}
            },
            "oneOf": [
                {"required": ["patch"]},
                {"required": ["replace"]},
                {"required": ["changes"]}
            ]
        }),
        allowed_callers: None,
        defer_loading: None,
        input_examples: None,
        strict: None,
        cache_control: None,
    };

    let payload = tool_to_responses_function(&tool);

    assert_eq!(
        payload["description"],
        "Apply patch\n\nExactly one of these parameter groups must be provided: `changes` | `patch` | `replace`."
    );
}

#[test]
fn responses_function_tool_leaves_description_unchanged_without_constraint_note() {
    let tool = Tool {
        tool_type: None,
        name: "lookup".to_string(),
        description: "Lookup".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "query": {"type": "string"}
            }
        }),
        allowed_callers: None,
        defer_loading: None,
        input_examples: None,
        strict: None,
        cache_control: None,
    };

    let payload = tool_to_responses_function(&tool);

    assert_eq!(payload["description"], "Lookup");
}
