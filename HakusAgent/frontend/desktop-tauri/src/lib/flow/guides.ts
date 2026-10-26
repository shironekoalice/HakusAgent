/**
 * Drag snapping geometry for the Flow canvas.
 *
 * While nodes are dragged, their bounding box is compared against every other
 * node's left/center/right (X) and top/middle/bottom (Y) edges. When an edge
 * pair is within `GUIDE_THRESHOLD` flow units, the drag is nudged onto the
 * alignment and a full-pane guide line is shown at the shared coordinate —
 * Figma/LangFlow behaviour. Snapping is display-only feedback about the
 * operator's own layout: it never touches the graph beyond node positions.
 */

export interface GuideRect {
  x: number
  y: number
  width: number
  height: number
}

export interface GuideLine {
  orientation: 'horizontal' | 'vertical'
  /** Flow coordinate of the line: y for horizontal, x for vertical. */
  at: number
}

export interface SnapResult {
  /** Offset to add to every dragged position so the group lands on the line. */
  dx: number
  dy: number
  lines: GuideLine[]
}

export const GUIDE_THRESHOLD = 6

export function boundingRect(rects: GuideRect[]): GuideRect | null {
  if (rects.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

const xsOf = (r: GuideRect) => [r.x, r.x + r.width / 2, r.x + r.width]
const ysOf = (r: GuideRect) => [r.y, r.y + r.height / 2, r.y + r.height]

/** Closest (delta <= threshold) match between one axis's candidate values. */
function snapAxis(
  groupValues: number[],
  otherValues: number[][],
  threshold: number,
): { delta: number; at: number } | null {
  let best: { delta: number; at: number } | null = null
  for (const g of groupValues) {
    for (const values of otherValues) {
      for (const v of values) {
        const delta = v - g
        if (Math.abs(delta) > threshold) continue
        if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, at: v }
      }
    }
  }
  return best
}

export function computeSnap(
  dragged: GuideRect[],
  others: GuideRect[],
  threshold = GUIDE_THRESHOLD,
): SnapResult {
  const group = boundingRect(dragged)
  if (!group || others.length === 0) return { dx: 0, dy: 0, lines: [] }

  const snapX = snapAxis(xsOf(group), others.map(xsOf), threshold)
  const snapY = snapAxis(ysOf(group), others.map(ysOf), threshold)

  const lines: GuideLine[] = []
  if (snapX) lines.push({ orientation: 'vertical', at: snapX.at })
  if (snapY) lines.push({ orientation: 'horizontal', at: snapY.at })
  return { dx: snapX?.delta || 0, dy: snapY?.delta || 0, lines }
}
