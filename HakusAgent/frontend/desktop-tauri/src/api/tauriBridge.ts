/**
 * Tauri API Bridge — replaces window.electron IPC with Tauri invoke().
 * The embedded Rust Runtime is exposed to legacy components as "backend".
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  RemoteConnectionType,
  RemoteProjectConnection,
  RemoteRuntimeInstallMode,
  Project,
} from '@/api/types'

// ── Store ──────────────────────────────────────────────────────────
export const store = {
  get: (key: string) => invoke<unknown>("store_get", { key }),
  set: (key: string, value: unknown) => invoke("store_set", { key, value }),
  getAll: () => invoke<Record<string, unknown>>("store_get_all"),
  clear: () => invoke<void>("store_clear"),
};

// ── Window ─────────────────────────────────────────────────────────
export const window = {
  minimize: () => invoke<boolean>("window_minimize"),
  toggleMaximize: () => invoke<boolean>("window_toggle_maximize"),
  close: () => invoke<boolean>("window_close"),
  isMaximized: () => invoke<boolean>("window_is_maximized"),
};

// ── Backend ────────────────────────────────────────────────────────
export const backend = {
  status: () =>
    invoke<{ running: boolean; port: number | null }>("backend_status"),
  logs: () => invoke<string[]>("backend_logs"),
  start: () =>
    invoke<{ ok: boolean; port: number | null }>("backend_start"),
  stop: () => invoke<{ ok: boolean }>("backend_stop"),
  restart: () =>
    invoke<{ ok: boolean; port: number | null }>("backend_restart"),
  health: () =>
    invoke<{ healthy: boolean; port?: number; reason?: string }>(
      "backend_health",
    ),
};

// ── Tray ───────────────────────────────────────────────────────────
export const tray = {
  getConfig: () =>
    invoke<{ enabled: boolean; minimizeToTray: boolean }>("tray_get_config"),
  setEnabled: (enabled: boolean) =>
    invoke<{ enabled: boolean; minimizeToTray: boolean }>("tray_set_enabled", {
      enabled,
    }),
  setMinimizeToTray: (enabled: boolean) =>
    invoke<{ enabled: boolean; minimizeToTray: boolean }>(
      "tray_set_minimize_to_tray",
      { enabled },
    ),
};

// ── Shortcuts ──────────────────────────────────────────────────────
export const shortcuts = {
  getConfig: () =>
    invoke<{ accelerator: string; default: string }>("shortcuts_get_config"),
  setAccelerator: (accelerator: string) =>
    invoke<{ ok: boolean; accelerator?: string; error?: string }>(
      "shortcuts_set_accelerator",
      { accelerator },
    ),
  validate: (accelerator: string) =>
    invoke<{ valid: boolean }>("shortcuts_validate", { accelerator }),
};

// ── Platform info ──────────────────────────────────────────────────
export const platform = {
  os: () => {
    if (typeof navigator !== "undefined") {
      const ua = navigator.userAgent.toLowerCase();
      if (ua.includes("mac")) return "darwin";
      if (ua.includes("win")) return "win32";
      if (ua.includes("linux")) return "linux";
    }
    return "unknown";
  },
};

export const clipboardOs = {
  readText: async () => {
    if (isAndroid()) {
      const clipboard = navigator.clipboard
      if (!clipboard?.readText) throw new Error("Clipboard access is unavailable")
      return clipboard.readText()
    }
    return invoke<string>("read_clipboard_text")
  },
};

// ── Updater ────────────────────────────────────────────────────────
export const updater = {
  getStatus: () => invoke("updater_get_status"),
  check: () => invoke("updater_check"),
  download: () => invoke("updater_download"),
  install: () => invoke("updater_install"),
  setAutoDownload: (enabled: boolean) =>
    invoke("updater_set_auto_download", { enabled }),
  setAutoInstallOnAppQuit: (enabled: boolean) =>
    invoke("updater_set_auto_install_on_app_quit", { enabled }),
};

// ── Voice ──────────────────────────────────────────────────────────
export const voice = {
  status: () => invoke("voice_status"),
  startCelia: (options?: Record<string, unknown>) =>
    invoke("voice_start_celia", { options }),
  stopCelia: () => invoke("voice_stop_celia"),
};

// ── HTTP (Flow canvas node) ────────────────────────────────────────
// Requests run in Rust (see src-tauri/src/http_cmds.rs) because the WebView
// CSP keeps `connect-src` at 'self'. Keeping it there is deliberate: it is
// what stops an injected script from shipping user data off the machine.

export interface TauriHttpResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  body: string
  json: unknown | null
}

export const httpOs = {
  request: (opts: {
    method: string
    url: string
    headers?: Record<string, string>
    body?: string
    timeoutSecs?: number
    allowInsecureHttp?: boolean
  }) =>
    invoke<TauriHttpResponse>('http_request', {
      method: opts.method,
      url: opts.url,
      headers: opts.headers ?? null,
      body: opts.body ?? null,
      timeoutSecs: opts.timeoutSecs ?? null,
      allowInsecureHttp: opts.allowInsecureHttp ?? null,
    }),
}

// ── Filesystem (Flow file nodes) ───────────────────────────────────
// Every call takes a `root`; the Rust side resolves paths inside it and
// rejects anything that escapes (verified after canonicalisation).

export interface TauriFileRead {
  content: string
  path: string
  bytes: number
}

export interface TauriDirEntry {
  name: string
  path: string
  isDir: boolean
  bytes: number
}

export const fsOs = {
  readText: (root: string, path: string) => invoke<TauriFileRead>('fs_read_text', { root, path }),
  writeText: (root: string, path: string, content: string) =>
    invoke<string>('fs_write_text', { root, path, content }),
  listDir: (root: string, path: string) => invoke<TauriDirEntry[]>('fs_list_dir', { root, path }),
}

// ── Flow file roots (operator-confirmed) ───────────────────────────
//
// A flow graph is an importable JSON document, so its `root` field is a
// proposal, not an instruction. The Rust side refuses file access until the
// operator has confirmed a folder; these calls are how the UI records that
// confirmation. See `src-tauri/src/flow_roots.rs` for the enforcement.

export interface ConfirmedFlowRoot {
  path: string
  /** Reads only until the operator explicitly enables writing. */
  writable: boolean
}

