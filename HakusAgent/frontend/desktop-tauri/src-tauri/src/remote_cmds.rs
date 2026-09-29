//! Remote workspace commands for the project manager.
//!
//! Remote workspace commands for the project manager. SSH connections stay in
//! the native shell so credentials and tunnel handles never enter the webview.

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use sha2::{Digest, Sha256};
use ssh2::KnownHostKeyFormat;
use ssh2::OpenFlags;
use ssh2::{CheckResult, KnownHostFileKind, Session, Sftp};
use tauri::{AppHandle, Emitter, State};

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectionConfig {
    pub kind: String,
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub auth_method: Option<String>,
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub trust_host_key: bool,
    #[serde(default)]
    pub distro: Option<String>,
    #[serde(default)]
    pub container: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectionResult {
    pub ok: bool,
    pub cwd: String,
    pub logs: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSyncResult {
    pub ok: bool,
    pub resource: String,
    pub logs: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostEntry {
    pub alias: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub private_key_path: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRuntimeRequest {
    pub project_id: String,
    pub path: String,
    pub config: RemoteConnectionConfig,
    #[serde(default)]
    pub install_mode: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRuntimeResult {
    pub local_port: u16,
    pub remote_port: u16,
    pub runtime_token: String,
    pub platform: String,
    pub installed: bool,
    pub logs: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RemoteRuntimeProgress {
    project_id: String,
    message: String,
}

fn runtime_log(app: &AppHandle, project_id: &str, logs: &mut Vec<String>, message: &str) {
    logs.push(message.to_string());
    let _ = app.emit(
        "remote-runtime-progress",
        RemoteRuntimeProgress {
            project_id: project_id.to_string(),
            message: message.to_string(),
        },
    );
}

struct RemoteRuntimeHandle {
    config: RemoteConnectionConfig,
    pid: String,
    marker: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct RemoteRuntimeRegistry {
    handles: HashMap<String, RemoteRuntimeHandle>,
    shutting_down: bool,
}

#[derive(Default)]
pub struct RemoteRuntimeState {
    registry: Arc<Mutex<RemoteRuntimeRegistry>>,
}

impl RemoteRuntimeState {
    pub fn stop_all(&self) {
        let handles = match self.registry.lock() {
            Ok(mut registry) => {
                registry.shutting_down = true;
                registry
                    .handles
                    .drain()
                    .map(|(_, handle)| handle)
                    .collect::<Vec<_>>()
            }
            Err(_) => return,
        };
        for handle in handles {
            stop_runtime_handle(handle);
        }
    }
}

impl Drop for RemoteRuntimeState {
    fn drop(&mut self) {
        self.stop_all();
    }
}

fn command_base(program: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new(program);
        command.creation_flags(0x0800_0000);
        command
    }
    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

fn run(program: &str, args: &[String], password: Option<&str>) -> Result<Output, String> {
    let mut command = command_base(program);
    command.args(args);
    if let Some(password) = password {
        command.env("SSHPASS", password);
    }
    command.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound && program.starts_with("sshpass") {
            "密码认证需要安装 sshpass（Windows 可将 sshpass.exe 放入 PATH）".into()
        } else {
            format!("无法启动 {program}：{error}")
        }
    })
}

fn output_text(output: &Output) -> String {
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    let error = String::from_utf8_lossy(&output.stderr);
    if !error.trim().is_empty() {
        if !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&error);
    }
    text.replace('\0', "")
}

fn wsl_output_text(bytes: &[u8]) -> String {
    let looks_like_utf16 = bytes.len() >= 2
        && bytes.len() % 2 == 0
        && bytes.chunks_exact(2).filter(|pair| pair[1] == 0).count() > bytes.len() / 8;
    if looks_like_utf16 {
        let words = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&words)
            .trim_start_matches('\u{feff}')
            .to_string();
    }
    String::from_utf8_lossy(bytes).replace('\0', "")
}

fn ssh_program() -> &'static str {
    if cfg!(windows) {
        "ssh.exe"
    } else {
        "ssh"
    }
}

fn ssh_config_aliases(config: &str) -> Vec<String> {
    let mut aliases = Vec::new();
    let mut seen = HashSet::new();
    for line in config.lines() {
        let line = line.split('#').next().unwrap_or_default().trim();
        let mut fields = line.split_whitespace();
        if !fields
            .next()
            .is_some_and(|keyword| keyword.eq_ignore_ascii_case("host"))
        {
            continue;
        }
        for alias in fields {
            let alias = alias.trim_matches(['\'', '"']);
            if !alias.starts_with('!')
                && !alias.contains('*')
                && !alias.contains('?')
                && seen.insert(alias.to_string())
            {
                aliases.push(alias.to_string());
            }
        }
    }
    aliases
}

fn expand_home_path(value: &str) -> PathBuf {
    if value == "~" {
        return local_home();
    }
    if let Some(relative) = value.strip_prefix("~/") {
        return local_home().join(relative);
    }
    PathBuf::from(value)
}

fn ssh_effective_host(alias: &str) -> Result<SshHostEntry, String> {
    let output = run(ssh_program(), &["-G".into(), alias.into()], None)?;
    if !output.status.success() {
        return Err(output_text(&output).trim().to_string());
    }
    let mut host = None;
    let mut port = None;
    let mut username = None;
    let mut private_key_path = None;
    for line in output_text(&output).lines() {
        let Some((key, value)) = line.split_once(' ') else {
            continue;
        };
        match key {
            "hostname" => host = Some(value.trim().to_string()),
            "port" => port = value.trim().parse().ok(),
            "user" if value.trim() != "none" => username = Some(value.trim().to_string()),
            "identityfile" => {
                let path = expand_home_path(value.trim());
                if path.is_file() && private_key_path.is_none() {
                    private_key_path = Some(path.display().to_string());
                }
            }
            _ => {}
        }
    }
    Ok(SshHostEntry {
        alias: alias.to_string(),
        host,
        port,
        username,
        private_key_path,
    })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn require_kind(config: &RemoteConnectionConfig) -> Result<(), String> {
    match config.kind.as_str() {
        "ssh" => {
            if config.host.as_deref().unwrap_or("").trim().is_empty()
                && config.alias.as_deref().unwrap_or("").trim().is_empty()
            {
                return Err("SSH 主机不能为空".into());
            }
            if config.auth_method.as_deref() == Some("key")
                && config
                    .private_key_path
                    .as_deref()
                    .is_none_or(|path| path.trim().is_empty())
                && config
                    .alias
                    .as_deref()
                    .is_none_or(|alias| alias.trim().is_empty())
            {
                return Err("私钥文件路径不能为空".into());
            }
            if config.auth_method.as_deref() == Some("password")
                && config.password.as_deref().unwrap_or("").is_empty()
            {
                return Err("密码认证需要填写密码".into());
            }
            Ok(())
        }
        "wsl" => {
            if !cfg!(windows) {
                return Err("WSL 连接仅支持 Windows".into());
            }
            if config.distro.as_deref().unwrap_or("").trim().is_empty() {
                return Err("请选择 WSL 发行版".into());
            }
            Ok(())
        }
        "docker" => {
            if config.container.as_deref().unwrap_or("").trim().is_empty() {
                return Err("请选择 Docker 容器".into());
            }
            Ok(())
        }
        _ => Err("不支持的远程连接方式".into()),
    }
}

fn ssh_host(config: &RemoteConnectionConfig) -> Result<String, String> {
    let configured = config
        .host
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            config
                .alias
                .as_deref()
                .filter(|value| !value.trim().is_empty())
        })
        .map(|value| value.trim().to_string())
        .ok_or_else(|| "SSH 主机不能为空".to_string())?;
    if config
        .host
        .as_deref()
        .is_some_and(|host| !host.trim().is_empty())
    {
        return Ok(configured);
    }
    ssh_effective_host(&configured)
        .ok()
        .and_then(|entry| entry.host)
        .filter(|host| !host.trim().is_empty())
        .ok_or_else(|| format!("无法解析 SSH 配置别名：{configured}"))
}

fn ssh_port(config: &RemoteConnectionConfig) -> u16 {
    if let Some(port) = config.port {
        return port;
    }
    if config
        .host
        .as_deref()
        .is_some_and(|host| !host.trim().is_empty())
    {
        return 22;
    }
    config
        .alias
        .as_deref()
        .and_then(|alias| ssh_effective_host(alias).ok())
        .and_then(|entry| entry.port)
        .unwrap_or(22)
}

fn ssh_username(config: &RemoteConnectionConfig) -> Result<String, String> {
    if let Some(username) = config
        .username
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(username.trim().to_string());
    }
    if config
        .host
        .as_deref()
        .is_none_or(|host| host.trim().is_empty())
    {
        if let Some(alias) = config.alias.as_deref() {
            if let Ok(host) = ssh_effective_host(alias) {
                if let Some(username) = host.username {
                    return Ok(username);
                }
            }
        }
    }
    env::var("USER")
        .or_else(|_| env::var("USERNAME"))
        .map_err(|_| "SSH 用户名不能为空".to_string())
}

