import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Tailwind-aware class merge — typical shadcn/ui helper */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Generate a short random ID (good enough for client-side session/message IDs) */
export function generateId(prefix = ''): string {
  const rand = Math.random().toString(36).slice(2, 10)
  const time = Date.now().toString(36)
  return `${prefix}${time}${rand}`
}

/** Format a timestamp as HH:MM */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Format a timestamp as short date+time for sidebar */
export function formatSessionTime(ts: number): string {
  const now = new Date()
  const date = new Date(ts)
  const sameDay = now.toDateString() === date.toDateString()
  if (sameDay) return formatTime(ts)
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (yesterday.toDateString() === date.toDateString()) return '昨天'
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

/** Truncate a string for preview (e.g. session title) */
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/**
 * Pretty-print a filesystem path for UI.
 * Strips the Windows extended-length prefix (`\\?\`, `\\?\UNC\`) that Tauri
 * dialogs often return, so users see `D:\项目\foo` instead of `\\?\D:\项目\foo`.
 */
export function displayPath(path: string): string {
  if (!path) return path
  let out = path
  if (out.startsWith('\\\\?\\UNC\\')) {
    out = `\\\\${out.slice(8)}`
  } else if (out.startsWith('\\\\?\\')) {
    out = out.slice(4)
  }
  return out
}

/** Copy text to clipboard with Tauri OS bridge + WebView fallbacks */
export async function copyToClipboard(text: string): Promise<boolean> {
  // 1) Tauri desktop: OS clipboard is reliable; WebView navigator.clipboard
  //    is often blocked because the page is not a secure context.
  try {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('copy_text', { text })
      return true
    }
  } catch {
    // fall through
  }
  // 2) Secure-context Clipboard API
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through
  }
  // 3) Legacy execCommand
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** Detect system theme preference */
export function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Apply theme class to <html> */
export function applyTheme(theme: 'light' | 'dark' | 'system') {
  const resolved = theme === 'system' ? getSystemTheme() : theme
  document.documentElement.classList.toggle('dark', resolved === 'dark')
}