export const flowRoots = {
  list: () => invoke<ConfirmedFlowRoot[]>('flow_roots_list'),
  /** Whether this root would be authorized — same rule enforcement uses. */
  check: (root: string, writable: boolean) =>
    invoke<boolean>('flow_root_check', { root, writable }),
  confirm: (root: string, writable: boolean) =>
    invoke<ConfirmedFlowRoot[]>('flow_root_confirm', { root, writable }),
  revoke: (root: string) => invoke<ConfirmedFlowRoot[]>('flow_root_revoke', { root }),
}

/**
 * True when an error is the Rust side refusing an unconfirmed Flow root.
 *
 * The Flow nodes call this to turn a hard failure into a confirmation prompt:
 * without it, pointing a node at a new folder reports an error the operator
 * cannot act on, which is a worse experience than the gate is worth.
 */
export function isUnconfirmedRootError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes('Flow file access is not confirmed')
}

/** True when the root is confirmed but read-only. */
export function isReadOnlyRootError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes('Read-only Flow root')
}

// ── Remote project access ─────────────────────────────────────────

export interface RemoteConnectionInput {
  kind: RemoteConnectionType
  alias?: string
  host?: string
  port?: number
  username?: string
  authMethod?: 'password' | 'key'
  privateKeyPath?: string
  password?: string
  trustHostKey?: boolean
  distro?: string
  container?: string
}

export interface RemoteConnectionResult {
  ok: boolean
  cwd: string
  logs: string[]
}

export interface RemoteDirEntry {
  name: string
  path: string
  isDir: boolean
}

export interface RemoteSyncResult {
  ok: boolean
  resource: string
  logs: string[]
}

export interface RemoteRuntimeResult {
  localPort: number
  remotePort: number
  runtimeToken: string
  platform: string
  installed: boolean
  logs: string[]
}

export interface RemoteRuntimeProgress {
  projectId: string
  message: string
}

export interface RemoteSshHost {
  alias: string
  host?: string
  port?: number
  username?: string
  privateKeyPath?: string
}

const hasTauriRuntime = () => typeof __TAURI_INTERNALS__ !== 'undefined'
const REMOTE_PROJECTS_KEY = 'hakusai-remote-projects'