fn ssh_private_key_path(config: &RemoteConnectionConfig) -> Option<PathBuf> {
    if let Some(path) = config
        .private_key_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        return Some(expand_home_path(path));
    }
    if config
        .host
        .as_deref()
        .is_some_and(|host| !host.trim().is_empty())
    {
        return None;
    }
    config
        .alias
        .as_deref()
        .and_then(|alias| ssh_effective_host(alias).ok())
        .and_then(|entry| entry.private_key_path.map(PathBuf::from))
}

fn trust_ssh_host_key(
    session: &Session,
    host: &str,
    port: u16,
    trust_unknown: bool,
) -> Result<(), String> {
    let (key, key_type) = session
        .host_key()
        .ok_or_else(|| "SSH 服务器未提供主机密钥".to_string())?;
    let known_hosts_path = local_home().join(".ssh").join("known_hosts");
    if let Some(parent) = known_hosts_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建 SSH 配置目录：{error}"))?;
    }

    let mut known_hosts = session
        .known_hosts()
        .map_err(|error| format!("无法读取 SSH 主机密钥：{error}"))?;
    if known_hosts_path.exists() {
        known_hosts
            .read_file(&known_hosts_path, KnownHostFileKind::OpenSSH)
            .map_err(|error| format!("SSH known_hosts 格式无效：{error}"))?;
    }
    match known_hosts.check_port(host, port, key) {
        CheckResult::Match => Ok(()),
        CheckResult::Mismatch => Err(format!(
            "SSH 主机密钥与 known_hosts 中记录不一致：{host}:{port}"
        )),
        CheckResult::Failure => Err("无法校验 SSH 主机密钥".into()),
        CheckResult::NotFound => {
            if !trust_unknown {
                let fingerprint = Sha256::digest(key)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<Vec<_>>()
                    .join(":");
                return Err(format!(
                    "SSH_HOST_KEY_CONFIRM:{host}:{port}:SHA256:{fingerprint}"
                ));
            }
            let known_host = if port == 22 {
                host.to_string()
            } else {
                format!("[{host}]:{port}")
            };
            known_hosts
                .add(
                    &known_host,
                    key,
                    &known_host,
                    KnownHostKeyFormat::from(key_type),
                )
                .map_err(|error| format!("无法记录 SSH 主机密钥：{error}"))?;
            known_hosts
                .write_file(&known_hosts_path, KnownHostFileKind::OpenSSH)
                .map_err(|error| format!("无法写入 SSH known_hosts：{error}"))
        }
    }
}

fn ensure_remote_dir(sftp: &Sftp, path: &Path) -> Result<(), String> {
    if path == Path::new("/") || path.as_os_str().is_empty() {
        return Ok(());
    }
    if sftp.stat(path).is_ok() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        ensure_remote_dir(sftp, parent)?;
    }
    sftp.mkdir(path, 0o700)
        .map_err(|error| format!("无法创建远程目录 {}：{error}", path.display()))
}

fn upload_file(sftp: &Sftp, source: &Path, destination: &Path) -> Result<(), String> {
    let mut local = fs::File::open(source)
        .map_err(|error| format!("无法读取本机文件 {}：{error}", source.display()))?;
    let mut remote = sftp
        .open_mode(
            destination,
            OpenFlags::WRITE | OpenFlags::TRUNCATE,
            0o600,
            ssh2::OpenType::File,
        )
        .map_err(|error| format!("无法创建远程文件 {}：{error}", destination.display()))?;
    std::io::copy(&mut local, &mut remote)
        .map_err(|error| format!("上传文件失败 {}：{error}", source.display()))?;
    Ok(())
}

fn upload_tree(sftp: &Sftp, source: &Path, destination: &Path) -> Result<(), String> {
    ensure_remote_dir(sftp, destination)?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("无法读取本机目录 {}：{error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("读取本机目录项失败：{error}"))?;
        let path = entry.path();
        let target = destination.join(entry.file_name());
        if path.is_dir() {
            upload_tree(sftp, &path, &target)?;
        } else if path.is_file() {
            upload_file(sftp, &path, &target)?;
        }
    }
    Ok(())
}

