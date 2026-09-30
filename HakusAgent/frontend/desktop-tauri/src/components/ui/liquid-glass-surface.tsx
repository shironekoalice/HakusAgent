import { forwardRef, useEffect, useState, type HTMLAttributes, type ReactNode } from 'react'
import LiquidGlass from 'liquid-glass-react'
import { cn } from '@/lib/utils'

interface LiquidGlassSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  contentClassName?: string
}

function useReducedTransparency(): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-transparency: reduce)')
    const sync = () => setReduced(media.matches)
    sync()
    media.addEventListener?.('change', sync)
    return () => media.removeEventListener?.('change', sync)
  }, [])

  return reduced
}

/**
 * Shared material for transient surfaces. The displacement pass is kept out
 * of page-sized content so long chat and settings views stay inexpensive.
 */
export const LiquidGlassSurface = forwardRef<HTMLDivElement, LiquidGlassSurfaceProps>(function LiquidGlassSurface(
  { children, className, contentClassName, ...props },
  ref,
) {
  const reducedTransparency = useReducedTransparency()
  const contentClass = cn('liquid-glass-surface-content', contentClassName)

  return (
    <div ref={ref} {...props} className={cn('liquid-glass-surface-host', className)}>
      {reducedTransparency ? (
        <div className={cn('liquid-glass-surface-fallback', contentClass)}>{children}</div>
      ) : (
        <LiquidGlass
          className="liquid-glass-surface"
          displacementScale={20}
          blurAmount={0.25}
          saturation={118}
          aberrationIntensity={0.35}
          elasticity={0}
          cornerRadius={14}
          padding="0"
          style={{ top: '50%', left: '50%' }}
          mode="standard"
        >
          <div className={contentClass}>{children}</div>
        </LiquidGlass>
      )}
    </div>
  )
})
