use std::env;
use std::fs;
use std::io::Write as _;
use std::path::PathBuf;
use std::process::Command;

/// Unquote one response-file line (rustc writes quoted args when they
/// contain spaces or backslashes).
fn unquote(line: &str) -> String {
    let t = line.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        let inner = &t[1..t.len() - 1];
        // rustc escapes backslashes and quotes inside response-file tokens.
        inner.replace("\\\\", "\\").replace("\\\"", "\"")
    } else {
        t.to_string()
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("android-aarch64-linker: no arguments");
        std::process::exit(1);
    }

    // exe lives at <repo>/scripts/android-aarch64-linker(.exe|.cmd)
    let exe_path = env::current_exe().expect("current_exe");
    let exe_dir = exe_path.parent().expect("exe parent").to_path_buf();
    let repo_root = exe_dir
        .parent()
        .expect("scripts dir parent = repo root")
        .to_path_buf();
    debug_assert!(repo_root.join("scripts").is_dir(), "repo root mismatch");

    let ndk_root = env::var("ANDROID_NDK_HOME")
        .or_else(|_| env::var("ANDROID_NDK_ROOT"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let android_home = env::var("ANDROID_HOME")
                .or_else(|_| env::var("ANDROID_SDK_ROOT"))
                .expect("ANDROID_HOME/SDK_ROOT/NDK");
            let ndk_parent = PathBuf::from(&android_home).join("ndk");
            let mut versions: Vec<_> = fs::read_dir(&ndk_parent)
                .expect("ndk dir")
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .map(|e| e.path())
                .collect();
            versions.sort();
            versions.pop().expect("no NDK installed")
        });

    let clang = ndk_root.join("toolchains/llvm/prebuilt/windows-x86_64/bin/clang.exe");
    if !clang.exists() {
        panic!("clang not found: {}", clang.display());
    }

    // Debug log: what cargo/rustc handed us.
    let log_path = exe_dir.join("linker-args.log");
    let mut log = fs::File::create(&log_path).expect("log");
    for a in &args {
        writeln!(log, "ARG: {}", a).ok();
    }

    // Expand the rustc `@response-file` ourselves so clang never has to
    // open a path containing non-ASCII characters.
    let mut expanded: Vec<String> = Vec::new();
    for arg in &args {
        if let Some(path) = arg.strip_prefix('@') {
            let bytes = fs::read(path).unwrap_or_else(|e| panic!("read {}: {}", path, e));
            let content = String::from_utf8_lossy(&bytes);
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                expanded.push(unquote(line));
            }
        } else {
            expanded.push(arg.clone());
        }
    }

    // Rewrite every absolute path under the repository to a path relative to
    // the repo root; we chdir there before spawning clang, so clang's whole
    // command line stays pure ASCII (the repo path contains non-ASCII).
    let repo_str = repo_root.display().to_string();
    let prefixes = [
        format!("{}\\", repo_str),
        format!("{}/", repo_str.replace('\\', "/")),
    ];
    let normalized: Vec<String> = expanded
        .into_iter()
        .map(|arg| {
            let mut a = arg;
            for p in &prefixes {
                a = a.replace(p.as_str(), "");
            }
            a
        })
        .collect();

    for a in &normalized {
        writeln!(log, "NORM: {}", a).ok();
    }

    // Write a fresh response file into the (ASCII) system temp dir and hand
    // only that path to clang.
    let rsp_path = env::temp_dir().join(format!("hakus-android-link-{}.rsp", std::process::id()));
    let mut rsp = fs::File::create(&rsp_path).unwrap_or_else(|e| panic!("create rsp: {}", e));
    for a in &normalized {
        // rustc escapes backslashes inside quoted response-file tokens
        // (C:\\dir\\file). Unescape first, then rewrite every repo-absolute
        // path to a repo-relative one, normalize separators to forward
        // slashes, and strip any embedded quotes — clang's @file tokenizer
        // keeps quotes literally, so a token like -Wl,--version-script="x"
        // would be opened as `"x"` and fail.
        let a = a.replace("\\\\", "\\").replace('"', "");
        let a = prefixes
            .iter()
            .fold(a, |acc, p| acc.replace(p.as_str(), ""))
            .replace('\\', "/");
        writeln!(rsp, "{}", a).ok();
    }
    drop(rsp);

    let status = Command::new(&clang)
        .arg("--target=aarch64-linux-android24")
        .arg(format!("@{}", rsp_path.display()))
        .current_dir(&repo_root)
        .status()
        .expect("spawn clang");

    let code = status.code().unwrap_or(1);
    if code != 0 {
        writeln!(log, "CLANG EXIT: {}", code).ok();
    }
    // Keep the rsp on failure for debugging; clean up only on success.
    if code == 0 {
        let _ = fs::remove_file(&rsp_path);
    } else {
        let keep = exe_dir.join("last-failed-link.rsp");
        let _ = fs::copy(&rsp_path, &keep);
    }
    std::process::exit(code);
}
