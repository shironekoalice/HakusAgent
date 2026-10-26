/**
 * FlowWorkbench — Dify / ComfyUI-style layout for the Flow mode.
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │ top bar: workflow name · stats · run / publish              │
 * ├──────────┬───────────────────────────────────┬──────────────┤
 * │ workflow │ canvas (+ floating node picker)   │ inspector    │
 * │ list     │                                   │ 参数 / 运行   │
 * ├──────────┴───────────────────────────────────┴──────────────┤
 * │ bottom bar: run inputs · status · human input               │
 * └─────────────────────────────────────────────────────────────┘
 *
 * The Flow mode owns the whole window: no chat sidebar, no review panel.
 *
 * This file is the composition shell only. The pieces live next to it:
 * FlowNodeCard / FlowEdgePath (renderers), Inspector / RunBar (right rail and
 * bottom bar), FlowContextMenu, useFitView / useFlowShortcuts /
 * useNarrowCanvas (behaviour), and the graph store in `@/store/flow`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import { FlaskConical, Workflow } from 'lucide-react'
import { useFlowStore } from '@/store/flow'
import { FLOW_NODE_DEFS, getNodeDef } from '@/lib/flow/registry'
import { cn } from '@/lib/utils'
import { autoLayout } from '@/lib/flow/layout'
import { alignNodes, distributeNodes } from '@/lib/flow/arrange'
import { computeSnap, type GuideLine, type GuideRect } from '@/lib/flow/guides'
import { useI18n } from '@/lib/i18n'
import { ResizeHandle } from '@/components/layout/ResizeHandle'
import { FlowSidebar } from './FlowSidebar'
import { FlowNodePicker } from './FlowNodePicker'
import { FlowRunPanel } from './FlowRunPanel'
import { FlowNodeCard } from './FlowNodeCard'
import { FlowEdgePath, edgeLabelFor } from './FlowEdgePath'
import { Inspector } from './Inspector'
import { RunBar } from './RunBar'
import { FlowTopBar } from './FlowTopBar'
import { CanvasToolbar } from './CanvasToolbar'
import {
  FlowContextMenu,
  type ContextMenuState,
  type ContextMenuActions,
  type MenuTarget,
} from './FlowContextMenu'
import { RenameDialog } from './RenameDialog'
import { useFitView } from './useFitView'
import { useFlowShortcuts } from './useFlowShortcuts'
import { useNarrowCanvas } from './useNarrowCanvas'

const nodeTypes: Record<string, any> = { flow: FlowNodeCard }
for (const def of FLOW_NODE_DEFS) nodeTypes[def.type] = FlowNodeCard

const edgeTypes = { flow: FlowEdgePath } as any

/** Smallest selection that can be aligned or distributed. */
const ALIGN_MIN = 2
const DISTRIBUTE_MIN = 3

/** Fallback card size when a node has not been measured yet. */
const UNMEASURED = { width: 200, height: 80 }

const rectOf = (n: { position: { x: number; y: number }; width?: number; height?: number; measured?: { width?: number; height?: number } }): GuideRect => ({
  x: n.position.x,
  y: n.position.y,
  width: n.measured?.width ?? n.width ?? UNMEASURED.width,
  height: n.measured?.height ?? n.height ?? UNMEASURED.height,
})

/**
 * Full-pane alignment lines shown while a drag is snapped. Rendered as a
 * ReactFlow child (screen coordinates via flowToScreenPosition), so panning
 * or zooming mid-drag keeps them glued to the right coordinate.
 */
function FlowGuides({ lines }: { lines: GuideLine[] }) {
  const { flowToScreenPosition } = useReactFlow()
  if (lines.length === 0) return null
  return (
    <>
      {lines.map((line, i) => {
        const screen = flowToScreenPosition(
          line.orientation === 'horizontal' ? { x: 0, y: line.at } : { x: line.at, y: 0 },
        )
        return line.orientation === 'horizontal' ? (
          <div key={`h${i}`} className="flow-guide flow-guide-h" style={{ top: screen.y }} />
        ) : (
          <div key={`v${i}`} className="flow-guide flow-guide-v" style={{ left: screen.x }} />
        )
      })}
    </>
  )
}

