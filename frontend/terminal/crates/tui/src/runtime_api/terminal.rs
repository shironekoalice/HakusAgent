use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, StatusCode, header::ORIGIN};
use axum::response::{IntoResponse, Response};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;

#[derive(Debug, Deserialize)]
struct TerminalMessage {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    data: String,
    #[serde(default)]
    cwd: Option<PathBuf>,
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    rows: Option<u16>,
}

pub(super) async fn terminal_ws(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !peer.ip().is_loopback()
        || !headers
            .get(ORIGIN)
            .and_then(|origin| origin.to_str().ok())
            .is_some_and(allowed_origin)
    {
        return (StatusCode::FORBIDDEN, "Terminal access is local-only").into_response();
    }
    ws.max_message_size(64 * 1024).on_upgrade(terminal_session)
}

fn allowed_origin(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
            | "http://localhost:1420"
            | "http://127.0.0.1:1420"
    )
}

async fn terminal_session(mut socket: WebSocket) {
    let Some(Ok(Message::Text(init))) = socket.recv().await else {
        return;
    };
    let Ok(init) = serde_json::from_str::<TerminalMessage>(init.as_str()) else {
        let _ = send_error(&mut socket, "Invalid terminal initialization").await;
        return;
    };
    if init.kind != "init" {
        let _ = send_error(&mut socket, "Terminal initialization is required").await;
        return;
    }

    let cwd = match resolve_working_directory(init.cwd.as_deref()) {
        Ok(cwd) => cwd,
        Err(error) => {
            let _ = send_error(&mut socket, &error).await;
            return;
        }
    };
    let cols = clamp_dimension(init.cols.unwrap_or(80), 20, 300);
    let rows = clamp_dimension(init.rows.unwrap_or(24), 5, 200);
    let opened = tokio::task::spawn_blocking(move || open_pty(&cwd, cols, rows)).await;
    let mut pty = match opened {
        Ok(Ok(pty)) => pty,
        Ok(Err(error)) => {
            let _ = send_error(&mut socket, &error.to_string()).await;
            return;
        }
        Err(error) => {
            let _ = send_error(&mut socket, &error.to_string()).await;
            return;
        }
    };

    let (output_tx, mut output_rx) = mpsc::channel::<Vec<u8>>(64);
    thread::Builder::new()
        .name("runtime-terminal-output".into())
        .spawn(move || {
            let mut reader = pty.reader;
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => {
                        if output_tx.blocking_send(buffer[..size].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        })
        .ok();

    let _ = socket
        .send(Message::Text(
            json!({ "type": "ready", "cwd": pty.cwd.to_string_lossy() })
                .to_string()
                .into(),
        ))
        .await;

    let mut check_exit = tokio::time::interval(Duration::from_millis(500));
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { break };
                match message {
                    Message::Text(text) => {
                        let Ok(message) = serde_json::from_str::<TerminalMessage>(text.as_str()) else {
                            let _ = send_error(&mut socket, "Invalid terminal message").await;
                            continue;
                        };
                        match message.kind.as_str() {
                            "stdin" => {
                                if pty.writer.write_all(message.data.as_bytes()).is_err()
                                    || pty.writer.flush().is_err()
                                {
                                    break;
                                }
                            }
                            "resize" => {
                                let size = PtySize {
                                    rows: clamp_dimension(message.rows.unwrap_or(rows), 5, 200),
                                    cols: clamp_dimension(message.cols.unwrap_or(cols), 20, 300),
                                    pixel_width: 0,
                                    pixel_height: 0,
                                };
                                if pty.master.resize(size).is_err() {
                                    let _ = send_error(&mut socket, "Failed to resize terminal").await;
                                }
                            }
                            _ => {
                                let _ = send_error(&mut socket, "Unsupported terminal message").await;
                            }
                        }
                    }
                    Message::Ping(payload) => {
                        if socket.send(Message::Pong(payload)).await.is_err() { break; }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            output = output_rx.recv() => {
                let Some(output) = output else { break };
                if socket.send(Message::Binary(output.into())).await.is_err() { break; }
            }
            _ = check_exit.tick() => {
                match pty.child.try_wait() {
                    Ok(Some(status)) => {
                        let _ = socket.send(Message::Text(
                            json!({ "type": "exit", "code": status.exit_code() }).to_string().into()
                        )).await;
                        break;
                    }
                    Err(error) => {
                        let _ = send_error(&mut socket, &format!("Terminal process error: {error}")).await;
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    let _ = pty.child.kill();
    let _ = pty.child.wait();
}

struct OpenPty {
    cwd: PathBuf,
    child: Box<dyn Child + Send>,
    master: Box<dyn MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
}

fn open_pty(cwd: &Path, cols: u16, rows: u16) -> anyhow::Result<OpenPty> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut command = shell_command();
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(command)?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;

    Ok(OpenPty {
        cwd: cwd.to_path_buf(),
        child,
        master: pair.master,
        reader,
        writer,
    })
}

fn shell_command() -> CommandBuilder {
    #[cfg(target_os = "windows")]
    {
        let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
        let mut command = CommandBuilder::new(shell);
        command.arg("/Q");
        command
    }
    #[cfg(not(target_os = "windows"))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut command = CommandBuilder::new(shell);
        command.arg("-l");
        command
    }
}

fn resolve_working_directory(requested: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(path) = requested {
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("Project directory is unavailable: {error}"))?;
        if !canonical.is_dir() {
            return Err("Project path is not a directory".into());
        }
        return Ok(strip_verbatim_prefix(canonical));
    }
    Ok(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// `Path::canonicalize` returns `\\?\C:\...` on Windows, and shells do not
/// accept the verbatim prefix as a working directory: cmd.exe classifies it
/// as a UNC path, prints "UNC paths are not supported", and silently falls
/// back to `C:\Windows` — the terminal would run outside the session
/// workspace while claiming otherwise. The plain form is the same directory
/// in the shape the PTY needs.
#[cfg(windows)]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    const VERBATIM: &str = r"\\?\";
    let text = path.as_os_str().to_string_lossy();
    match text.strip_prefix(VERBATIM) {
        Some(stripped) => PathBuf::from(stripped.to_string()),
        None => path,
    }
}

#[cfg(not(windows))]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    path
}

fn clamp_dimension(value: u16, min: u16, max: u16) -> u16 {
    value.clamp(min, max)
}

async fn send_error(socket: &mut WebSocket, message: &str) -> Result<(), axum::Error> {
    socket
        .send(Message::Text(
            json!({ "type": "error", "message": message })
                .to_string()
                .into(),
        ))
        .await
}

#[cfg(test)]
mod tests {
    use super::{allowed_origin, clamp_dimension, resolve_working_directory};
    use std::path::Path;

    #[test]
    fn terminal_dimensions_are_bounded() {
        assert_eq!(clamp_dimension(1, 20, 300), 20);
        assert_eq!(clamp_dimension(120, 20, 300), 120);
        assert_eq!(clamp_dimension(500, 20, 300), 300);
    }

    #[test]
    fn invalid_working_directory_is_reported() {
        let cwd = resolve_working_directory(Some(Path::new("Z:/path/that/does/not/exist")));
        assert!(cwd.is_err());
    }

    #[test]
    fn resolved_working_directory_drops_the_verbatim_prefix() {
        let cwd = resolve_working_directory(Some(Path::new("."))).expect("cwd resolves");
        let text = cwd.as_os_str().to_string_lossy();
        assert!(!text.starts_with(r"\\?\"), "verbatim prefix survived: {cwd:?}");
        assert!(cwd.is_dir(), "stripped path still resolves: {cwd:?}");
    }

    #[test]
    fn terminal_websocket_allows_only_app_origins() {
        assert!(allowed_origin("tauri://localhost"));
        assert!(allowed_origin("http://localhost:1420"));
        assert!(!allowed_origin("https://example.com"));
        assert!(!allowed_origin("null"));
    }
}
