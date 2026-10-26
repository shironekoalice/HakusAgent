/// <reference types="vite/client" />

// Tauri global declarations
declare const __TAURI_INTERNALS__: unknown;

// Legacy Electron API type — kept for gradual migration
// Components still reference window.electron but will be migrated to
// direct tauriBridge imports over time.

interface TrayConfig {
  enabled: boolean
  minimizeToTray: boolean
  active: boolean
}

interface ShortcutsConfig {
  accelerator: string
  registered: string | null
  default: string
}

interface SetAcceleratorResult {
  ok: boolean
  error: string | null
  registered: string | null
}

type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installed'
  | 'error'

interface UpdaterState {
  status: UpdateStatus
  info: {
    version: string
    releaseDate: string | null
    releaseNotes: string | unknown | null
  } | null
  progress: number | null
  error: string | null
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  currentVersion: string
  isPackaged: boolean
}

interface VoiceProcessStatus {
  running: boolean
  pid: number | null
  startedAt: number | null
  lastError: string | null
  state?: 'started' | 'unavailable' | 'rejected' | 'crashed'
  extensionId?: string
}

interface VoiceProcessResult {
  ok: boolean
  running: boolean
  pid: number | null
  error: string | null
  text?: string | null
}

interface ElectronAPI {
  store: {
    get: (key: string) => Promise<any>
    set: (key: string, value: unknown) => Promise<void>
    getAll: () => Promise<Record<string, any>>
  }
  window: {
    minimize: () => Promise<boolean>
    toggleMaximize: () => Promise<boolean>
    close: () => Promise<boolean>
    isMaximized: () => Promise<boolean>
  }
  backend: {
    status: () => Promise<any>
    logs: () => Promise<string[]>
    restart: () => Promise<{ ok: boolean; port: number | null; error: string | null; logPath: string | null }>
  }
  tray: {
    getConfig: () => Promise<TrayConfig>
    setEnabled: (enabled: boolean) => Promise<TrayConfig>
    setMinimizeToTray: (enabled: boolean) => Promise<TrayConfig>
    onNewChat: (cb: () => void) => () => void
  }
  shortcuts: {
    getConfig: () => Promise<ShortcutsConfig>
    setAccelerator: (accelerator: string | null) => Promise<SetAcceleratorResult>
    validate: (accelerator: string) => Promise<{ valid: boolean }>
  }
  updater: {
    getStatus: () => Promise<UpdaterState>
    check: () => Promise<UpdaterState>
    download: () => Promise<UpdaterState>
    install: () => Promise<{ ok: boolean }>
    setAutoDownload: (enabled: boolean) => Promise<UpdaterState>
    setAutoInstallOnAppQuit: (enabled: boolean) => Promise<UpdaterState>
    onStatusChange: (cb: (s: UpdaterState) => void) => () => void
  }
  voice: {
    status: () => Promise<VoiceProcessStatus>
    startCelia: (options?: {
      configPath?: string
      openInTerminal?: boolean
      threadId?: string
    }) => Promise<VoiceProcessResult>
    stopCelia: () => Promise<VoiceProcessResult>
  }
  platform: NodeJS.Platform
  versions: {
    electron: string
    chrome: string
    node: string
  }
}

interface Window {
  electron?: ElectronAPI
}
