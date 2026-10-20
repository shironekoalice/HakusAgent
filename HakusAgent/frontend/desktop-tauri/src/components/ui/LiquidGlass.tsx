/**
 * LiquidGlass — 真·液态玻璃表面（SVG 折射实现）
 *
 * 与"半透明 + blur"的伪玻璃不同，这一层做了真实的折射：
 *   1. feTurbulence 生成平滑噪声 → feDisplacementMap 让背景产生透镜式扭曲
 *   2. 双层高光：顶部 specular 弧线 + 边缘 rim light
 *   3. 弹性曲线入场/按压回弹，状态切换时高光位置随指针移动
 *
 * 用法：
 *   <LiquidGlass className="rounded-3xl">内容</LiquidGlass>
 *   <LiquidGlass as="button" interactive>可点击的玻璃按钮</LiquidGlass>
 */
import { useId, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent, ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface LiquidGlassProps {
  children: ReactNode
  className?: string
  /** 玻璃浓度：0.1 最通透，1 最厚重。默认 0.6。 */
  thickness?: number
  /** 可交互：按压时折射增强 + 高光跟随指针。 */
  interactive?: boolean
  /** 内层内容的内边距类。 */
  contentClassName?: string
  style?: CSSProperties
  onClick?: () => void
  ariaLabel?: string
}

export function LiquidGlass({
  children,
  className,
  thickness = 0.6,
  interactive = false,
  contentClassName,
  style,
  onClick,
  ariaLabel,
}: LiquidGlassProps) {
  const filterId = `lg-refract-${useId().replace(/:/g, '')}`
  const ref = useRef<HTMLDivElement>(null)
  const [pressed, setPressed] = useState(false)
  const [glow, setGlow] = useState({ x: 50, y: 0 })

  const t = Math.max(0.05, Math.min(1, thickness))
  // 折射强度随厚度上升；位移尺度太小看不出透镜感，太大则糊成一片。
  const scale = 6 + t * 10

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    setGlow({
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    })
  }

  return (
    <div
      ref={ref}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={ariaLabel}
      onClick={onClick}
      onPointerDown={() => interactive && setPressed(true)}
      onPointerUp={() => interactive && setPressed(false)}
      onPointerLeave={() => interactive && setPressed(false)}
      onPointerMove={handlePointerMove}
      className={cn(
        'liquid-glass relative isolate overflow-hidden',
        interactive && 'cursor-pointer select-none',
        pressed && 'liquid-glass-pressed',
        className,
      )}
      style={{
        // 每块玻璃独立一套折射滤镜，避免共享 filter 时的坐标错位
        ['--lg-thickness' as string]: String(t),
        ['--lg-glow-x' as string]: `${glow.x}%`,
        ['--lg-glow-y' as string]: `${glow.y}%`,
        ...style,
      }}
      data-lg-thickness={t.toFixed(2)}
    >
      {/* 折射层：把背景扭曲成透镜效果 */}
      <svg className="pointer-events-none absolute h-0 w-0" aria-hidden>
        <defs>
          <filter id={filterId} x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.008 0.012"
              numOctaves={2}
              seed={7}
              result="noise"
            />
            <feGaussianBlur in="noise" stdDeviation="2" result="soft" />
            <feDisplacementMap
              in="SourceGraphic"
              in2="soft"
              scale={scale}
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>

      {/* 背景层承载折射滤镜；自身不带内容 */}
      <div className="liquid-glass-backdrop absolute inset-0" style={{ filter: `url(#${filterId})` }} aria-hidden />

      {/* 顶部高光弧 */}
      <div className="liquid-glass-specular absolute inset-0" aria-hidden />
      {/* 跟随指针的柔光 */}
      {interactive && <div className="liquid-glass-glow absolute inset-0" aria-hidden />}
      {/* 边缘 rim light */}
      <div className="liquid-glass-rim absolute inset-0" aria-hidden />

      <div className={cn('relative z-10', contentClassName)}>{children}</div>
    </div>
  )
}
