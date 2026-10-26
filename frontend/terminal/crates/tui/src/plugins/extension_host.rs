//! Host boundary for versioned feature-plane extensions.
//!
//! The host owns extension process creation. Extensions receive a small,
//! newline-delimited JSON request over stdin and never receive a registry,
//! ledger, policy engine, or mutable source path. A missing, untrusted, stale,
//! or crashed extension is reported as a host error so the core remains
//! usable.

use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

use super::activation::PluginActivationCapability;
use super::context::PluginDiscoveryContext;
use super::registry::{PluginRegistry, verify_plugin_component_authority};

pub const EXTENSION_PROTOCOL_V1: &str = super::manifest::EXTENSION_PROTOCOL_V1;

/// Reviewed external runtime settings. These names select model/assets or a
/// local service configuration; they never select an executable. Everything
/// else is removed from an extension process environment.
const REVIEWED_RUNTIME_ENV: &[&str] = &[
    "HAKUS_CELIA_ASR_MODEL",
    "HAKUS_CELIA_MODEL_DIR",
    "HAKUS_CELIA_ROOT",
    "HAKUS_AVATAR_ASSET_DIR",
    "HAKUS_AVATAR_ENABLE_LIVE_SERVER",
    "HAKUS_AVATAR_HTTP_HOST",
    "HAKUS_AVATAR_HTTP_PORT",
    "HAKUS_AVATAR_LIVE_SERVER_CONFIG",
    "HAKUS_AVATAR_LIVE_SERVER_DIR",
    "HAKUS_AVATAR_LIVE_SERVER_HOST",
    "HAKUS_AVATAR_LIVE_SERVER_PORT",
];

/// Wire message sent to one extension invocation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExtensionRequest {
    pub protocol: String,
    pub request_id: String,
    pub extension_id: String,
    pub event_type: String,
    pub payload: Value,
}

impl ExtensionRequest {
    pub fn validate(&self) -> Result<(), ExtensionHostError> {
        validate_message_identity(
            &self.protocol,
            &self.request_id,
            &self.extension_id,
            &self.event_type,
        )
    }
}

/// Response shape reserved by the same protocol. A host adapter may parse it
/// without giving the extension any access to core state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExtensionResponse {
    pub protocol: String,
    pub request_id: String,
    pub extension_id: String,
    pub event_type: String,
    pub ok: bool,
    pub payload: Value,
}

impl ExtensionResponse {
    pub fn validate(&self) -> Result<(), ExtensionHostError> {
        validate_message_identity(
            &self.protocol,
            &self.request_id,
            &self.extension_id,
            &self.event_type,
        )
    }
}

/// The only extension information that may cross into the Runtime ledger.
/// Payloads are redacted again at this boundary because responses are
/// untrusted input even when the extension itself was reviewed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionEventPayload {
    pub extension_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub state: ExtensionHostState,
    pub payload: Value,
}

impl ExtensionEventPayload {
    pub fn new(
        extension_id: impl Into<String>,
        event_type: impl Into<String>,
        state: ExtensionHostState,
        payload: Value,
    ) -> Self {
        Self {
            extension_id: extension_id.into(),
            event_type: event_type.into(),
            state,
            payload: redact_payload(payload),
        }
    }

    pub fn from_error(
        extension_id: impl Into<String>,
        event_type: impl Into<String>,
        error: &ExtensionHostError,
    ) -> Self {
        Self::new(
            extension_id,
            event_type,
            error.state.clone(),
            serde_json::json!({"message": error.message}),
        )
    }

    pub fn from_response(response: &ExtensionResponse) -> Self {
        Self::new(
            response.extension_id.clone(),
            response.event_type.clone(),
            if response.ok {
                ExtensionHostState::Started
            } else {
                ExtensionHostState::Crashed
            },
            response.payload.clone(),
        )
    }
}

