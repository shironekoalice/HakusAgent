//! QR login state machine.

use crate::QR_POLL_INTERVAL_SECS;
use crate::client::IlLinkClient;
use crate::models::{QrLoginStatus, QrStatusResponse, WechatError};
use base64::Engine;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Notify;
use tokio::time::{Duration, sleep};

/// A handle to an in-progress QR login flow.
///
/// The flow runs in the background.  Callers can:
/// 1. Read the initial QR data via [`LoginHandle::qr_data`].
/// 2. Wait for completion via [`LoginHandle::wait`].
/// 3. Cancel via [`LoginHandle::cancel`].
#[derive(Debug)]
pub struct LoginHandle {
    /// The raw `qrcode` token string.
    pub qr_token: String,
    /// Base64-encoded QR image content.
    pub qr_image_b64: String,
    /// Notified when the login completes or is cancelled.
    done: Arc<Notify>,
    /// Shared cancellation flag.
    cancelled: Arc<AtomicBool>,
    /// Final status (set on completion).
    status: Arc<tokio::sync::Mutex<Option<QrLoginStatus>>>,
}

impl LoginHandle {
    /// Block until the login flow finishes, returning the final status.
    /// If cancelled, returns `Err(WechatError::LoginCancelled)`.
    pub async fn wait(&self) -> crate::models::Result<QrLoginStatus> {
        self.done.notified().await;
        let mut guard = self.status.lock().await;
        guard.take().ok_or(WechatError::LoginCancelled)
    }

    /// Cancel the login flow.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        self.done.notify_waiters();
    }

    /// Whether the flow has been cancelled.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// Read the current status (non-blocking).
    pub async fn current_status(&self) -> Option<QrLoginStatus> {
        self.status.lock().await.clone()
    }
}

/// Render `text` as a QR code and return it as base64-encoded PNG.
/// The desktop frontend embeds the result in `data:image/png;base64,`,
/// so the payload must be a real PNG — a base64 of the raw URL text
/// renders as a broken image.
fn encode_qr_png(text: &str) -> Option<String> {
    let code = qrcode::QrCode::new(text.as_bytes()).ok()?;
    let img = code
        .render::<image::Luma<u8>>()
        .min_dimensions(256, 256)
        .build();
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png).ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(buf.into_inner()))
}

/// Start a QR login flow on `client`.
///
/// 1. Calls `get_bot_qrcode` to obtain the QR data.
/// 2. Spawns a background task that polls `get_qrcode_status`
///    until the user scans, confirms, or the QR expires.
/// 3. On confirmation, persists credentials via `client.save_login()`.
/// 4. Returns a [`LoginHandle`] the caller can use to wait or cancel.
pub async fn start_qr_login(client: &IlLinkClient) -> crate::models::Result<LoginHandle> {
    let qr_resp = client.get_qrcode().await?;

    let qr_image_b64 = if !qr_resp.qrcode_img_content.is_empty() {
        qr_resp.qrcode_img_content.clone()
    } else if qr_resp.qrcode.starts_with("http") {
        encode_qr_png(&qr_resp.qrcode).unwrap_or_else(|| {
            // Last resort: base64 of the URL text (not a valid image,
            // but keeps the field non-empty for status reporting).
            base64::engine::general_purpose::STANDARD.encode(qr_resp.qrcode.as_bytes())
        })
    } else {
        qr_resp.qrcode.clone()
    };

    let done = Arc::new(Notify::new());
    let cancelled = Arc::new(AtomicBool::new(false));
    let status: Arc<tokio::sync::Mutex<Option<QrLoginStatus>>> =
        Arc::new(tokio::sync::Mutex::new(None));

    let client_handle = client.clone();
    let qr_token = qr_resp.qrcode.clone();
    let done_clone = done.clone();
    let cancelled_clone = cancelled.clone();
    let status_clone = status.clone();

    // Spawn the background poll loop.
    tokio::spawn(async move {
        loop {
            if cancelled_clone.load(Ordering::Relaxed) {
                return;
            }

            match client_handle.get_qrcode_status(&qr_token).await {
                Ok(resp) => {
                    let parsed = parse_qr_status(resp);
                    match &parsed {
                        QrLoginStatus::Waiting => {
                            // Still waiting for scan.
                        }
                        QrLoginStatus::Scanned => {
                            // Scanned but not confirmed yet.
                            let mut s = status_clone.lock().await;
                            *s = Some(parsed);
                        }
                        QrLoginStatus::Confirmed {
                            account_id,
                            bot_token,
                            base_url,
                            route_tag,
                        } => {
                            // Login success!
                            if let Err(e) = client_handle
                                .save_login(
                                    account_id.clone(),
                                    bot_token.clone(),
                                    base_url.clone(),
                                    route_tag.clone(),
                                )
                                .await
                            {
                                tracing::error!("WeChat: failed to save login: {e}");
                            }
                            let mut s = status_clone.lock().await;
                            *s = Some(parsed);
                            done_clone.notify_waiters();
                            return;
                        }
                        QrLoginStatus::Expired => {
                            let mut s = status_clone.lock().await;
                            *s = Some(QrLoginStatus::Expired);
                            done_clone.notify_waiters();
                            return;
                        }
                        QrLoginStatus::Redirect { redirect_host } => {
                            // Switch to the redirect host and continue polling.
                            let new_url = format!("https://{redirect_host}");
                            client_handle.set_base_url(new_url).await;
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("WeChat: QR status poll error: {e}");
                }
            }

            sleep(Duration::from_secs(QR_POLL_INTERVAL_SECS)).await;
        }
    });

    Ok(LoginHandle {
        qr_token: qr_resp.qrcode,
        qr_image_b64,
        done,
        cancelled,
        status,
    })
}

/// Map the raw `QrStatusResponse` into a typed `QrLoginStatus`.
fn parse_qr_status(resp: QrStatusResponse) -> QrLoginStatus {
    match resp.status.as_str() {
        "wait" => QrLoginStatus::Waiting,
        "scaned" => QrLoginStatus::Scanned,
        "scaned_but_redirect" => QrLoginStatus::Redirect {
            redirect_host: resp.redirect_host.unwrap_or_default(),
        },
        "expired" => QrLoginStatus::Expired,
        "confirmed" => QrLoginStatus::Confirmed {
            account_id: resp.ilink_bot_id.unwrap_or_default(),
            bot_token: resp.bot_token.unwrap_or_default(),
            base_url: resp.baseurl.unwrap_or_else(|| crate::ILINK_BASE.into()),
            route_tag: resp.route_tag,
        },
        other => {
            tracing::warn!("WeChat: unknown QR status: {other}");
            QrLoginStatus::Waiting
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_png_is_valid_image() {
        let b64 = encode_qr_png("https://liteapp.weixin.qq.com/q/abc?bot_type=3").expect("png");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .expect("base64");
        assert!(bytes.starts_with(&[0x89, b'P', b'N', b'G']), "not a PNG");
        let decoded = image::load_from_memory(&bytes).expect("decodable PNG");
        assert!(decoded.width() >= 256);
    }
}
