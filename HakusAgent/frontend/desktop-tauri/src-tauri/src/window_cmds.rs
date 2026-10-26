//! Window commands — custom titlebar controls (minimize, maximize, close).
//! No more IPC bridge needed — Tauri window API handles this natively.

use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

/// Read (trayEnabled, minimizeToTray) from the persisted settings store.
fn read_tray_settings(app: &AppHandle) -> (bool, bool) {
    let store = match app.store("settings.json") {
        Ok(s) => s,
        Err(_) => return (true, false),
    };
    let tray_enabled = store
        .get("trayEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let minimize_to_tray = store
        .get("minimizeToTray")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    (tray_enabled, minimize_to_tray)
}

#[tauri::command]
pub fn window_minimize(app: AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_window("main") {
        window.minimize().map_err(|e| e.to_string())?;
        Ok(true)
    } else {
        Err("No main window".into())
    }
}

#[tauri::command]
pub fn window_toggle_maximize(app: AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_window("main") {
        let is_max = window.is_maximized().map_err(|e| e.to_string())?;
        if is_max {
            window.unmaximize().map_err(|e| e.to_string())?;
        } else {
            window.maximize().map_err(|e| e.to_string())?;
        }
        Ok(!is_max)
    } else {
        Err("No main window".into())
    }
}

/// Close (or hide) the main window.
///
/// When `trayEnabled && minimizeToTray` are both on, hides the window
/// instead of closing it so the app keeps running in the tray. The user
/// can re-open it via the tray icon (left-click or "显示/隐藏窗口" menu).
///
/// Otherwise, calls `window.close()` which fires `CloseRequested` — the
/// `on_window_event` handler in lib.rs will let it through and stop the
/// in-process Rust Runtime before the window actually closes.
#[tauri::command]
pub fn window_close(app: AppHandle) -> Result<bool, String> {
    let (tray_enabled, minimize_to_tray) = read_tray_settings(&app);
    if let Some(window) = app.get_window("main") {
        if tray_enabled && minimize_to_tray {
            window.hide().map_err(|e| e.to_string())?;
        } else {
            // This fires CloseRequested; the on_window_event handler will
            // let it through (since minimizeToTray is false) and stop the
            // embedded Rust Runtime.
            window.close().map_err(|e| e.to_string())?;
        }
        Ok(true)
    } else {
        Err("No main window".into())
    }
}

#[tauri::command]
pub fn window_is_maximized(app: AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_window("main") {
        window.is_maximized().map_err(|e| e.to_string())
    } else {
        Err("No main window".into())
    }
}

/// Reveal the main window.
///
/// The external splash window was removed: the React app renders its own
/// in-window AwakeningSplash during boot. This command now only guarantees
/// the main window is visible/focused when the frontend signals readiness.
/// Safe to call multiple times.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn finish_splash(app: AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(true)
}