pub(super) fn ssh_session(config: &RemoteConnectionConfig) -> Result<Session, String> {
    let host = ssh_host(config)?;
    let port = ssh_port(config);
    let username = ssh_username(config)?;
    let addresses = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| format!("无法解析 SSH 主机：{error}"))?
        .collect::<Vec<SocketAddr>>();
    let tcp = addresses
        .iter()
        .find_map(|address| TcpStream::connect_timeout(address, Duration::from_secs(12)).ok())
        .ok_or_else(|| format!("无法连接 SSH 主机 {host}:{port}"))?;
    tcp.set_nodelay(true).ok();
    let mut session = Session::new().map_err(|error| format!("无法初始化 SSH：{error}"))?;
    session.set_tcp_stream(tcp);
    session.set_timeout(15_000);
    session
        .handshake()
        .map_err(|error| format!("SSH 握手失败：{error}"))?;
    trust_ssh_host_key(&session, &host, port, config.trust_host_key)?;

    let authenticated = match config.auth_method.as_deref() {
        Some("password") => {
            let password = config
                .password
                .as_deref()
                .ok_or_else(|| "请重新输入 SSH 密码".to_string())?;
            session.userauth_password(&username, password).is_ok()
        }
        Some("key") => {
            let key_auth = ssh_private_key_path(config)
                .map(|path| session.userauth_pubkey_file(&username, None, &path, None));
            key_auth.is_some_and(|result| result.is_ok())
                || session.userauth_agent(&username).is_ok()
        }
        _ => session.userauth_agent(&username).is_ok(),
    };
    if !authenticated || !session.authenticated() {
        return Err("SSH 身份验证失败，请检查用户名、密码或私钥。".into());
    }
    session.set_keepalive(true, 30);
    Ok(session)
}

pub(super) fn ssh_exec(config: &RemoteConnectionConfig, script: &str) -> Result<String, String> {
    let session = ssh_session(config)?;
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("无法创建 SSH 命令通道：{error}"))?;
    channel
        .exec(script)
        .map_err(|error| format!("无法执行远程命令：{error}"))?;
    let mut stdout = String::new();
    let mut stderr = String::new();
    channel
        .read_to_string(&mut stdout)
        .map_err(|error| format!("读取远程命令输出失败：{error}"))?;
    channel
        .stderr()
        .read_to_string(&mut stderr)
        .map_err(|error| format!("读取远程命令错误输出失败：{error}"))?;
    channel
        .wait_close()
        .map_err(|error| format!("等待远程命令结束失败：{error}"))?;
    if channel.exit_status().unwrap_or(1) != 0 {
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(if detail.is_empty() {
            "远程命令执行失败".into()
        } else {
            detail.to_string()
        });
    }
    if !stderr.trim().is_empty() {
        stdout.push_str(&stderr);
    }
    Ok(stdout.replace('\0', ""))
}

const STABLE_RELEASE_API: &str =
    "https://api.github.com/repos/modemneko/HakusAgent/releases/tags/stable";

struct RuntimeAssetMetadata {
    url: String,
    digest: String,
}

fn shell_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn runtime_token(project_id: &str) -> String {
    let seed = format!(
        "{}:{}:{}",
        project_id,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    );
    format!("hakus-remote-{}", shell_hash(&seed))
}

fn remote_platform(config: &RemoteConnectionConfig) -> Result<(&'static str, String), String> {
    let output = remote_exec(config, "uname -s; uname -m")?;
    let mut lines = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let os = lines.next().unwrap_or_default().to_ascii_lowercase();
    let arch = lines.next().unwrap_or_default().to_ascii_lowercase();
    if os != "linux" {
        return Err(format!("当前远端系统为 {os}，首期远程 Agent 只支持 Linux"));
    }
    let asset = match arch.as_str() {
        "x86_64" | "amd64" => "hakuscli-linux-x64",
        "aarch64" | "arm64" => "hakuscli-linux-arm64",
        _ => return Err(format!("暂不支持远端 CPU 架构：{arch}")),
    };
    Ok((asset, format!("linux-{arch}")))
}

fn runtime_asset_metadata(asset_name: &str) -> Result<RuntimeAssetMetadata, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("HakusAI-RemoteRuntime")
        .build()
        .map_err(|error| format!("初始化 Release 客户端失败：{error}"))?;
    let release: serde_json::Value = client
        .get(STABLE_RELEASE_API)
        .send()
        .map_err(|error| format!("读取 stable Release 失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("stable Release 请求失败：{error}"))?
        .json()
        .map_err(|error| format!("解析 stable Release 失败：{error}"))?;
    let asset = release
        .get("assets")
        .and_then(serde_json::Value::as_array)
        .and_then(|assets| {
            assets.iter().find(|candidate| {
                candidate.get("name").and_then(serde_json::Value::as_str) == Some(asset_name)
            })
        })
        .ok_or_else(|| format!("stable Release 中没有 {asset_name}"))?;
    let digest = asset
        .get("digest")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.strip_prefix("sha256:"))
        .ok_or_else(|| format!("Release 资产 {asset_name} 缺少 SHA-256 digest"))?
        .to_ascii_lowercase();
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!(
            "Release 资产 {asset_name} 的 SHA-256 digest 格式无效"
        ));
    }
    let url = asset
        .get("browser_download_url")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("Release 资产 {asset_name} 缺少下载地址"))?;
    if !url.starts_with("https://github.com/modemneko/HakusAgent/releases/download/") {
        return Err(format!("Release 资产 {asset_name} 的下载地址不受信任"));
    }
    Ok(RuntimeAssetMetadata {
        url: url.to_string(),
        digest,
    })
}

