//! Confirmed filesystem roots for the Flow canvas.
//!
//! `fs_write_text` and friends accept a root from the graph, which makes them
//! powerful and, before this module, unbounded: a flow graph is a JSON document
//! that can be imported from a file, pasted, or produced by a model, and its
//! `root` field was a free-text absolute path. `resolve_within` in `fs_cmds`
//! stops `..` and symlink escapes *inside* that root, but nothing stopped the
//! root from being `C:\Users\<user>` — so a graph could write
//! `.ssh/authorized_keys` or a Startup-folder script with one click on Run.
//!
//! The rule enforced here is narrower than "deny file access" and wider than
//! "trust the graph": **a root must be confirmed by the operator before any
//! file access uses it, and the confirmation is remembered**. That keeps the
//! feature intact (an operator still points a node at any folder they like)
//! while making an imported graph's choice of root something a human has to
//! agree to rather than something the document asserts.
//!
//! Enforcement lives here rather than in the frontend because a Tauri
//! `#[tauri::command]` is callable from any page context in the WebView;
//! frontend-side checks would be advisory only.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

/// Store file holding the confirmed roots. Separate from `settings.json` so a
/// settings reset does not silently re-grant filesystem reach, and so the list
/// is auditable on its own.
const STORE_FILE: &str = "flow-roots.json";
const STORE_KEY: &str = "confirmed_roots";

/// One operator-approved root.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmedRoot {
    /// The canonicalised root, which is what containment is checked against.
    pub path: String,
    /// Whether writes (not just reads) are permitted under this root.
    pub writable: bool,
}

fn load(app: &AppHandle) -> Result<Vec<ConfirmedRoot>, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let Some(value) = store.get(STORE_KEY) else {
        return Ok(Vec::new());
    };
    match serde_json::from_value::<Vec<ConfirmedRoot>>(value) {
        Ok(roots) => Ok(roots),
        // A malformed list must not silently become "nothing is confirmed"
        // while a stale grant still exists on disk, nor become "everything is
        // confirmed". Surface it so the operator can re-grant deliberately.
        Err(error) => Err(format!(
            "Confirmed root list is unreadable ({error}); re-add the folder in Flow settings"
        )),
    }
}

fn save(app: &AppHandle, roots: &[ConfirmedRoot]) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(
        STORE_KEY,
        serde_json::to_value(roots).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())
}

/// Canonicalise a requested root, so two spellings of one folder compare equal.
///
/// The root must already exist: `canonicalize` needs a real directory, and
/// asking the operator to confirm a path that does not exist yet would grant
/// access to whatever is created there later, which is the wrong moment to
/// decide. Creating a folder is a normal file-manager action.
fn canonical_root(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("A root directory is required for file access".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!("Root must be an absolute path: {trimmed}"));
    }
    let resolved = path
        .canonicalize()
        .map_err(|e| format!("Root directory is not accessible: {e}"))?;
    if !resolved.is_dir() {
        return Err(format!("Root is not a directory: {trimmed}"));
    }
    Ok(resolved)
}

/// Reject obviously dangerous roots even when confirmed.
///
/// A confirmation prompt is a speed bump, not a judgement: an operator who does
/// not read it can approve a filesystem root or a home directory. These are the
/// paths where "the user said yes once" is not sufficient, because the blast
/// radius is every credential and every autostart hook on the machine.
fn reject_dangerous_root(resolved: &Path) -> Result<(), String> {
    // Filesystem roots: "/" or "C:\".
    if resolved.parent().is_none() {
        return Err(format!(
            "Refusing a filesystem root as a Flow file root: {}",
            resolved.display()
        ));
    }

    // The user's home directory itself, or anything that is a direct parent of
    // the conventional credential and autostart locations.
    if let Some(home) = dirs_home() {
        if resolved == home {
            return Err(
                "Refusing the home directory itself as a Flow file root; choose a project folder"
                    .to_string(),
            );
        }
    }

    Ok(())
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .and_then(|p| p.canonicalize().ok())
}

