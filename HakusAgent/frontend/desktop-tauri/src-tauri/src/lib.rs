mod embedded_backend;
#[cfg(not(target_os = "android"))]
mod updater_cmds;
#[cfg(not(target_os = "android"))]
mod shortcut_cmds;
mod store_cmds;
#[cfg(not(target_os = "android"))]
mod voice_cmds;
#[cfg(not(target_os = "android"))]
mod tray_cmds;
#[cfg(not(target_os = "android"))]
mod window_cmds;
mod clipboard_cmds;
// Available on every platform (including Android) so the Flow HTTP node works
// there too — it must therefore be registered in BOTH invoke handlers below.
mod http_cmds;
// Filesystem access for the Flow file nodes (root-confined, see fs_cmds.rs).
mod fs_cmds;
#[cfg(not(target_os = "android"))]
mod git_cmds;
#[cfg(not(target_os = "android"))]
mod remote_cmds;
#[cfg(not(target_os = "android"))]
mod browser_cmds;

#[cfg(not(target_os = "android"))]
use std::time::{Duration, Instant};
#[cfg(not(target_os = "android"))]
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
#[cfg(not(target_os = "android"))]
use tauri_plugin_store::StoreExt;

#[cfg(target_os = "android")]
use tauri::{Manager, RunEvent};

#[cfg(target_os = "android")]
fn configure_android_webview(app: &tauri::AppHandle) -> tauri::Result<()> {
    let Some(webview) = app.get_webview_window("main") else {
        eprintln!("[setup] Main Android WebView is not ready; keeping CSS viewport fallback");
        return Ok(());
    };

    if let Err(error) = webview.with_webview(|webview| {
        use jni::objects::JValue;

        webview.jni_handle().exec(|env, _, webview| {
            let result = (|| -> jni::errors::Result<()> {
                let settings = env
                    .call_method(
                        &webview,
                        "getSettings",
                        "()Landroid/webkit/WebSettings;",
                        &[],
                    )?
                    .l()?;

                // Never let Android fall back to the legacy ~980px desktop
                // viewport. Responsive CSS must see the actual WebView width.
                env.call_method(&settings, "setUseWideViewPort", "(Z)V", &[JValue::Bool(0)])?;
                env.call_method(
                    &settings,
                    "setLoadWithOverviewMode",
                    "(Z)V",
                    &[JValue::Bool(0)],
                )?;
                Ok(())
            })();

            if let Err(error) = result {
                eprintln!("[setup] Failed to normalize Android WebView viewport: {error}");
            }
        });
    }) {
        eprintln!("[setup] Failed to access Android WebView: {error}");
    }

    Ok(())
}

/// Read (trayEnabled, minimizeToTray) from the persisted settings store.
/// Defaults to (true, false) when the store is unavailable or keys missing.
#[cfg(not(target_os = "android"))]
fn read_tray_settings(app: &tauri::AppHandle) -> (bool, bool) {
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

/// Stop the in-process Rust Runtime API if it is still running.
/// Called from every exit path (close button, tray quit, Alt+F4, process kill)
/// so the runtime task does not linger after the UI disappears.
#[cfg(not(target_os = "android"))]
fn kill_backend(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<embedded_backend::EmbeddedBackendState>() {
        state.stop();
    }
    if let Some(state) = app.try_state::<voice_cmds::VoiceProcessState>() {
        voice_cmds::stop_process(state.inner());
    }
    if let Some(state) = app.try_state::<remote_cmds::RemoteRuntimeState>() {
        state.stop_all();
    }
}

/// Toggle the main window's visibility — used by tray left-click and the
/// "显示/隐藏窗口" context menu item. If the window is visible, hide it;
/// if hidden, show + focus it.
#[cfg(not(target_os = "android"))]
pub(crate) fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// Opt the main window into Windows 11 rounded corners.
///
/// With `decorations: false` the DWM draws square corners by default; the
/// explicit `DWMWCP_ROUND` preference restores the native rounded frame
/// (plus the system drop shadow enabled in tauri.conf.json).
#[cfg(target_os = "windows")]
fn apply_rounded_corners(app: &tauri::AppHandle) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let preference = DWMWCP_ROUND;
    let result = unsafe {
        DwmSetWindowAttribute(
            HWND(hwnd.0),
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&preference) as u32,
        )
    };
    if let Err(error) = result {
        eprintln!("[setup] Failed to set rounded corners: {error}");
    }
}

