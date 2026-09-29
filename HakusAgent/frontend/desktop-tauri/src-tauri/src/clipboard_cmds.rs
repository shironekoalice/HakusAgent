//! Clipboard helpers for the desktop shell.
//!
//! WebView `navigator.clipboard` is unreliable in Tauri (especially when the
//! page is not treated as a secure context). These commands write through the
//! OS clipboard so Copy buttons in the UI always work.

#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::ptr;

        // Win32 clipboard via windows crate would pull extra features;
        // use a tiny PowerShell-free path through arboard if available,
        // else fall back to the `clip` utility which ships with Windows.
        if copy_with_arboard(&text) {
            return Ok(());
        }
        let status = std::process::Command::new("cmd")
            .args(["/C", "clip"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                if let Some(stdin) = child.stdin.as_mut() {
                    // clip.exe expects the console/OEM encoding on some
                    // builds; UTF-16LE with BOM is handled by clip on Win10+.
                    stdin.write_all(text.as_bytes())?;
                }
                child.wait()
            })
            .map_err(|e| e.to_string())?;
        let _ = ptr::null::<()>();
        if status.success() {
            Ok(())
        } else {
            Err("clip.exe failed".into())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if copy_with_arboard(&text) {
            return Ok(());
        }
        // xclip / wl-copy fallbacks
        for (cmd, args) in [
            ("wl-copy", vec![] as Vec<&str>),
            ("xclip", vec!["-selection", "clipboard"]),
            ("xsel", vec!["--clipboard", "--input"]),
        ] {
            if let Ok(mut child) = std::process::Command::new(cmd)
                .args(&args)
                .stdin(std::process::Stdio::piped())
                .spawn()
            {
                use std::io::Write;
                if let Some(stdin) = child.stdin.as_mut() {
                    let _ = stdin.write_all(text.as_bytes());
                }
                if child.wait().map(|s| s.success()).unwrap_or(false) {
                    return Ok(());
                }
            }
        }
        Err("No clipboard backend available".into())
    }
}

#[tauri::command]
pub fn read_clipboard_text() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
            "-STA",
                "-Command",
                "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $value = Get-Clipboard -Raw; if ($null -ne $value) { [Console]::Write($value) }",
            ])
            .output()
            .map_err(|error| format!("读取系统剪贴板失败：{error}"))?;
        if !output.status.success() {
            return Err("读取系统剪贴板失败".into());
        }
        return String::from_utf8(output.stdout)
            .map_err(|error| format!("剪贴板文本编码无效：{error}"));
    }

    #[cfg(target_os = "macos")]
    let candidates: [(&str, &[&str]); 1] = [("pbpaste", &[])];
    #[cfg(all(unix, not(target_os = "macos")))]
    let candidates: [(&str, &[&str]); 3] = [
        ("wl-paste", &["--no-newline", "--type", "text"]),
        ("xclip", &["-selection", "clipboard", "-o"]),
        ("xsel", &["--clipboard", "--output"]),
    ];

    #[cfg(unix)]
    {
        for (program, args) in candidates {
            let output = match std::process::Command::new(program).args(args).output() {
                Ok(output) if output.status.success() => output,
                _ => continue,
            };
            return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
        }
        Err("未找到可用的系统剪贴板读取工具".into())
    }

    #[cfg(not(any(unix, target_os = "windows")))]
    {
        Err("当前平台不支持读取系统剪贴板".into())
    }
}

#[allow(dead_code)]
fn copy_with_arboard(text: &str) -> bool {
    // arboard is not a direct dependency; keep this hook for when it is added.
    // Returning false routes to the OS fallback above.
    let _ = text;
    false
}
