//! Canonical user-scoped runtime path resolution for Hakus.
//!
//! This leaf crate owns only the environment and platform-home decision. File
//! migration and per-subsystem fallback remain with the crate that owns those
//! files.
#![deny(missing_docs)]

use std::ffi::OsString;
use std::fmt;
use std::path::PathBuf;

/// Canonical Hakus app directory name under the user home.
pub const HAKUS_APP_DIR: &str = ".hakus";

/// Historical name kept only for source compatibility with old test fixtures.
/// Runtime path resolution never uses this directory.
#[deprecated(note = "legacy path is not read or written by Hakus")]
pub const LEGACY_APP_DIR: &str = ".deepseek";

/// An environment-provided runtime path was not safe to use as a global path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathOverrideError {
    variable: &'static str,
    path: PathBuf,
    kind: PathOverrideErrorKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PathOverrideErrorKind {
    Relative,
    HomeUnavailable,
}

impl fmt::Display for PathOverrideError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.kind {
            PathOverrideErrorKind::Relative => write!(
                formatter,
                "{} must be an absolute path, got {}",
                self.variable,
                self.path.display()
            ),
            PathOverrideErrorKind::HomeUnavailable => write!(
                formatter,
                "{} uses '~', but the user home directory could not be resolved: {}",
                self.variable,
                self.path.display()
            ),
        }
    }
}

impl std::error::Error for PathOverrideError {}

/// Return the explicit Hakus home override, if one is configured.
///
/// Unicode values are trimmed so whitespace-only values are treated as unset,
/// matching the existing config and secret-store contract. Non-Unicode path
/// values are preserved on platforms that support them instead of silently
/// dropping an otherwise valid filesystem path. A leading `~` is expanded;
/// every other relative value is rejected.
pub fn hakus_home_override() -> Result<Option<PathBuf>, PathOverrideError> {
    absolute_path_env("HAKUS_HOME")
}

/// Whether `HAKUS_HOME` establishes an explicit isolation boundary.
#[must_use]
pub fn hakus_home_is_explicit() -> bool {
    path_env("HAKUS_HOME").is_some()
}

/// Resolve the user's platform home, preferring `HOME` before `USERPROFILE`.
///
/// The explicit environment order makes CLI, state, config, and secret paths
/// deterministic in hermetic shells. On Windows, `HOMEDRIVE` plus `HOMEPATH`
/// remains a compatibility fallback before the platform resolver. The platform
/// resolver remains last for ordinary desktop launches without those variables.
#[must_use]
pub fn user_home() -> Option<PathBuf> {
    path_env("HOME")
        .or_else(|| path_env("USERPROFILE"))
        .or_else(windows_home_from_environment)
        .or_else(dirs::home_dir)
}

#[cfg(windows)]
fn windows_home_from_environment() -> Option<PathBuf> {
    let mut path = path_env("HOMEDRIVE")?;
    path.push(path_env("HOMEPATH")?);
    (!path.as_os_str().is_empty()).then_some(path)
}

#[cfg(not(windows))]
fn windows_home_from_environment() -> Option<PathBuf> {
    None
}

/// Resolve the canonical Hakus runtime home.
///
/// A valid explicit `HAKUS_HOME` is returned after `~` expansion. Otherwise
/// this is `<user home>/.hakus`.
pub fn hakus_home() -> Result<Option<PathBuf>, PathOverrideError> {
    if let Some(path) = hakus_home_override()? {
        return Ok(Some(path));
    }
    if std::env::var("HAKUS_INSTALL_MODE")
        .ok()
        .is_some_and(|value| value.eq_ignore_ascii_case("installed"))
    {
        return Ok(user_home().map(|home| home.join(HAKUS_APP_DIR)));
    }
    let root = path_env("HAKUS_DATA_DIR")
        .or_else(|| std::env::current_dir().ok())
        .or_else(|| user_home());
    Ok(root.map(|path| path.join(HAKUS_APP_DIR)))
}

