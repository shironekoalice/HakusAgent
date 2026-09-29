/**
 * MessageNavRail — 会话右缘「用户消息导航轨」。
 *
 * 对齐解码资产 thread-user-message-navigation-rail-app-5098d9077294.js /
 * thread-user-message-navigation-rail-app-33e1d82a93e0.css 的精确规格：
 *   - marker = 26×2px 横线（_Marker/_MarkerLine，非圆点），默认 scaleX(.2308)
 *   - 当前消息 marker：opacity .6 + 文本色（button[aria-current=true]）
 *   - hover：自身 scaleX(1) + opacity 1；邻接 1/2/3 级衰减 scaleX .7/.4/.2
 *   - 过渡 .16s linear(0,.398 10%,…,1)（CSS 内 .cx-rail-marker 原样实现）
 *   - hover 预览：w-80 rounded-xl bg-elevated/95 p-2 text-sm + line-clamp-3
 *   - 点击 → scrollIntoView 平滑跳到该消息；滚动时跟随视口高亮「当前」
 *
 * 纯 DOM 探测实现（复用 MessageBubble 的 data-role/data-message-id
 * 锚点），不侵入消息渲染逻辑。用户消息少于 4 条时不渲染。
 */
import { useEffect, useState, useCallback, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

interface RailItem {
  id: string
  /** 预览文本（截断后的纯文本摘要）。 */
  preview: string
}

interface MessageNavRailProps {
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** 消息列表变化时变化的 key，触发重新枚举用户消息。 */
  messagesKey: string | number
}

/** 少于这个数量的用户消息不显示导航轨（没有导航价值）。 */
const MIN_MARKS = 4
const PREVIEW_MAX = 80

export function MessageNavRail({ scrollRef, messagesKey }: MessageNavRailProps) {
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en)
  const [items, setItems] = useState<RailItem[]>([])
  const [activeIndex, setActiveIndex] = useState(-1)
  const [hoverIndex, setHoverIndex] = useState(-1)

  // 从 DOM 枚举用户消息锚点（id + 预览文本）。
  const enumerate = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      setItems([])
      return
    }
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-role="user"][data-message-id]'))
    const next = nodes.map((node) => {
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim()
      return {
        id: node.dataset.messageId || '',
        preview: text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text,
      }
    }).filter((item) => item.id)
    setItems(next)
  }, [scrollRef])

  useEffect(() => {
    enumerate()
  }, [messagesKey, enumerate])

  // 布局稳定后再枚举一次（markdown/图片渲染会改变高度）。
  useEffect(() => {
    const t = setTimeout(enumerate, 200)
    return () => clearTimeout(t)
  }, [messagesKey, enumerate])

  // 滚动时计算「当前」消息：最接近视口顶部的那条。
  const recomputeActive = useCallback(() => {
    const el = scrollRef.current
    if (!el || items.length === 0) {
      setActiveIndex(-1)
      return
    }
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-role="user"][data-message-id]'))
    const containerTop = el.getBoundingClientRect().top
    let best = -1
    let bestDist = Number.POSITIVE_INFINITY
    nodes.forEach((node, idx) => {
      const dist = Math.abs(node.getBoundingClientRect().top - containerTop - 32)
      if (dist < bestDist) {
        bestDist = dist
        best = idx
      }
    })
    setActiveIndex(best)
  }, [scrollRef, items.length])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const handler = () => recomputeActive()
    el.addEventListener('scroll', handler, { passive: true })
    // 初始计算一次
    recomputeActive()
    return () => el.removeEventListener('scroll', handler)
  }, [scrollRef, recomputeActive])

  const jumpTo = useCallback((id: string) => {
    const el = scrollRef.current
    if (!el) return
    el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [scrollRef])

  const preview = useMemo(
    () => (hoverIndex >= 0 && hoverIndex < items.length ? items[hoverIndex].preview : ''),
    [hoverIndex, items],
  )

  if (items.length < MIN_MARKS) return null

  return (
    <div className="pointer-events-none absolute right-1 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center gap-1.5">
      {items.map((item, idx) => {
        // 资产的邻接衰减：hover 点相邻 1/2/3 级 → scaleX .7/.4/.2，其余保持基础态。
        const distance = hoverIndex >= 0 ? Math.abs(idx - hoverIndex) : 0
        const isHot = hoverIndex === idx
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => jumpTo(item.id)}
            onMouseEnter={() => setHoverIndex(idx)}
            onMouseLeave={() => setHoverIndex((cur) => (cur === idx ? -1 : cur))}
            aria-current={idx === activeIndex}
            aria-label={copy('跳转到此消息', 'Jump to this message')}
            className="group pointer-events-auto relative flex h-2.5 w-[30px] items-center justify-center"
          >
            <span
              className={cn('cx-rail-marker')}
              data-hot={isHot ? 'true' : undefined}
              data-current={idx === activeIndex ? 'true' : undefined}
              data-level={!isHot && hoverIndex >= 0 && distance >= 1 && distance <= 3 ? String(distance) : undefined}
            />
            {/* hover 预览气泡（资产 _preview_3gogw_1：w-80 / line-clamp-3 / text-sm） */}
            {preview && hoverIndex === idx && (
              <span
                className="pointer-events-none absolute right-[38px] top-1/2 w-80 max-w-[calc(100vw-1rem)] -translate-y-1/2 rounded-xl bg-card/95 p-2 text-left text-sm leading-5 shadow-lg ring-[0.5px] ring-border/60 backdrop-blur-sm"
                role="tooltip"
              >
                <span className="line-clamp-3 block text-muted-foreground">{preview}</span>
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