#[cfg(target_os = "windows")]
fn apply_window_material(app: &tauri::AppHandle) {
    use tauri::window::{Effect, EffectsBuilder};

    if let Some(window) = app.get_webview_window("main") {
        let acrylic = EffectsBuilder::new().effect(Effect::Acrylic).build();
        if let Err(error) = window.set_effects(acrylic) {
            eprintln!("[setup] Acrylic material unavailable, falling back to Mica: {error}");
            if let Err(error) =
                window.set_effects(EffectsBuilder::new().effect(Effect::Mica).build())
            {
                eprintln!("[setup] Failed to apply the native window material: {error}");
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn apply_window_material(app: &tauri::AppHandle) {
    use tauri::window::{Effect, EffectState, EffectsBuilder};

    if let Some(window) = app.get_webview_window("main") {
        let effects = EffectsBuilder::new()
            .effect(Effect::Sidebar)
            .state(EffectState::FollowsWindowActiveState)
            .build();
        if let Err(error) = window.set_effects(effects) {
            eprintln!("[setup] Failed to apply the native window material: {error}");
        }
    }
}

#[cfg(not(target_os = "android"))]
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    // Build the tray icon EXPLICITLY here instead of relying on the
    // `trayIcon` config block. Config-created trays have an uncontrolled id
    // and (worse) are created during app construction in every process —
    // an explicit tray built in `setup` only ever exists in the single
    // instance that wins the single-instance mutex, so duplicate tray
    // icons are structurally impossible. It also guarantees the menu and
    // visibility handling below are attached to the one real icon.

    // Build the right-click context menu. Use a separator between the
    // show/hide action and the quit action so the destructive option is
    // visually distinct — this matches native Windows app conventions.
    let show_item = MenuItem::with_id(app, "tray_show", "显示/隐藏窗口", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "tray_quit", "退出 HakusAI", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &sep, &quit_item])?;

    let icon = match app.default_window_icon() {
        Some(icon) => icon.clone(),
        None => {
            eprintln!("[setup] No default window icon available — skipping tray");
            return Ok(());
        }
    };

    let tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        // Template rendering only applies on macOS; ignored elsewhere.
        .icon_as_template(true)
        .tooltip("HakusAI")
        .menu(&menu)
        // Left-click is handled manually below (show/hide toggle); the
        // context menu opens on right-click only.
        .show_menu_on_left_click(false)
        .build(app)?;

    // Left-click toggles window visibility (Windows / Linux convention).
    // Right-click is handled automatically by the OS — it shows the menu
    // set above.
    tray.on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            toggle_main_window(tray.app_handle());
        }
    });

    // Apply the persisted `trayEnabled` setting — if the user previously
    // disabled the tray, hide it on startup.
    let (tray_enabled, _) = read_tray_settings(app);
    let _ = tray.set_visible(tray_enabled);

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build());

    #[cfg(not(target_os = "android"))]
    {
        builder = builder
            // Single-instance: registering before any window-creating setup so
            // a second launch (e.g. double-clicking the exe while HakusAI
            // lives in the tray) exits immediately after focusing the
            // existing window — without this, two processes each own a tray
            // icon.
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }))
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_dialog::init())
            // Desktop-only setup: start the shared Rust Runtime API and tray.
            .setup(|app| {
                app.manage(updater_cmds::UpdaterCommandState::default());
                app.manage(voice_cmds::VoiceProcessState::default());
                app.manage(remote_cmds::RemoteRuntimeState::default());
                match embedded_backend::EmbeddedBackendState::start(app.handle()) {
                    Ok(state) => {
                        app.manage(state);
                        eprintln!(
                            "[setup] Rust Runtime auto-started, port = {}",
                            embedded_backend::EMBEDDED_BACKEND_PORT
                        );
                    }
                    Err(e) => eprintln!("[setup] Backend auto-start failed: {e}"),
                }

                // No external splash window: the React app boots straight
                // into its in-window AwakeningSplash, which covers the
                // whole boot sequence and fades into the UI by itself.
                #[cfg(any(target_os = "windows", target_os = "macos"))]
                apply_window_material(app.handle());

                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }

                // Windows 11: restore rounded corners on the undecorated
                // window (they default to square without OS decorations).
                #[cfg(target_os = "windows")]
                apply_rounded_corners(app.handle());

                // Build the system tray icon + menu.
                if let Err(e) = setup_tray(app.handle()) {
                    eprintln!("[setup] Tray setup failed: {e}");
                }
                shortcut_cmds::register_saved_shortcut(app.handle());

                Ok(())
            })
            // ── Window close interceptor ────────────────────────────
            // If `trayEnabled && minimizeToTray`, hide the window instead of
            // closing it so the app keeps running in the tray. Otherwise let the
            // close go through and stop the embedded Rust Runtime so it does
            // not outlive the UI.
            .on_window_event(|window, event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    // Only the MAIN window goes through the minimize-to-tray
                    // interceptor. The splash window must always be allowed
                    // to close, otherwise it would hide and linger forever
                    // when the user has tray mode enabled.
                    if window.label() != "main" {
                        return;
                    }
                    let app = window.app_handle();
                    let (tray_enabled, minimize_to_tray) = read_tray_settings(app);
                    if tray_enabled && minimize_to_tray {
                        // Prevent the window from actually closing — hide it
                        // instead so the app keeps running in the tray.
                        api.prevent_close();
                        let _ = window.hide();
                        // Make sure the tray icon is visible (it might have been
                        // hidden if the user previously disabled the tray and
                        // just re-enabled it).
                        if let Some(tray) = app.tray_by_id("main") {
                            let _ = tray.set_visible(true);
                        }
                    } else {
                        // Actually closing — stop the runtime so it doesn't
                        // outlive the UI. The RunEvent::Exit handler below is
                        // a backup, but killing here ensures the backend dies
                        // even if some other window keeps the app alive.
                        kill_backend(app);
                    }
                }
            })
            // ── Global menu event handler ───────────────────────────
            // Registering on the app (not the tray) catches menu events from
            // any source — tray context menu, window menu, etc. This is more
            // robust than tray.on_menu_event which can be silently overwritten.
            .on_menu_event(|app, event| {
                if event.id() == "tray_show" {
                    toggle_main_window(app);
                } else if event.id() == "tray_quit" {
                    kill_backend(app);
                    app.exit(0);
                }
            });
    }

    #[cfg(target_os = "android")]
    {
        // Android uses the dialog plugin only for the explicit project access
        // confirmation. Folder selection itself is handled by the SAF plugin
        // below because the official dialog plugin has no folder picker on Android.
        builder = builder.plugin(tauri_plugin_dialog::init());
        builder = builder.plugin(hakus_folder_picker::init());
        // Android has no bundled Python interpreter. Start the shared Rust
        // Runtime API in-process and keep all state under app_data_dir().
        builder = builder.setup(|app| {
            configure_android_webview(app.handle())?;
            let state = embedded_backend::EmbeddedBackendState::start(app.handle())
                .map_err(std::io::Error::other)?;
            app.manage(state);
            Ok(())
        });
    }

    #[cfg(not(target_os = "android"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        // Rust Runtime API
        embedded_backend::backend_status,
        embedded_backend::backend_logs,
        embedded_backend::backend_start,
        embedded_backend::backend_stop,
        embedded_backend::backend_restart,
        embedded_backend::backend_health,
        // Store (was electron-store)
        store_cmds::store_get,
        store_cmds::store_set,
        store_cmds::store_get_all,
        store_cmds::store_clear,
        // Window (was BrowserWindow IPC)
        window_cmds::window_minimize,
        window_cmds::window_toggle_maximize,
        window_cmds::window_close,
        window_cmds::window_is_maximized,
        window_cmds::finish_splash,
        // Tray
        tray_cmds::tray_get_config,
        tray_cmds::tray_set_enabled,
        tray_cmds::tray_set_minimize_to_tray,
        // Shortcuts
        shortcut_cmds::shortcuts_get_config,
        shortcut_cmds::shortcuts_set_accelerator,
        shortcut_cmds::shortcuts_validate,
        // Updates (Electron-compatible renderer contract)
        updater_cmds::updater_get_status,
        updater_cmds::updater_check,
        updater_cmds::updater_download,
        updater_cmds::updater_install,
        updater_cmds::updater_set_auto_download,
        updater_cmds::updater_set_auto_install_on_app_quit,
        // External Celia voice process
        voice_cmds::voice_status,
        voice_cmds::voice_start_celia,
        voice_cmds::voice_stop_celia,
        // OS clipboard (WebView navigator.clipboard is unreliable)
        clipboard_cmds::copy_text,
        clipboard_cmds::read_clipboard_text,
        // Git review / worktree / dependency doctor
        git_cmds::git_apply_patch,
        git_cmds::git_branch_list,
        git_cmds::git_worktree_list,
        git_cmds::git_worktree_add,
        git_cmds::git_pr_list,
        git_cmds::git_pr_checks,
        git_cmds::doctor_check_dependencies,
        http_cmds::http_request,
        fs_cmds::fs_read_text,
        fs_cmds::fs_write_text,
        fs_cmds::fs_list_dir,
        remote_cmds::remote_list_targets,
        remote_cmds::remote_list_ssh_hosts,
        remote_cmds::remote_connect,
        remote_cmds::remote_list_dir,
        remote_cmds::remote_sync,
        remote_cmds::remote_start_runtime,
        remote_cmds::remote_stop_runtime,
        browser_cmds::browser_create,
        browser_cmds::browser_set_bounds,
        browser_cmds::browser_select_tab,
        browser_cmds::browser_hide_tabs,
        browser_cmds::browser_close_tab,
        browser_cmds::browser_current_url,
        browser_cmds::browser_action,
    ]);

    #[cfg(target_os = "android")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        // Android runs the same in-process Rust Runtime as desktop. Keep the
        // lifecycle/status commands available so the settings UI is truthful.
        embedded_backend::backend_status,
        embedded_backend::backend_logs,
        embedded_backend::backend_start,
        embedded_backend::backend_stop,
        embedded_backend::backend_restart,
        embedded_backend::backend_health,
        store_cmds::store_get,
        store_cmds::store_set,
        store_cmds::store_get_all,
        store_cmds::store_clear,
        // Registered here too: http_cmds / fs_cmds have no platform cfg, so an
        // unregistered command would fail with "command not found" on Android.
        http_cmds::http_request,
        fs_cmds::fs_read_text,
        fs_cmds::fs_write_text,
        fs_cmds::fs_list_dir,
    ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    #[cfg(not(target_os = "android"))]
    // Run loop — handle Exit / ExitRequested to clean up the embedded Rust
    // Runtime for any exit path we didn't catch in on_window_event (e.g.
    // process kill, panic, Alt+F4 when minimizeToTray is on but tray is
    // disabled, or the user clicked "退出 HakusAI" in the tray menu).
    app.run(|app_handle, event| {
        match event {
            RunEvent::ExitRequested { .. } => {
                // Last window is closing — stop the Rust Runtime before the
                // app exits so it doesn't linger after the UI is gone.
                kill_backend(app_handle);
            }
            RunEvent::Exit => {
                // Final cleanup — duplicate of the above but covers cases
                // where Exit is triggered without ExitRequested (e.g. via
                // app.exit(0) from the tray menu).
                kill_backend(app_handle);
            }
            _ => {}
        }
    });

    #[cfg(target_os = "android")]
    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            if let Some(state) = app_handle.try_state::<embedded_backend::EmbeddedBackendState>() {
                state.stop();
            }
        }
    });
}
