fn main() {
    // The Tauri context embeds frontendDist; rebuild when Vite replaces it.
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