/// Public host state. The messages intentionally contain no filesystem path,
/// command line, credential, or child process detail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionHostState {
    Started,
    Unavailable,
    Rejected,
    Crashed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionHostError {
    pub state: ExtensionHostState,
    pub message: String,
}

impl ExtensionHostError {
    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            state: ExtensionHostState::Unavailable,
            message: message.into(),
        }
    }

    fn rejected(message: impl Into<String>) -> Self {
        Self {
            state: ExtensionHostState::Rejected,
            message: message.into(),
        }
    }

    fn crashed(message: impl Into<String>) -> Self {
        Self {
            state: ExtensionHostState::Crashed,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ExtensionHostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ExtensionHostError {}

/// Child process owned by the caller's lifecycle state. The host never gives
/// callers the resolved command or staged path.
pub struct ExtensionChild {
    pub(crate) child: Child,
    pub(crate) extension_id: String,
    pub(crate) request_id: String,
    stdout: Option<BufReader<ChildStdout>>,
}

impl ExtensionChild {
    #[must_use]
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }

    pub fn kill(&mut self) -> std::io::Result<()> {
        self.child.kill()
    }

    pub fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.wait()
    }

    /// Read and validate one newline-delimited response. Long-running
    /// extensions may leave this unread; callers that need a one-shot result
    /// can consume it explicitly without exposing the child command or path.
    pub fn read_response(&mut self) -> Result<ExtensionResponse, ExtensionHostError> {
        let Some(stdout) = self.stdout.as_mut() else {
            return Err(ExtensionHostError::crashed(
                "Extension response channel is unavailable",
            ));
        };
        let mut line = String::new();
        stdout
            .read_line(&mut line)
            .map_err(|_| ExtensionHostError::crashed("Extension response could not be read"))?;
        if line.trim().is_empty() {
            let status = self
                .child
                .try_wait()
                .map_err(|_| ExtensionHostError::crashed("Extension process status was unavailable"))?;
            return Err(if status.is_some() {
                ExtensionHostError::crashed("Extension process exited without a response")
            } else {
                ExtensionHostError::crashed("Extension response was empty")
            });
        }
        parse_response_line(line.trim(), &self.request_id, &self.extension_id)
    }

    /// Drain any remaining response bytes before waiting for a one-shot child.
    /// This is useful for tests and adapters that expect the process to exit.
    pub fn wait_for_response(
        &mut self,
    ) -> Result<ExtensionResponse, ExtensionHostError> {
        let response = self.read_response()?;
        self.child
            .wait()
            .map_err(|_| ExtensionHostError::crashed("Extension process did not settle"))?;
        Ok(response)
    }
}

impl std::fmt::Debug for ExtensionChild {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExtensionChild")
            .field("extension_id", &self.extension_id)
            .field("request_id", &self.request_id)
            .field("pid", &self.child.id())
            .finish()
    }
}

/// Start a reviewed extension from the immutable plugin snapshot.
///
/// `extension_selector` is a plugin id or name. The selector is not a path and
/// is resolved only through the registry captured before dotenv loading.
pub fn spawn_extension(
    workspace: &Path,
    extension_selector: &str,
    event_type: &str,
    payload: Value,
) -> Result<ExtensionChild, ExtensionHostError> {
    let context = PluginDiscoveryContext::capture_pre_dotenv();
    let registry = context.registry_for_workspace(workspace);
    spawn_extension_with_registry(
        workspace,
        registry.as_ref(),
        extension_selector,
        event_type,
        payload,
    )
}

