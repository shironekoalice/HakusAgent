//! Persistent state for WeChat account credentials and per-user context tokens.
//!
//! ## Account state (`wechat.json`)
//!
//! ```json
//! { "account_id": "...", "bot_token": "...", "base_url": "...", "route_tag": "..." }
//! ```
//!
//! ## Per-user state (`wechat-state.jsonl`)
//!
//! One JSON-object per line:
//! ```json
//! {"user_id":"...","context_token":"...","updated_at":1700000000}
//! ```

use crate::models::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Account-level credentials persisted to `wechat.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountState {
    pub account_id: String,
    pub bot_token: String,
    pub base_url: String,
    /// Optional routing tag returned by the server at login time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_tag: Option<String>,
}

impl AccountState {
    pub fn is_empty(&self) -> bool {
        self.account_id.is_empty() || self.bot_token.is_empty()
    }
}

/// One per-user context_token entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserContextEntry {
    pub user_id: String,
    pub context_token: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WechatUserSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verbosity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WechatSettings {
    #[serde(default)]
    pub auto_reply: bool,
    #[serde(default)]
    pub users: HashMap<String, WechatUserSettings>,
}

/// Top-level state manager.
#[derive(Debug)]
pub struct WechatState {
    state_dir: PathBuf,
}

impl WechatState {
    /// Create a new state manager rooted at `state_dir`.
    /// The directory is created if it does not exist.
    pub fn new(state_dir: PathBuf) -> Self {
        Self { state_dir }
    }

    /// Default state dir: explicit `HAKUS_HOME`, portable `./.hakus`, or the
    /// installed per-user root when `HAKUS_INSTALL_MODE=installed`.
    pub fn default_dir() -> PathBuf {
        hakus_paths::hakus_home()
            .ok()
            .flatten()
            .unwrap_or_else(|| PathBuf::from(".hakus"))
    }

    // -- Account state -------------------------------------------------------

    fn account_path(&self) -> PathBuf {
        self.state_dir.join("wechat.json")
    }

    /// Load persisted account state. Returns `Ok(None)` if the file
    /// does not exist or is empty/unparseable.
    pub fn load_account(&self) -> Result<Option<AccountState>> {
        let path = self.account_path();
        if !path.exists() {
            return Ok(None);
        }
        let data = std::fs::read_to_string(&path)?;
        let state: AccountState = serde_json::from_str(&data)?;
        if state.is_empty() {
            return Ok(None);
        }
        Ok(Some(state))
    }

    /// Persist account state to disk.
    pub fn save_account(&self, state: &AccountState) -> Result<()> {
        self.ensure_dir()?;
        let data = serde_json::to_string_pretty(state)?;
        std::fs::write(self.account_path(), data)?;
        tracing::info!(
            account_id = %state.account_id,
            "WeChat: account state saved"
        );
        Ok(())
    }

    /// Remove persisted account state (logout).
    pub fn clear_account(&self) -> Result<()> {
        let path = self.account_path();
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        Ok(())
    }

    // -- Per-user context tokens --------------------------------------------

    fn user_state_path(&self) -> PathBuf {
        self.state_dir.join("wechat-state.jsonl")
    }

    fn updates_buf_path(&self) -> PathBuf {
        self.state_dir.join("wechat-updates-buf.txt")
    }

    fn settings_path(&self) -> PathBuf {
        self.state_dir.join("wechat-settings.json")
    }

    pub fn load_settings(&self) -> Result<WechatSettings> {
        let path = self.settings_path();
        if !path.exists() {
            return Ok(WechatSettings::default());
        }
        let data = std::fs::read_to_string(path)?;
        Ok(serde_json::from_str(&data)?)
    }

    pub fn save_settings(&self, settings: &WechatSettings) -> Result<()> {
        self.ensure_dir()?;
        let data = serde_json::to_string_pretty(settings)?;
        std::fs::write(self.settings_path(), data)?;
        Ok(())
    }

    /// Load the opaque iLink pagination cursor.
    pub fn load_updates_buf(&self) -> Result<String> {
        let path = self.updates_buf_path();
        if !path.exists() {
            return Ok(String::new());
        }
        Ok(std::fs::read_to_string(path)?.trim().to_string())
    }

    /// Persist the opaque iLink pagination cursor.
    pub fn save_updates_buf(&self, value: &str) -> Result<()> {
        self.ensure_dir()?;
        std::fs::write(self.updates_buf_path(), value)?;
        Ok(())
    }

    /// Remove pagination and per-user conversation state on logout.
    pub fn clear_contexts(&self) -> Result<()> {
        for path in [self.user_state_path(), self.updates_buf_path()] {
            if path.exists() {
                std::fs::remove_file(path)?;
            }
        }
        Ok(())
    }

    /// Load all per-user context tokens into a `HashMap`.
    pub fn load_user_contexts(&self) -> Result<HashMap<String, String>> {
        let path = self.user_state_path();
        if !path.exists() {
            return Ok(HashMap::new());
        }
        let data = std::fs::read_to_string(&path)?;
        let mut map = HashMap::new();
        for line in data.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(entry) = serde_json::from_str::<UserContextEntry>(line) {
                map.insert(entry.user_id, entry.context_token);
            }
        }
        Ok(map)
    }

    /// Update (or insert) the context token for a specific user.
    /// The JSONL file is rewritten on each call (acceptable for the
    /// small expected cardinality — a bot typically talks to < 100 users).
    pub fn save_user_context(&self, user_id: &str, context_token: &str) -> Result<()> {
        self.ensure_dir()?;
        let mut contexts = self.load_user_contexts()?;
        contexts.insert(user_id.into(), context_token.into());

        let now = chrono::Utc::now().timestamp();
        let mut lines = Vec::new();
        for (uid, token) in &contexts {
            let entry = UserContextEntry {
                user_id: uid.clone(),
                context_token: token.clone(),
                updated_at: now,
            };
            lines.push(serde_json::to_string(&entry)?);
        }

        let data = lines.join("\n") + "\n";
        std::fs::write(self.user_state_path(), data)?;
        Ok(())
    }

    /// Remove a user's context token.
    pub fn remove_user_context(&self, user_id: &str) -> Result<()> {
        let mut contexts = self.load_user_contexts()?;
        contexts.remove(user_id);

        let now = chrono::Utc::now().timestamp();
        let mut lines = Vec::new();
        for (uid, token) in &contexts {
            let entry = UserContextEntry {
                user_id: uid.clone(),
                context_token: token.clone(),
                updated_at: now,
            };
            lines.push(serde_json::to_string(&entry)?);
        }

        let data = lines.join("\n");
        if data.is_empty() {
            let path = self.user_state_path();
            if path.exists() {
                std::fs::remove_file(&path)?;
            }
        } else {
            std::fs::write(self.user_state_path(), data + "\n")?;
        }
        Ok(())
    }

    // -- Helpers -------------------------------------------------------------

    fn ensure_dir(&self) -> Result<()> {
        std::fs::create_dir_all(&self.state_dir)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{WechatSettings, WechatState, WechatUserSettings};
    use std::collections::HashMap;
    use std::path::PathBuf;

    #[test]
    fn settings_round_trip_persists_auto_reply_and_user_preferences() {
        let state_dir =
            std::env::temp_dir().join(format!("hakus-wechat-settings-{}", uuid::Uuid::new_v4()));
        let state = WechatState::new(state_dir.clone());
        let mut users = HashMap::new();
        users.insert(
            "wechat-user".to_string(),
            WechatUserSettings {
                model: Some("provider/model".to_string()),
                workspace: Some(PathBuf::from("workspace")),
                ..Default::default()
            },
        );
        state
            .save_settings(&WechatSettings {
                auto_reply: true,
                users,
            })
            .expect("save settings");

        let loaded = state.load_settings().expect("load settings");
        assert!(loaded.auto_reply);
        let user = loaded.users.get("wechat-user").expect("user settings");
        assert_eq!(user.model.as_deref(), Some("provider/model"));
        assert_eq!(
            user.workspace.as_deref(),
            Some(std::path::Path::new("workspace"))
        );

        std::fs::remove_dir_all(state_dir).expect("remove temporary state");
    }
}