/// Return the explicit config-file override, preferring the Hakus name.
///
/// `~` is expanded through the canonical user-home resolver before the path is
/// validated. All other relative paths are rejected so a process working in a
/// repository can never turn a global config override into a repo-local file.
pub fn config_path_override() -> Result<Option<PathBuf>, PathOverrideError> {
    absolute_path_env("HAKUS_CONFIG_PATH")
}

/// Read an optional path environment variable and require a global path.
///
/// Empty and whitespace-only values are treated as unset. A leading `~` path
/// is expanded first; any path still relative after expansion is rejected.
pub fn absolute_path_env(variable: &'static str) -> Result<Option<PathBuf>, PathOverrideError> {
    path_env(variable)
        .map(|path| validate_absolute_path(variable, path))
        .transpose()
}

/// Expand a leading `~` and reject a path that is not absolute.
pub fn validate_absolute_path(
    variable: &'static str,
    path: PathBuf,
) -> Result<PathBuf, PathOverrideError> {
    let original = path.clone();
    let path = match path.to_str() {
        Some("~") => user_home().ok_or_else(|| PathOverrideError {
            variable,
            path: original.clone(),
            kind: PathOverrideErrorKind::HomeUnavailable,
        })?,
        Some(value)
            if value
                .strip_prefix('~')
                .is_some_and(|suffix| suffix.starts_with('/') || suffix.starts_with('\\')) =>
        {
            let mut home = user_home().ok_or_else(|| PathOverrideError {
                variable,
                path: original.clone(),
                kind: PathOverrideErrorKind::HomeUnavailable,
            })?;
            let suffix = value[1..].trim_start_matches(['/', '\\']);
            if !suffix.is_empty() {
                home.push(suffix);
            }
            home
        }
        _ => path,
    };

    if path.is_absolute() {
        Ok(path)
    } else {
        Err(PathOverrideError {
            variable,
            path: original,
            kind: PathOverrideErrorKind::Relative,
        })
    }
}

fn path_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).and_then(normalize_path_value)
}

fn normalize_path_value(value: OsString) -> Option<PathBuf> {
    if value.is_empty() {
        return None;
    }
    match value.to_str() {
        Some(value) => {
            let value = value.trim();
            (!value.is_empty()).then(|| PathBuf::from(value))
        }
        None => Some(PathBuf::from(value)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_path_values_are_trimmed_and_whitespace_is_unset() {
        assert_eq!(
            normalize_path_value(OsString::from("  /tmp/hakus  ")),
            Some(PathBuf::from("/tmp/hakus"))
        );
        assert_eq!(normalize_path_value(OsString::from(" \t\n ")), None);
        assert_eq!(normalize_path_value(OsString::new()), None);
    }

    #[test]
    fn relative_global_overrides_are_rejected_with_the_variable_name() {
        let error =
            validate_absolute_path("HAKUS_CONFIG_PATH", PathBuf::from(".hakus/config.toml"))
                .expect_err("relative global config path must fail closed");
        let message = error.to_string();
        assert!(message.contains("HAKUS_CONFIG_PATH"), "{message}");
        assert!(message.contains(".hakus/config.toml"), "{message}");
        assert!(message.contains("absolute"), "{message}");
    }

    #[test]
    fn absolute_global_overrides_are_preserved() {
        let path = if cfg!(windows) {
            PathBuf::from(r"C:\hakus\config.toml")
        } else {
            PathBuf::from("/tmp/hakus/config.toml")
        };
        assert_eq!(
            validate_absolute_path("HAKUS_CONFIG_PATH", path.clone()),
            Ok(path)
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_non_unicode_path_values_are_preserved() {
        use std::os::unix::ffi::OsStringExt;

        let value = OsString::from_vec(b"hakus-\xff-home".to_vec());
        assert_eq!(
            normalize_path_value(value.clone()),
            Some(PathBuf::from(value))
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_non_unicode_path_values_are_preserved() {
        use std::os::windows::ffi::OsStringExt;

        let value = OsString::from_wide(&[b'C' as u16, b':' as u16, b'\\' as u16, 0xd800]);
        assert_eq!(
            normalize_path_value(value.clone()),
            Some(PathBuf::from(value))
        );
    }
}
