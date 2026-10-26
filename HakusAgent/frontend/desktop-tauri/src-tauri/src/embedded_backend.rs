//! Tauri's in-process Hakus Runtime API.
//!
//! Desktop and Android use the same Rust runtime. Keeping the server in the
//! Tauri process removes the Python dependency from the desktop bundle and
//! makes the two clients exercise the same `/v1/*` API.

use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use tauri::{AppHandle, Manager, State};

pub const EMBEDDED_BACKEND_PORT: u16 = 48081;

pub struct EmbeddedBackendState {
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    running: Arc<AtomicBool>,
}

impl EmbeddedBackendState {
    pub fn start(app: &AppHandle) -> Result<Self, String> {
        let running = Arc::new(AtomicBool::new(false));
        let task = spawn_runtime(app, Arc::clone(&running))?;
        Ok(Self {
            task: Mutex::new(Some(task)),
            running,
        })
    }

    fn start_if_stopped(&self, app: &AppHandle) -> Result<(), String> {
        let mut task_lock = self.task.lock().map_err(|error| error.to_string())?;
        if !self.running.load(Ordering::Acquire) {
            // A failed startup leaves a completed JoinHandle behind. Remove
            // it before restarting so status does not report a dead runtime.
            if let Some(task) = task_lock.take() {
                task.abort();
            }
            *task_lock = Some(spawn_runtime(app, Arc::clone(&self.running))?);
        }
        Ok(())
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::Release);
        if let Ok(mut task) = self.task.lock() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }
}

fn spawn_runtime(
    app: &AppHandle,
    running: Arc<AtomicBool>,
) -> Result<tauri::async_runtime::JoinHandle<()>, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("resolve Tauri app data directory: {error}"))?;
    let workspace = app_data_dir.join("workspace");
    std::fs::create_dir_all(&workspace)
        .map_err(|error| format!("create runtime workspace: {error}"))?;

    // The canonical state root is the app's private data directory. This
    // keeps sessions, config, skills, and runtime records together and
    // avoids every legacy product-directory fallback.
    std::env::set_var("HAKUS_HOME", &app_data_dir);

    let task_workspace: PathBuf = workspace;
    running.store(true, Ordering::Release);

    // The agent dispatch pipeline measures a 2.25-2.5 MiB stack high-water
    // mark in debug builds. Tauri's shared async runtime uses tokio's 2 MiB
    // worker default, so the first message dispatch overflowed the guard
    // page and killed the whole process (STATUS_STACK_OVERFLOW). hakus-tui's
    // own binary runs its workers on 16 MiB stacks for exactly this reason
    // (hakus_tui::build_runtime); the embedded runtime gets the same
    // treatment on a dedicated owner thread. Keep the embedded stack aligned
    // with the standalone Runtime worker stack so its reservation does not
    // inflate the desktop process footprint.
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    std::thread::Builder::new()
        .name("hakus-runtime".to_string())
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            let runtime = match hakus_tui::build_runtime() {
                Ok(runtime) => runtime,
                Err(error) => {
                    eprintln!("[rust-backend] Failed to build runtime: {error:#}");
                    let _ = done_tx.send(());
                    return;
                }
            };
            runtime.block_on(async move {
                if let Err(error) = hakus_tui::run_embedded_runtime_api(
                    task_workspace,
                    "127.0.0.1".to_string(),
                    EMBEDDED_BACKEND_PORT,
                    cfg!(target_os = "android"),
                )
                .await
                {
                    eprintln!("[rust-backend] Runtime API stopped: {error:#}");
                }
            });
            let _ = done_tx.send(());
        })
        .map_err(|error| format!("spawn runtime thread: {error}"))?;

    // Supervisor on the Tauri runtime so EmbeddedBackendState keeps its
    // existing JoinHandle/status semantics; the worker thread itself is
    // detached (a stack overflow aborts the process regardless).
    Ok(tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _ = done_rx.recv();
        })
        .await;
        running.store(false, Ordering::Release);
    }))
}

impl Drop for EmbeddedBackendState {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
        if let Ok(task) = self.task.get_mut() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
    }
}

#[tauri::command]
pub fn backend_status(state: State<EmbeddedBackendState>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "running": state.is_running(),
        "port": if state.is_running() { Some(EMBEDDED_BACKEND_PORT) } else { None::<u16> },
        "backend": "rust-runtime"
    }))
}

#[tauri::command]
pub fn backend_logs(_state: State<EmbeddedBackendState>) -> Result<Vec<String>, String> {
    // Runtime logs are emitted by the Rust process. The old Python log buffer
    // is intentionally not exposed as a compatibility layer.
    Ok(Vec::new())
}

#[tauri::command]
pub fn backend_start(
    app: AppHandle,
    state: State<EmbeddedBackendState>,
) -> Result<serde_json::Value, String> {
    state.start_if_stopped(&app)?;
    Ok(serde_json::json!({ "ok": true, "port": EMBEDDED_BACKEND_PORT }))
}

#[tauri::command]
pub fn backend_stop(state: State<EmbeddedBackendState>) -> Result<serde_json::Value, String> {
    state.stop();
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn backend_restart(
    app: AppHandle,
    state: State<'_, EmbeddedBackendState>,
) -> Result<serde_json::Value, String> {
    state.stop();
    state.start_if_stopped(&app)?;
    Ok(serde_json::json!({ "ok": true, "port": EMBEDDED_BACKEND_PORT }))
}

#[tauri::command]
pub async fn backend_health(
    state: State<'_, EmbeddedBackendState>,
) -> Result<serde_json::Value, String> {
    if !state.is_running() {
        return Ok(serde_json::json!({
            "healthy": false,
            "reason": "Rust Runtime is not running"
        }));
    }

    let url = format!("http://127.0.0.1:{EMBEDDED_BACKEND_PORT}/health");
    match reqwest::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => Ok(serde_json::json!({
            "healthy": true,
            "port": EMBEDDED_BACKEND_PORT,
            "backend": "rust-runtime"
        })),
        Ok(response) => Ok(serde_json::json!({
            "healthy": false,
            "reason": format!("HTTP {}", response.status())
        })),
        Err(error) => Ok(serde_json::json!({
            "healthy": false,
            "reason": error.to_string()
        })),
    }
}
