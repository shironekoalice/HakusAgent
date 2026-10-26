/**
 * Filesystem commands for the Flow canvas node.
 *
 * File access from a graph is powerful, so it is deliberately constrained:
 * - the requested root must have been **confirmed by the operator** before any
 *   access uses it (`flow_roots::authorize`). The root still comes from the
 *   graph, but a graph is an importable JSON document, so its choice of root is
 *   a proposal the operator agrees to rather than an assertion that takes
 *   effect;
 * - every path is resolved INSIDE that root, and `..` cannot escape it (checked
 *   after canonicalisation, not by string matching);
 * - writes only ever create or replace a file — never a directory tree walk;
 * - size caps bound memory.
 *
 * The two layers are complementary and neither is sufficient alone: the
 * confirmation decides *which folder* is in play, and `resolve_within` decides
 * *what inside it* is reachable.
 */

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::flow_roots;

const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
const MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;

/// Resolve `relative` inside `root`, rejecting anything that escapes.
///
/// Containment is verified on the canonicalised paths so symlinks and `..`
/// segments cannot slip past a naive string check. When `create_parents` is
/// set the missing parent chain is created first (write path only) — the
/// containment check still runs afterwards, against the real directories.
fn resolve_within(root: &Path, relative: &str, create_parents: bool) -> Result<PathBuf, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("Root directory is not accessible: {e}"))?;
    let trimmed = relative.trim().trim_start_matches(['/', '\\']);
    let candidate = root.join(trimmed);
    if candidate
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        // Reject `..` outright rather than relying on the resolution below:
        // an explicit message is clearer, and it cannot be bypassed.
        return Err(format!("Path must not contain '..': {trimmed}"));
    }

    let resolved = if candidate.exists() {
        candidate
            .canonicalize()
            .map_err(|e| format!("Cannot resolve path: {e}"))?
    } else {
        let parent = candidate
            .parent()
            .ok_or_else(|| "Invalid path".to_string())?;
        let parent = if create_parents {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
            parent
                .canonicalize()
                .map_err(|e| format!("Cannot resolve parent directory: {e}"))?
        } else {
            parent
                .canonicalize()
                .map_err(|e| format!("Parent directory is not accessible: {e}"))?
        };
        let name = candidate
            .file_name()
            .ok_or_else(|| "Invalid file name".to_string())?;
        parent.join(name)
    };

    if !resolved.starts_with(&root) {
        return Err(format!(
            "Path escapes the configured root: {trimmed}"
        ));
    }
    Ok(resolved)
}

/// Strip the Verbatim prefix that Windows canonicalisation adds, so paths in
/// the UI and in graph data stay the ones the operator typed.
fn display_path(path: &Path) -> String {
    let s = path.display().to_string();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileReadResult {
    pub content: String,
    pub path: String,
    pub bytes: u64,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub bytes: u64,
}

#[tauri::command]
pub async fn fs_read_text(
    app: AppHandle,
    root: String,
    path: String,
) -> Result<FileReadResult, String> {
    let root = flow_roots::authorize(&app, &root, false)?;
    let target = resolve_within(&root, &path, false)?;
    let meta = tokio::fs::metadata(&target)
        .await
        .map_err(|e| format!("Cannot stat {}: {e}", target.display()))?;
    if meta.is_dir() {
        return Err(format!("{} is a directory", target.display()));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "File is {} bytes, over the {} byte read limit",
            meta.len(),
            MAX_READ_BYTES
        ));
    }
    let bytes = tokio::fs::read(&target)
        .await
        .map_err(|e| format!("Cannot read {}: {e}", target.display()))?;
    Ok(FileReadResult {
        content: String::from_utf8_lossy(&bytes).to_string(),
        path: display_path(&target),
        bytes: meta.len(),
    })
}

#[tauri::command]
pub async fn fs_write_text(
    app: AppHandle,
    root: String,
    path: String,
    content: String,
) -> Result<String, String> {
    let root = flow_roots::authorize(&app, &root, true)?;
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "Content is {} bytes, over the {} byte write limit",
            content.len(),
            MAX_WRITE_BYTES
        ));
    }
    let target = resolve_within(&root, &path, true)?;
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }
    tokio::fs::write(&target, content.as_bytes())
        .await
        .map_err(|e| format!("Cannot write {}: {e}", target.display()))?;
    Ok(display_path(&target))
}

#[tauri::command]
pub async fn fs_list_dir(
    app: AppHandle,
    root: String,
    path: String,
) -> Result<Vec<DirEntry>, String> {
    let root = flow_roots::authorize(&app, &root, false)?;
    let target = resolve_within(&root, &path, false)?;
    let mut entries = Vec::new();
    let mut reader = tokio::fs::read_dir(&target)
        .await
        .map_err(|e| format!("Cannot list {}: {e}", target.display()))?;
    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|e| format!("Cannot read directory entry: {e}"))?
    {
        let meta = entry.metadata().await.ok();
        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: display_path(&entry.path()),
            is_dir: meta.as_ref().is_some_and(|m| m.is_dir()),
            bytes: meta.as_ref().map_or(0, |m| m.len()),
        });
    }
    // Directories first, then by name (case-insensitive).
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}
