use tauri::{plugin::PluginHandle, AppHandle, Manager, Runtime, State};

const ANDROID_PLUGIN_ID: &str = "com.hakusai.androidasr";

pub struct AndroidAsr<R: Runtime>(PluginHandle<R>);

#[tauri::command]
async fn status<R: Runtime>(
    _app: AppHandle<R>,
    plugin: State<'_, AndroidAsr<R>>,
) -> Result<serde_json::Value, String> {
    plugin
        .0
        .run_mobile_plugin::<serde_json::Value>("status", serde_json::json!({}))
        .map_err(|error| format!("Android ASR status failed: {error}"))
}

#[tauri::command]
async fn start<R: Runtime>(
    _app: AppHandle<R>,
    plugin: State<'_, AndroidAsr<R>>,
    model_dir: Option<String>,
) -> Result<serde_json::Value, String> {
    plugin
        .0
        .run_mobile_plugin::<serde_json::Value>(
            "start",
            serde_json::json!({ "modelDir": model_dir.unwrap_or_default() }),
        )
        .map_err(|error| format!("Android ASR start failed: {error}"))
}

#[tauri::command]
async fn stop<R: Runtime>(
    _app: AppHandle<R>,
    plugin: State<'_, AndroidAsr<R>>,
) -> Result<serde_json::Value, String> {
    plugin
        .0
        .run_mobile_plugin::<serde_json::Value>("stop", serde_json::json!({}))
        .map_err(|error| format!("Android ASR stop failed: {error}"))
}

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("hakus-android-asr")
        .invoke_handler(tauri::generate_handler![status, start, stop])
        .setup(|app: &AppHandle<R>, api| {
            let handle = api.register_android_plugin(ANDROID_PLUGIN_ID, "HakusAndroidAsrPlugin")?;
            app.manage(AndroidAsr(handle));
            Ok(())
        })
        .build()
}

