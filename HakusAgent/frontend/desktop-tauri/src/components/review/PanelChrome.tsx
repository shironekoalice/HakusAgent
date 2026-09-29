/**
 * Shared chrome for right-panel tabs.
 */

import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

export function RpShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('rp-shell', className)}>{children}</div>
}

export function RpHeader({
  icon: Icon,
  title,
  meta,
  actions,
}: {
  icon?: LucideIcon
  title: string
  meta?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="rp-header">
      <div className="rp-header-left">
        {Icon ? <Icon className="rp-header-icon" aria-hidden /> : null}
        <span className="rp-title">{title}</span>
        {meta ? <span className="rp-title-meta">{meta}</span> : null}
      </div>
      {actions ? <div className="rp-header-actions">{actions}</div> : null}
    </div>
  )
}

export function RpIconButton({
  icon: Icon,
  title,
  onClick,
  disabled,
  className,
}: {
  icon: LucideIcon
  title: string
  onClick?: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      className={cn('rp-icon-btn', className)}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}

export function RpBody({ children, pad = true, className }: { children: React.ReactNode; pad?: boolean; className?: string }) {
  return <div className={cn('rp-body', pad && 'rp-pad', className)}>{children}</div>
}

export function RpSection({
  label,
  icon: Icon,
  children,
  className,
}: {
  label?: string
  icon?: LucideIcon
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('rp-section', className)}>
      {label ? (
        <div className="rp-section-label">
          {Icon ? <Icon aria-hidden /> : null}
          {label}
        </div>
      ) : null}
      {children}
    </section>
  )
}

export function RpEmpty({
  icon: Icon,
  title,
  desc,
  action,
}: {
  icon?: LucideIcon
  title: string
  desc?: string
  action?: React.ReactNode
}) {
  return (
    <div className="rp-empty">
      {Icon ? <Icon className="rp-empty-icon" aria-hidden /> : null}
      <div className="rp-empty-title">{title}</div>
      {desc ? <div className="rp-empty-desc">{desc}</div> : null}
      {action}
    </div>
  )
}

export function RpFooter({ children }: { children: React.ReactNode }) {
  return <div className="rp-footer">{children}</div>
}

export function RpChip({
  tone = 'muted',
  children,
  className,
}: {
  tone?: 'muted' | 'ok' | 'warn' | 'danger' | 'info'
  children: React.ReactNode
  className?: string
}) {
  return <span className={cn('rp-chip', `rp-chip-${tone}`, className)}>{children}</span>
}

export function RpStat({
  icon: Icon,
  label,
  value,
  sub,
  className,
}: {
  icon?: LucideIcon
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('rp-stat', className)}>
      <div className="rp-stat-label">
        {Icon ? <Icon aria-hidden /> : null}
        {label}
      </div>
      <div className="rp-stat-value">{value}</div>
      {sub != null && <div className="rp-stat-sub">{sub}</div>}
    </div>
  )
}

/** Locale helper used by all review panels. */
export function useRpCopy() {
  const { locale } = useI18n()
  return (zh: string, en: string) => (locale === 'zh-CN' ? zh : en)
}