fn runtime_asset(metadata: &RuntimeAssetMetadata) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("HakusAI-RemoteRuntime")
        .build()
        .map_err(|error| format!("初始化 Release 下载器失败：{error}"))?;
    let bytes = client
        .get(&metadata.url)
        .send()
        .map_err(|error| format!("下载远程 Agent 失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("远程 Agent 下载返回错误：{error}"))?
        .bytes()
        .map_err(|error| format!("读取远程 Agent 失败：{error}"))?
        .to_vec();
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != metadata.digest {
        return Err(format!(
            "远程 Agent 校验失败：期望 {}，实际 {actual}",
            metadata.digest
        ));
    }
    Ok(bytes)
}

fn parse_remote_download_tools(output: &str) -> Result<(String, String), String> {
    let mut lines = output.lines().map(str::trim);
    let downloader = lines.next().unwrap_or_default();
    let checksum = lines.next().unwrap_or_default();
    if !matches!(downloader, "curl" | "wget") || !matches!(checksum, "sha256sum" | "shasum") {
        return Err("无法识别远端下载或 SHA-256 校验工具，请改用“本机下载后上传”。".into());
    }
    Ok((downloader.to_string(), checksum.to_string()))
}

fn remote_download_preflight(config: &RemoteConnectionConfig) -> Result<(String, String), String> {
    let output = remote_exec(
        config,
        "set -eu; if command -v curl >/dev/null 2>&1; then printf 'curl\\n'; elif command -v wget >/dev/null 2>&1; then printf 'wget\\n'; else echo 'PRECHECK_NO_DOWNLOADER'; exit 1; fi; if command -v sha256sum >/dev/null 2>&1; then printf 'sha256sum\\n'; elif command -v shasum >/dev/null 2>&1; then printf 'shasum\\n'; else echo 'PRECHECK_NO_SHA256'; exit 1; fi",
    )
    .map_err(|error| {
        if error.contains("PRECHECK_NO_DOWNLOADER") {
            "远端没有 curl 或 wget，请返回配置并改用“本机下载后上传”。".to_string()
        } else if error.contains("PRECHECK_NO_SHA256") {
            "远端没有 sha256sum 或 shasum，无法校验下载文件；请改用“本机下载后上传”。".to_string()
        } else {
            error
        }
    })?;
    parse_remote_download_tools(&output)
}

fn remote_download_script(
    metadata: &RuntimeAssetMetadata,
    downloader: &str,
    checksum: &str,
    partial: &str,
    binary: &str,
) -> Result<String, String> {
    let download = match downloader {
        "curl" => format!(
            "curl --fail --location --silent --show-error --retry 2 --output \"$partial\" {}",
            shell_quote(&metadata.url)
        ),
        "wget" => format!("wget -q -O \"$partial\" {}", shell_quote(&metadata.url)),
        _ => return Err("不支持的远端下载工具".into()),
    };
    let digest_command = match checksum {
        "sha256sum" => "actual=\"$(sha256sum \"$partial\")\"; actual=\"${actual%% *}\"",
        "shasum" => "actual=\"$(shasum -a 256 \"$partial\")\"; actual=\"${actual%% *}\"",
        _ => return Err("不支持的 SHA-256 校验工具".into()),
    };
    let script = format!(
        "set -eu; partial={partial}; trap 'rm -f \"$partial\"' EXIT; {download}; {digest_command}; if test \"$actual\" != {digest}; then echo \"SHA-256 mismatch: expected {digest}, got $actual\"; exit 1; fi; chmod 700 \"$partial\"; mv -f \"$partial\" {binary}; trap - EXIT",
        partial = shell_quote(partial),
        digest = shell_quote(&metadata.digest),
        binary = shell_quote(binary),
    );
    Ok(script)
}

fn download_runtime_on_remote(
    config: &RemoteConnectionConfig,
    metadata: &RuntimeAssetMetadata,
    downloader: &str,
    checksum: &str,
    partial: &str,
    binary: &str,
) -> Result<(), String> {
    let script = remote_download_script(metadata, downloader, checksum, partial, binary)?;
    remote_exec(config, &script).map(|_| ())
}

fn upload_bytes(sftp: &Sftp, destination: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut remote = sftp
        .open_mode(
            destination,
            OpenFlags::WRITE | OpenFlags::TRUNCATE,
            0o700,
            ssh2::OpenType::File,
        )
        .map_err(|error| format!("无法创建远程 Agent 文件：{error}"))?;
    remote
        .write_all(bytes)
        .map_err(|error| format!("上传远程 Agent 失败：{error}"))
}

fn install_runtime(
    config: &RemoteConnectionConfig,
    install_mode: &str,
    app: &AppHandle,
    project_id: &str,
    logs: &mut Vec<String>,
) -> Result<(String, String, bool), String> {
    runtime_log(app, project_id, logs, "正在检查远端系统与 CPU 架构");
    let (asset_name, platform) = remote_platform(config)?;
    runtime_log(
        app,
        project_id,
        logs,
        "正在读取 stable Release 版本与 SHA-256",
    );
    let metadata = runtime_asset_metadata(asset_name)?;
    let digest = metadata.digest.clone();
    let home = remote_exec(config, "printf '%s' \"$HOME\"")?
        .trim()
        .to_string();
    if home.is_empty() || !home.starts_with('/') {
        return Err("无法确定远端用户目录".into());
    }
    let release_dir = format!("{home}/.hakus/server/releases/{digest}");
    let binary = format!("{release_dir}/hakuscli");
    let hit = remote_exec(
        config,
        &format!(
            "test -x {} && printf HIT || printf MISS",
            shell_quote(&binary)
        ),
    )?
    .trim()
        == "HIT";
    if hit {
        runtime_log(
            app,
            project_id,
            logs,
            "发现匹配版本的远端 Runtime，跳过下载",
        );
        return Ok((binary, platform, false));
    }
    remote_exec(config, &format!("mkdir -p {}", shell_quote(&release_dir)))?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let partial = format!(
        "{binary}.partial-{}",
        shell_hash(&format!("{}:{}:{nonce}", project_id, std::process::id()))
    );
    if install_mode == "remoteDownload" {
        runtime_log(app, project_id, logs, "正在预检远端下载器与 SHA-256 工具");
        let (downloader, checksum) = remote_download_preflight(config)?;
        runtime_log(
            app,
            project_id,
            logs,
            &format!("远端环境就绪：{downloader} + {checksum}"),
        );
        runtime_log(app, project_id, logs, "正在由远端下载 Runtime 到临时文件");
        download_runtime_on_remote(config, &metadata, &downloader, &checksum, &partial, &binary)
            .map_err(|error| {
                if error.contains("SHA-256 mismatch") {
                    format!("远端 Runtime 的 SHA-256 校验失败：{error}")
                } else {
                    error
                }
            })?;
        runtime_log(
            app,
            project_id,
            logs,
            "远端 SHA-256 校验通过，Runtime 已原子安装",
        );
    } else {
        runtime_log(app, project_id, logs, "正在本机下载 Runtime");
        let bytes = runtime_asset(&metadata)?;
        runtime_log(
            app,
            project_id,
            logs,
            "本机 SHA-256 校验通过，正在通过 SSH 上传",
        );
        let session = ssh_session(config)?;
        let sftp = session
            .sftp()
            .map_err(|error| format!("无法创建 SFTP 会话：{error}"))?;
        upload_bytes(&sftp, Path::new(&partial), &bytes)?;
        remote_exec(
            config,
            &format!(
                "chmod 700 {partial} && mv -f {partial} {binary}",
                partial = shell_quote(&partial),
                binary = shell_quote(&binary),
            ),
        )?;
        runtime_log(app, project_id, logs, "Runtime 上传完成并原子安装");
    }
    Ok((binary, platform, true))
}

fn start_remote_runtime(
    config: &RemoteConnectionConfig,
    project_id: &str,
    binary: &str,
    path: &str,
    token: &str,
) -> Result<(u16, String), String> {
    let key = shell_hash(project_id);
    let home = remote_exec(config, "printf '%s' \"$HOME\"")?
        .trim()
        .to_string();
    if home.is_empty() || !home.starts_with('/') {
        return Err("无法确定远端用户目录".into());
    }
    let log = format!("{home}/.hakus/server/runtime-{key}.log");
    let pid = format!("{home}/.hakus/server/runtime-{key}.pid");
    let instance_file = format!("{pid}.instance");
    let marker_value = token.to_string();
    let command = format!(
        "set -eu; umask 077; mkdir -p \"$HOME/.hakus/server\"; if test -f {pid} && test -f {instance_file}; then old_pid=\"$(cat {pid} 2>/dev/null || true)\"; old_marker=\"$(cat {instance_file} 2>/dev/null || true)\"; case \"$old_pid\" in ''|*[!0-9]*) ;; *) if test -r \"/proc/$old_pid/environ\" && tr '\\000' '\\n' < \"/proc/$old_pid/environ\" | grep -Fxq \"HAKUS_REMOTE_INSTANCE=$old_marker\"; then kill \"$old_pid\" 2>/dev/null || true; i=0; while test $i -lt 30 && kill -0 \"$old_pid\" 2>/dev/null && tr '\\000' '\\n' < \"/proc/$old_pid/environ\" 2>/dev/null | grep -Fxq \"HAKUS_REMOTE_INSTANCE=$old_marker\"; do sleep 0.1; i=$((i + 1)); done; if test -r \"/proc/$old_pid/environ\" && tr '\\000' '\\n' < \"/proc/$old_pid/environ\" | grep -Fxq \"HAKUS_REMOTE_INSTANCE=$old_marker\"; then kill -9 \"$old_pid\" 2>/dev/null || true; fi; fi ;; esac; fi; printf '%s\\n' {marker} > {instance_file}; : > {log}; nohup env HAKUS_HOME=\"$HOME/.hakus\" HAKUS_RUNTIME_TOKEN={token} HAKUS_REMOTE_INSTANCE={marker} {binary} --workspace {workspace} app-server --http --host 127.0.0.1 --port 0 > {log} 2>&1 < /dev/null & echo $! > {pid}; i=0; while test $i -lt 120; do line=\"$(grep -m 1 'Runtime API listening on' {log} 2>/dev/null || true)\"; if test -n \"$line\"; then printf '%s\\n' \"$line\"; exit 0; fi; if ! kill -0 \"$(cat {pid})\" 2>/dev/null; then cat {log}; exit 1; fi; i=$((i + 1)); sleep 0.25; done; cat {log}; exit 1",
        pid = shell_quote(&pid),
        instance_file = shell_quote(&instance_file),
        marker = shell_quote(&marker_value),
        log = shell_quote(&log),
        binary = shell_quote(binary),
        workspace = shell_quote(path),
        token = shell_quote(token),
    );
    let output = match remote_exec(config, &command) {
        Ok(output) => output,
        Err(error) => {
            let _ = stop_remote_process(config, &pid, token);
            return Err(error);
        }
    };
    let port = output
        .lines()
        .find_map(|line| {
            let port = line.rsplit_once(':')?.1.trim().parse::<u16>().ok()?;
            (port > 0).then_some(port)
        })
        .ok_or_else(|| "远端 Runtime 已启动，但没有读到监听端口".to_string());
    match port {
        Ok(port) => Ok((port, pid)),
        Err(error) => {
            let _ = stop_remote_process(config, &pid, token);
            Err(error)
        }
    }
}

fn stop_remote_process(
    config: &RemoteConnectionConfig,
    pid_file: &str,
    marker: &str,
) -> Result<(), String> {
    let instance_file = format!("{pid_file}.instance");
    let marker_value = format!("HAKUS_REMOTE_INSTANCE={marker}");
    let script = format!(
        "if test -f {pid}; then pid_value=\"$(cat {pid} 2>/dev/null || true)\"; case \"$pid_value\" in ''|*[!0-9]*) ;; *) if test -r \"/proc/$pid_value/environ\" && tr '\\000' '\\n' < \"/proc/$pid_value/environ\" | grep -Fxq {marker_value}; then kill \"$pid_value\" 2>/dev/null || true; i=0; while test $i -lt 30 && kill -0 \"$pid_value\" 2>/dev/null && tr '\\000' '\\n' < \"/proc/$pid_value/environ\" 2>/dev/null | grep -Fxq {marker_value}; do sleep 0.1; i=$((i + 1)); done; if test -r \"/proc/$pid_value/environ\" && tr '\\000' '\\n' < \"/proc/$pid_value/environ\" | grep -Fxq {marker_value}; then kill -9 \"$pid_value\" 2>/dev/null || true; fi; fi ;; esac; if test \"$(cat {instance_file} 2>/dev/null || true)\" = {marker}; then rm -f {pid} {instance_file}; fi; fi",
        pid = shell_quote(pid_file),
        instance_file = shell_quote(&instance_file),
        marker_value = shell_quote(&marker_value),
        marker = shell_quote(marker),
    );
    remote_exec(config, &script).map(|_| ())
}

fn stop_runtime_handle(mut handle: RemoteRuntimeHandle) {
    handle.stop.store(true, Ordering::Release);
    if let Some(thread) = handle.thread.take() {
        let _ = thread.join();
    }
    let _ = stop_remote_process(&handle.config, &handle.pid, &handle.marker);
}

fn bridge_connection(
    config: RemoteConnectionConfig,
    remote_port: u16,
    local: TcpStream,
) -> Result<(), String> {
    let session = ssh_session(&config)?;
    session.set_timeout(0);
    let mut channel = session
        .channel_direct_tcpip("127.0.0.1", remote_port, None)
        .map_err(|error| format!("无法建立远程 Runtime 通道：{error}"))?;
    let mut local_writer = local
        .try_clone()
        .map_err(|error| format!("无法复制本地隧道连接：{error}"))?;
    let mut channel_writer = channel.clone();
    let mut local_reader = local;
    let upload = thread::spawn(move || {
        let _ = io::copy(&mut local_reader, &mut channel_writer);
    });
    let _ = io::copy(&mut channel, &mut local_writer);
    let _ = upload.join();
    Ok(())
}

fn tunnel_loop(
    config: RemoteConnectionConfig,
    remote_port: u16,
    listener: std::net::TcpListener,
    stop: Arc<AtomicBool>,
) {
    listener.set_nonblocking(true).ok();
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((local, _)) => {
                let config = config.clone();
                thread::spawn(move || {
                    let _ = bridge_connection(config, remote_port, local);
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break,
        }
    }
}

fn docker_program() -> &'static str {
    if cfg!(windows) {
        "docker.exe"
    } else {
        "docker"
    }
}

fn remote_exec(config: &RemoteConnectionConfig, script: &str) -> Result<String, String> {
    require_kind(config)?;
    if config.kind == "ssh" {
        return ssh_exec(config, script);
    }
    let (program, args, password) = match config.kind.as_str() {
        "ssh" => {
            unreachable!("SSH commands use ssh2")
        }
        "wsl" => (
            "wsl.exe".to_string(),
            vec![
                "-d".to_string(),
                config.distro.clone().unwrap(),
                "--".to_string(),
                "bash".to_string(),
                "-lc".to_string(),
                script.to_string(),
            ],
            None,
        ),
        "docker" => (
            docker_program().to_string(),
            vec![
                "exec".to_string(),
                config.container.clone().unwrap(),
                "sh".to_string(),
                "-lc".to_string(),
                script.to_string(),
            ],
            None,
        ),
        _ => unreachable!(),
    };

    let (actual_program, actual_args) = if program.starts_with("sshpass") {
        let mut wrapped = vec!["-e".to_string(), "ssh".to_string()];
        wrapped.extend(args);
        (program, wrapped)
    } else {
        (program, args)
    };
    let output = run(&actual_program, &actual_args, password)?;
    if !output.status.success() {
        let detail = output_text(&output);
        return Err(if detail.trim().is_empty() {
            format!("远程命令退出状态：{}", output.status)
        } else {
            detail.trim().to_string()
        });
    }
    Ok(output_text(&output))
}

fn remote_path_join(root: &str, name: &str) -> String {
    if root == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", root.trim_end_matches('/'), name)
    }
}