/// Start an extension from the Runtime's reviewed registry snapshot. Runtime
/// callers must use this path so embedded servers and tests share the same
/// pre-dotenv discovery context as the rest of the Runtime.
pub(crate) fn spawn_extension_with_registry(
    _workspace: &Path,
    registry: &PluginRegistry,
    extension_selector: &str,
    event_type: &str,
    payload: Value,
) -> Result<ExtensionChild, ExtensionHostError> {
    let host_environment = registry
        .host_environment()
        .ok_or_else(|| ExtensionHostError::unavailable("Extension environment is unavailable"))?;
    let Some(plugin) = registry.get(extension_selector) else {
        return Err(ExtensionHostError::unavailable("Requested extension is unavailable"));
    };
    let Some(extension) = plugin.manifest.extension.as_ref() else {
        return Err(ExtensionHostError::unavailable("Requested extension is unavailable"));
    };
    if extension.id != extension_selector && plugin.id.as_str() != extension_selector {
        return Err(ExtensionHostError::rejected(
            "Extension identity does not match its reviewed plugin",
        ));
    }
    if extension.protocol != EXTENSION_PROTOCOL_V1 {
        return Err(ExtensionHostError::rejected("Extension protocol is unsupported"));
    }
    if !plugin.active() {
        return Err(ExtensionHostError::unavailable(format!(
            "Extension `{}` is not enabled or trusted",
            extension.id
        )));
    }
    let Some(authority) = registry.authority_for(plugin.id.as_str()) else {
        return Err(ExtensionHostError::rejected(
            "Extension authority is unavailable",
        ));
    };
    verify_plugin_component_authority(&authority, PluginActivationCapability::Extension)
        .map_err(|_| ExtensionHostError::rejected("Extension authority was denied"))?;
    let Some(staged_root) = plugin.staged_root.as_deref() else {
        return Err(ExtensionHostError::unavailable(
            "Extension runtime snapshot is unavailable",
        ));
    };

    let argv = shell_words::split(&extension.entrypoint)
        .map_err(|_| ExtensionHostError::rejected("Extension entrypoint is malformed"))?;
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| ExtensionHostError::rejected("Extension entrypoint is empty"))?;
    let program = resolve_program(
        staged_root,
        program,
        host_environment.get_os(OsStr::new("PATH")),
    )?;
    let request_id = Uuid::new_v4().simple().to_string();
    let request = ExtensionRequest {
        protocol: EXTENSION_PROTOCOL_V1.to_string(),
        request_id: request_id.clone(),
        extension_id: extension.id.clone(),
        event_type: validate_event_type(event_type)?,
        payload: redact_payload(payload),
    };
    request.validate()?;
    let encoded = serde_json::to_vec(&request)
        .map_err(|_| ExtensionHostError::rejected("Extension request could not be encoded"))?;

    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(staged_root)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(path) = host_environment.get_os(OsStr::new("PATH")) {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    if let Some(system_root) = host_environment.get_os(OsStr::new("SystemRoot")) {
        command.env("SystemRoot", system_root);
    }
    for name in REVIEWED_RUNTIME_ENV {
        if let Some(value) = host_environment.get_os(OsStr::new(name)) {
            command.env(name, value);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| ExtensionHostError::unavailable("Extension process could not be started"))?;
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(ExtensionHostError::crashed(
            "Extension process did not provide a request channel",
        ));
    };
    if stdin.write_all(&encoded).is_err() || stdin.write_all(b"\n").is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return Err(ExtensionHostError::crashed(
            "Extension process closed its request channel",
        ));
    }
    drop(stdin);
    if child
        .try_wait()
        .map_err(|_| ExtensionHostError::crashed("Extension process status was unavailable"))?
        .is_some()
    {
        return Err(ExtensionHostError::crashed(
            "Extension process exited before activation",
        ));
    }
    let stdout = child
        .stdout
        .take()
        .map(BufReader::new)
        .ok_or_else(|| ExtensionHostError::crashed("Extension did not provide a response channel"))?;
    Ok(ExtensionChild {
        child,
        extension_id: extension.id.clone(),
        request_id,
        stdout: Some(stdout),
    })
}

fn validate_event_type(event_type: &str) -> Result<String, ExtensionHostError> {
    let valid = !event_type.is_empty()
        && event_type.len() <= 128
        && event_type
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    valid
        .then(|| event_type.to_string())
        .ok_or_else(|| ExtensionHostError::rejected("Extension event type is invalid"))
}

