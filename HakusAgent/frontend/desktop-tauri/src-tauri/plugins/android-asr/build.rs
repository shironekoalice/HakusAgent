fn main() {
    tauri_plugin::Builder::new(&["status", "start", "stop"])
        .android_path("android")
        .build();
}
