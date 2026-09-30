import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LiquidGlassSurface } from '@/components/ui/liquid-glass-surface'

export interface GlassSelectOption {
  value: string
  label: string
}

interface GlassSelectProps {
  value: string
  onChange: (value: string) => void
  options: GlassSelectOption[]
  id?: string
  ariaLabel?: string
  className?: string
  triggerClassName?: string
  disabled?: boolean
  onFocus?: () => void
  onBlur?: () => void
}

/**
 * Liquid-glass replacement for native <select>. Native popups render as an
 * OS-gray list that clashes with the app theme — this renders the options in
 * a rounded, translucent, blur-backed panel with restrained selection states.
 */
export function GlassSelect({ value, onChange, options, id, ariaLabel, className, triggerClassName, disabled, onFocus, onBlur }: GlassSelectProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)))
  const [listPosition, setListPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const triggerId = id ?? `${listId}-trigger`

  const selected = options.find((option) => option.value === value)

  useEffect(() => {
    const selectedIndex = options.findIndex((option) => option.value === value)
    setActiveIndex(Math.max(0, selectedIndex))
  }, [options, value])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      setListPosition(null)
      return
    }
    const updatePosition = () => {
      const trigger = rootRef.current?.querySelector<HTMLElement>('[role="combobox"]')
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom - 12
      const spaceAbove = rect.top - 12
      const estimatedHeight = Math.min(288, Math.max(96, options.length * 40 + 12))
      const openAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow
      const maxHeight = Math.max(96, Math.min(288, openAbove ? spaceAbove : spaceBelow))
      const top = openAbove
        ? Math.max(8, rect.top - maxHeight - 6)
        : Math.min(Math.max(8, window.innerHeight - maxHeight - 8), rect.bottom + 6)
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - rect.width - 8))
      setListPosition({ top, left, width: rect.width, maxHeight })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, options.length])

  useEffect(() => {
    const list = listRef.current
    const activeOption = list?.querySelector<HTMLElement>('[data-active="true"]')
    if (!open || !list || !activeOption) return

    const listRect = list.getBoundingClientRect()
    const optionRect = activeOption.getBoundingClientRect()
    if (optionRect.top < listRect.top) {
      list.scrollTop -= listRect.top - optionRect.top
    } else if (optionRect.bottom > listRect.bottom) {
      list.scrollTop += optionRect.bottom - listRect.bottom
    }
  }, [activeIndex, open])

  const commit = (value: string) => {
    onChange(value)
    setOpen(false)
    requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus({ preventScroll: true })
    })
  }

  const handleTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (disabled || options.length === 0) return
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((index) => {
          const next = event.key === 'ArrowDown' ? index + 1 : index - 1
          return (next + options.length) % options.length
        })
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        commit(options[activeIndex]?.value ?? value)
      }
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setOpen(true)
    }
  }

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        id={triggerId}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        disabled={disabled || options.length === 0}
        onClick={() => !disabled && options.length > 0 && setOpen((v) => !v)}
        onKeyDown={handleTriggerKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        className={cn(
          'flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-border/70 bg-background/70 px-3.5 py-2 text-left text-sm shadow-sm transition-colors',
          'hover:border-primary/30 hover:bg-background',
          'glass-select-trigger',
          open && 'border-foreground/20',
          disabled && 'cursor-not-allowed opacity-50',
          triggerClassName,
        )}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? value}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180 text-primary')} aria-hidden="true" />
      </button>
      {open && createPortal(
        <LiquidGlassSurface
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel ? undefined : triggerId}
          style={listPosition ? {
            top: listPosition.top,
            left: listPosition.left,
            width: listPosition.width,
            maxHeight: listPosition.maxHeight,
            visibility: 'visible',
          } : { visibility: 'hidden' }}
          className="glass-list pointer-events-auto fixed z-[500]"
          data-hakus-overlay="glass-select"
        >
          {options.map((option, index) => {
            const isSelected = option.value === value
            return (
                <button
                  key={option.value}
                  id={`${listId}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-active={index === activeIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => commit(option.value)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
                    isSelected
                      ? 'bg-foreground/[0.08] font-medium text-foreground'
                      : index === activeIndex
                        ? 'bg-foreground/[0.06] text-foreground'
                        : 'text-foreground/90',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                </button>
            )
          })}
        </LiquidGlassSurface>,
        rootRef.current?.closest<HTMLElement>('[data-hakus-overlay="dialog-content"]') ?? document.body,
      )}
    </div>
  )
}