export const remoteOs = {
  listSshHosts: () => invoke<RemoteSshHost[]>('remote_list_ssh_hosts'),
  listTargets: (kind: RemoteConnectionType) =>
    invoke<string[]>('remote_list_targets', { kind }),
  connect: (config: RemoteConnectionInput) =>
    invoke<RemoteConnectionResult>('remote_connect', { config }),
  listDir: (config: RemoteConnectionInput, path: string) =>
    invoke<RemoteDirEntry[]>('remote_list_dir', { config, path }),
  sync: (config: RemoteConnectionInput, path: string, resource: string) =>
    invoke<RemoteSyncResult>('remote_sync', { config, path, resource }),
  startRuntime: (projectId: string, config: RemoteConnectionInput, path: string, installMode?: RemoteRuntimeInstallMode) =>
    invoke<RemoteRuntimeResult>('remote_start_runtime', {
      request: { projectId, config, path, installMode },
    }),
  stopRuntime: (projectId: string) =>
    invoke<void>('remote_stop_runtime', { projectId }),
}

export async function loadRemoteProjects(): Promise<Project[]> {
  try {
    const raw = hasTauriRuntime()
      ? await store.get(REMOTE_PROJECTS_KEY)
      : JSON.parse(localStorage.getItem(REMOTE_PROJECTS_KEY) || 'null')
    return Array.isArray(raw) ? raw.filter((item): item is Project => item?.kind === 'remote') : []
  } catch {
    return []
  }
}

export async function saveRemoteProjects(projects: Project[]): Promise<void> {
  const value = projects.map((project) => ({ ...project, kind: 'remote' as const }))
  if (hasTauriRuntime()) {
    await store.set(REMOTE_PROJECTS_KEY, value)
    return
  }
  try {
    localStorage.setItem(REMOTE_PROJECTS_KEY, JSON.stringify(value))
  } catch {
    // Private browsing or a full storage quota should not block local projects.
  }
}

export function remoteConnectionForProject(project: Project): RemoteConnectionInput | null {
  const connection = project.remote
  if (!connection) return null
  return {
    kind: connection.type,
    alias: connection.alias,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authMethod: connection.authMethod,
    privateKeyPath: connection.privateKeyPath,
    distro: connection.distro,
    container: connection.container,
  }
}

export function toRemoteProjectConnection(
  input: RemoteConnectionInput,
  id: string,
): RemoteProjectConnection {
  return {
    id,
    type: input.kind,
    alias: input.alias,
    host: input.host,
    port: input.port,
    username: input.username,
    authMethod: input.authMethod,
    privateKeyPath: input.privateKeyPath,
    distro: input.distro,
    container: input.container,
  }
}

// ── Git review / worktree / doctor ─────────────────────────────────
export interface TauriWorktree {
  path: string
  branch: string | null
  head: string
  bare: boolean
  locked: boolean
}

export interface TauriDoctorCheck {
  id: string
  name: string
  required: boolean
  found: boolean
  version?: string
  path?: string
  status: 'ok' | 'missing' | 'outdated' | 'error'
  hint?: string
}

export interface TauriDoctorReport {
  checks: TauriDoctorCheck[]
  healthy: boolean
  backend_version?: string
}