fn parse_response_line(
    line: &str,
    request_id: &str,
    extension_id: &str,
) -> Result<ExtensionResponse, ExtensionHostError> {
    let response: ExtensionResponse = serde_json::from_str(line)
        .map_err(|_| ExtensionHostError::rejected("Extension response is malformed"))?;
    response.validate()?;
    if response.request_id != request_id || response.extension_id != extension_id {
        return Err(ExtensionHostError::rejected(
            "Extension response identity does not match the request",
        ));
    }
    Ok(ExtensionResponse {
        payload: redact_payload(response.payload),
        ..response
    })
}

fn validate_message_identity(
    protocol: &str,
    request_id: &str,
    extension_id: &str,
    event_type: &str,
) -> Result<(), ExtensionHostError> {
    if protocol != EXTENSION_PROTOCOL_V1 {
        return Err(ExtensionHostError::rejected("Extension protocol is unsupported"));
    }
    if request_id.is_empty() || request_id.len() > 128 {
        return Err(ExtensionHostError::rejected("Extension request id is invalid"));
    }
    if extension_id.is_empty() || extension_id.len() > 128 {
        return Err(ExtensionHostError::rejected("Extension id is invalid"));
    }
    validate_event_type(event_type).map(|_| ())
}

fn resolve_program(
    staged_root: &Path,
    token: &str,
    path_value: Option<&OsStr>,
) -> Result<PathBuf, ExtensionHostError> {
    let token_path = Path::new(token);
    if token_path.is_absolute() {
        return Err(ExtensionHostError::rejected(
            "Extension executable must be a reviewed snapshot path",
        ));
    }
    if token_path.components().count() > 1 {
        let candidate = staged_root.join(token_path);
        let canonical_root = staged_root
            .canonicalize()
            .map_err(|_| ExtensionHostError::unavailable("Extension runtime snapshot is unavailable"))?;
        let canonical = candidate
            .canonicalize()
            .map_err(|_| ExtensionHostError::unavailable("Extension executable is unavailable"))?;
        if !canonical.starts_with(&canonical_root) || !canonical.is_file() {
            return Err(ExtensionHostError::rejected(
                "Extension executable is outside its reviewed snapshot",
            ));
        }
        return Ok(canonical);
    }
    // Python is the only external launcher currently admitted by the voice
    // migration. Other extension types must ship a contained executable.
    if matches!(token.to_ascii_lowercase().as_str(), "python" | "python3" | "py" | "python.exe" | "python3.exe" | "py.exe") {
        let Some(path_value) = path_value else {
            return Err(ExtensionHostError::unavailable("Extension launcher is unavailable"));
        };
        for directory in std::env::split_paths(path_value) {
            let candidate = directory.join(token);
            if candidate.is_file() {
                return candidate
                    .canonicalize()
                    .map_err(|_| ExtensionHostError::unavailable("Extension launcher is unavailable"));
            }
            #[cfg(windows)]
            if Path::new(token).extension().is_none() {
                for suffix in ["exe", "cmd", "bat"] {
                    let candidate = directory.join(format!("{token}.{suffix}"));
                    if candidate.is_file() {
                        return candidate.canonicalize().map_err(|_| {
                            ExtensionHostError::unavailable("Extension launcher is unavailable")
                        });
                    }
                }
            }
        }
        return Err(ExtensionHostError::unavailable("Extension launcher is unavailable"));
    }
    Err(ExtensionHostError::rejected(
        "Extension executable must be a reviewed snapshot path",
    ))
}

