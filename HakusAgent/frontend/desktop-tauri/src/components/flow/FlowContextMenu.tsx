/**
 * Canvas context menu — one menu, four targets.
 *
 * ComfyUI, n8n and Dify all separate the menu by what was right-clicked, because
 * the available actions genuinely differ: a workflow with no selection cannot be
 * "duplicated", and an edge has exactly one sensible action. The target is
 * decided by the caller and passed in as `target`.
 *
 * The menu is positioned in viewport coordinates and flipped near the window
 * edges so it never opens partly off-screen.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Copy,
  CopyPlus,
  Crosshair,
  LayoutGrid,
  Pencil,
  Play,
  Plus,
  Scan,
  SquareDashed,
  Trash2,
} from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export type MenuTarget =
  | { kind: 'pane'; flow: { x: number; y: number } }
  | { kind: 'node'; nodeId: string }
  | { kind: 'edge'; edgeId: string }
  | { kind: 'selection'; count: number }

export interface ContextMenuState {
  target: MenuTarget
  /** Screen coordinates of the click, relative to the canvas wrapper. */
  at: { x: number; y: number }
}

export interface ContextMenuActions {
  addNode: () => void
  paste: () => void
  autoLayout: () => void
  fitView: () => void
  runFromNode: (nodeId: string) => void
  copy: () => void
  duplicate: () => void
  rename: (nodeId: string) => void
  removeNode: (nodeId: string) => void
  removeEdge: (edgeId: string) => void
  removeSelection: () => void
  focusNode: (nodeId: string) => void
  align: (edge: 'top' | 'middle' | 'bottom' | 'left' | 'center' | 'right') => void
  distribute: (axis: 'horizontal' | 'vertical') => void
}

interface Props {
  state: ContextMenuState | null
  actions: ContextMenuActions
  onClose: () => void
}

function MenuItem({
  icon: Icon,
  label,
  hint,
  onClick,
  danger,
  disabled,
}: {
  icon: typeof Plus
  label: string
  hint?: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn('flow-menu-item', danger && 'flow-menu-item-danger')}
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 opacity-80" />
      <span className="flex-1 truncate text-left">{label}</span>
      {hint ? <span className="flow-menu-hint">{hint}</span> : null}
    </button>
  )
}

function Separator() {
  return <div className="flow-menu-sep" role="separator" />
}