export const gitOs = {
  /**
   * Stage or revert a single hunk.
   *
   * Goes through the Rust Runtime (`POST /v1/workspace/apply-hunk`) rather than
   * spawning `git apply` in the Tauri process. The desktop command it replaces
   * (`git_apply_patch`, `src-tauri/src/git_cmds.rs`) took a caller-supplied
   * `workdir` and arbitrary patch text, so a caller chose both the repository
   * and the mutation. The Runtime route is bound to the workspace it serves and
   * validates `path` as workspace-relative, so only the choice of *hunk* remains
   * caller-controlled — which is the whole point of the button.
   *
   * `path` is the workspace-relative file the hunk belongs to; the caller reads
   * it from the parsed diff rather than this function re-deriving it from the
   * patch text, which would be a second, weaker parser.
   */
  applyPatch: async (options: {
    path: string
    patch: string
    reverse?: boolean
    cached?: boolean
  }): Promise<void> => {
    const { apiClient } = await import('./client')
    const response = await fetch(`${apiClient.runtimeBaseUrl()}/v1/workspace/apply-hunk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: options.path,
        patch: options.patch,
        reverse: options.reverse ?? false,
        cached: options.cached ?? false,
      }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(detail.trim() || `Applying the hunk failed (${response.status})`)
    }
  },
  branchList: (workdir: string) => invoke<string[]>("git_branch_list", { workdir }),
  worktreeList: (workdir: string) => invoke<TauriWorktree[]>("git_worktree_list", { workdir }),
  /**
   * Create a worktree through the Rust Runtime (`POST /v1/workspace/worktree`)
   * rather than spawning `git worktree add` in the Tauri process. The desktop
   * command it replaced (`git_worktree_add`, `src-tauri/src/git_cmds.rs`) took
   * a caller-supplied `workdir`; the Runtime route is bound to the workspace it
   * serves and validates `path` as workspace-relative and both branch names as
   * git references, so the caller controls only where inside the workspace the
   * worktree lands.
   *
   * `workdir` is accepted for call-site compatibility but unused: the caller
   * derives it from `getGitStatus()`, which already reports the Runtime
   * workspace, so the route's fixed scope is the same repository.
   */
  worktreeAdd: async (workdir: string, path: string, branch?: string, newBranch?: string) => {
    void workdir
    const { apiClient } = await import('./client')
    const response = await fetch(`${apiClient.runtimeBaseUrl()}/v1/workspace/worktree`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path,
        branch: branch ?? null,
        new_branch: newBranch ?? null,
      }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(detail.trim() || `Creating the worktree failed (${response.status})`)
    }
  },
  prList: (workdir: string) =>
    invoke<Array<Record<string, unknown>>>("git_pr_list", { workdir }),
  /** CI checks for a PR via `gh pr checks <n>` (empty if gh unavailable). */
  prChecks: (workdir: string, number: number) =>
    invoke<Array<Record<string, unknown>>>("git_pr_checks", { workdir, number }),
}

export const doctor = {
  checkDependencies: (backendHealthy: boolean, backendVersion?: string) =>
    invoke<TauriDoctorReport>("doctor_check_dependencies", {
      backendHealthy,
      backendVersion,
    }),
}

// ── Project folder access ─────────────────────────────────────────
export interface ProjectFolderSelection {
  /** Real local workspace path used by the runtime. */
  path: string
  /** Android SAF tree URI, persisted for later sync. */
  sourceUri?: string
  name?: string
}

function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)
}

function bridgeLocale(): 'zh-CN' | 'en-US' {
  if (typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('zh')) return 'zh-CN'
  if (typeof navigator !== 'undefined' && String(navigator.language || '').toLowerCase().startsWith('zh')) return 'zh-CN'
  return 'en-US'
}

/** Ask before a project folder is exposed to read/write/command tools. */
export async function confirmProjectAccess(): Promise<boolean> {
  // The extra "allow folder access" dialog after every folder pick was noise —
  // the user just chose that folder deliberately, and the permission mode
  // still gates what tools can do. Access is granted without a second prompt.
  if (typeof __TAURI_INTERNALS__ === "undefined") return false
  return true
}

/** Open the desktop picker or Android's persistent SAF folder picker. */
export async function pickProjectFolder(): Promise<ProjectFolderSelection | null> {
  if (typeof __TAURI_INTERNALS__ === "undefined") return null
  if (isAndroid()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      return await invoke<ProjectFolderSelection>("plugin:hakus-folder-picker|pick_folder")
    } catch (e) {
      console.warn("[tauriBridge] Android folder picker failed:", e)
      return null
    }
  }

  try {
    const { open } = await import("@tauri-apps/plugin-dialog")
    const selected = await open({ directory: true, multiple: false, title: bridgeLocale() === 'zh-CN' ? "选择项目文件夹" : "Choose project folder" })
    if (typeof selected !== "string" || !selected) return null
    return { path: selected }
  } catch (e) {
    console.warn("[tauriBridge] folder picker failed:", e)
    return null
  }
}

async function syncAndroidFolder(
  command: "refresh_folder" | "sync_folder",
  selection: Pick<ProjectFolderSelection, "path" | "sourceUri">,
): Promise<void> {
  if (!isAndroid() || !selection.sourceUri) return
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke(`plugin:hakus-folder-picker|${command}`, {
    request: { uri: selection.sourceUri, path: selection.path },
  })
}

export function refreshProjectFolder(selection: Pick<ProjectFolderSelection, "path" | "sourceUri">): Promise<void> {
  return syncAndroidFolder("refresh_folder", selection)
}

export function syncProjectFolder(selection: Pick<ProjectFolderSelection, "path" | "sourceUri">): Promise<void> {
  return syncAndroidFolder("sync_folder", selection)
}

// Keep the old helper for any non-project caller. New project flows use the
// richer selection so Android can persist its SAF URI.
export async function pickFolder(): Promise<string | null> {
  const selected = await pickProjectFolder()
  return selected?.path || null
}
