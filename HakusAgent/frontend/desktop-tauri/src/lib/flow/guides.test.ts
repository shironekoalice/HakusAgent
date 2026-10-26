import { describe, expect, it } from 'vitest'
import { boundingRect, computeSnap } from './guides'

const rect = (x: number, y: number, w = 200, h = 80): { x: number; y: number; width: number; height: number } => ({
  x,
  y,
  width: w,
  height: h,
})

describe('boundingRect', () => {
  it('is null for an empty group', () => {
    expect(boundingRect([])).toBeNull()
  })

  it('spans every member', () => {
    expect(boundingRect([rect(10, 20), rect(210, 120, 100, 40)])).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 140,
    })
  })
})

describe('computeSnap', () => {
  it('does nothing with no other nodes on the canvas', () => {
    expect(computeSnap([rect(0, 0)], [])).toEqual({ dx: 0, dy: 0, lines: [] })
  })

  it('does nothing when every edge is farther than the threshold', () => {
    const result = computeSnap([rect(0, 0)], [rect(500, 500)])
    expect(result.dx).toBe(0)
    expect(result.dy).toBe(0)
    expect(result.lines).toEqual([])
  })

  it('snaps left edges onto a shared vertical line', () => {
    const result = computeSnap([rect(103, 400)], [rect(100, 100)])
    expect(result.dx).toBe(-3)
    expect(result.dy).toBe(0)
    expect(result.lines).toEqual([{ orientation: 'vertical', at: 100 }])
  })

  it('snaps horizontal centres (middle edges)', () => {
    // other: y 100..180, middle 140. A differently-sized dragged node whose
    // middle (137) is closer to 140 than its top (107→100) or bottom is to
    // 180, so the MIDDLE pair must win; dragged x stays far off every other
    // x edge so only the Y axis can produce a line.
    const result = computeSnap([rect(1300, 107, 200, 60)], [rect(1000, 100)])
    expect(result.dx).toBe(0)
    expect(result.dy).toBe(3)
    expect(result.lines).toEqual([{ orientation: 'horizontal', at: 140 }])
  })

  it('shows the line even when already exactly aligned (delta 0)', () => {
    const result = computeSnap([rect(100, 100)], [rect(100, 300)])
    expect(result.dx).toBe(0)
    expect(result.lines).toEqual([{ orientation: 'vertical', at: 100 }])
  })

  it('can snap both axes at once', () => {
    const result = computeSnap([rect(104, 96)], [rect(100, 100)])
    expect(result.dx).toBe(-4)
    expect(result.dy).toBe(4)
    expect(result.lines).toEqual([
      { orientation: 'vertical', at: 100 },
      { orientation: 'horizontal', at: 100 },
    ])
  })

  it('picks the closest candidate when several are within threshold', () => {
    // dragged left edge 100; candidates at 102 (delta +2) and 97 (delta -3).
    const result = computeSnap([rect(100, 0)], [rect(102, 300), rect(97, 600)])
    expect(result.dx).toBe(2)
    expect(result.lines).toEqual([{ orientation: 'vertical', at: 102 }])
  })

  it('aligns a multi-node drag by the group bounding box', () => {
    // Group spans x 0..400; another node's left edge at 402 → group right snaps to it.
    const result = computeSnap([rect(0, 0), rect(200, 100, 200, 80)], [rect(402, 500)])
    expect(result.dx).toBe(2)
    expect(result.lines).toEqual([{ orientation: 'vertical', at: 402 }])
  })
})
