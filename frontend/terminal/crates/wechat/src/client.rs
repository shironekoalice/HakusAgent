//! Low-level iLink HTTP client.

use crate::models::*;
use crate::state::{AccountState, WechatState};
use crate::{
    AUTH_TYPE, ILINK_APP_ID, ILINK_BASE, ILINK_CLIENT_VERSION, MAX_MSG_LENGTH, POLL_TIMEOUT_SECS,
    QR_EXPIRY_CHECK_SECS, USER_AGENT,
};
use base64::Engine;
use reqwest::header::{
    AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue, USER_AGENT as UA_HEADER,
};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

/// A full-featured iLink client with built-in state persistence.
#[derive(Debug, Clone)]
pub struct IlLinkClient {
    http: reqwest::Client,
    state: Arc<WechatState>,
    /// Memoized account credentials (read from disk or set after login).
    account: Arc<RwLock<Option<AccountState>>>,
    /// Memoized per-user context tokens (for getupdates pagination).
    user_contexts: Arc<RwLock<HashMap<String, String>>>,
    /// Opaque pagination cursor for the account-wide update stream.
    updates_buf: Arc<RwLock<String>>,
}

impl IlLinkClient {
    /// Create a new client with a given state directory.
    /// The HTTP client uses rustls (no native TLS dependency).
    pub fn new(state_dir: std::path::PathBuf) -> Self {
        // Install ring crypto provider for rustls.
        let _ = rustls::crypto::ring::default_provider().install_default();

        let http = http_client_builder()
            .timeout(Duration::from_secs(POLL_TIMEOUT_SECS + 10))
            .build()
            .expect("failed to build reqwest client");

        let state = WechatState::new(state_dir);
        let account = Arc::new(RwLock::new(state.load_account().ok().flatten()));
        let user_contexts = Arc::new(RwLock::new(state.load_user_contexts().unwrap_or_default()));
        let updates_buf = Arc::new(RwLock::new(state.load_updates_buf().unwrap_or_default()));

        Self {
            http,
            state: Arc::new(state),
            account,
            user_contexts,
            updates_buf,
        }
    }

    /// Create a client using the default state directory.
    pub fn with_default_state() -> Self {
        Self::new(WechatState::default_dir())
    }

    /// Borrow a shared reference to the state manager.
    pub fn state(&self) -> &WechatState {
        &self.state
    }

    // -- Auth helpers --------------------------------------------------------

    /// Returns `true` if we have persisted credentials.
    pub async fn is_logged_in(&self) -> bool {
        let acc = self.account.read().await;
        acc.as_ref().is_some_and(|a| !a.is_empty())
    }

    /// Read-only snapshot of the current account state.
    pub async fn account_snapshot(&self) -> Option<AccountState> {
        self.account.read().await.clone()
    }

    /// The base URL to use for API calls. After login this may differ
    /// from `ILINK_BASE` if the server returned a `redirect_host`.
    async fn base_url(&self) -> String {
        self.account
            .read()
            .await
            .as_ref()
            .map(|a| a.base_url.clone())
            .unwrap_or_else(|| ILINK_BASE.into())
    }

