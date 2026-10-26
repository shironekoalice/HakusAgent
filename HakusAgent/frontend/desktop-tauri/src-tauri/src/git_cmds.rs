/**
 * git / doctor / worktree Tauri commands — desktop OS-level git ops and
 * dependency probes that the embedded Runtime may not expose yet.
 */

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(serde::Serialize, Clone)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub bare: bool,
    pub locked: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct DependencyCheck {
    pub id: String,
    pub name: String,
    pub required: bool,
    pub found: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub status: String,
    pub hint: Option<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct DoctorReport {
    pub checks: Vec<DependencyCheck>,
    pub healthy: bool,
    pub backend_version: Option<String>,
}

fn command_base(program: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new(program);
        cmd.creation_flags(0x0800_0000);
        cmd
    }
    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

fn run_cmd(program: &str, args: &[&str], workdir: Option<&Path>) -> Result<String, String> {
    let mut cmd = command_base(program);
    cmd.args(args);
    if let Some(dir) = workdir {
        cmd.current_dir(dir);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("{program} failed to start: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{program} exited with status {}", output.status)
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// `git_apply_stdin` lived here too, feeding a patch to `git apply` over stdin.
// It was only ever called by `git_apply_patch`; both are gone now that hunk
// staging goes through the Runtime, and leaving an unused patch-applier in the
// Tauri process would invite it being wired up again.

// `git_apply_patch` used to live here. It spawned `git apply --3way` in the
// Tauri process against a caller-supplied `workdir` and arbitrary patch text,
// which made the desktop a second place where a repository could be mutated —
// choosing both the repository and the change. Staging and reverting a hunk now
// goes through the Rust Runtime's `POST /v1/workspace/apply-hunk`, which is
// bound to the workspace it serves and validates the path as workspace-relative.
// See `frontend/terminal/crates/tui/src/runtime_api/workspace.rs`.

/// List local branches (names only) for the review branch picker.
#[tauri::command]
pub fn git_branch_list(workdir: String) -> Result<Vec<String>, String> {
    let dir = PathBuf::from(&workdir);
    let stdout = run_cmd(
        "git",
        &["branch", "--format=%(refname:short)"],
        Some(&dir),
    )?;
    Ok(stdout
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

/// Parse `git worktree list --porcelain`.
#[tauri::command]
pub fn git_worktree_list(workdir: String) -> Result<Vec<WorktreeInfo>, String> {
    let dir = PathBuf::from(&workdir);
    let stdout = run_cmd("git", &["worktree", "list", "--porcelain"], Some(&dir))?;
    let mut trees: Vec<WorktreeInfo> = Vec::new();
    let mut current: Option<WorktreeInfo> = None;
    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(t) = current.take() {
                trees.push(t);
            }
            current = Some(WorktreeInfo {
                path: path.to_string(),
                branch: None,
                head: String::new(),
                bare: false,
                locked: false,
            });
        } else if let Some(head) = line.strip_prefix("HEAD ") {
            if let Some(t) = current.as_mut() {
                t.head = head.to_string();
            }
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(t) = current.as_mut() {
                t.branch = Some(b.trim_start_matches("refs/heads/").to_string());
            }
        } else if line == "bare" {
            if let Some(t) = current.as_mut() {
                t.bare = true;
            }
        } else if line.starts_with("locked") {
            if let Some(t) = current.as_mut() {
                t.locked = true;
            }
        }
    }
    if let Some(t) = current.take() {
        trees.push(t);
    }
    Ok(trees)
}

/// PR list via GitHub CLI when available; empty list otherwise.
#[tauri::command]
pub fn git_pr_list(workdir: String) -> Result<Vec<serde_json::Value>, String> {
    let dir = PathBuf::from(&workdir);
    let which = if cfg!(windows) { "where" } else { "which" };
    if run_cmd(which, &["gh"], None).is_err() {
        return Ok(vec![]);
    }
    let stdout = run_cmd(
        "gh",
        &[
            "pr",
            "list",
            "--json",
            "number,title,state,headRefName,baseRefName,url,author,isDraft",
        ],
        Some(&dir),
    )?;
    Ok(serde_json::from_str(stdout.trim()).unwrap_or_default())
}

/// CI checks for a PR via `gh pr checks <number> --json`.
#[tauri::command]
pub fn git_pr_checks(workdir: String, number: u32) -> Result<Vec<serde_json::Value>, String> {
    let dir = PathBuf::from(&workdir);
    let which = if cfg!(windows) { "where" } else { "which" };
    if run_cmd(which, &["gh"], None).is_err() {
        return Ok(vec![]);
    }
    let num = number.to_string();
    let stdout = run_cmd(
        "gh",
        &[
            "pr",
            "checks",
            &num,
            "--json",
            "name,state,description,link,bucket",
        ],
        Some(&dir),
    )?;
    Ok(serde_json::from_str(stdout.trim()).unwrap_or_default())
}

fn probe_version(
    id: &str,
    name: &str,
    required: bool,
    program: &str,
    args: &[&str],
    hint: &str,
) -> DependencyCheck {
    let which = if cfg!(windows) { "where" } else { "which" };
    let path = run_cmd(which, &[program], None)
        .ok()
        .map(|o| o.lines().next().unwrap_or("").trim().to_string())
        .filter(|s| !s.is_empty());
    match run_cmd(program, args, None) {
        Ok(stdout) => {
            let version = stdout
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .chars()
                .take(80)
                .collect::<String>();
            DependencyCheck {
                id: id.into(),
                name: name.into(),
                required,
                found: true,
                version: if version.is_empty() {
                    None
                } else {
                    Some(version)
                },
                path,
                status: "ok".into(),
                hint: None,
            }
        }
        Err(_) => DependencyCheck {
            id: id.into(),
            name: name.into(),
            required,
            found: path.is_some(),
            version: None,
            path: path.clone(),
            status: if path.is_some() {
                "error".into()
            } else {
                "missing".into()
            },
            hint: Some(hint.into()),
        },
    }
}

/// Dependency doctor — probe git / node / python / uv versions on this machine.
#[tauri::command]
pub fn doctor_check_dependencies(
    backend_healthy: bool,
    backend_version: Option<String>,
) -> Result<DoctorReport, String> {
    let checks = vec![
        probe_version(
            "git",
            "Git",
            true,
            "git",
            &["--version"],
            "Install Git from https://git-scm.com and ensure it is on PATH.",
        ),
        probe_version(
            "node",
            "Node.js",
            false,
            "node",
            &["--version"],
            "Install Node.js 18+ if you need JS tooling or MCP servers.",
        ),
        probe_version(
            "python",
            "Python",
            false,
            "python",
            &["--version"],
            "Install Python 3.11+ via python.org, py launcher, or uv.",
        ),
        probe_version(
            "uv",
            "uv",
            false,
            "uv",
            &["--version"],
            "Optional: install uv for faster Python tooling (https://docs.astral.sh/uv).",
        ),
        probe_version(
            "gh",
            "GitHub CLI",
            false,
            "gh",
            &["--version"],
            "Optional: install GitHub CLI to list pull requests in Review.",
        ),
    ];
    Ok(DoctorReport {
        checks,
        healthy: backend_healthy,
        backend_version,
    })
}
