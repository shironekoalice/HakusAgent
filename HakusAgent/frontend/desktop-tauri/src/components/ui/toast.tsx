/**
 * Minimal toast system — no portal/provider ceremony.
 *
 * Usage:
 *   import { useToast, Toaster } from '@/components/ui/toast'
 *   const toast = useToast()
 *   toast.success('Saved')
 *   toast.error('Failed: ...')
 *
 * Render <Toaster /> once near the app root.
 */

import { create } from 'zustand'
import { useEffect, useMemo } from 'react'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

type ToastVariant = 'success' | 'error' | 'info'

interface ToastItem {
  id: string
  variant: ToastVariant
  message: string
  duration: number
}

interface ToastStore {
  toasts: ToastItem[]
  push: (variant: ToastVariant, message: string, duration?: number) => void
  dismiss: (id: string) => void
}

const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (variant, message, duration = 3500) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    set({ toasts: [...get().toasts, { id, variant, message, duration }] })
    setTimeout(() => get().dismiss(id), duration)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

/** Hook returning stable functions to fire toasts from anywhere. */
export function useToast() {
  const push = useToastStore((s) => s.push)
  return useMemo(
    () => ({
      success: (m: string, d?: number) => push('success', m, d),
      error: (m: string, d?: number) => push('error', m, d ?? 5000),
      info: (m: string, d?: number) => push('info', m, d),
    }),
    [push],
  )
}

/**
 * Imperative toast helpers for non-component callers (App-level effects,
 * Tauri event listeners, store subscriptions) that cannot use the hook.
 */
export const toastApi = {
  error: (message: string, duration?: number) =>
    useToastStore.getState().push('error', message, duration ?? 5000),
  info: (message: string, duration?: number) =>
    useToastStore.getState().push('info', message, duration),
  success: (message: string, duration?: number) =>
    useToastStore.getState().push('success', message, duration),
}

const ICONS: Record<ToastVariant, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
}

const VARIANT_STYLES: Record<ToastVariant, string> = {
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  error: 'border-red-500/40 bg-red-500/10 text-red-500',
  info: 'border-primary/40 bg-primary/10 text-primary',
}

/** Single toast entry — animates itself out. */
function ToastRow({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss)
  const Icon = ICONS[item.variant]
  useEffect(() => {
    // noop — duration timer is in store
  }, [])
  return (
    <div
      className={cn(
        'pointer-events-auto flex items-start gap-2 rounded-[var(--ui-radius-surface)] border px-4 py-3 text-sm shadow-lg backdrop-blur-md',
        'animate-in fade-in-0 slide-in-from-bottom-2 duration-200',
        VARIANT_STYLES[item.variant],
      )}
      role="status"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1 break-words text-foreground/90">{item.message}</div>
      <button
        onClick={() => dismiss(item.id)}
        className="ml-1 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

/** Render once at app root. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="hakus-toast-root pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((t) => (
        <ToastRow key={t.id} item={t} />
      ))}
    </div>
  )
}
