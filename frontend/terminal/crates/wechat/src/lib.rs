//! Native Rust implementation of the WeChat ClawBot **iLink** protocol.
//!
//! This crate provides a zero-dependency-on-SDK HTTP client that speaks
//! directly to the four iLink endpoints used by the `wechat-clawbot-sdk`:
//!
//! 1. `GET  /ilink/bot/get_bot_qrcode`   — obtain QR code for login
//! 2. `GET  /ilink/bot/get_qrcode_status` — long-poll QR scan status
//! 3. `POST /ilink/bot/getupdates`        — long-poll inbound messages
//! 4. `POST /ilink/bot/sendmessage`      — send text to a user
//! 5. `POST /ilink/bot/sendtyping`       — typing indicator
//! 6. `GET  /ilink/bot/getconfig`        — bot configuration
//!
//! # State persistence
//!
//! Account credentials (`account_id`, `bot_token`, `base_url`, `route_tag`)
//! are persisted to `$HAKUS_HOME/wechat.json`.  Per-user `context_token`
//! entries are appended to `$HAKUS_HOME/wechat-state.jsonl`.

pub mod client;
pub mod login;
pub mod messaging;
pub mod models;
pub mod state;

pub use client::IlLinkClient;
pub use login::LoginHandle;
pub use models::*;
pub use state::{WechatSettings, WechatState, WechatUserSettings};

/// iLink protocol base URL.
pub const ILINK_BASE: &str = "https://ilinkai.weixin.qq.com";

/// Current iLink app client version encoded as `u32`:
/// `major << 16 | minor << 8 | patch`.
/// Matches the SDK's default `2.1.1`.
pub const ILINK_CLIENT_VERSION: u32 = (2u32 << 16) | (1u32 << 8) | 1u32;

/// `channel_version` carried inside message `base_info`.
pub const CHANNEL_VERSION: &str = "2.1.1";

/// Maximum WeChat single-message text length.
pub const MAX_MSG_LENGTH: usize = 2000;

/// Default long-poll timeout (seconds) for `getupdates`.
pub const POLL_TIMEOUT_SECS: u64 = 30;

/// Default QR status poll interval (seconds).
pub const QR_POLL_INTERVAL_SECS: u64 = 3;

/// Default QR expiry check interval (seconds).
pub const QR_EXPIRY_CHECK_SECS: u64 = 5;

/// User-Agent header required by iLink.
pub const USER_AGENT: &str = "node";

/// iLink-App-Id header value.
pub const ILINK_APP_ID: &str = "bot";

/// AuthorizationType header value after login.
pub const AUTH_TYPE: &str = "ilink_bot_token";