/// Redact credential-shaped keys and local path values before they cross the
/// extension protocol boundary. The original value is never logged or sent.
pub fn redact_payload(value: Value) -> Value {
    match value {
        Value::Object(entries) => {
            let mut redacted = Map::new();
            for (key, value) in entries {
                let sensitive = key.to_ascii_lowercase();
                if sensitive.contains("token")
                    || sensitive.contains("secret")
                    || sensitive.contains("password")
                    || sensitive.contains("credential")
                    || sensitive.contains("api_key")
                {
                    redacted.insert(key, Value::String("<redacted>".to_string()));
                } else {
                    redacted.insert(key, redact_payload(value));
                }
            }
            Value::Object(redacted)
        }
        Value::Array(values) => Value::Array(values.into_iter().map(redact_payload).collect()),
        Value::String(text) if looks_like_local_path(&text) => {
            Value::String("<redacted-path>".to_string())
        }
        other => other,
    }
}

fn looks_like_local_path(value: &str) -> bool {
    value.contains('\\') || value.contains('/') || value.starts_with("~")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_round_trip_preserves_request_identity() {
        let request = ExtensionRequest {
            protocol: EXTENSION_PROTOCOL_V1.to_string(),
            request_id: "request-1".to_string(),
            extension_id: "voice.celia".to_string(),
            event_type: "voice.start".to_string(),
            payload: serde_json::json!({"config": "config.yaml"}),
        };
        let encoded = serde_json::to_vec(&request).unwrap();
        let decoded: ExtensionRequest = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, request);
    }

    #[test]
    fn malformed_event_type_is_rejected() {
        let error = validate_event_type("voice/start").unwrap_err();
        assert_eq!(error.state, ExtensionHostState::Rejected);
    }

    #[test]
    fn malformed_protocol_is_rejected_before_dispatch() {
        let request = ExtensionRequest {
            protocol: "hakus.extension.v0".to_string(),
            request_id: "request-1".to_string(),
            extension_id: "voice.celia".to_string(),
            event_type: "voice.start".to_string(),
            payload: Value::Null,
        };
        assert_eq!(request.validate().unwrap_err().state, ExtensionHostState::Rejected);
    }

    #[test]
    fn redaction_removes_credentials_and_paths() {
        let value = redact_payload(serde_json::json!({
            "token": "secret-value",
            "config": "C:\\Users\\operator\\celia.yaml",
            "nested": [{"password": "pw"}],
        }));
        assert_eq!(value["token"], "<redacted>");
        assert_eq!(value["config"], "<redacted-path>");
        assert_eq!(value["nested"][0]["password"], "<redacted>");
    }

    #[test]
    fn response_parser_rejects_identity_mismatch_and_redacts_payload() {
        let response = serde_json::json!({
            "protocol": EXTENSION_PROTOCOL_V1,
            "request_id": "other-request",
            "extension_id": "voice.celia",
            "event_type": "voice.start",
            "ok": true,
            "payload": {"token": "never-store"}
        });
        let error = parse_response_line(
            &response.to_string(),
            "request-1",
            "voice.celia",
        )
        .unwrap_err();
        assert_eq!(error.state, ExtensionHostState::Rejected);

        let response = serde_json::json!({
            "protocol": EXTENSION_PROTOCOL_V1,
            "request_id": "request-1",
            "extension_id": "voice.celia",
            "event_type": "voice.start",
            "ok": true,
            "payload": {"token": "never-store", "status": "ready"}
        });
        let parsed = parse_response_line(&response.to_string(), "request-1", "voice.celia")
            .expect("valid extension response");
        assert_eq!(parsed.payload["token"], "<redacted>");
        assert_eq!(parsed.payload["status"], "ready");
    }

    #[test]
    fn extension_event_payload_is_safe_for_ledger() {
        let event = ExtensionEventPayload::new(
            "voice.celia",
            "voice.start",
            ExtensionHostState::Crashed,
            serde_json::json!({
                "config_path": "C:\\Users\\operator\\celia.yaml",
                "password": "secret",
            }),
        );
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["payload"]["config_path"], "<redacted-path>");
        assert_eq!(value["payload"]["password"], "<redacted>");
    }
}
