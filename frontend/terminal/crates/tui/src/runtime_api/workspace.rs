use std::path::{Path as FsPath, PathBuf};

use axum::Json;
use axum::extract::{Query, State};
use serde::{Deserialize, Serialize};

use crate::dependencies::{ExternalTool as _, Git};

use super::{ApiError, RuntimeApiState};

#[derive(Debug, Serialize)]
pub(super) struct WorkspaceStatusResponse {
    pub(super) workspace: PathBuf,
    pub(super) git_repo: bool,
    pub(super) branch: Option<String>,
    pub(super) head: Option<String>,
    pub(super) dirty: bool,
    pub(super) staged: usize,
    pub(super) unstaged: usize,
    pub(super) untracked: usize,
    pub(super) ahead: Option<u32>,
    pub(super) behind: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct GitFileChange {
    pub(super) path: String,
    pub(super) status: String,
    pub(super) staged: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct GitStatusFilesResponse {
    pub(super) branch: String,
    pub(super) workdir: PathBuf,
    pub(super) is_repo: bool,
    pub(super) unstaged: Vec<GitFileChange>,
    pub(super) staged: Vec<GitFileChange>,
    pub(super) untracked: Vec<GitFileChange>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct GitDiffResponse {
    pub(super) diff: String,
    pub(super) truncated: bool,
    pub(super) workdir: PathBuf,
}

#[derive(Debug, Deserialize, Default)]
pub(super) struct GitDiffQuery {
    #[serde(default)]
    pub(super) staged: bool,
    #[serde(rename = "ref", default)]
    pub(super) reference: Option<String>,
    #[serde(default)]
    pub(super) paths: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct GitStageRequest {
    pub(super) path: String,
    #[serde(default)]
    pub(super) unstage: bool,
}

#[derive(Debug, Deserialize)]
pub(super) struct GitDiscardRequest {
    pub(super) path: String,
}

#[derive(Debug, Default)]
pub(super) struct WorkspaceGitMetadata {
    pub(super) branch: Option<String>,
    pub(super) head: Option<String>,
    pub(super) dirty: bool,
}

pub(super) async fn workspace_status(
    State(state): State<RuntimeApiState>,
) -> Result<Json<WorkspaceStatusResponse>, ApiError> {
    Ok(Json(collect_workspace_status(&state.workspace)))
}

pub(super) async fn workspace_git_status(
    State(state): State<RuntimeApiState>,
) -> Result<Json<GitStatusFilesResponse>, ApiError> {
    let status = collect_workspace_status(&state.workspace);
    if !status.git_repo {
        return Ok(Json(GitStatusFilesResponse {
            branch: String::new(),
            workdir: state.workspace,
            is_repo: false,
            unstaged: Vec::new(),
            staged: Vec::new(),
            untracked: Vec::new(),
        }));
    }

    let porcelain = run_git(&state.workspace, &["status", "--porcelain=v1", "-z"])
        .ok_or_else(|| ApiError::internal("Failed to read git status"))?;
    let (unstaged, staged, untracked) = parse_git_status(&porcelain);
    Ok(Json(GitStatusFilesResponse {
        branch: status.branch.unwrap_or_default(),
        workdir: status.workspace,
        is_repo: true,
        unstaged,
        staged,
        untracked,
    }))
}

pub(super) async fn workspace_diff(
    State(state): State<RuntimeApiState>,
    Query(query): Query<GitDiffQuery>,
) -> Result<Json<GitDiffResponse>, ApiError> {
    if !collect_workspace_status(&state.workspace).git_repo {
        return Ok(Json(GitDiffResponse {
            diff: String::new(),
            truncated: false,
            workdir: state.workspace,
        }));
    }

    let reference = query
        .reference
        .as_deref()
        .map(validate_git_reference)
        .transpose()?;
    let paths = parse_git_paths(query.paths.as_deref())?;
    let mut args = vec!["diff".to_string(), "--no-ext-diff".to_string()];
    if query.staged {
        args.push("--cached".to_string());
    }
    if let Some(reference) = reference {
        args.push(reference);
    }
    args.push("--".to_string());
    args.extend(paths);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = Git::output(&arg_refs, &state.workspace)
        .map_err(|e| ApiError::internal(format!("Failed to run git diff: {e}")))?;
    if !output.status.success() {
        return Err(ApiError::bad_request(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
    let truncated = output.stdout.len() > MAX_DIFF_BYTES;
    let diff = String::from_utf8_lossy(&output.stdout[..output.stdout.len().min(MAX_DIFF_BYTES)])
        .to_string();
    Ok(Json(GitDiffResponse {
        diff,
        truncated,
        workdir: state.workspace,
    }))
}

pub(super) async fn stage_path(
    State(state): State<RuntimeApiState>,
    Json(request): Json<GitStageRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !collect_workspace_status(&state.workspace).git_repo {
        return Err(ApiError::bad_request("Workspace is not a git repository"));
    }
    let path = validate_workspace_relative_path(&request.path)?;
    let args = if request.unstage {
        vec!["restore", "--staged", "--", path.as_str()]
    } else {
        vec!["add", "--", path.as_str()]
    };
    let output = Git::output(&args, &state.workspace)
        .map_err(|e| ApiError::internal(format!("Failed to run git stage: {e}")))?;
    if !output.status.success() {
        return Err(ApiError::bad_request(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(Json(serde_json::json!({
        "ok": true,
        "path": path,
        "unstaged": request.unstage,
    })))
}

pub(super) fn collect_workspace_status(workspace: &FsPath) -> WorkspaceStatusResponse {
    let mut status = WorkspaceStatusResponse {
        workspace: workspace.to_path_buf(),
        git_repo: false,
        branch: None,
        head: None,
        dirty: false,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        ahead: None,
        behind: None,
    };

    let Some(repo_check) = run_git(workspace, &["rev-parse", "--is-inside-work-tree"]) else {
        return status;
    };
    if repo_check.trim() != "true" {
        return status;
    }

    status.git_repo = true;
    let metadata = collect_workspace_git_metadata(workspace);
    status.branch = metadata.branch;
    status.head = metadata.head;
    status.dirty = metadata.dirty;

    if let Some(porcelain) = run_git(workspace, &["status", "--porcelain=v1"]) {
        for line in porcelain.lines() {
            if line.starts_with("??") {
                status.untracked += 1;
                continue;
            }
            let chars: Vec<char> = line.chars().collect();
            if chars.len() >= 2 {
                if chars[0] != ' ' {
                    status.staged += 1;
                }
                if chars[1] != ' ' {
                    status.unstaged += 1;
                }
            }
        }
    }

    if let Some(counts) = run_git(
        workspace,
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    ) {
        let mut parts = counts.split_whitespace();
        if let (Some(behind), Some(ahead)) = (parts.next(), parts.next()) {
            status.behind = behind.parse::<u32>().ok();
            status.ahead = ahead.parse::<u32>().ok();
        }
    }

    status
}

pub(super) fn collect_workspace_git_metadata(workspace: &FsPath) -> WorkspaceGitMetadata {
    let Some(repo_check) = run_git(workspace, &["rev-parse", "--is-inside-work-tree"]) else {
        return WorkspaceGitMetadata::default();
    };
    if repo_check.trim() != "true" {
        return WorkspaceGitMetadata::default();
    }

    WorkspaceGitMetadata {
        branch: current_git_branch(workspace),
        head: current_git_head(workspace),
        dirty: run_git(workspace, &["status", "--porcelain=v1"])
            .is_some_and(|porcelain| !porcelain.trim().is_empty()),
    }
}

/// Discard local changes to one path: 'git checkout --' restores tracked
/// modifications/deletions, 'git clean -f --' removes untracked files. The
/// clean only runs after checkout so ignored files are never touched.
pub(super) async fn discard_path(
    State(state): State<RuntimeApiState>,
    Json(request): Json<GitDiscardRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !collect_workspace_status(&state.workspace).git_repo {
        return Err(ApiError::bad_request("Workspace is not a git repository"));
    }
    let path = validate_workspace_relative_path(&request.path)?;
    let checkout = Git::output(&["checkout", "--", path.as_str()], &state.workspace)
        .map_err(|e| ApiError::internal(format!("Failed to run git checkout: {e}")))?;
    if !checkout.status.success() {
        // checkout fails on a path with no tracked changes. That is only OK
        // when the path is untracked (??) — the clean below then removes it.
        let status = run_git(
            &state.workspace,
            &["status", "--porcelain", "--", path.as_str()],
        )
        .unwrap_or_default();
        if !status.lines().any(|line| line.starts_with("??")) {
            return Err(ApiError::bad_request(
                String::from_utf8_lossy(&checkout.stderr).trim().to_string(),
            ));
        }
    }
    let clean = Git::output(&["clean", "-f", "--", path.as_str()], &state.workspace)
        .map_err(|e| ApiError::internal(format!("Failed to run git clean: {e}")))?;
    if !clean.status.success() {
        return Err(ApiError::bad_request(
            String::from_utf8_lossy(&clean.stderr).trim().to_string(),
        ));
    }
    Ok(Json(serde_json::json!({
        "ok": true,
        "path": path,
    })))
}

/// Apply (or reverse) one unified-diff hunk against the workspace.
///
/// This exists so the desktop Review panel's per-hunk Stage/Revert buttons can
/// go through the Runtime instead of the Tauri process spawning `git apply`
/// itself (`desktop-tauri/src-tauri/src/git_cmds.rs:104`). That desktop command
/// takes a caller-supplied `workdir` and arbitrary patch text; this route is
/// bound to `state.workspace` and validates `path` as workspace-relative, so the
/// only thing a caller controls is *which hunk of which tracked file* moves.
///
/// The hunk body itself cannot be validated as a path can — it is patch syntax.
/// What is checked instead: the target path may not escape the workspace, and
/// `git apply` runs with `--unsafe-paths` withheld so a patch naming a path
/// outside the repo is rejected by git rather than by this code.
#[derive(Debug, Deserialize)]
pub(super) struct GitApplyHunkRequest {
    /// Workspace-relative path the hunk belongs to.
    pub(super) path: String,
    /// A standalone unified diff for exactly one hunk (`buildHunkPatch` output).
    pub(super) patch: String,
    /// Reverse the hunk (revert) instead of applying it.
    #[serde(default)]
    pub(super) reverse: bool,
    /// Apply against the index (`--cached`) rather than the worktree.
    #[serde(default)]
    pub(super) cached: bool,
}

/// Upper bound on one hunk patch. A single hunk is at most a few hundred lines;
/// 1 MiB is far above any real hunk and keeps a malformed or hostile body from
/// being piped into git unbounded.
const MAX_HUNK_PATCH_BYTES: usize = 1024 * 1024;

/// Apply or reverse one hunk against the workspace.
///
/// `git apply` reads the diff from stdin, so this uses `std::process::Command`
/// directly rather than `Git::output` (which is argv-only). The argv is a fixed
/// literal list, so nothing in the request can influence the command line — the
/// patch reaches git as data on stdin, never as arguments.
pub(super) async fn apply_hunk(
    State(state): State<RuntimeApiState>,
    Json(request): Json<GitApplyHunkRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !collect_workspace_status(&state.workspace).git_repo {
        return Err(ApiError::bad_request("Workspace is not a git repository"));
    }
    let path = validate_workspace_relative_path(&request.path)?;
    if request.patch.len() > MAX_HUNK_PATCH_BYTES {
        return Err(ApiError::bad_request(format!(
            "Hunk patch is {} bytes, over the {MAX_HUNK_PATCH_BYTES} byte limit",
            request.patch.len()
        )));
    }
    if request.patch.trim().is_empty() {
        return Err(ApiError::bad_request("Hunk patch is empty"));
    }

    // `--cached` targets the index, so it is what makes "Stage hunk" stage and
    // "Revert hunk" (reverse, on the worktree) discard. `--recount` lets git
    // recompute hunk line counts, which the desktop's rebuild can make stale
    // when it flips `+`/`-` for a reverse apply.
    let mut args = vec!["apply", "--recount"];
    if request.reverse {
        args.push("--reverse");
    }
    if request.cached {
        args.push("--cached");
    }
    args.push("-");

    let output = apply_hunk_stdin(&args, &state.workspace, &request.patch)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(ApiError::bad_request(if stderr.is_empty() {
            "git apply rejected the hunk".to_string()
        } else {
            stderr
        }));
    }

    Ok(Json(serde_json::json!({
        "ok": true,
        "path": path,
        "reverse": request.reverse,
        "cached": request.cached,
    })))
}

fn apply_hunk_stdin(
    args: &[&str],
    workspace: &FsPath,
    patch: &str,
) -> Result<std::process::Output, ApiError> {
    use std::io::Write as _;
    use std::process::{Command, Stdio};

    let program = Git::resolve().unwrap_or_else(|| "git".to_string());
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x0800_0000);
    }

    let mut child = command
        .spawn()
        .map_err(|e| ApiError::internal(format!("Failed to run git apply: {e}")))?;
    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| ApiError::internal("git apply stdin unavailable"))?;
        stdin
            .write_all(patch.as_bytes())
            .map_err(|e| ApiError::internal(format!("Failed to send the hunk to git: {e}")))?;
    }
    // Dropping stdin above closes the pipe, so git sees EOF and applies.
    child
        .wait_with_output()
        .map_err(|e| ApiError::internal(format!("git apply did not finish: {e}")))
}

/// Create a git worktree inside the workspace.
///
/// This exists so the desktop's worktree creation goes through the Runtime
/// instead of the Tauri process spawning `git worktree add` itself with a
/// caller-supplied `workdir`. The route is bound to `state.workspace`, `path`
/// must be workspace-relative, and both branch names go through
/// `validate_git_reference`, so the caller controls only *where inside the
/// workspace* the worktree lands and *which ref* it tracks — never the
/// repository or the argv shape.
#[derive(Debug, Deserialize)]
pub(super) struct GitWorktreeRequest {
    /// Workspace-relative directory the worktree is created in. It must not
    /// exist yet; git rejects an existing non-empty destination itself.
    pub(super) path: String,
    /// Create and check out a new branch (`git worktree add -b`).
    #[serde(default)]
    pub(super) new_branch: Option<String>,
    /// Check out an existing branch instead of the default one.
    #[serde(default)]
    pub(super) branch: Option<String>,
}

pub(super) async fn add_worktree(
    State(state): State<RuntimeApiState>,
    Json(request): Json<GitWorktreeRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !collect_workspace_status(&state.workspace).git_repo {
        return Err(ApiError::bad_request("Workspace is not a git repository"));
    }
    let path = validate_workspace_relative_path(&request.path)?;
    let new_branch = request
        .new_branch
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(validate_git_reference)
        .transpose()?;
    let branch = request
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(validate_git_reference)
        .transpose()?;

    let mut args: Vec<&str> = vec!["worktree", "add"];
    if let Some(name) = new_branch.as_deref() {
        args.push("-b");
        args.push(name);
    }
    args.push(path.as_str());
    if let Some(name) = branch.as_deref() {
        args.push(name);
    }
    let output = Git::output(&args, &state.workspace)
        .map_err(|e| ApiError::internal(format!("Failed to run git worktree add: {e}")))?;
    if !output.status.success() {
        return Err(ApiError::bad_request(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(Json(serde_json::json!({
        "ok": true,
        "path": path,
        "new_branch": new_branch,
        "branch": branch,
    })))
}

fn run_git(workspace: &FsPath, args: &[&str]) -> Option<String> {
    let output = Git::output(args, workspace).ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

fn parse_git_status(
    porcelain: &str,
) -> (Vec<GitFileChange>, Vec<GitFileChange>, Vec<GitFileChange>) {
    let mut unstaged = Vec::new();
    let mut staged = Vec::new();
    let mut untracked = Vec::new();
    for record in porcelain.split('\0').filter(|record| !record.is_empty()) {
        let bytes = record.as_bytes();
        if bytes.len() < 3 {
            continue;
        }
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let raw_path = record[3..].to_string();
        let path = raw_path
            .rsplit_once(" -> ")
            .map_or(raw_path.as_str(), |(_, new_path)| new_path)
            .to_string();
        if x == '?' && y == '?' {
            untracked.push(GitFileChange {
                path,
                status: "untracked".to_string(),
                staged: false,
            });
            continue;
        }
        let status = git_status_label(if x != ' ' { x } else { y });
        if x != ' ' {
            staged.push(GitFileChange {
                path: path.clone(),
                status: status.clone(),
                staged: true,
            });
        }
        if y != ' ' {
            unstaged.push(GitFileChange {
                path,
                status,
                staged: false,
            });
        }
    }
    (unstaged, staged, untracked)
}

fn git_status_label(status: char) -> String {
    match status {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' | 'C' => "renamed",
        _ => "unknown",
    }
    .to_string()
}

fn validate_workspace_relative_path(raw: &str) -> Result<String, ApiError> {
    let path = std::path::Path::new(raw.trim());
    if raw.trim().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::RootDir
            )
        })
        || raw.contains('\0')
    {
        return Err(ApiError::bad_request(
            "Git path must be a non-empty relative path inside the workspace",
        ));
    }
    Ok(raw.trim().replace('\\', "/"))
}

fn parse_git_paths(raw: Option<&str>) -> Result<Vec<String>, ApiError> {
    raw.unwrap_or_default()
        .split(',')
        .filter(|path| !path.trim().is_empty())
        .map(validate_workspace_relative_path)
        .collect()
}

fn validate_git_reference(raw: &str) -> Result<String, ApiError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.contains('\0') {
        return Err(ApiError::bad_request("Invalid git reference"));
    }
    Ok(trimmed.to_string())
}

fn current_git_branch(workspace: &FsPath) -> Option<String> {
    let repo_check = run_git(workspace, &["rev-parse", "--is-inside-work-tree"])?;
    if repo_check.trim() != "true" {
        return None;
    }
    let branch = run_git(workspace, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = branch.trim();
    if branch.is_empty() {
        return None;
    }
    if branch != "HEAD" {
        return Some(branch.to_string());
    }
    let short_hash = run_git(workspace, &["rev-parse", "--short", "HEAD"])?;
    let short_hash = short_hash.trim();
    (!short_hash.is_empty()).then(|| format!("detached@{short_hash}"))
}

fn current_git_head(workspace: &FsPath) -> Option<String> {
    let head = run_git(workspace, &["rev-parse", "--short", "HEAD"])?;
    let head = head.trim();
    (!head.is_empty()).then(|| head.to_string())
}
