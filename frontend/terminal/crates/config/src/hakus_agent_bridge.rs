//! HakusAgent `config.yaml` API-key discovery bridge.
//!
//! HakusCLI runs inside (or alongside) the HakusAgent repository, whose
//! backend keeps provider credentials in a root-level `config.yaml` under an
//! `api_keys:` map, e.g.
//!
//! ```yaml
//! api_keys:
//!   deepseek_api_key: ${DEEPSEEK_API_KEY:sk-...}
//!   glm_api_key: ${GLM_API_KEY:}
//! ```
//!
//! Resolution order stays: config.toml `[providers.*].api_key` → process env
//! → this bridge (walk up from the CWD for a `config.yaml` carrying an
//! `api_keys:` section). Values support the `${VAR:default}` expansion shape;
//! by the time this bridge runs the env leg has already missed, so the
//! default half is what we take. A plain scalar is used verbatim. Inline
//! comments and surrounding quotes are stripped.
//!
//! The lookup is cached — the file is small but the resolver is hot.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Provider-kind → HakusAgent `api_keys` field names, first hit wins.
/// The generic `<kind>_api_key` spelling is tried before these aliases.
const KEY_ALIASES: &[(&str, &[&str])] = &[
    // qwen credentials live under the DashScope brand in config.yaml
    ("qwen", &["dashscope_api_key", "qwen_api_key"]),
    ("dashscope", &["dashscope_api_key"]),
    // z.ai / GLM share one key in HakusAgent
    ("zai", &["glm_api_key", "zai_api_key"]),
    ("glm", &["glm_api_key"]),
    ("xiaomi-mimo", &["mimo_api_key"]),
    ("mimo", &["mimo_api_key"]),
    ("google-gemini", &["gemini_api_key", "google_api_key"]),
    ("gemini", &["gemini_api_key"]),
    ("opencode", &["opencode_api_key"]),
    ("opencode-go", &["opencode_api_key"]),
    ("opencode-zen", &["opencode_api_key"]),
];

pub fn api_key_for_provider(provider_kind: &str) -> Option<String> {
    // Kill switch — primarily for cargo-invoked test processes, which must not
    // see the developer's real keys through an ambient CWD walk. Set via
    // `.cargo/config.toml [env]` so `cargo test` isolates, while the shipped
    // binary (run directly) keeps discovery on.
    if std::env::var("HAKUS_AGENT_BRIDGE").as_deref() == Ok("0") {
        return None;
    }
    let keys = api_keys_map();
    let kind = provider_kind.trim().to_ascii_lowercase();
    let mut candidates: Vec<String> = Vec::new();
    if let Some((_, aliases)) = KEY_ALIASES.iter().find(|(k, _)| *k == kind) {
        candidates.extend(aliases.iter().map(|a| (*a).to_string()));
    }
    candidates.push(format!("{kind}_api_key"));
    candidates
        .into_iter()
        .find_map(|name| keys.get(&name).cloned())
        .filter(|v| !v.trim().is_empty())
}

fn api_keys_map() -> &'static std::collections::HashMap<String, String> {
    static CACHE: OnceLock<std::collections::HashMap<String, String>> = OnceLock::new();
    CACHE.get_or_init(|| {
        locate_config_yaml()
            .and_then(|path| std::fs::read_to_string(&path).ok())
            .map(|content| parse_api_keys(&content))
            .unwrap_or_default()
    })
}

/// Walk up from the CWD (and from the binary's directory as a second seed)
/// looking for a HakusAgent-style `config.yaml`. The `api_keys:` marker keeps
/// us from latching onto unrelated config.yaml files. `HAKUS_AGENT_CONFIG`
/// pins an explicit path when set.
fn locate_config_yaml() -> Option<PathBuf> {
    if let Ok(pinned) = std::env::var("HAKUS_AGENT_CONFIG") {
        // An explicit pin (even a missing file) disables discovery entirely —
        // explicit means explicit.
        let pinned = PathBuf::from(pinned);
        if pinned.is_file() {
            return Some(pinned);
        }
        return None;
    }
    let mut seeds = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        seeds.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent().map(Path::to_path_buf) {
            seeds.push(dir);
        }
    }
    for seed in seeds {
        let mut dir: &Path = &seed;
        for _ in 0..10 {
            let candidate = dir.join("config.yaml");
            if candidate.is_file() {
                if let Ok(content) = std::fs::read_to_string(&candidate) {
                    if content.lines().any(|l| l.trim_end() == "api_keys:") {
                        return Some(candidate);
                    }
                }
            }
            match dir.parent() {
                Some(parent) => dir = parent,
                None => break,
            }
        }
    }
    None
}

/// Minimal flat-map parser for the `api_keys:` section — top-level key,
/// one nesting level of `<name>: <value>` lines. No yaml dependency: the
/// shapes we care about are `${VAR:default}`, plain scalars, and quotes.
fn parse_api_keys(content: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let mut in_section = false;
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        let indent = line.len() - trimmed.len();
        if indent == 0 {
            in_section = trimmed.trim_end() == "api_keys:";
            continue;
        }
        if !in_section || indent == 0 {
            continue;
        }
        let Some((name, value)) = trimmed.split_once(':') else {
            continue;
        };
        let name = name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let value = normalize_value(value.trim());
        map.insert(name, value);
    }
    map
}

fn normalize_value(raw: &str) -> String {
    // strip trailing inline comment outside quotes
    let mut out = raw.to_string();
    if !out.starts_with('"') && !out.starts_with('\'') {
        if let Some(idx) = out.find(" #") {
            out.truncate(idx);
        }
    }
    let out = out.trim();
    // ${VAR:default} → default (env leg already missed by the time we run)
    if out.starts_with("${") && out.ends_with('}') {
        let inner = &out[2..out.len() - 1];
        if let Some((_var, default)) = inner.split_once(':') {
            return default.trim().to_string();
        }
        return String::new();
    }
    // strip matching quotes
    let bytes = out.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        return out[1..out.len() - 1].to_string();
    }
    out.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_env_expansion_quotes_and_comments() {
        let content = "\
# comment
api_keys:
  deepseek_api_key: ${DEEPSEEK_API_KEY:sk-abc} # inline
  glm_api_key: \"sk-quoted\"
  empty_env: ${GLM_API_KEY:}
other_section:
  unrelated: 1
";
        let map = parse_api_keys(content);
        assert_eq!(map.get("deepseek_api_key").unwrap(), "sk-abc");
        assert_eq!(map.get("glm_api_key").unwrap(), "sk-quoted");
        assert_eq!(map.get("empty_env").unwrap(), "");
        assert!(!map.contains_key("unrelated"));
    }

    #[test]
    fn provider_alias_resolution() {
        let map = parse_api_keys("api_keys:\n  dashscope_api_key: sk-ds\n  glm_api_key: sk-glm\n");
        let get = |kind: &str| -> Option<String> {
            let mut v: Vec<String> = Vec::new();
            if let Some((_, aliases)) = KEY_ALIASES.iter().find(|(k, _)| *k == kind) {
                v.extend(aliases.iter().map(|a| (*a).to_string()));
            }
            v.push(format!("{kind}_api_key"));
            v.into_iter().find_map(|n| map.get(&n).cloned())
        };
        assert_eq!(get("qwen").unwrap(), "sk-ds");
        assert_eq!(get("zai").unwrap(), "sk-glm");
    }
}