export function FlowContextMenu({ state, actions, onClose }: Props) {
  const { locale } = useI18n()
  const zh = locale === 'zh-CN'
  const boxRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  // Measure after mount and flip the menu inside the window when it would
  // overflow — a menu opened near the right/bottom edge is otherwise unusable.
  useLayoutEffect(() => {
    if (!state) return
    const el = boxRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pad = 8
    let x = state.at.x
    let y = state.at.y
    const hostW = el.offsetParent ? (el.offsetParent as HTMLElement).clientWidth : window.innerWidth
    const hostH = el.offsetParent ? (el.offsetParent as HTMLElement).clientHeight : window.innerHeight
    if (x + rect.width > hostW - pad) x = Math.max(pad, hostW - rect.width - pad)
    if (y + rect.height > hostH - pad) y = Math.max(pad, hostH - rect.height - pad)
    setPos({ x, y })
  }, [state])

  useEffect(() => {
    if (!state) return
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
  }, [state, onClose])

  if (!state) return null

  const run = (fn: () => void) => () => {
    fn()
    onClose()
  }

  const t = {
    addNode: zh ? '添加节点' : 'Add node',
    paste: zh ? '粘贴' : 'Paste',
    autoLayout: zh ? '整理布局' : 'Tidy up layout',
    fitView: zh ? '适应视图' : 'Fit view',
    runFrom: zh ? '运行到此节点' : 'Run to this node',
    copy: zh ? '复制' : 'Copy',
    duplicate: zh ? '再制' : 'Duplicate',
    rename: zh ? '重命名' : 'Rename',
    delete: zh ? '删除' : 'Delete',
    deleteEdge: zh ? '删除连线' : 'Delete connection',
    focus: zh ? '在画布中定位' : 'Reveal on canvas',
    align: zh ? '对齐' : 'Align',
    distribute: zh ? '分布' : 'Distribute',
    alignTop: zh ? '顶端对齐' : 'Align top',
    alignMiddle: zh ? '垂直居中' : 'Align middle',
    alignBottom: zh ? '底端对齐' : 'Align bottom',
    alignLeft: zh ? '左对齐' : 'Align left',
    alignCenter: zh ? '水平居中' : 'Align center',
    alignRight: zh ? '右对齐' : 'Align right',
    distH: zh ? '水平等距' : 'Distribute horizontally',
    distV: zh ? '垂直等距' : 'Distribute vertically',
    selected: zh ? '已选中' : 'selected',
  }

  return (
    <div
      ref={boxRef}
      className="flow-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.target.kind === 'pane' && (
        <>
          <MenuItem icon={Plus} label={t.addNode} hint="Tab" onClick={run(actions.addNode)} />
          <MenuItem icon={Copy} label={t.paste} hint="Ctrl+V" onClick={run(actions.paste)} />
          <Separator />
          <MenuItem icon={LayoutGrid} label={t.autoLayout} onClick={run(actions.autoLayout)} />
          <MenuItem icon={Scan} label={t.fitView} hint="Ctrl+0" onClick={run(actions.fitView)} />
        </>
      )}

      {state.target.kind === 'edge' && (
        <MenuItem icon={Trash2} label={t.deleteEdge} danger onClick={run(() => actions.removeEdge(state.target.kind === 'edge' ? state.target.edgeId : ''))} />
      )}

      {state.target.kind === 'node' && (
        <>
          <MenuItem icon={Play} label={t.runFrom} onClick={run(() => actions.runFromNode(state.target.kind === 'node' ? state.target.nodeId : ''))} />
          <MenuItem icon={Crosshair} label={t.focus} onClick={run(() => actions.focusNode(state.target.kind === 'node' ? state.target.nodeId : ''))} />
          <Separator />
          <MenuItem icon={Copy} label={t.copy} hint="Ctrl+C" onClick={run(actions.copy)} />
          <MenuItem icon={CopyPlus} label={t.duplicate} hint="Ctrl+D" onClick={run(actions.duplicate)} />
          <MenuItem icon={Pencil} label={t.rename} onClick={run(() => actions.rename(state.target.kind === 'node' ? state.target.nodeId : ''))} />
          <Separator />
          <MenuItem icon={Trash2} label={t.delete} hint="Del" danger onClick={run(() => actions.removeNode(state.target.kind === 'node' ? state.target.nodeId : ''))} />
        </>
      )}

      {state.target.kind === 'selection' && (
        <>
          <MenuItem
            icon={SquareDashed}
            label={`${state.target.count} ${t.selected}`}
            onClick={run(() => undefined)}
            disabled
          />
          <Separator />
          <MenuItem icon={Copy} label={t.copy} hint="Ctrl+C" onClick={run(actions.copy)} />
          <MenuItem icon={CopyPlus} label={t.duplicate} hint="Ctrl+D" onClick={run(actions.duplicate)} />
          <Separator />
          <MenuItem icon={AlignStartHorizontal} label={t.alignTop} onClick={run(() => actions.align('top'))} />
          <MenuItem icon={AlignCenterHorizontal} label={t.alignMiddle} onClick={run(() => actions.align('middle'))} />
          <MenuItem icon={AlignEndHorizontal} label={t.alignBottom} onClick={run(() => actions.align('bottom'))} />
          <MenuItem icon={AlignStartVertical} label={t.alignLeft} onClick={run(() => actions.align('left'))} />
          <MenuItem icon={AlignCenterVertical} label={t.alignCenter} onClick={run(() => actions.align('center'))} />
          <MenuItem icon={AlignEndVertical} label={t.alignRight} onClick={run(() => actions.align('right'))} />
          <Separator />
          <MenuItem icon={LayoutGrid} label={t.distH} onClick={run(() => actions.distribute('horizontal'))} />
          <MenuItem icon={LayoutGrid} label={t.distV} onClick={run(() => actions.distribute('vertical'))} />
          <Separator />
          <MenuItem icon={Trash2} label={t.delete} hint="Del" danger onClick={run(actions.removeSelection)} />
        </>
      )}
    </div>
  )
}
