/**
 * FlowSidebar — left rail of the Flow workbench: the workflow file list.
 * ComfyUI keeps its workflow menu here; Dify keeps its app list here.
 */

import { useMemo, useState } from 'react'
import {
  Copy,
  Download,
  Layers,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Workflow,
} from 'lucide-react'
import { useFlowStore } from '@/store/flow'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { exportGraph, importGraphFile } from '@/lib/flow/io'

function relativeTime(ts: number | undefined, zh: boolean): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return zh ? '刚刚' : 'just now'
  if (min < 60) return `${min}${zh ? ' 分钟前' : 'm ago'}`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}${zh ? ' 小时前' : 'h ago'}`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day}${zh ? ' 天前' : 'd ago'}`
  return new Date(ts).toLocaleDateString()
}

function FileIcon() {
  return <Workflow className="h-3.5 w-3.5 shrink-0 opacity-70" />
}

export function FlowSidebar() {
  const graphs = useFlowStore((s) => s.graphs)
  const currentId = useFlowStore((s) => s.graph.id)
  const openFlow = useFlowStore((s) => s.openFlow)
  const newFlow = useFlowStore((s) => s.newFlow)
  const renameFlow = useFlowStore((s) => s.renameFlow)
  const deleteFlow = useFlowStore((s) => s.deleteFlow)
  const duplicateFlow = useFlowStore((s) => s.duplicateFlow)
  const importGraph = useFlowStore((s) => s.importGraph)
  const loadDemo = useFlowStore((s) => s.loadDemo)
  const { locale } = useI18n()
  const zh = locale === 'zh-CN'

  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    const sorted = [...graphs].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    return q ? sorted.filter((g) => g.name.toLowerCase().includes(q)) : sorted
  }, [graphs, query])

  const commitRename = (id: string) => {
    const name = draft.trim()
    if (name) renameFlow(id, name)
    setEditingId(null)
  }

  return (
    <aside className="flow-sidebar">
      <div className="flow-sidebar-head">
        <span className="flow-sidebar-title">
          <Layers className="h-3.5 w-3.5" />
          {zh ? '工作流' : 'Workflows'}
        </span>
        <button
          type="button"
          className="flow-icon-btn"
          title={zh ? '新建工作流' : 'New workflow'}
          onClick={() => newFlow()}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flow-search search-composite">
        <Search className="h-3 w-3 shrink-0 opacity-60" />
        <input
          className="flow-search-input search-composite-input"
          value={query}
          placeholder={zh ? '搜索工作流…' : 'Search workflows…'}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="flow-list">
        {list.length === 0 ? (
          <div className="flow-list-empty">
            {query ? (zh ? '没有匹配的工作流' : 'No matching workflow') : (zh ? '还没有工作流' : 'No workflows yet')}
          </div>
        ) : (
          list.map((g) => {
            const active = g.id === currentId
            return (
              <div
                key={g.id}
                className={cn('flow-list-item', active && 'flow-list-item-active')}
                onClick={() => !active && openFlow(g.id)}
                onDoubleClick={() => {
                  setEditingId(g.id)
                  setDraft(g.name)
                }}
              >
                <FileIcon />
                <div className="min-w-0 flex-1">
                  {editingId === g.id ? (
                    <input
                      className="flow-list-rename"
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(g.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(g.id)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <div className="flow-list-name">{g.name}</div>
                  )}
                  <div className="flow-list-meta">
                    {g.nodes.length} {zh ? '节点' : 'nodes'} · {relativeTime(g.updated_at, zh)}
                  </div>
                </div>

                <div className="flow-list-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="flow-icon-btn"
                    title={zh ? '复制' : 'Duplicate'}
                    onClick={() => duplicateFlow(g.id)}
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    className="flow-icon-btn"
                    title={zh ? '导出 JSON' : 'Export JSON'}
                    onClick={() => exportGraph(g)}
                  >
                    <Download className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    className="flow-icon-btn flow-icon-btn-danger"
                    title={zh ? '删除' : 'Delete'}
                    onClick={() => {
                      if (window.confirm(zh ? `删除工作流「${g.name}」？` : `Delete "${g.name}"?`)) {
                        deleteFlow(g.id)
                      }
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="flow-sidebar-foot">
        <button
          type="button"
          className="flow-foot-btn"
          onClick={async () => {
            const graph = await importGraphFile()
            if (graph) importGraph(graph)
            else window.alert(zh ? '导入失败：不是合法的 .flow.json' : 'Import failed: not a valid .flow.json')
          }}
        >
          <Upload className="h-3.5 w-3.5" />
          {zh ? '导入' : 'Import'}
        </button>
        <button type="button" className="flow-foot-btn" onClick={loadDemo}>
          <Sparkles className="h-3.5 w-3.5" />
          {zh ? '示例' : 'Demo'}
        </button>
      </div>
    </aside>
  )
}