function FlowWorkbenchInner() {
  const { locale } = useI18n()
  const zh = locale === 'zh-CN'
  const graph = useFlowStore((s) => s.graph)
  const run = useFlowStore((s) => s.run)
  const setNodes = useFlowStore((s) => s.setNodes)
  const setEdges = useFlowStore((s) => s.setEdges)
  const addNode = useFlowStore((s) => s.addNode)
  const selectNodes = useFlowStore((s) => s.selectNodes)
  const selectedNodeIds = useFlowStore((s) => s.selectedNodeIds)
  const startRun = useFlowStore((s) => s.startRun)
  const stopRun = useFlowStore((s) => s.stopRun)
  const expanded = useFlowStore((s) => s.expanded)
  const setExpanded = useFlowStore((s) => s.setExpanded)
  const setNodePositions = useFlowStore((s) => s.setNodePositions)
  const removeNodes = useFlowStore((s) => s.removeNodes)
  const removeEdge = useFlowStore((s) => s.removeEdge)
  const beginBatch = useFlowStore((s) => s.beginBatch)
  const endBatch = useFlowStore((s) => s.endBatch)
  const { screenToFlowPosition, getViewport, setCenter } = useReactFlow()

  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const [tab, setTab] = useState<'param' | 'run'>('param')
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [picker, setPicker] = useState<{ open: boolean; x: number; y: number; flow: { x: number; y: number } }>({
    open: false,
    x: 0,
    y: 0,
    flow: { x: 0, y: 0 },
  })
  const wrapRef = useRef<HTMLDivElement>(null)

  // Alignment snapping (lib/flow/guides.ts): while a drag is within
  // GUIDE_THRESHOLD of a shared edge with another node, nudge it onto the
  // alignment and draw full-pane guide lines. The offset rides React Flow's
  // own position change in onNodesChange — d3-drag recomputes each change
  // from the drag-start snapshot, so a fresh offset per tick cannot
  // accumulate drift.
  const [guides, setGuides] = useState<GuideLine[]>([])
  const snapOffsetRef = useRef<{ dx: number; dy: number } | null>(null)
  const onNodeDrag = useCallback((_: unknown, __: Node, draggedNodes: Node[]) => {
    const current = useFlowStore.getState().graph
    const draggedIds = new Set(draggedNodes.map((n) => n.id))
    const dragged = current.nodes.filter((n) => draggedIds.has(n.id)).map(rectOf)
    const others = current.nodes.filter((n) => !draggedIds.has(n.id)).map(rectOf)
    const snap = computeSnap(dragged, others)
    snapOffsetRef.current = { dx: snap.dx, dy: snap.dy }
    setGuides(snap.lines)
  }, [])
  const clearGuides = useCallback(() => {
    snapOffsetRef.current = null
    setGuides([])
  }, [])

  // In-app rename dialog state (replaces window.prompt's browser chrome).
  const [rename, setRename] = useState<{ nodeId: string; initial: string } | null>(null)

  // Experimental notice: shown once per storage, dismissed for good. Flow's
  // graph format may still change between versions, so say so up front.
  const [betaNotice, setBetaNotice] = useState(() => {
    try {
      return localStorage.getItem('hakusai:flow-beta-notice-dismissed') !== '1'
    } catch {
      return false
    }
  })
  const dismissBetaNotice = () => {
    setBetaNotice(false)
    try {
      localStorage.setItem('hakusai:flow-beta-notice-dismissed', '1')
    } catch {
      /* ignore */
    }
  }

  const { fit, fitUnlessRunning, fitAfterLayout } = useFitView(wrapRef)

  // Below the rail breakpoint the rails float over the canvas (see index.css),
  // so leaving both open would hide the graph entirely. Collapse them when the
  // window is narrow and restore them when it grows back.
  const railsFloat = useNarrowCanvas()
  useEffect(() => {
    setLeftOpen(!railsFloat)
    setRightOpen(!railsFloat)
  }, [railsFloat])

  // Selecting a node should reveal its parameters.
  useEffect(() => {
    if (selectedNodeIds.length === 1) setTab('param')
  }, [selectedNodeIds.length])

  const rfNodes: Node[] = useMemo(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data,
        // Without the measured size React Flow keeps the node invisible.
        measured: n.measured,
        // A resized node's operator-set size: React Flow reads width/height
        // from the node and writes them inline, overriding the CSS default.
        // Without round-tripping these, a reload snaps the node back.
        width: n.width,
        height: n.height,
        // Selection must round-trip too, or box-select flashes and resets.
        selected: selectedNodeIds.includes(n.id),
      })),
    [graph.nodes, selectedNodeIds],
  )

  const rfEdges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const label = edgeLabelFor(e.sourceHandle)
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle || undefined,
          targetHandle: e.targetHandle || undefined,
          type: 'flow',
          data: label ? { label } : undefined,
          animated: run.activeEdgeIds.includes(e.id),
        }
      }),
    [graph.edges, run.activeEdgeIds],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      // Refuse a duplicate of an existing connection.
      const exists = graph.edges.some(
        (e) =>
          e.source === connection.source &&
          e.target === connection.target &&
          (e.sourceHandle || null) === (connection.sourceHandle || null),
      )
      if (exists) return
      const id = `e_${connection.source}_${connection.sourceHandle || 'out'}_${connection.target}_${Date.now().toString(36)}`
      setEdges([
        ...graph.edges,
        {
          id,
          source: connection.source,
          target: connection.target,
          sourceHandle: connection.sourceHandle,
          targetHandle: connection.targetHandle,
        },
      ])
    },
    [graph.edges, setEdges],
  )

  const openPickerAtClient = useCallback(
    (clientX: number, clientY: number) => {
      const rect = wrapRef.current?.getBoundingClientRect()
      setPicker({
        open: true,
        x: clientX - (rect?.left || 0),
        y: clientY - (rect?.top || 0),
        flow: screenToFlowPosition({ x: clientX, y: clientY }),
      })
    },
    [screenToFlowPosition],
  )

  const openPickerAtCenter = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    openPickerAtClient(rect.left + rect.width / 2 - 90, rect.top + 120)
  }, [openPickerAtClient])

  // Dragging a wire into empty space opens the node picker (ComfyUI's
  // link-release); picking a node there completes the connection from the
  // port the drag started at. The ref survives from connect-start through the
  // picker's pick callback.
  const pendingConnectionRef = useRef<{ source: string; sourceHandle: string | null } | null>(null)
  const onConnectStart = useCallback((_: unknown, params: { nodeId: string | null; handleId: string | null | undefined }) => {
    if (params.nodeId) pendingConnectionRef.current = { source: params.nodeId, sourceHandle: params.handleId ?? null }
  }, [])
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const pending = pendingConnectionRef.current
      if (!pending) return
      // If the drag ended ON a valid target, onConnect already handled it and
      // the store has the edge — only an empty-space release reaches here with
      // no edge created. The ref is deliberately KEPT: the picker's pick
      // callback consumes it to finish the connection.
      const clientX = 'clientX' in event ? event.clientX : event.changedTouches[0]?.clientX
      const clientY = 'clientY' in event ? event.clientY : event.changedTouches[0]?.clientY
      if (clientX === undefined || clientY === undefined) return
      const el = document.elementFromPoint(clientX, clientY)
      if (el?.closest('.react-flow__node')) {
        pendingConnectionRef.current = null
        return
      }
      openPickerAtClient(clientX, clientY)
    },
    [openPickerAtClient],
  )

  // Called by the picker: insert the node AND wire it to the pending port.
  const addNodeConnected = useCallback(
    (type: string, position: { x: number; y: number }) => {
      const id = addNode(type, position)
      const pending = pendingConnectionRef.current
      if (pending) {
        const graph = useFlowStore.getState().graph
        useFlowStore.getState().setEdges([
          ...graph.edges,
          {
            id: `e_${pending.source}_${pending.sourceHandle || 'out'}_${id}_${Date.now().toString(36)}`,
            source: pending.source,
            target: id,
            sourceHandle: pending.sourceHandle,
            targetHandle: null,
          },
        ])
        pendingConnectionRef.current = null
      }
      return id
    },
    [addNode],
  )

  const applyAutoLayout = useCallback(() => {
    const positions = autoLayout(graph.nodes, graph.edges)
    if (Object.keys(positions).length === 0) return
    setNodePositions(positions)
    fitAfterLayout()
  }, [graph.nodes, graph.edges, setNodePositions, fitAfterLayout])

  const zoomBy = useCallback(
    (factor: number) => {
      const { zoom, x, y } = getViewport()
      const el = wrapRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const next = Math.min(1.6, Math.max(0.2, zoom * factor))
      // Zoom about the canvas centre so the view does not drift.
      const cx = rect.width / 2
      const cy = rect.height / 2
      const worldX = (cx - x) / zoom
      const worldY = (cy - y) / zoom
      void setCenter(worldX, worldY, { zoom: next, duration: 120 })
    },
    [getViewport, setCenter],
  )

  const selectedNodes = useMemo(
    () => graph.nodes.filter((n) => selectedNodeIds.includes(n.id)),
    [graph.nodes, selectedNodeIds],
  )

  const menuActions: ContextMenuActions = useMemo(
    () => ({
      addNode: () => openPickerAtCenter(),
      paste: () => {
        const at = menu?.target.kind === 'pane' ? menu.target.flow : undefined
        useFlowStore.getState().pasteNodes(at)
      },
      autoLayout: applyAutoLayout,
      fitView: fit,
      runFromNode: () => void startRun(),
      copy: () => useFlowStore.getState().copyNodes(selectedNodeIds),
      duplicate: () => useFlowStore.getState().duplicateNodes(selectedNodeIds),
      rename: (nodeId) => {
        const node = graph.nodes.find((n) => n.id === nodeId)
        if (!node) return
        setRename({ nodeId, initial: String(node.data.label || '') })
      },
      removeNode: (nodeId) => removeNodes([nodeId]),
      removeEdge,
      removeSelection: () => removeNodes(selectedNodeIds),
      focusNode: (nodeId) => {
        const node = graph.nodes.find((n) => n.id === nodeId)
        if (!node) return
        const w = node.measured?.width ?? 280
        const h = node.measured?.height ?? 60
        void setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: 1, duration: 260 })
      },
      align: (edge) => {
        if (selectedNodes.length < ALIGN_MIN) return
        setNodePositions(alignNodes(selectedNodes, edge))
      },
      distribute: (axis) => {
        if (selectedNodes.length < DISTRIBUTE_MIN) return
        setNodePositions(distributeNodes(selectedNodes, axis))
      },
    }),
    [
      applyAutoLayout,
      fit,
      graph.nodes,
      menu,
      openPickerAtCenter,
      removeEdge,
      removeNodes,
      selectedNodeIds,
      selectedNodes,
      setCenter,
      setNodePositions,
      startRun,
    ],
  )

  const openMenu = useCallback((target: MenuTarget, clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect()
    setMenu({ target, at: { x: clientX - (rect?.left || 0), y: clientY - (rect?.top || 0) } })
  }, [])

  useFlowShortcuts({
    onFitView: fit,
    onDuplicate: () => useFlowStore.getState().duplicateNodes(selectedNodeIds),
    onDelete: () => removeNodes(selectedNodeIds),
    onCopy: () => useFlowStore.getState().copyNodes(selectedNodeIds),
    onPaste: () => useFlowStore.getState().pasteNodes(),
    onSelectAll: () => selectNodes(graph.nodes.map((n) => n.id)),
    onToggleRun: () => {
      if (run.status === 'running' || run.status === 'waiting_human') stopRun()
      else void startRun()
    },
    onAddNode: openPickerAtCenter,
    onCommandPalette: openPickerAtCenter,
    onZoomIn: () => zoomBy(1.2),
    onZoomOut: () => zoomBy(1 / 1.2),
    onGroupSelected: undefined,
  })

  const running = run.status === 'running' || run.status === 'waiting_human'

  return (
    <div className="flow-workbench">
      {leftOpen ? (
        <>
          <FlowSidebar />
          <ResizeHandle
            className="flow-resize"
            cssVar="--flow-sidebar-width"
            side="left"
            minPx={180}
            maxPx={420}
            collapseThreshold={140}
            onCollapse={() => setLeftOpen(false)}
          />
        </>
      ) : null}

      <div className="flow-main">
        <FlowTopBar
          zh={zh}
          running={running}
          onRun={() => void startRun()}
          onStop={stopRun}
        />

        {betaNotice && (
          <div className="flow-beta-notice" role="status">
            <FlaskConical className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{zh ? 'Flow 模式为实验性功能：画布与节点仍在快速迭代，图数据保存在本机，格式可能随版本调整。' : 'Flow mode is experimental: the canvas and nodes are still evolving. Graphs are stored locally and their format may change.'}</span>
            <button
              type="button"
              className="flow-beta-notice-close"
              onClick={dismissBetaNotice}
              title={zh ? '知道了' : 'Dismiss'}
              aria-label={zh ? '知道了' : 'Dismiss'}
            >
              {zh ? '知道了' : 'Got it'}
            </button>
          </div>
        )}

        <div
          className="flow-canvas-wrap"
          ref={wrapRef}
          onContextMenu={(e) => {
            // Only the empty pane gets the canvas menu; node/edge handlers
            // below stop propagation for their own targets.
            const el = e.target as HTMLElement
            if (!el.classList?.contains('react-flow__pane')) return
            e.preventDefault()
            openMenu({ kind: 'pane', flow: screenToFlowPosition({ x: e.clientX, y: e.clientY }) }, e.clientX, e.clientY)
          }}
        >
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={(changes) => {
              const next = [...graph.nodes]
              let structural = false
              let selectionChanged = false
              for (const ch of changes) {
                if (ch.type === 'add') continue
                const idx = next.findIndex((n) => n.id === ch.id)
                if (idx < 0) continue
                if (ch.type === 'position' && ch.position) {
                  let pos = ch.position
                  const off = snapOffsetRef.current
                  if (off) pos = { x: pos.x + off.dx, y: pos.y + off.dy }
                  next[idx] = { ...next[idx], position: pos }
                  structural = true
                } else if (ch.type === 'dimensions' && ch.dimensions) {
                  // Persist the measurement, otherwise the node stays hidden.
                  const cur = next[idx].measured
                  const dim = ch as typeof ch & {
                    resizing?: boolean
                    setAttributes?: boolean | 'width' | 'height'
                  }
                  if (dim.setAttributes) {
                    // A RESIZE: the operator-set size must land on the node's
                    // width/height (mirroring applyNodeChanges), not just
                    // `measured` — measured is re-derived from the rendered
                    // size every frame, so writing only it makes the resize
                    // snap straight back to the CSS default.
                    const patch: { width?: number; height?: number; measured: { width?: number; height?: number } } = {
                      measured: ch.dimensions,
                    }
                    if (dim.setAttributes === true || dim.setAttributes === 'width') patch.width = ch.dimensions.width
                    if (dim.setAttributes === true || dim.setAttributes === 'height') patch.height = ch.dimensions.height
                    next[idx] = { ...next[idx], ...patch }
                    setNodes(next, { history: false })
                  } else if (
                    cur?.width !== ch.dimensions.width ||
                    cur?.height !== ch.dimensions.height
                  ) {
                    next[idx] = { ...next[idx], measured: ch.dimensions }
                    // Not a graph edit: measuring must not create an undo step.
                    setNodes(next, { history: false })
                  }
                } else if (ch.type === 'select') {
                  selectionChanged = true
                } else if (ch.type === 'remove') {
                  next.splice(idx, 1)
                  structural = true
                }
              }
              if (selectionChanged) {
                // React Flow's own multi-select (shift-click, marquee) arrives
                // as select changes; dropping them is why box-select used to
                // flash and reset. Read the LATEST selection from the store —
                // the render closure here can be stale after the first change
                // in the same batch.
                const current = useFlowStore.getState().selectedNodeIds
                const merged = changes
                  .filter((c) => c.type === 'select')
                  .reduce((ids: string[], c) => {
                    const sc = c as { type: 'select'; id: string; selected: boolean }
                    return sc.selected ? [...ids, sc.id] : ids.filter((x) => x !== sc.id)
                  }, current)
                selectNodes(merged)
              }
              if (structural) setNodes(next)
            }}
            onNodeDrag={onNodeDrag}
            onNodeDragStart={beginBatch}
            onNodeDragStop={() => {
              endBatch()
              clearGuides()
            }}
            onEdgesChange={(changes) => {
              let next = [...graph.edges]
              for (const ch of changes) {
                if (ch.type === 'remove') next = next.filter((e) => e.id !== ch.id)
              }
              if (next.length !== graph.edges.length) setEdges(next)
            }}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onNodeContextMenu={(e, node) => {
              e.preventDefault()
              // Right-clicking a node outside the selection targets that node
              // alone; right-clicking one INSIDE a multi-selection opens the
              // selection menu (align/distribute act on the whole set).
              if (!selectedNodeIds.includes(node.id)) selectNodes([node.id])
              if (selectedNodeIds.length > 1) {
                openMenu({ kind: 'selection', count: selectedNodeIds.length }, e.clientX, e.clientY)
              } else {
                openMenu({ kind: 'node', nodeId: node.id }, e.clientX, e.clientY)
              }
            }}
            onEdgeContextMenu={(e, edge) => {
              e.preventDefault()
              openMenu({ kind: 'edge', edgeId: edge.id }, e.clientX, e.clientY)
            }}
            onSelectionContextMenu={(e) => {
              e.preventDefault()
              openMenu({ kind: 'selection', count: selectedNodeIds.length }, e.clientX, e.clientY)
            }}
            onPaneClick={() => {
              selectNodes([])
              setPicker((p) => ({ ...p, open: false }))
              setMenu(null)
            }}
            onDoubleClick={(e) => {
              // zoomOnDoubleClick is off, so this handler now reliably wins —
              // with d3-zoom's default the event was swallowed before React saw it.
              const el = e.target as HTMLElement
              if (!el.classList?.contains('react-flow__pane')) return
              openPickerAtClient(e.clientX, e.clientY)
            }}
            onDrop={(e) => {
              e.preventDefault()
              const type = e.dataTransfer.getData('application/hakus-flow-type')
              if (!type) return
              addNode(type, screenToFlowPosition({ x: e.clientX, y: e.clientY }))
            }}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
            }}
            fitView
            fitViewOptions={{ padding: 0.16, minZoom: 0.2, maxZoom: 1 }}
            minZoom={0.2}
            maxZoom={1.6}
            // The double-click gesture belongs to the node picker, not to zoom.
            zoomOnDoubleClick={false}
            // Left-drag on the canvas marquees (ComfyUI / tldraw convention);
            // xyflow requires panOnDrag off for it to activate. Panning moves
            // to the middle mouse button (button index 1), which survives as
            // an array filter — Space+drag pans too (ComfyUI's own gesture).
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            panOnDrag={[1]}
            panActivationKeyCode="Space"
            multiSelectionKeyCode={['Meta', 'Control']}
            deleteKeyCode={null}
            // Grid snap carries ordinary drags; a nearby alignment guide
            // (onNodeDrag) then overrides the grid by up to GUIDE_THRESHOLD,
            // so node-to-node alignment always wins over the lattice.
            snapToGrid
            snapGrid={[8, 8]}
            proOptions={{ hideAttribution: true }}
            className="flow-canvas"
          >
            <Background gap={18} size={1} color="hsl(var(--flow-grid))" />
            <FlowGuides lines={guides} />
            <Controls showInteractive={false} className="flow-controls" />
            <MiniMap
              className="flow-minimap"
              style={{ width: 168, height: 108 }}
              pannable
              zoomable
              nodeColor={(n) => getNodeDef(n.type)?.color || 'hsl(var(--muted-foreground))'}
              nodeStrokeWidth={0}
            />
          </ReactFlow>

          {graph.nodes.length === 0 ? (
            <div className="flow-empty">
              <Workflow className="h-7 w-7 opacity-40" />
              <div className="flow-empty-title">{zh ? '画布为空' : 'Empty canvas'}</div>
              <div className="flow-empty-desc">
                {zh ? '双击画布空白处，或按 Tab 搜索并添加节点' : 'Double-click the canvas, or press Tab to add the first node'}
              </div>
              <button
                type="button"
                className="flow-empty-cta"
                onClick={openPickerAtCenter}
              >
                {zh ? '添加节点' : 'Add node'}
              </button>
            </div>
          ) : null}

          <CanvasToolbar
            zh={zh}
            expanded={expanded}
            leftOpen={leftOpen}
            rightOpen={rightOpen}
            onAutoLayout={applyAutoLayout}
            onToggleExpand={() => setExpanded(!expanded)}
            onFitView={fit}
            onAddNode={openPickerAtCenter}
            onToggleLeft={() => setLeftOpen((v) => !v)}
            onToggleRight={() => setRightOpen((v) => !v)}
          />

          <FlowNodePicker
            open={picker.open}
            at={{ x: picker.x, y: picker.y }}
            onClose={() => {
              pendingConnectionRef.current = null
              setPicker((p) => ({ ...p, open: false }))
            }}
            onPick={(type) => addNodeConnected(type, { x: picker.flow.x, y: picker.flow.y })}
          />

          <FlowContextMenu state={menu} actions={menuActions} onClose={() => setMenu(null)} />

          <RenameDialog
            open={!!rename}
            title={zh ? '节点名称' : 'Node label'}
            initialValue={rename?.initial || ''}
            onCommit={(value) => {
              if (rename) useFlowStore.getState().updateNodeData(rename.nodeId, { label: value })
            }}
            onClose={() => setRename(null)}
          />
        </div>

        <RunBar />
      </div>

      {rightOpen ? (
        <>
          <ResizeHandle
            className="flow-resize"
            cssVar="--flow-inspector-width"
            side="right"
            minPx={260}
            maxPx={720}
            collapseThreshold={220}
            onCollapse={() => setRightOpen(false)}
          />
          <aside className="flow-inspector-col">
            <div className="flow-tabs">
              <button
                type="button"
                className={cn('flow-tab', tab === 'param' && 'flow-tab-active')}
                onClick={() => setTab('param')}
              >
                {zh ? '参数' : 'Params'}
              </button>
              <button
                type="button"
                className={cn('flow-tab', tab === 'run' && 'flow-tab-active')}
                onClick={() => setTab('run')}
              >
                {zh ? '运行' : 'Run'}
              </button>
            </div>
            <div className="flow-inspector-body">{tab === 'param' ? <Inspector /> : <FlowRunPanel />}</div>
          </aside>
        </>
      ) : null}
    </div>
  )
}

export function FlowWorkbench() {
  return (
    <ReactFlowProvider>
      <FlowWorkbenchInner />
    </ReactFlowProvider>
  )
}
