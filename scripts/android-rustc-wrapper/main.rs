use std::env;
use std::path::PathBuf;
use std::process::Command;

/// RUSTC_WRAPPER that injects the Chinese-path-safe linker wrapper for
/// aarch64-linux-android compilations. Implemented as a Rust exe so rustc
/// arguments (notably quoted `--cfg=feature="..."` values) pass through
/// byte-for-byte; the previous cmd.exe wrapper mangled them.
fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("android-rustc-wrapper: expected rustc path as first argument");
        std::process::exit(1);
    }
    let rustc = PathBuf::from(&args[0]);
    let rest = &args[1..];

    let is_android = rest.windows(2).any(|w| {
        (w[0] == "--target" && w[1] == "aarch64-linux-android")
            || w[0] == "--target=aarch64-linux-android"
    });

    let mut arguments: Vec<String> = rest.to_vec();
    if is_android {
        // exe lives at <repo>/scripts/android-rustc-wrapper.exe
        let exe_dir = env::current_exe()
            .expect("current_exe")
            .parent()
            .expect("exe parent")
            .to_path_buf();
        let linker = exe_dir.join("android-aarch64-linker.exe");
        arguments.push("-C".into());
        arguments.push(format!("linker={}", linker.display().to_string().replace('\\', "/")));
    }

    let status = Command::new(&rustc)
        .args(&arguments)
        .status()
        .unwrap_or_else(|e| panic!("spawn rustc: {}", e));
    std::process::exit(status.code().unwrap_or(1));
}