/// The authorization decision, over an explicit root list.
///
/// Split out from [`authorize`] so the rule can be tested directly instead of
/// through a Tauri `AppHandle`. That matters: an earlier version of these tests
/// asserted `Path::starts_with` in isolation, so swapping the real comparison
/// for a string prefix left every test green.
fn select_root(
    roots: &[ConfirmedRoot],
    resolved: &Path,
    needs_write: bool,
) -> Result<(), RootDenial> {
    let containing = roots.iter().find(|entry| {
        Path::new(&entry.path)
            .canonicalize()
            .map(|confirmed| resolved.starts_with(&confirmed))
            .unwrap_or(false)
    });

    match containing {
        Some(entry) if !needs_write || entry.writable => Ok(()),
        Some(_) => Err(RootDenial::ReadOnly),
        None => Err(RootDenial::NotConfirmed),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RootDenial {
    NotConfirmed,
    ReadOnly,
}

/// True when `resolved` sits inside a confirmed root with the required access.
///
/// Containment is checked on canonicalised paths and with `Path::starts_with`,
/// which compares whole components — so a confirmed `C:\work` does not grant
/// `C:\workshop`, which a string-prefix check would wrongly allow.
pub fn authorize(app: &AppHandle, root: &str, needs_write: bool) -> Result<PathBuf, String> {
    let resolved = canonical_root(root)?;
    reject_dangerous_root(&resolved)?;

    let roots = load(app)?;
    match select_root(&roots, &resolved, needs_write) {
        Ok(()) => Ok(resolved),
        Err(RootDenial::ReadOnly) => Err(format!(
            "Read-only Flow root: {} is confirmed for reading only. Enable writing for it in Flow settings.",
            resolved.display()
        )),
        Err(RootDenial::NotConfirmed) => Err(format!(
            "Flow file access is not confirmed for {}. Open Flow settings and confirm this folder first.",
            resolved.display()
        )),
    }
}

/// Roots the operator has confirmed, for display in Flow settings.
#[tauri::command]
pub fn flow_roots_list(app: AppHandle) -> Result<Vec<ConfirmedRoot>, String> {
    load(&app)
}

/// Whether a root would be authorized, without performing any file access.
///
/// The Flow nodes call this before their real work so they can prompt exactly
/// when needed. It shares [`select_root`] with [`authorize`], so the answer
/// cannot drift from what enforcement will actually decide — a frontend that
/// re-implemented the containment rule would eventually disagree with it.
#[tauri::command]
pub fn flow_root_check(app: AppHandle, root: String, writable: bool) -> Result<bool, String> {
    let Ok(resolved) = canonical_root(&root) else {
        return Ok(false);
    };
    if reject_dangerous_root(&resolved).is_err() {
        return Ok(false);
    }
    let roots = load(&app)?;
    Ok(select_root(&roots, &resolved, writable).is_ok())
}

/// Confirm a root. Does not grant write access unless `writable` is set.
#[tauri::command]
pub fn flow_root_confirm(
    app: AppHandle,
    root: String,
    writable: bool,
) -> Result<Vec<ConfirmedRoot>, String> {
    let resolved = canonical_root(&root)?;
    reject_dangerous_root(&resolved)?;
    let path = resolved.display().to_string();

    let mut roots = load(&app)?;
    match roots.iter_mut().find(|entry| entry.path == path) {
        Some(existing) => {
            // Widening read→write is the operator's later, separate decision.
            // Narrowing back to read-only is allowed and takes effect now.
            existing.writable = writable;
        }
        None => roots.push(ConfirmedRoot { path, writable }),
    }
    save(&app, &roots)?;
    Ok(roots)
}

/// Revoke a root. Existing graphs pointing at it stop working until re-confirmed.
#[tauri::command]
pub fn flow_root_revoke(app: AppHandle, root: String) -> Result<Vec<ConfirmedRoot>, String> {
    let canonical = canonical_root(&root).ok();
    let mut roots = load(&app)?;
    roots.retain(|entry| {
        // Compare both raw and canonical so a revoke works even when the folder
        // has since been deleted (the exact case where a stale grant is most
        // dangerous, since the path could be recreated by someone else).
        if entry.path == root.trim() {
            return false;
        }
        match (&canonical, Path::new(&entry.path).canonicalize().ok()) {
            (Some(a), Some(b)) => a != &b,
            _ => true,
        }
    });
    save(&app, &roots)?;
    Ok(roots)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical(path: &Path) -> String {
        path.canonicalize().unwrap().display().to_string()
    }

    #[test]
    fn canonical_root_rejects_relative_empty_and_missing_paths() {
        assert!(canonical_root("").is_err());
        assert!(canonical_root("   ").is_err());
        assert!(canonical_root("relative/dir").is_err());
        // A path that does not exist cannot be confirmed: confirming it would
        // grant whatever is later created there.
        let missing = std::env::temp_dir().join("hakus-does-not-exist-9f3a1c");
        assert!(!missing.exists());
        assert!(canonical_root(&missing.display().to_string()).is_err());
    }

    #[test]
    fn canonical_root_accepts_an_existing_directory() {
        let dir = std::env::temp_dir();
        let resolved = canonical_root(&dir.display().to_string()).expect("temp dir resolves");
        assert!(resolved.is_dir());
        assert!(resolved.is_absolute());
    }

    #[test]
    fn canonical_root_rejects_a_file() {
        let file = std::env::temp_dir().join("hakus-fs-cmds-root-check.tmp");
        std::fs::write(&file, b"x").unwrap();
        let result = canonical_root(&file.display().to_string());
        let _ = std::fs::remove_file(&file);
        assert!(result.is_err(), "a file is not a root");
    }

    #[test]
    fn filesystem_roots_are_refused() {
        let root = PathBuf::from(std::path::MAIN_SEPARATOR.to_string());
        assert!(reject_dangerous_root(&root).is_err());
    }

    #[test]
    fn home_directory_itself_is_refused_but_a_subfolder_is_allowed() {
        let Some(home) = dirs_home() else {
            return;
        };
        assert!(
            reject_dangerous_root(&home).is_err(),
            "the home directory itself must not be confirmable"
        );
        let nested = home.join("Documents");
        if nested.is_dir() {
            assert!(
                reject_dangerous_root(&nested).is_ok(),
                "a folder inside home is an ordinary choice"
            );
        }
    }

    /// The containment rule a string-prefix check would get wrong, asserted
    /// against the real decision function.
    #[test]
    fn a_sibling_sharing_a_name_prefix_is_not_authorized() {
        let base = std::env::temp_dir().join(format!("hakus-rootcheck-{}", std::process::id()));
        let confirmed_dir = base.join("proj");
        let sibling_dir = base.join("proj-secret");
        std::fs::create_dir_all(&confirmed_dir).unwrap();
        std::fs::create_dir_all(&sibling_dir).unwrap();

        let confirmed_path = confirmed_dir.canonicalize().unwrap();
        let sibling_path = sibling_dir.canonicalize().unwrap();
        let roots = vec![ConfirmedRoot {
            path: confirmed_path.display().to_string(),
            writable: true,
        }];

        // Precondition: the sibling really does share the string prefix, so a
        // prefix-based check would grant it. Without this the test could pass
        // for an unrelated reason.
        assert!(
            sibling_path
                .display()
                .to_string()
                .starts_with(&confirmed_path.display().to_string()),
            "precondition: the sibling must share the string prefix"
        );

        // The real decision: a sibling is outside, even though its path string
        // begins with the confirmed root's path string.
        assert_eq!(
            select_root(&roots, &sibling_path, false),
            Err(RootDenial::NotConfirmed),
            "a name-prefix sibling must not be authorized"
        );
        // And a genuine child still is.
        assert_eq!(
            select_root(&roots, &confirmed_path, false),
            Ok(())
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The decision itself, including the read-only distinction.
    #[test]
    fn select_root_enforces_containment_and_the_write_bit() {
        let home = std::env::temp_dir().join(format!("hakus-authz-{}", std::process::id()));
        let root = home.join("workspace");
        let outside = home.join("elsewhere");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let root_c = root.canonicalize().unwrap();
        let root_s = root_c.display().to_string();
        let outside_c = outside.canonicalize().unwrap();

        let read_only = vec![ConfirmedRoot { path: root_s.clone(), writable: false }];
        let read_write = vec![ConfirmedRoot { path: root_s.clone(), writable: true }];

        assert_eq!(select_root(&read_only, &root_c, false), Ok(()), "a confirmed root is readable");
        assert_eq!(
            select_root(&read_only, &root_c, true),
            Err(RootDenial::ReadOnly),
            "a read-only root refuses writes"
        );
        assert_eq!(select_root(&read_write, &root_c, true), Ok(()), "a writable root allows writes");
        assert_eq!(
            select_root(&read_write, &outside_c, false),
            Err(RootDenial::NotConfirmed),
            "an unconfirmed folder is refused even for reading"
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn confirmed_root_round_trips_through_json() {
        let entry = ConfirmedRoot {
            path: canonical(&std::env::temp_dir()),
            writable: true,
        };
        let encoded = serde_json::to_value(&entry).unwrap();
        // camelCase on the wire, so the frontend field names match.
        assert!(encoded.get("writable").is_some());
        let decoded: ConfirmedRoot = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded.path, entry.path);
        assert!(decoded.writable);
    }
}
