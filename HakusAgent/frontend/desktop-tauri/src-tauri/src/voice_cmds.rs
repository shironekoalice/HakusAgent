//! Desktop voice extension lifecycle controls.
//!
//! Celia is hosted through the reviewed `hakus.extension.v1` boundary. The
//! webview can request lifecycle actions, but it cannot provide an executable,
//! source directory, or policy/ledger access.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{sync::Mutex, time::{SystemTime, UNIX_EPOCH}};

#[derive(Default)]
pub struct VoiceProcessState {
    started_at: Mutex<Option<u64>>,
    last_error: Mutex<Option<String>>,
}

#[derive(Debug, Default, Deserialize)]
pub struct VoiceStartOptions {
    #[serde(default, alias = "configPath")]
    pub config_path: Option<String>,
    #[serde(default, alias = "threadId")]
    pub thread_id: Option<String>,
    #[serde(default, alias = "openInTerminal")]
    pub open_in_terminal: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProcessStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub started_at: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProcessResult {
    pub ok: bool,
    pub running: bool,
    pub pid: Option<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RuntimeExtensionStatus {
    running: bool,
    pid: Option<u32>,
    error: Option<String>,
}

const RUNTIME_EXTENSION_URL: &str = "http://127.0.0.1:48081/v1/extensions/voice.celia";

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn status_inner(state: &VoiceProcessState) -> Result<VoiceProcessStatus, String> {
    let cached_error = state.last_error.lock().map_err(|_| "voice state poisoned".to_string())?.clone();
    let (running, pid, remote_error) = match reqwest::blocking::Client::new()
        .get(RUNTIME_EXTENSION_URL)
        .timeout(std::time::Duration::from_secs(2))
        .send()
    {
        Ok(response) if response.status().is_success() => match response.json::<RuntimeExtensionStatus>() {
            Ok(status) => (status.running, status.pid, status.error),
            Err(error) => (false, None, Some(format!("Runtime extension status was malformed: {error}"))),
        },
        Ok(response) => (false, None, Some(format!("Runtime extension status failed: HTTP {}", response.status()))),
        Err(error) => (false, None, Some(format!("Runtime extension status unavailable: {error}"))),
    };
    if !running {
        *state.started_at.lock().map_err(|_| "voice state poisoned".to_string())? = None;
    }
    let last_error = remote_error.or(cached_error);
    let started_at = *state.started_at.lock().map_err(|_| "voice state poisoned".to_string())?;
    Ok(VoiceProcessStatus { running, pid, started_at, last_error })
}

#[tauri::command]
pub fn voice_status(state: tauri::State<'_, VoiceProcessState>) -> Result<VoiceProcessStatus, String> {
    status_inner(&state)
}

#[tauri::command]
pub fn voice_start_celia(
    state: tauri::State<'_, VoiceProcessState>,
    options: Option<VoiceStartOptions>,
) -> Result<VoiceProcessResult, String> {
    let options = options.unwrap_or_default();
    let current = status_inner(&state)?;
    if current.running {
        return Ok(VoiceProcessResult { ok: true, running: true, pid: current.pid, error: None });
    }

    let config_name = options
        .config_path
        .as_deref()
        .and_then(|value| value.rsplit(['/', '\\']).next())
        .filter(|value| !value.is_empty())
        .unwrap_or("config.yaml");
    let payload = serde_json::json!({
        "backend": "celia",
        "config": config_name,
        "open_in_terminal": options.open_in_terminal.unwrap_or(false),
    });
    let mut request = serde_json::Map::new();
    request.insert("event_type".to_string(), Value::String("voice.start".to_string()));
    request.insert("payload".to_string(), payload);
    if let Some(thread_id) = options.thread_id.filter(|value| !value.trim().is_empty()) {
        request.insert("thread_id".to_string(), Value::String(thread_id));
    }
    let response = reqwest::blocking::Client::new()
        .post(format!("{RUNTIME_EXTENSION_URL}/start"))
        .json(&request)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .map_err(|error| format!("Runtime extension start unavailable: {error}"))?;
    let status: RuntimeExtensionStatus = response
        .json()
        .map_err(|error| format!("Runtime extension start response was malformed: {error}"))?;
    if !status.running {
        let message = status.error.unwrap_or_else(|| "Celia extension is unavailable".to_string());
        *state.last_error.lock().map_err(|_| "voice state poisoned".to_string())? = Some(message.clone());
        return Ok(VoiceProcessResult { ok: false, running: false, pid: None, error: Some(message) });
    }
    *state.started_at.lock().map_err(|_| "voice state poisoned".to_string())? = Some(now_millis());
    *state.last_error.lock().map_err(|_| "voice state poisoned".to_string())? = None;
    Ok(VoiceProcessResult { ok: true, running: true, pid: status.pid, error: None })
}

#[tauri::command]
pub fn voice_stop_celia(
    state: tauri::State<'_, VoiceProcessState>,
) -> Result<VoiceProcessResult, String> {
    let response = reqwest::blocking::Client::new()
        .post(format!("{RUNTIME_EXTENSION_URL}/stop"))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .map_err(|error| format!("Runtime extension stop unavailable: {error}"))?;
    let status: RuntimeExtensionStatus = response
        .json()
        .map_err(|error| format!("Runtime extension stop response was malformed: {error}"))?;
    *state.started_at.lock().map_err(|_| "voice state poisoned".to_string())? = None;
    Ok(VoiceProcessResult { ok: status.error.is_none(), running: status.running, pid: status.pid, error: status.error })
}

pub fn stop_process(state: &VoiceProcessState) {
    if let Ok(mut started_at) = state.started_at.lock() { *started_at = None; }
}
