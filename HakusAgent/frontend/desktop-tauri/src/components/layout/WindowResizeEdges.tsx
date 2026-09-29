import { createPortal } from 'react-dom'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { IS_ANDROID } from '@/lib/platform'

const RESIZE_EDGES = [
  ['North', 'north'],
  ['South', 'south'],
  ['East', 'east'],
  ['West', 'west'],
  ['NorthWest', 'north-west'],
  ['NorthEast', 'north-east'],
  ['SouthWest', 'south-west'],
  ['SouthEast', 'south-east'],
] as const

export function WindowResizeEdges() {
  if (typeof __TAURI_INTERNALS__ === 'undefined' || IS_ANDROID || !document.body) return null

  return createPortal(
    <div className="window-resize-hit-edges" aria-hidden="true">
      {RESIZE_EDGES.map(([direction, edge]) => (
        <div
          key={edge}
          className={`window-resize-hit-edge window-resize-hit-edge-${edge}`}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.stopPropagation()
            void getCurrentWindow().startResizeDragging(direction).catch((error) => {
              console.error('Window resize drag failed', error)
            })
          }}
        />
      ))}
    </div>,
    document.body,
  )
}
