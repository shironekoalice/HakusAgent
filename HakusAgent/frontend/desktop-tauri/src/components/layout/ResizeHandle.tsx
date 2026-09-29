/**
 * ResizeHandle — draggable divider for resizable panels.
 *
 * Usage: Place between a panel and its neighbour. Dragging updates
 * a CSS custom property on :root so all consumers (wrapper + inner <aside>)
 * resize together automatically.
 *
 * Props:
 *   cssVar     — e.g. '--sidebar-width' or '--right-panel-width'
 *   side       — 'left' means panel is on the left of the handle (drag right → wider)
 *                'right' means panel is on the right of the handle (drag left → wider)
 *   minPx      — minimum width in px when the panel is OPEN (default 180)
 *   maxPx      — maximum width in px (default 600)
 *   collapseThreshold — if provided, dragging the panel narrower than this
 *                triggers `onCollapse` (e.g. auto-hide the sidebar).
 *   onCollapse — callback invoked when the collapse threshold is crossed
 *                during an active drag.
 */

import { useCallback, useRef, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

interface ResizeHandleProps {
  className?: string
  cssVar: string
  side: 'left' | 'right'
  minPx?: number
  maxPx?: number
  collapseThreshold?: number
  onCollapse?: () => void
  expandThreshold?: number
  startWidthPx?: number
  onExpand?: (width: number) => void
}

export function ResizeHandle({
  className,
  cssVar,
  side,
  minPx = 180,
  maxPx = 600,
  collapseThreshold,
  onCollapse,
  expandThreshold,
  startWidthPx,
  onExpand,
}: ResizeHandleProps) {
  const [hovering, setHovering] = useState(false)
  const [dragging, setDragging] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  // When collapse is enabled, the visual floor during drag is the collapse
  // threshold so the user gets feedback that they're entering the collapse
  // zone. Without collapse, the floor is just minPx.
  const dragFloor = collapseThreshold ?? minPx

  // Read the current pixel value of the CSS variable
  const getCurrentWidth = useCallback(() => {
    const val = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim()
    // Could be "16rem", "256px", etc. Parse it.
    const el = document.createElement('div')
    el.style.width = val
    document.body.appendChild(el)
    const px = el.getBoundingClientRect().width
    document.body.removeChild(el)
    return px
  }, [cssVar])

  // Set the CSS variable to a px value (clamped to [dragFloor, maxPx]).
  // dragFloor lets the panel visually shrink into the collapse zone when
  // collapseThreshold is configured.
  const setWidth = useCallback((px: number) => {
    const clamped = Math.max(dragFloor, Math.min(maxPx, px))
    document.documentElement.style.setProperty(cssVar, `${clamped}px`)
  }, [cssVar, dragFloor, maxPx])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(true)
    startXRef.current = e.clientX
    startWidthRef.current = startWidthPx ?? getCurrentWidth()
    // Mark the document as "currently resizing" so CSS can disable
    // width transitions on panel wrappers. Without this, the 200ms
    // transition on the wrapper makes the panel lag behind the cursor
    // during drag, which feels like the resize direction is reversed.
    document.documentElement.setAttribute('data-resizing', cssVar)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [getCurrentWidth, cssVar])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return
    const delta = e.clientX - startXRef.current
    // For 'left' side panel: dragging right → positive delta → wider
    // For 'right' side panel: dragging left → negative delta → wider
    const newWidth = side === 'left'
      ? startWidthRef.current + delta
      : startWidthRef.current - delta

    if (expandThreshold !== undefined && onExpand && newWidth >= expandThreshold) {
      onExpand(Math.max(minPx, Math.min(maxPx, newWidth)))
    }

    // Auto-collapse: if the user dragged the panel narrower than the
    // threshold, fire onCollapse and stop the drag. Also reset the CSS
    // variable to minPx so the panel reopens at a sensible width later.
    if (
      collapseThreshold !== undefined &&
      onCollapse &&
      newWidth <= collapseThreshold
    ) {
      onCollapse()
      document.documentElement.style.setProperty(cssVar, `${minPx}px`)
      setDragging(false)
      return
    }

    setWidth(newWidth)
  }, [dragging, side, setWidth, collapseThreshold, onCollapse, cssVar, minPx, expandThreshold, onExpand, maxPx])

  const onPointerUp = useCallback(() => {
    // If the user released the drag below minPx (but above the collapse
    // threshold, otherwise onCollapse would have fired already), snap the
    // width back to minPx so the panel doesn't stay in a weird half-state.
    if (collapseThreshold !== undefined) {
      const currentWidth = getCurrentWidth()
      if (currentWidth < minPx) {
        document.documentElement.style.setProperty(cssVar, `${minPx}px`)
      }
    }
    setDragging(false)
    // Re-enable CSS transitions on panel wrappers.
    document.documentElement.removeAttribute('data-resizing')
  }, [collapseThreshold, getCurrentWidth, cssVar, minPx])

  // Reset cursor on unmount + cleanup data-resizing if drag is interrupted
  useEffect(() => {
    if (dragging) {
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    } else {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // Safety: if the component unmounts mid-drag (e.g. panel closed
      // via keyboard shortcut), make sure we don't leave data-resizing
      // stuck on <html> and freezing all panel transitions forever.
      document.documentElement.removeAttribute('data-resizing')
    }
  }, [dragging])

  return (
    <div
      className={cn('relative z-20 shrink-0 cursor-col-resize', className)}
      style={{ width: dragging ? 5 : 3 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/* Visual handle line */}
      <div
        className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2"
        style={{
          width: dragging ? 2 : 1,
          backgroundColor: dragging
            ? 'hsl(var(--foreground) / 0.55)'
            : hovering
              ? 'hsl(var(--foreground) / 0.22)'
              : 'transparent',
          // Keep the hit area stable while avoiding layout-property animation.
          // The visual line still fades between hover/idle colors.
          transition: dragging ? 'none' : 'background-color 0.15s',
        }}
      />
      {/* Wider invisible hit area for easier grabbing */}
      <div
        className="absolute top-0 bottom-0"
        style={{
          left: -4,
          right: -4,
        }}
      />
    </div>
  )
}
