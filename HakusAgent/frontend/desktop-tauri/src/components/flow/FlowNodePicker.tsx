/**
 * FlowNodePicker — ComfyUI-style floating node search box on the canvas.
 * Double-click empty canvas (or press the "+" button) to summon it; typing
 * filters every registered node, Enter inserts the highlighted one.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { FLOW_NODE_DEFS } from '@/lib/flow/registry'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const CATEGORY_ORDER = ['io', 'llm', 'logic', 'tool', 'human', 'data']

const CATEGORY_LABEL: Record<string, { zh: string; en: string }> = {
  io: { zh: '输入输出', en: 'Input / Output' },
  llm: { zh: '模型', en: 'Model' },
  logic: { zh: '逻辑', en: 'Logic' },
  tool: { zh: '工具', en: 'Tools' },
  human: { zh: '人工', en: 'Human' },
  data: { zh: '数据', en: 'Data' },
}

interface Props {
  open: boolean
  /** Screen coordinates inside the canvas wrapper. */
  at: { x: number; y: number }
  onClose: () => void
  onPick: (type: string) => void
}

export function FlowNodePicker({ open, at, onClose, onPick }: Props) {
  const { locale } = useI18n()
  const zh = locale === 'zh-CN'
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    const t = window.setTimeout(() => inputRef.current?.focus(), 10)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = FLOW_NODE_DEFS.filter((d) => {
      if (!q) return true
      return (
        d.type.includes(q) ||
        d.label.toLowerCase().includes(q) ||
        (d.labelZh || '').toLowerCase().includes(q) ||
        (d.labelZh || '').includes(query.trim())
      )
    })
    const flat = matched.slice().sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a.category || '')
      const bi = CATEGORY_ORDER.indexOf(b.category || '')
      return ai - bi
    })
    return { flat, byCat: CATEGORY_ORDER.map((c) => ({ cat: c, items: flat.filter((d) => (d.category || '') === c) })).filter((g) => g.items.length) }
  }, [query])

  if (!open) return null
  const flat = groups.flat

  return (
    <div
      ref={boxRef}
      className="flow-picker"
      style={{ left: Math.max(8, at.x), top: Math.max(8, at.y) }}
    >
      <div className="flow-picker-search search-composite">
        <Search className="h-3 w-3 shrink-0 opacity-60" />
        <input
          ref={inputRef}
          className="flow-picker-input search-composite-input"
          value={query}
          placeholder={zh ? '搜索节点…' : 'Search nodes…'}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(flat.length - 1, c + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(0, c - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const target = flat[cursor]
              if (target) {
                onPick(target.type)
                onClose()
              }
            }
          }}
        />
      </div>

      <div className="flow-picker-list">
        {flat.length === 0 ? (
          <div className="flow-picker-empty">{zh ? '没有匹配的节点' : 'No matching node'}</div>
        ) : (
          groups.byCat.map((g) => (
            <div key={g.cat} className="flow-picker-group">
              <div className="flow-picker-group-label">
                {CATEGORY_LABEL[g.cat]?.[zh ? 'zh' : 'en'] || g.cat}
              </div>
              {g.items.map((def) => {
                const idx = flat.indexOf(def)
                return (
                  <button
                    key={def.type}
                    type="button"
                    className={cn('flow-picker-item', idx === cursor && 'flow-picker-item-active')}
                    draggable
                    onDragStart={(e) => {
                      // The canvas onDrop reads this MIME type; without it,
                      // dragging from the palette does nothing.
                      e.dataTransfer.setData('application/hakus-flow-type', def.type)
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    onMouseEnter={() => setCursor(idx)}
                    onClick={() => {
                      onPick(def.type)
                      onClose()
                    }}
                  >
                    <span className="flow-node-dot" style={{ background: def.color }} />
                    <span className="truncate">{zh ? def.labelZh || def.label : def.label}</span>
                    <span className="flow-picker-type">{def.type}</span>
                  </button>
                )
              })}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