#[tauri::command]
pub async fn remote_list_targets(kind: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || remote_list_targets_blocking(kind))
        .await
        .map_err(|error| format!("远程目标查询任务失败：{error}"))?
}

fn remote_list_targets_blocking(kind: String) -> Result<Vec<String>, String> {
    match kind.as_str() {
        "wsl" => {
            if !cfg!(windows) {
                return Err("WSL 连接仅支持 Windows".into());
            }
            let output = run("wsl.exe", &["-l".into(), "-q".into()], None)?;
            if !output.status.success() {
                return Err(output_text(&output).trim().to_string());
            }
            Ok(wsl_output_text(&output.stdout)
                .lines()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect())
        }
        "docker" => {
            let output = run(
                docker_program(),
                &["ps".into(), "--format".into(), "{{.Names}}".into()],
                None,
            )?;
            if !output.status.success() {
                return Err(output_text(&output).trim().to_string());
            }
            Ok(output_text(&output)
                .lines()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect())
        }
        "ssh" => Ok(Vec::new()),
        _ => Err("不支持的远程连接方式".into()),
    }
}

#[tauri::command]
pub async fn remote_list_ssh_hosts() -> Result<Vec<SshHostEntry>, String> {
    tauri::async_runtime::spawn_blocking(remote_list_ssh_hosts_blocking)
        .await
        .map_err(|error| format!("SSH 配置查询任务失败：{error}"))?
}