    /// Build the common header set for authenticated requests.
    async fn auth_headers(&self) -> Result<HeaderMap> {
        let acc = self.account.read().await;
        let acc = acc.as_ref().ok_or(WechatError::NotLoggedIn)?;

        let mut headers = HeaderMap::new();
        headers.insert(UA_HEADER, HeaderValue::from_static(USER_AGENT));
        headers.insert("iLink-App-Id", HeaderValue::from_static(ILINK_APP_ID));
        headers.insert(
            "iLink-App-ClientVersion",
            HeaderValue::from_str(&ILINK_CLIENT_VERSION.to_string())
                .map_err(|e| WechatError::Other(e.to_string()))?,
        );
        headers.insert("AuthorizationType", HeaderValue::from_static(AUTH_TYPE));
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", acc.bot_token))
                .map_err(|e| WechatError::Other(e.to_string()))?,
        );
        // Random X-WECHAT-UIN: base64(random u32).
        let uin_bytes = rand::random::<u32>().to_le_bytes();
        let uin_b64 = base64::engine::general_purpose::STANDARD.encode(uin_bytes);
        headers.insert(
            "X-WECHAT-UIN",
            HeaderValue::from_str(&uin_b64).map_err(|e| WechatError::Other(e.to_string()))?,
        );
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        Ok(headers)
    }

    /// Build headers for unauthenticated QR requests (no auth).
    fn qr_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(UA_HEADER, HeaderValue::from_static(USER_AGENT));
        headers.insert("iLink-App-Id", HeaderValue::from_static(ILINK_APP_ID));
        headers.insert(
            "iLink-App-ClientVersion",
            HeaderValue::from_str(&ILINK_CLIENT_VERSION.to_string())
                .unwrap_or_else(|_| HeaderValue::from_static("0")),
        );
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers
    }

    // -- QR code -------------------------------------------------------------

    /// `GET /ilink/bot/get_bot_qrcode?bot_type=3`
    pub async fn get_qrcode(&self) -> Result<QrCodeResponse> {
        let url = format!("{ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3");
        let resp = self
            .http
            .get(&url)
            .headers(Self::qr_headers())
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(WechatError::Protocol { status, body });
        }
        let data: QrCodeResponse = resp.json().await?;
        tracing::info!(qrcode = %data.qrcode, "WeChat: QR code obtained");
        Ok(data)
    }

    /// `GET /ilink/bot/get_qrcode_status?qrcode=<token>`
    /// Performs a single (non-polling) status check.
    pub async fn get_qrcode_status(&self, qrcode_token: &str) -> Result<QrStatusResponse> {
        let url = format!("{ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode={qrcode_token}");
        let resp = self
            .http
            .get(&url)
            .headers(Self::qr_headers())
            .timeout(Duration::from_secs(QR_EXPIRY_CHECK_SECS + 5))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(WechatError::Protocol { status, body });
        }
        Ok(resp.json().await?)
    }

    // -- Message polling -----------------------------------------------------

    /// `POST /ilink/bot/getupdates` — long-poll for new messages.
    /// Returns the list of new messages and an updated context token.
    pub async fn get_updates(&self) -> Result<GetUpdatesResponse> {
        let base = self.base_url().await;
        let url = format!("{base}/ilink/bot/getupdates");
        let headers = self.auth_headers().await?;

        let cursor = self.updates_buf.read().await.clone();
        let body = GetUpdatesRequest {
            get_updates_buf: cursor,
            base_info: Default::default(),
        };
        // ensure_ascii=false is the serde default; compact formatting.
        let body_json = serde_json::to_string(&body)?;

        tracing::debug!("WeChat: polling getupdates...");
        let resp = self
            .http
            .post(&url)
            .headers(headers)
            .body(body_json)
            .timeout(Duration::from_secs(POLL_TIMEOUT_SECS + 10))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(WechatError::Protocol { status, body });
        }

        let result: GetUpdatesResponse = resp.json().await?;

        if let Some(next) = result
            .get_updates_buf
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            *self.updates_buf.write().await = next.to_string();
            if let Err(error) = self.state.save_updates_buf(next) {
                tracing::warn!("WeChat: failed to persist update cursor: {error}");
            }
        }

        for message in &result.msgs {
            if let (Some(user), Some(token)) =
                (message.sender_id(), message.context_token.as_deref())
                && !token.is_empty()
            {
                self.user_contexts
                    .write()
                    .await
                    .insert(user.to_string(), token.to_string());
                if let Err(error) = self.state.save_user_context(user, token) {
                    tracing::warn!("WeChat: failed to persist context_token: {error}");
                }
            }
        }

        tracing::debug!(count = result.msgs.len(), "WeChat: received messages");
        Ok(result)
    }

    /// Convenience: poll once and extract text messages with sender info.
    pub async fn poll_text_messages(&self) -> Result<Vec<(String, String, String)>> {
        let resp = self.get_updates().await?;
        let mut out = Vec::new();
        for msg in &resp.msgs {
            if !msg.item_list.is_empty() {
                let user = msg.sender_id().unwrap_or_default().to_string();
                let text = msg.text();
                let id = msg.stable_id();
                out.push((user, text, id));
            }
        }
        Ok(out)
    }

    // -- Send messages -------------------------------------------------------

    /// Send a text message.  Long texts are automatically chunked at
    /// `MAX_MSG_LENGTH` characters.
    pub async fn send_text(&self, to_user: &str, text: &str) -> Result<()> {
        let base = self.base_url().await;
        let headers = self.auth_headers().await?;
        let context_token = self
            .user_contexts
            .read()
            .await
            .get(to_user)
            .cloned()
            .unwrap_or_default();
        if context_token.is_empty() {
            return Err(WechatError::Other(format!(
                "no context token for {to_user}; run /wechat poll after receiving a message first"
            )));
        }
        let account_id = self
            .account
            .read()
            .await
            .as_ref()
            .map(|account| account.account_id.clone())
            .unwrap_or_default();

        let chunks = split_text(text, MAX_MSG_LENGTH);
        if chunks.len() == 1 {
            let req = SendMessageRequest::new(&account_id, to_user, &chunks[0], &context_token);
            let body = serde_json::to_string(&req)?;
            self.post_json(&format!("{base}/ilink/bot/sendmessage"), &headers, &body)
                .await?;
        } else {
            for (i, chunk) in chunks.iter().enumerate() {
                let req = SendMessageRequest::new(&account_id, to_user, chunk, &context_token);
                let body = serde_json::to_string(&req)?;
                self.post_json(&format!("{base}/ilink/bot/sendmessage"), &headers, &body)
                    .await?;
                // Brief pause between chunks to avoid rate-limiting.
                if i + 1 < chunks.len() {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
        tracing::info!(to = %to_user, len = text.len(), "WeChat: message sent");
        Ok(())
    }

    /// Send a typing indicator.
    pub async fn send_typing(&self, to_user: &str, typing: bool) -> Result<()> {
        let base = self.base_url().await;
        let headers = self.auth_headers().await?;
        let req = SendTypingRequest::new(to_user, typing);
        let body = serde_json::to_string(&req)?;
        self.post_json(&format!("{base}/ilink/bot/sendtyping"), &headers, &body)
            .await
    }

    /// `GET /ilink/bot/getconfig` — retrieve bot configuration.
    pub async fn get_config(&self) -> Result<BotConfigResponse> {
        let base = self.base_url().await;
        let headers = self.auth_headers().await?;
        let url = format!("{base}/ilink/bot/getconfig");
        let resp = self.http.get(&url).headers(headers).send().await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(WechatError::Protocol { status, body });
        }
        Ok(resp.json().await?)
    }

    // -- Login / logout ------------------------------------------------------

    /// Save credentials after a successful QR login.
    pub async fn save_login(
        &self,
        account_id: String,
        bot_token: String,
        base_url: String,
        route_tag: Option<String>,
    ) -> Result<()> {
        let state = AccountState {
            account_id,
            bot_token,
            base_url,
            route_tag,
        };
        self.state.save_account(&state)?;
        *self.account.write().await = Some(state);
        Ok(())
    }

    /// Update the base URL (e.g. after a `scaned_but_redirect` response).
    pub async fn set_base_url(&self, new_url: String) {
        let mut acc = self.account.write().await;
        if let Some(ref mut a) = *acc {
            a.base_url = new_url;
        }
    }

    /// Logout: clear credentials from memory and disk.
    pub async fn logout(&self) -> Result<()> {
        self.state.clear_account()?;
        self.state.clear_contexts()?;
        *self.account.write().await = None;
        self.user_contexts.write().await.clear();
        *self.updates_buf.write().await = String::new();
        tracing::info!("WeChat: logged out");
        Ok(())
    }

    // -- Internal ------------------------------------------------------------

    async fn post_json(&self, url: &str, headers: &HeaderMap, body: &str) -> Result<()> {
        let resp = self
            .http
            .post(url)
            .headers(headers.clone())
            .body(body.to_owned())
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let resp_body = resp.text().await.unwrap_or_default();
            return Err(WechatError::Protocol {
                status,
                body: resp_body,
            });
        }
        Ok(())
    }
}

fn split_text(text: &str, max_chars: usize) -> Vec<String> {
    if max_chars == 0 {
        return vec![text.to_string()];
    }
    let chars = text.chars().collect::<Vec<_>>();
    if chars.is_empty() {
        return vec![String::new()];
    }
    chars
        .chunks(max_chars)
        .map(|chunk| chunk.iter().collect())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::split_text;

    #[test]
    fn message_chunks_preserve_utf8_and_character_limit() {
        let chunks = split_text("你好abc世界🙂", 3);
        assert_eq!(chunks, ["你好a", "bc世", "界🙂"]);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 3));
        assert_eq!(chunks.concat(), "你好abc世界🙂");
    }
}

fn http_client_builder() -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder();

    #[cfg(target_os = "android")]
    {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        return builder.tls_backend_preconfigured(
            rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );
    }

    #[cfg(not(target_os = "android"))]
    {
        builder
    }
}