fn remote_list_ssh_hosts_blocking() -> Result<Vec<SshHostEntry>, String> {
    let config_path = local_home().join(".ssh").join("config");
    let config = match fs::read_to_string(&config_path) {
        Ok(config) => config,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("无法读取 SSH 配置文件：{error}")),
    };
    let aliases = ssh_config_aliases(&config);
    if aliases.is_empty() {
        return Ok(Vec::new());
    }
    let hosts = aliases
        .iter()
        .map(|alias| ssh_effective_host(alias))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(hosts)
}

#[tauri::command]
pub async fn remote_connect(
    config: RemoteConnectionConfig,
) -> Result<RemoteConnectionResult, String> {
    tauri::async_runtime::spawn_blocking(move || remote_connect_blocking(config))
        .await
        .map_err(|error| format!("SSH 连接任务失败：{error}"))?
}

fn remote_connect_blocking(
    config: RemoteConnectionConfig,
) -> Result<RemoteConnectionResult, String> {
    let mut logs = vec![format!("正在连接 {}", config.kind.to_uppercase())];
    let output = remote_exec(&config, "printf '__HAKUS_CONNECTED__\\n'; pwd")?;
    let mut after_marker = false;
    let cwd = output
        .lines()
        .find_map(|line| {
            if line.contains("__HAKUS_CONNECTED__") {
                after_marker = true;
                return None;
            }
            if after_marker && !line.trim().is_empty() {
                Some(line.trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "/".to_string());
    logs.push(format!("连接成功，远程目录：{cwd}"));
    Ok(RemoteConnectionResult {
        ok: true,
        cwd,
        logs,
    })
}

#[tauri::command]
pub async fn remote_start_runtime(
    app: AppHandle,
    state: State<'_, RemoteRuntimeState>,
    request: RemoteRuntimeRequest,
) -> Result<RemoteRuntimeResult, String> {
    let registry = Arc::clone(&state.registry);
    tauri::async_runtime::spawn_blocking(move || {
        remote_start_runtime_blocking(registry, request, app)
    })
    .await
    .map_err(|error| format!("远程 Runtime 部署任务失败：{error}"))?
}

fn remote_start_runtime_blocking(
    registry: Arc<Mutex<RemoteRuntimeRegistry>>,
    request: RemoteRuntimeRequest,
    app: AppHandle,
) -> Result<RemoteRuntimeResult, String> {
    require_kind(&request.config)?;
    if request.config.kind != "ssh" {
        return Err("远程 Runtime 首期只支持 SSH Linux 主机".into());
    }
    if request.project_id.trim().is_empty() {
        return Err("远程项目 ID 不能为空".into());
    }
    if request.path.trim().is_empty() {
        return Err("远程工作目录不能为空".into());
    }

    let install_mode = request.install_mode.as_deref().unwrap_or("localUpload");
    if !matches!(install_mode, "localUpload" | "remoteDownload") {
        return Err("不支持的 Runtime 安装方式".into());
    }

    let old = {
        let mut registry = registry
            .lock()
            .map_err(|error| format!("远程 Runtime 状态锁定失败：{error}"))?;
        if registry.shutting_down {
            return Err("应用正在关闭，无法启动远程 Runtime".into());
        }
        registry.handles.remove(&request.project_id)
    };
    if let Some(old) = old {
        stop_runtime_handle(old);
    }

    let mut logs = Vec::new();
    let (binary, platform, installed) = install_runtime(
        &request.config,
        install_mode,
        &app,
        &request.project_id,
        &mut logs,
    )?;
    let token = runtime_token(&request.project_id);
    runtime_log(&app, &request.project_id, &mut logs, "正在启动远端 Runtime");
    let (remote_port, pid) = start_remote_runtime(
        &request.config,
        &request.project_id,
        &binary,
        &request.path,
        &token,
    )?;
    let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
        Ok(listener) => listener,
        Err(error) => {
            let _ = stop_remote_process(&request.config, &pid, &token);
            return Err(format!("无法创建本地 SSH 隧道：{error}"));
        }
    };
    let local_port = listener
        .local_addr()
        .map_err(|error| {
            let _ = stop_remote_process(&request.config, &pid, &token);
            format!("无法读取本地隧道端口：{error}")
        })?
        .port();
    let stop = Arc::new(AtomicBool::new(false));
    runtime_log(
        &app,
        &request.project_id,
        &mut logs,
        "正在建立本地 SSH 隧道",
    );
    let thread_stop = Arc::clone(&stop);
    let thread_config = request.config.clone();
    let thread = match thread::Builder::new()
        .name(format!("remote-tunnel-{}", shell_hash(&request.project_id)))
        .spawn(move || tunnel_loop(thread_config, remote_port, listener, thread_stop))
    {
        Ok(thread) => thread,
        Err(error) => {
            let _ = stop_remote_process(&request.config, &pid, &token);
            return Err(format!("无法启动 SSH 隧道：{error}"));
        }
    };

    let result = RemoteRuntimeResult {
        local_port,
        remote_port,
        runtime_token: token.clone(),
        platform,
        installed,
        logs: {
            runtime_log(
                &app,
                &request.project_id,
                &mut logs,
                &format!("SSH 隧道已建立：本地 127.0.0.1:{local_port}"),
            );
            logs
        },
    };
    let mut registry = match registry.lock() {
        Ok(handles) => handles,
        Err(error) => {
            stop_runtime_handle(RemoteRuntimeHandle {
                config: request.config,
                pid,
                marker: token,
                stop,
                thread: Some(thread),
            });
            return Err(format!("远程 Runtime 状态锁定失败：{error}"));
        }
    };
    if registry.shutting_down {
        drop(registry);
        stop_runtime_handle(RemoteRuntimeHandle {
            config: request.config,
            pid,
            marker: token,
            stop,
            thread: Some(thread),
        });
        return Err("应用正在关闭，已清理远程 Runtime".into());
    }
    let replaced = registry.handles.insert(
        request.project_id,
        RemoteRuntimeHandle {
            config: request.config,
            pid,
            marker: token,
            stop,
            thread: Some(thread),
        },
    );
    drop(registry);
    if let Some(replaced) = replaced {
        stop_runtime_handle(replaced);
    }
    Ok(result)
}

#[tauri::command]
pub async fn remote_stop_runtime(
    state: State<'_, RemoteRuntimeState>,
    project_id: String,
) -> Result<(), String> {
    let registry = Arc::clone(&state.registry);
    tauri::async_runtime::spawn_blocking(move || remote_stop_runtime_blocking(registry, project_id))
        .await
        .map_err(|error| format!("远程 Runtime 停止任务失败：{error}"))?
}

fn remote_stop_runtime_blocking(
    registry: Arc<Mutex<RemoteRuntimeRegistry>>,
    project_id: String,
) -> Result<(), String> {
    let handle = registry
        .lock()
        .map_err(|error| format!("远程 Runtime 状态锁定失败：{error}"))?
        .handles
        .remove(&project_id);
    if let Some(handle) = handle {
        stop_runtime_handle(handle);
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_list_dir(
    config: RemoteConnectionConfig,
    path: String,
) -> Result<Vec<RemoteDirEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || remote_list_dir_blocking(config, path))
        .await
        .map_err(|error| format!("远程目录读取任务失败：{error}"))?
}

fn remote_list_dir_blocking(
    config: RemoteConnectionConfig,
    path: String,
) -> Result<Vec<RemoteDirEntry>, String> {
    let path = if path.trim().is_empty() {
        "/"
    } else {
        path.trim()
    };
    let script = format!(
        "cd -- {} && for item in ./* ./.[!.]* ./..?*; do [ -e \"$item\" ] || continue; name=\"${{item#./}}\"; if [ -d \"$item\" ]; then printf 'd\\t%s\\n' \"$name\"; else printf 'f\\t%s\\n' \"$name\"; fi; done | sort -f -k2",
        shell_quote(path)
    );
    let output = remote_exec(&config, &script)?;
    let mut entries = Vec::new();
    for line in output.lines() {
        let Some((kind, name)) = line.split_once('\t') else {
            continue;
        };
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        entries.push(RemoteDirEntry {
            name: name.to_string(),
            path: remote_path_join(path, name),
            is_dir: kind == "d",
        });
    }
    Ok(entries)
}

fn local_home() -> PathBuf {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn resource_source(resource: &str) -> (PathBuf, bool) {
    let root = local_home().join(".hakus");
    match resource {
        "skill" => (root.join("skills"), true),
        "plugin" => (root.join("plugins"), true),
        "mcp" => (root.join("mcp.json"), false),
        _ => (root.join("missing"), false),
    }
}

fn remote_sync_root(path: &str) -> String {
    format!("{}/.hakus", path.trim_end_matches('/'))
}

fn wsl_program() -> &'static str {
    if cfg!(windows) {
        "wsl.exe"
    } else {
        "wsl"
    }
}

fn wsl_source_path(config: &RemoteConnectionConfig, source: &PathBuf) -> Result<String, String> {
    let output = run(
        wsl_program(),
        &[
            "-d".into(),
            config.distro.clone().unwrap_or_default(),
            "--".into(),
            "wslpath".into(),
            "-a".into(),
            source.display().to_string(),
        ],
        None,
    )?;
    if !output.status.success() {
        return Err(output_text(&output).trim().to_string());
    }
    Ok(output_text(&output).trim().to_string())
}

#[tauri::command]
pub async fn remote_sync(
    config: RemoteConnectionConfig,
    path: String,
    resource: String,
) -> Result<RemoteSyncResult, String> {
    tauri::async_runtime::spawn_blocking(move || remote_sync_blocking(config, path, resource))
        .await
        .map_err(|error| format!("远程资源同步任务失败：{error}"))?
}

fn remote_sync_blocking(
    config: RemoteConnectionConfig,
    path: String,
    resource: String,
) -> Result<RemoteSyncResult, String> {
    require_kind(&config)?;
    let (source, recursive) = resource_source(&resource);
    if !source.exists() {
        return Ok(RemoteSyncResult {
            ok: false,
            resource,
            logs: vec![format!("本机资源不存在：{}", source.display())],
        });
    }
    let sync_root = remote_sync_root(&path);
    let mut logs = vec![format!("准备同步 {}", resource)];
    match config.kind.as_str() {
        "ssh" => {
            let session = ssh_session(&config)?;
            let sftp = session
                .sftp()
                .map_err(|error| format!("无法创建 SFTP 会话：{error}"))?;
            let remote_root = Path::new(&sync_root);
            ensure_remote_dir(&sftp, remote_root)?;
            if recursive {
                upload_tree(
                    &sftp,
                    &source,
                    &remote_root.join(source.file_name().unwrap_or_default()),
                )?;
            } else {
                upload_file(
                    &sftp,
                    &source,
                    &remote_root.join(source.file_name().unwrap_or_default()),
                )?;
            }
            logs.push("同步完成".into());
        }
        "docker" => {
            remote_exec(&config, &format!("mkdir -p {}", shell_quote(&sync_root)))?;
            let output = run(
                docker_program(),
                &[
                    "cp".into(),
                    source.display().to_string(),
                    format!("{}:{sync_root}/", config.container.clone().unwrap()),
                ],
                None,
            )?;
            if !output.status.success() {
                return Err(output_text(&output).trim().to_string());
            }
            logs.push("同步完成".into());
        }
        "wsl" => {
            remote_exec(&config, &format!("mkdir -p {}", shell_quote(&sync_root)))?;
            let source_path = wsl_source_path(&config, &source)?;
            remote_exec(
                &config,
                &format!(
                    "cp -R -- {} {}/",
                    shell_quote(&source_path),
                    shell_quote(&sync_root)
                ),
            )?;
            logs.push("同步完成".into());
        }
        _ => unreachable!(),
    }
    Ok(RemoteSyncResult {
        ok: true,
        resource,
        logs,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        parse_remote_download_tools, remote_download_script, remote_path_join, remote_sync_root,
        shell_quote, ssh_config_aliases, wsl_output_text, RuntimeAssetMetadata,
    };

    #[test]
    fn remote_path_join_handles_root_and_nested_directories() {
        assert_eq!(remote_path_join("/", "folder"), "/folder");
        assert_eq!(
            remote_path_join("/home/user/", "folder"),
            "/home/user/folder"
        );
    }

    #[test]
    fn shell_quote_protects_spaces_and_single_quotes() {
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn remote_sync_root_targets_the_hidden_config_directory() {
        assert_eq!(remote_sync_root("/home/user"), "/home/user/.hakus");
        assert_eq!(remote_sync_root("/"), "/.hakus");
    }

    #[test]
    fn ssh_config_aliases_skip_wildcards_and_duplicates() {
        let config = "Host *\n  User default\nHost work staging work\n  Port 2200\nHost !ignored\n";
        assert_eq!(
            ssh_config_aliases(config),
            vec!["work".to_string(), "staging".to_string()]
        );
    }

    #[test]
    fn wsl_target_output_decodes_windows_utf16_and_utf8() {
        assert_eq!(wsl_output_text(&[b'U', 0, b'b', 0, b'u', 0]), "Ubu");
        assert_eq!(wsl_output_text(b"Ubuntu\n"), "Ubuntu\n");
    }

    #[test]
    fn remote_download_preflight_accepts_supported_tool_pairs_only() {
        assert_eq!(
            parse_remote_download_tools("curl\nsha256sum\n").unwrap(),
            ("curl".to_string(), "sha256sum".to_string())
        );
        assert_eq!(
            parse_remote_download_tools("wget\nshasum\n").unwrap(),
            ("wget".to_string(), "shasum".to_string())
        );
        assert!(parse_remote_download_tools("busybox\nsha256sum\n").is_err());
    }

    #[test]
    fn remote_download_script_quotes_paths_and_verifies_before_rename() {
        let metadata = RuntimeAssetMetadata {
            url: "https://github.com/modemneko/HakusAgent/releases/download/stable/hakuscli-linux-x64"
                .into(),
            digest: "a".repeat(64),
        };
        let script = remote_download_script(
            &metadata,
            "curl",
            "sha256sum",
            "/home/user's/.hakus/server/hakuscli.partial",
            "/home/user's/.hakus/server/hakuscli",
        )
        .unwrap();
        assert!(script.contains("curl --fail --location"));
        assert!(script.contains("trap 'rm -f \"$partial\"' EXIT"));
        assert!(script.contains("sha256sum \"$partial\""));
        let verify = script.find("if test \"$actual\"").unwrap();
        let install = script.find("chmod 700 \"$partial\"").unwrap();
        assert!(verify < install);
        assert!(script.contains("mv -f \"$partial\""));
        assert!(script.contains("'\\''s/.hakus/server/hakuscli.partial'"));

        let wget_script = remote_download_script(
            &metadata,
            "wget",
            "shasum",
            "/tmp/hakus.partial",
            "/tmp/hakus",
        )
        .unwrap();
        assert!(wget_script.contains("wget -q -O \"$partial\""));
        assert!(wget_script.contains("shasum -a 256 \"$partial\""));
        assert!(remote_download_script(&metadata, "curl", "md5sum", "/tmp/a", "/tmp/b").is_err());
    }
}
