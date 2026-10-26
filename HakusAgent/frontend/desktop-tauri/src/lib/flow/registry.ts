/**
 * Node registry — every executable node type for the Flow canvas.
 * Execution is a real dataflow runtime (not compile-to-single-agent).
 */

import { interpolate, evalCondition, evalExpression, splitItems, toDisplay } from './template'
import type { FlowEdge, FlowNodeDef, FlowValue, IncomingEdge, NodeExecCtx, NodeExecResult } from './types'
import {
  BookOpen,
  Braces,
  Calculator,
  CalendarClock,
  Code2,
  FileText,
  GitBranch,
  GitMerge,
  Globe,
  Play,
  Regex,
  Repeat,
  Send,
  Sparkles,
  Timer,
  Type,
  UserCheck,
  Users,
  Variable,
  Wrench,
} from 'lucide-react'

const text = (v: FlowValue) => toDisplay(v)

function scopeOf(ctx: NodeExecCtx) {
  const run: Record<string, FlowValue> = { ...(ctx.runInputs || {}) }
  const out = ctx.inputs.out
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    Object.assign(run, out as Record<string, FlowValue>)
  }
  return {
    inputs: ctx.inputs,
    run,
    vars: ctx.vars,
    outputsByNode: ctx.inputs as unknown as Record<string, Record<string, FlowValue>>,
  }
}

/**
 * Flow sessions are logical names ("flow_llm_llm_1"), but the embedded Rust
 * Runtime only speaks real thread ids — posting a turn to a name that was
 * never created fails with `404 Thread not found`. Resolve each name to a
 * thread id once, creating the thread on first use and caching it so later
 * runs of the same node continue the same conversation.
 */
const threadIds = new Map<string, string>()

/** Drop a cached mapping whose thread the Runtime no longer has. */
function forgetThreadId(session: string): void {
  threadIds.delete(session)
}

async function resolveThreadId(client: any, session: string): Promise<string> {
  const cached = threadIds.get(session)
  if (cached) return cached
  if (!client.usesEmbeddedRuntime) return session

  const title = `Flow · ${session}`
  try {
    const sessions = await client.listSessions()
    const existing = (sessions || []).find((s: any) => s.title === title)
    if (existing) {
      const id = existing.remote_session_id || existing.id
      threadIds.set(session, id)
      return id
    }
  } catch {
    /* listing is best-effort — fall through and create one */
  }

  const created = await client.createSession({ id: session, title })
  const id = created?.remote_session_id || created?.id || session
  threadIds.set(session, id)
  return id
}

/** Run one runtime turn and stream assistant text back (used by LLM/Tool/Subagent). */
async function runAgentTurn(
  prompt: string,
  session: string,
  signal: AbortSignal,
  runMode: string,
  onDelta?: (text: string) => void,
  route?: { provider?: string; model?: string },
): Promise<string> {
  const { apiClient: client, isRuntimeMissingThreadError } = await import('@/api/client')

  const turn = async (threadId: string) => {
    let acc = ''
    let lastEmit = 0
    await client.chatStream(
      prompt,
      threadId,
      (chunk: any) => {
        if (chunk?.content) {
          acc += chunk.content
          const now = Date.now()
          if (onDelta && now - lastEmit > 90) {
            lastEmit = now
            onDelta(acc)
          }
        }
      },
      signal,
      // chatStream(message, sessionId, onChunk, signal, provider, runMode,
      //   reasoningEffort, projectId, model, longRunningGoal, providerId)
      route?.model,
      runMode as any,
      undefined, // reasoning effort
      undefined, // project id
      route?.model,
      false, // longRunningGoal
      route?.provider,
    )
    return acc
  }

  let threadId = await resolveThreadId(client, session)
  let acc: string
  try {
    acc = await turn(threadId)
  } catch (error) {
    // The cached mapping can outlive the thread it points at: the Runtime
    // restarts onto a fresh store, or the thread was deleted elsewhere. The
    // cache is process-lifetime, so without this the node fails with
    // "404 Thread not found" forever. Drop the stale mapping and retry once
    // on a freshly created thread.
    if (signal.aborted || !isRuntimeMissingThreadError(error)) throw error
    forgetThreadId(session)
    threadId = await resolveThreadId(client, session)
    acc = await turn(threadId)
  }
  onDelta?.(acc)
  return acc.trim() || '(empty)'
}

/** Parse a headers JSON blob. Tolerant on purpose: a typo should not kill a run. */
function parseHeaders(raw: string): Record<string, string> {
  if (!raw || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) out[String(k)] = String(v ?? '')
    return out
  } catch {
    return {}
  }
}

/** Best-effort JSON parse: invalid input stays a string rather than throwing. */
function safeParse(raw: string): FlowValue {
  try {
    return JSON.parse(raw) as FlowValue
  } catch {
    return raw
  }
}

/** Date formatting without a date library — the four formats flows actually use. */
function formatDate(date: Date, format: string): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  const y = date.getFullYear()
  const mo = pad(date.getMonth() + 1)
  const d = pad(date.getDate())
  const h = pad(date.getHours())
  const mi = pad(date.getMinutes())
  const s = pad(date.getSeconds())
  switch (format) {
    case 'iso':
      return date.toISOString()
    case 'date':
      return `${y}-${mo}-${d}`
    case 'time':
      return `${h}:${mi}:${s}`
    case 'locale':
      return date.toLocaleString()
    default:
      return `${y}-${mo}-${d} ${h}:${mi}:${s}`
  }
}

export const FLOW_NODE_DEFS: FlowNodeDef[] = [
  {
    type: 'start',
    label: 'Start',
    labelZh: '开始',
    category: 'io',
    color: 'var(--flow-node-start)',
    icon: Play,
    inputs: [],
    outputs: [
      { id: 'out', label: 'out', dataType: 'object' },
    ],
    fields: [
      { key: 'fields', label: '输入字段（每行 name=label 或 name）', kind: 'textarea', rows: 4, placeholder: 'topic=主题\ncontext' },
      { key: 'defaults', label: '默认值 JSON', kind: 'json', rows: 3, placeholder: '{"topic":"HakusAgent"}' },
    ],
    defaults: { label: '开始', fields: 'topic=主题\ncontext=上下文', defaults: '{}' },
    execute: async (ctx) => {
      const fieldLines = String(ctx.data.fields || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      const runInputs: Record<string, FlowValue> = {}
      let parsedDefaults: Record<string, unknown> = {}
      try {
        parsedDefaults = ctx.data.defaults ? JSON.parse(String(ctx.data.defaults)) : {}
      } catch {
        parsedDefaults = {}
      }
      for (const line of fieldLines) {
        const [rawKey, rawLabel] = line.split('=')
        const key = (rawKey || '').trim()
        if (!key) continue
        const label = (rawLabel || key).trim()
        const fromCtx = ctx.runInputs[key]
        const value = fromCtx !== undefined && fromCtx !== null && fromCtx !== '' ? fromCtx : (parsedDefaults[key] as FlowValue) ?? ''
        runInputs[key] = value
        ctx.log(`Start ${key} (${label}) = ${text(value).slice(0, 80)}`)
      }
      return { outputs: { out: runInputs } }
    },
  },
  {
    type: 'llm',
    label: 'LLM',
    labelZh: '大模型',
    category: 'llm',
    color: 'var(--flow-node-llm)',
    icon: Sparkles,
    inputs: [
      { id: 'in', label: 'in', dataType: 'any' },
    ],
    outputs: [
      { id: 'text', label: 'text', dataType: 'string' },
    ],
    fields: [
      { key: 'system', label: '系统提示', kind: 'textarea', rows: 3, placeholder: 'You are a helpful assistant.' },
      { key: 'prompt', label: '用户提示（可用 {{input}} / {{start.out.topic}}）', kind: 'textarea', rows: 5, placeholder: '围绕 {{input}} 写一段摘要' },
      { key: 'sessionPrefix', label: '会话前缀', kind: 'text', placeholder: 'flow_llm' },
      // Pickers, not free text: the runtime knows which providers have
      // credentials and which models each serves, so asking it beats making
      // the operator spell a model id correctly.
      { key: 'provider', label: '供应商', kind: 'select', optionsFrom: 'configured-providers' },
      { key: 'model', label: '模型', kind: 'select', optionsFrom: 'models', dependsOn: 'provider' },
    ],
    defaults: {
      label: 'LLM',
      system: '你是 HakusAgent 的 Flow 节点执行器，输出简洁准确。',
      prompt: '{{input}}',
      sessionPrefix: 'flow_llm',
    },
    execute: async (ctx) => {
      const wideScope = scopeOf(ctx)
      const prompt = interpolate(String(ctx.data.prompt || '{{input}}'), wideScope)
      const system = interpolate(String(ctx.data.system || ''), wideScope)
      const full = system ? `${system}\n\n---\n${prompt}` : prompt
      ctx.log(`LLM prompt (${full.length} chars)`)
      const session = `${ctx.data.sessionPrefix || 'flow_llm'}_${ctx.nodeId}`
      const route = {
        provider: String(ctx.data.provider || '') || undefined,
        model: String(ctx.data.model || '') || undefined,
      }
      const out = await runAgentTurn(full, session, ctx.signal, String(ctx.data.runMode || 'swift'), ctx.emit, route)
      ctx.log(`LLM → ${out.slice(0, 120)}`)
      return { outputs: { text: out } }
    },
  },
  {
    type: 'prompt',
    label: 'Template',
    labelZh: '模板',
    category: 'llm',
    color: 'var(--flow-node-prompt)',
    icon: FileText,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [{ id: 'text', label: 'text', dataType: 'string' }],
    fields: [
      { key: 'template', label: '模板文本', kind: 'textarea', rows: 5, placeholder: 'Input: {{input}}\nTopic: {{run.topic}}' },
    ],
    defaults: { label: '模板', template: '{{input}}' },
    execute: async (ctx) => {
      const wideScope = scopeOf(ctx)
      const result = interpolate(String(ctx.data.template || '{{input}}'), wideScope)
      ctx.log(`Template → ${result.slice(0, 100)}`)
      return { outputs: { text: result } }
    },
  },
  {
    type: 'condition',
    label: 'Condition',
    labelZh: '条件',
    category: 'logic',
    color: 'var(--flow-node-condition)',
    icon: GitBranch,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [
      { id: 'true', label: 'true', dataType: 'branch' },
      { id: 'false', label: 'false', dataType: 'branch' },
      { id: 'value', label: 'value', dataType: 'string' },
    ],
    fields: [
      { key: 'expression', label: '条件（插值后求真值，或 JS 表达式）', kind: 'text', placeholder: '{{input}} 或 {{input.text}} 包含 ok' },
      { key: 'mode', label: '模式', kind: 'select', options: [
        { value: 'truthy', label: '插值真值' },
        { value: 'contains', label: '包含子串' },
        { value: 'expr', label: 'JS 表达式' },
      ] },
      { key: 'needle', label: '子串（contains 模式）', kind: 'text', showWhen: { key: 'mode', equals: 'contains' }, placeholder: 'ok' },
    ],
    defaults: { label: '条件', expression: '{{input}}', mode: 'truthy', needle: 'ok' },
    execute: async (ctx) => {
      const wideScope = scopeOf(ctx)
      const interpolated = interpolate(String(ctx.data.expression || ''), wideScope)
      let result = false
      const mode = String(ctx.data.mode || 'truthy')
      if (mode === 'contains') {
        const needle = interpolate(String(ctx.data.needle || ''), wideScope)
        result = interpolated.toLowerCase().includes(needle.toLowerCase())
      } else if (mode === 'expr') {
        try {
          const vars: Record<string, FlowValue> = {
            input: ctx.inputs.in ?? ctx.inputs,
            value: interpolated,
            ...ctx.runInputs,
          }
          const v = evalExpression(String(ctx.data.expression || 'false'), vars)
          result = Boolean(v) && v !== 0 && v !== '0' && v !== 'false'
        } catch (e: any) {
          throw new Error(`Condition expr failed: ${e?.message || e}`)
        }
      } else {
        result = evalCondition(String(ctx.data.expression || ''), wideScope)
      }
      ctx.log(`Condition → ${result}`)
      return {
        outputs: { true: result, false: !result, value: interpolated },
        activeHandles: result ? ['true', 'value'] : ['false', 'value'],
      }
    },
  },
  {
    type: 'code',
    label: 'Code',
    labelZh: '代码',
    category: 'logic',
    color: 'var(--flow-node-code)',
    icon: Code2,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [{ id: 'result', label: 'result', dataType: 'any' }],
    fields: [
      { key: 'language', label: '语言', kind: 'select', options: [
        { value: 'expr', label: '表达式 (JS 子集)' },
        { value: 'transform', label: '字符串变换' },
      ] },
      { key: 'body', label: '表达式 / 变换', kind: 'code', rows: 4, placeholder: 'String(input).toUpperCase()' },
    ],
    defaults: { label: '代码', language: 'transform', body: 'String(input)' },
    execute: async (ctx) => {
      const input = ctx.inputs.in
      const language = String(ctx.data.language || 'transform')
      let result: FlowValue
      if (language === 'expr') {
        const vars: Record<string, FlowValue> = {
          input,
          ...(typeof input === 'object' && input && !Array.isArray(input) ? (input as Record<string, FlowValue>) : {}),
          ...ctx.runInputs,
        }
        result = evalExpression(String(ctx.data.body || 'input'), vars)
      } else {
        const raw = text(input)
        const body = String(ctx.data.body || 'String(input)')
        // Limited transform helpers
        if (body.includes('toUpperCase')) result = raw.toUpperCase()
        else if (body.includes('toLowerCase')) result = raw.toLowerCase()
        else if (body.includes('trim')) result = raw.trim()
        else if (body.includes('length')) result = raw.length
        else result = raw
      }
      ctx.log(`Code → ${text(result).slice(0, 100)}`)
      return { outputs: { result } }
    },
  },
  {
    type: 'tool',
    label: 'Tool',
    labelZh: '工具',
    category: 'tool',
    color: 'var(--flow-node-tool)',
    icon: Wrench,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [{ id: 'text', label: 'text', dataType: 'string' }],
    fields: [
      { key: 'instruction', label: '给 Agent 的指令（工具按会话模式提供）', kind: 'textarea', rows: 4, placeholder: '列出当前目录文件' },
      { key: 'toolHint', label: '期望工具（提示词约束，可选）', kind: 'text', placeholder: 'bash / read_file / web_search' },
      { key: 'runMode', label: 'Agent 模式', kind: 'select', options: [
        { value: 'swift', label: 'Work' },
        { value: 'deep', label: 'Code' },
      ] },
    ],
    defaults: {
      label: '工具',
      instruction: '执行任务并只返回关键结果。\n输入：{{input}}',
      toolHint: '',
      runMode: 'swift',
    },
    execute: async (ctx) => {
      const wideScope = scopeOf(ctx)
      let instruction = interpolate(String(ctx.data.instruction || ''), wideScope)
      const hint = String(ctx.data.toolHint || '').trim()
      if (hint) instruction = `[prefer tool: ${hint}]\n${instruction}`
      ctx.log(`Tool agent (${ctx.data.runMode || 'swift'})…`)
      const session = `flow_tool_${ctx.nodeId}_${Date.now().toString(36)}`
      const out = await runAgentTurn(instruction, session, ctx.signal, String(ctx.data.runMode || 'swift'), ctx.emit)
      return { outputs: { text: out } }
    },
  },
  {
    type: 'human',
    label: 'Human',
    labelZh: '人工',
    category: 'human',
    color: 'var(--flow-node-human)',
    icon: UserCheck,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [{ id: 'text', label: 'text', dataType: 'string' }],
    fields: [
      { key: 'prompt', label: '向操作者展示的问题', kind: 'textarea', rows: 3, placeholder: '请确认或补充：' },
      { key: 'placeholder', label: '输入框占位', kind: 'text', placeholder: '输入你的决定…' },
    ],
    defaults: { label: '人工确认', prompt: '请审阅上游结果并输入继续指令：\n{{input}}', placeholder: '同意 / 修改意见…' },
    execute: async (ctx) => {
      const wideScope = scopeOf(ctx)
      const prompt = interpolate(String(ctx.data.prompt || 'Continue?'), wideScope)
      const value = await ctx.waitHuman(prompt, String(ctx.data.placeholder || ''))
      return { outputs: { text: value } }
    },
  },
  {
    type: 'knowledge',
    label: 'Knowledge',
    labelZh: '知识',
    category: 'data',
    color: 'var(--flow-node-knowledge)',
    icon: BookOpen,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [{ id: 'text', label: 'text', dataType: 'string' }],
    fields: [
      { key: 'query', label: '检索查询', kind: 'textarea', rows: 2, placeholder: '{{input}}' },
      { key: 'limit', label: '条数', kind: 'number' },
    ],
    defaults: { label: '知识', query: '{{input}}', limit: 5 },
    execute: async (ctx) => {
      const wideScope = scopeOf(ctx)
      const q = interpolate(String(ctx.data.query || ''), wideScope)
      const limit = Number(ctx.data.limit || 5)
      ctx.log(`Memory search: ${q.slice(0, 80)}`)
      try {
        const { apiClient: client } = await import('@/api/client')
        const raw: any = await (client as any).searchRuntimeMemory?.(q, 'all')
        // The runtime answers with `{ entries: [...], total }`; the old chain
        // only looked for items/results/memories, so every real hit was
        // dropped and the node always reported "no knowledge hits".
        const items = Array.isArray(raw)
          ? raw
          : raw?.entries || raw?.items || raw?.results || raw?.memories || []
        const snippets = (items as any[]).slice(0, limit).map((m, i) => {
          // The runtime's memory rows expose their text as `summary`; the old
          // lookup checked content/text/body and fell through to a JSON dump.
          const body = m.summary ?? m.content ?? m.text ?? m.body ?? JSON.stringify(m)
          return `[${i + 1}] ${String(body).slice(0, 400)}`
        })
        const out = snippets.length ? snippets.join('\n\n') : `(no knowledge hits for: ${q.slice(0, 60)})`
        return { outputs: { text: out } }
      } catch (e: any) {
        ctx.log(`Knowledge fallback: ${e?.message || e}`)
        return { outputs: { text: `(knowledge unavailable) query=${q}` } }
      }
    },
  },
  {
    type: 'subagent',
    label: 'Subagent',
    labelZh: '子代理',
    category: 'tool',
    color: 'var(--flow-node-subagent)',
    icon: Users,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [{ id: 'text', label: 'text', dataType: 'string' }],
    fields: [
      { key: 'objective', label: '子代理目标', kind: 'textarea', rows: 4, placeholder: '探索代码库并总结架构' },
      { key: 'runMode', label: '模式', kind: 'select', options: [
        { value: 'swift', label: 'Work' },
        { value: 'deep', label: 'Code' },
      ] },
    ],
    defaults: { label: '子代理', objective: '根据以下输入完成任务并返回结果：\n{{input}}', runMode: 'deep' },
    execute: async (ctx) => {
      const wideScope = scopeOf(ctx)
      const objective = interpolate(String(ctx.data.objective || ''), wideScope)
      const session = `flow_sub_${ctx.nodeId}_${Date.now().toString(36)}`
      const out = await runAgentTurn(objective, session, ctx.signal, String(ctx.data.runMode || 'deep'), ctx.emit)
      return { outputs: { text: out } }
    },
  },
  {
    type: 'iteration',
    label: 'Iteration',
    labelZh: '迭代',
    category: 'logic',
    color: 'var(--flow-node-iteration)',
    icon: Repeat,
    inputs: [{ id: 'in', label: 'in', dataType: 'array' }],
    outputs: [
      { id: 'body', label: 'body', dataType: 'branch' },
      { id: 'done', label: 'done', dataType: 'branch' },
      { id: 'items', label: 'items', dataType: 'array' },
      { id: 'text', label: 'text', dataType: 'string' },
    ],
    fields: [
      { key: 'splitBy', label: '切分方式', kind: 'select', options: [
        { value: 'lines', label: '按行' },
        { value: 'comma', label: '按逗号' },
        { value: 'json', label: 'JSON 数组' },
      ] },
      { key: 'template', label: '未接循环体时的每项模板（可用 {{item}} / {{index}}）', kind: 'textarea', rows: 3, placeholder: '{{index}}. {{item}}' },
      { key: 'maxItems', label: '最大条数', kind: 'number' },
    ],
    defaults: { label: '迭代', splitBy: 'lines', template: '{{item}}', maxItems: 20 },
    // Loop bodies are executed by the executor (see runIteration in executor.ts);
    // this fallback only fires when no `body` branch is wired.
    execute: async (ctx) => {
      const list = splitItems(ctx.inputs.in, String(ctx.data.splitBy || 'lines')).slice(0, Number(ctx.data.maxItems || 20))
      const template = String(ctx.data.template || '{{item}}')
      const results = list.map((item, index) =>
        interpolate(template, {
          // `in: item` so `{{input}}` also means "the current item" inside a loop.
          inputs: { ...ctx.inputs, in: item, item, index },
          run: ctx.runInputs,
          outputsByNode: ctx.inputs as any,
        }),
      )
      ctx.log(`Iteration x${results.length} (no body wired -> template map)`)
      return { outputs: { items: results, text: results.join('\n') } }
    },
  },
  {
    type: 'join',
    label: 'Join',
    labelZh: '聚合',
    category: 'logic',
    color: 'var(--flow-node-join)',
    icon: GitMerge,
    join: true,
    inputs: [{ id: 'in', label: 'in', dataType: 'any', multi: true }],
    outputs: [
      { id: 'out', label: 'out', dataType: 'object' },
      { id: 'text', label: 'text', dataType: 'string' },
    ],
    fields: [
      { key: 'mode', label: '汇合时机', kind: 'select', options: [
        { value: 'all', label: '等待全部分支' },
        { value: 'any', label: '任一到达即继续' },
      ] },
      { key: 'merge', label: '合并方式', kind: 'select', options: [
        { value: 'object', label: '按来源节点建对象' },
        { value: 'array', label: '数组合并' },
        { value: 'text', label: '拼接文本' },
      ] },
    ],
    defaults: { label: '聚合', mode: 'all', merge: 'object' },
    execute: async (ctx) => {
      const entries = ctx.incoming.map((e) => [e.source, e.value] as const)
      const merge = String(ctx.data.merge || 'object')
      let out: FlowValue
      if (merge === 'array') out = entries.map(([, v]) => v)
      else if (merge === 'text') out = entries.map(([, v]) => toDisplay(v)).join('\n\n')
      else {
        const obj: Record<string, FlowValue> = {}
        for (const [source, value] of entries) obj[source] = value
        out = obj
      }
      ctx.log(`Join <- ${entries.length} branch(es) [${merge}]`)
      return { outputs: { out, text: toDisplay(out) } }
    },
  },  {
    type: 'output',
    label: 'Output',
    labelZh: '输出',
    category: 'io',
    color: 'var(--flow-node-output)',
    icon: Send,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [{ id: 'out', label: 'out', dataType: 'string' }],
    fields: [
      { key: 'template', label: '输出模板', kind: 'textarea', rows: 4, placeholder: '{{input}}' },
    ],
    defaults: { label: '输出', template: '{{input}}' },
    execute: async (ctx) => {
      const wideScope = scopeOf(ctx)
      const result = interpolate(String(ctx.data.template || '{{input}}'), wideScope)
      return { outputs: { out: result } }
    },
  },
  {
    type: 'http',
    label: 'HTTP',
    labelZh: 'HTTP 请求',
    category: 'tool',
    color: 'var(--flow-node-http)',
    icon: Globe,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [
      { id: 'body', label: 'body', dataType: 'string' },
      { id: 'json', label: 'json', dataType: 'object' },
      { id: 'status', label: 'status', dataType: 'number' },
      { id: 'text', label: 'text', dataType: 'string' },
    ],
    fields: [
      { key: 'method', label: '方法', kind: 'select', options: [
        { value: 'GET', label: 'GET' },
        { value: 'POST', label: 'POST' },
        { value: 'PUT', label: 'PUT' },
        { value: 'PATCH', label: 'PATCH' },
        { value: 'DELETE', label: 'DELETE' },
      ] },
      { key: 'url', label: 'URL（支持 {{input.x}}）', kind: 'text', placeholder: 'https://api.example.com/v1/things' },
      { key: 'headers', label: '请求头 JSON', kind: 'json', rows: 3, placeholder: '{"Authorization":"Bearer ..."}' },
      { key: 'body', label: '请求体（GET 忽略）', kind: 'textarea', rows: 4, placeholder: '{"query":"{{input}}"}' },
      { key: 'timeoutSecs', label: '超时（秒）', kind: 'number' },
      { key: 'allowInsecureHttp', label: '允许明文 http（仅本机除外）', kind: 'select', options: [
        { value: 'no', label: '否（推荐）' },
        { value: 'yes', label: '是' },
      ] },
    ],
    defaults: {
      label: 'HTTP 请求',
      method: 'GET',
      url: 'https://api.github.com/repos/{{input}}',
      headers: '{}',
      body: '',
      timeoutSecs: 15,
      allowInsecureHttp: 'no',
    },
    execute: async (ctx) => {
      const wideScope = scopeOf(ctx)
      const url = interpolate(String(ctx.data.url || ''), wideScope).trim()
      const method = String(ctx.data.method || 'GET').toUpperCase()
      const headers = parseHeaders(interpolate(String(ctx.data.headers || '{}'), wideScope))
      const rawBody = interpolate(String(ctx.data.body || ''), wideScope)
      const timeoutSecs = Number(ctx.data.timeoutSecs || 15)
      const allowInsecure = String(ctx.data.allowInsecureHttp || 'no') === 'yes'

      if (!url) {
        ctx.log('HTTP: no url configured')
        return { outputs: { body: '', json: null, status: 0, text: '(no url)' } }
      }

      ctx.log(`HTTP ${method} ${url.slice(0, 120)}`)
      try {
        const { httpOs } = await import('@/api/tauriBridge')
        const res = await httpOs.request({ method, url, headers, body: rawBody, timeoutSecs, allowInsecureHttp: allowInsecure })
        ctx.log(`HTTP → ${res.status} (${res.body.length} chars)`)
        return {
          outputs: {
            body: res.body,
            json: (res.json ?? null) as FlowValue,
            status: res.status,
            text: String(res.status),
          },
        }
      } catch (e: any) {
        // Surface the failure as a node error instead of killing the run.
        const message = e?.message || String(e)
        ctx.log(`HTTP failed: ${message}`)
        throw new Error(message)
      }
    },
  },
  {
    type: 'json',
    label: 'JSON',
    labelZh: 'JSON',
    category: 'data',
    color: 'var(--flow-node-json)',
    icon: Braces,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [
      { id: 'value', label: 'value', dataType: 'any' },
      { id: 'text', label: 'text', dataType: 'string' },
    ],
    fields: [
      { key: 'mode', label: '操作', kind: 'select', options: [
        { value: 'parse', label: '解析 JSON 字符串' },
        { value: 'stringify', label: '对象转 JSON' },
        { value: 'pick', label: '取字段（a.b.c）' },
      ] },
      { key: 'path', label: '字段路径（pick 模式，留空取全部）', kind: 'text', placeholder: 'data.items.0' },
    ],
    defaults: { label: 'JSON', mode: 'parse', path: '' },
    execute: async (ctx) => {
      const input = ctx.inputs.in
      const mode = String(ctx.data.mode || 'parse')
      let value: FlowValue

      if (mode === 'stringify') {
        value = JSON.stringify(input, null, 2)
      } else if (mode === 'pick') {
        const path = String(ctx.data.path || '').trim()
        let cur: any = typeof input === 'string' ? safeParse(input) : input
        if (path) {
          for (const part of path.split('.')) {
            if (cur == null) break
            cur = cur[part]
          }
        }
        value = (cur ?? null) as FlowValue
      } else {
        value = safeParse(text(input))
      }
      ctx.log(`JSON [${mode}] → ${text(value).slice(0, 100)}`)
      return { outputs: { value, text: text(value) } }
    },
  },
  {
    type: 'template',
    label: 'Template',
    labelZh: '文本拼接',
    category: 'data',
    color: 'var(--flow-node-template)',
    icon: Type,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [{ id: 'text', label: 'text', dataType: 'string' }],
    fields: [
      { key: 'template', label: '模板（{{input}} / {{run.x}} / {{input.field}}）', kind: 'textarea', rows: 5, placeholder: '标题：{{input.title}}\n摘要：{{input.summary}}' },
      { key: 'joinWith', label: '数组输入时的连接符', kind: 'text', placeholder: '\n' },
    ],
    defaults: { label: '文本拼接', template: '{{input}}', joinWith: '\n' },
    execute: async (ctx) => {
      const wideScope = scopeOf(ctx)
      const template = String(ctx.data.template || '{{input}}')
      const joinWith = String(ctx.data.joinWith ?? '\n')
      const input = ctx.inputs.in
      const out = Array.isArray(input)
        ? input
            .map((item, index) =>
              interpolate(template, {
                // `item`/`index` ride on the `in` port so `{{input}}`,
                // `{{input.x}}` and `{{item}}` all resolve for one item.
                inputs: { ...ctx.inputs, in: item, item, index },
                run: ctx.runInputs,
                outputsByNode: ctx.inputs as any,
              }),
            )
            .join(joinWith)
        : interpolate(template, wideScope)
      ctx.log(`Template → ${out.slice(0, 100)}`)
      return { outputs: { text: out } }
    },
  },
  {
    type: 'delay',
    label: 'Delay',
    labelZh: '延时',
    category: 'logic',
    color: 'var(--flow-node-delay)',
    icon: Timer,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [{ id: 'out', label: 'out', dataType: 'any' }],
    fields: [
      { key: 'seconds', label: '延时（秒，最多 60）', kind: 'number' },
    ],
    defaults: { label: '延时', seconds: 1 },
    execute: async (ctx) => {
      const seconds = Math.min(60, Math.max(0, Number(ctx.data.seconds || 0)))
      ctx.log(`Delay ${seconds}s`)
      // Abortable: waking early on cancel keeps "stop" responsive.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, seconds * 1000)
        const onAbort = () => {
          clearTimeout(timer)
          resolve()
        }
        if (ctx.signal.aborted) onAbort()
        else ctx.signal.addEventListener('abort', onAbort, { once: true })
      })
      return { outputs: { out: ctx.inputs.in } }
    },
  },
  {
    type: 'regex',
    label: 'Regex',
    labelZh: '正则提取',
    category: 'data',
    color: 'var(--flow-node-regex)',
    icon: Regex,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [
      { id: 'match', label: 'match', dataType: 'string' },
      { id: 'group', label: 'group', dataType: 'string' },
      { id: 'all', label: 'all', dataType: 'array' },
    ],
    fields: [
      { key: 'pattern', label: '正则（不含斜杠，可带 flags 后缀）', kind: 'text', placeholder: '\\d{4}-\\d{2}-\\d{2}' },
      { key: 'flags', label: 'flags', kind: 'text', placeholder: 'gi' },
      { key: 'groupIndex', label: '捕获组序号（0=整个匹配）', kind: 'number' },
    ],
    defaults: { label: '正则提取', pattern: '', flags: 'g', groupIndex: 1 },
    execute: async (ctx) => {
      const raw = text(ctx.inputs.in)
      const pattern = String(ctx.data.pattern || '')
      if (!pattern) {
        ctx.log('Regex: no pattern configured')
        return { outputs: { match: '', group: '', all: [] } }
      }
      const flagsRaw = String(ctx.data.flags || 'g').replace(/[^gimsuy]/g, '')
      const groupIndex = Math.max(0, Number(ctx.data.groupIndex ?? 1))
      let re: RegExp
      try {
        re = new RegExp(pattern, flagsRaw.includes('g') ? flagsRaw : flagsRaw + 'g')
      } catch (e: any) {
        // A bad pattern is a node error worth surfacing, not a silent no-op.
        throw new Error(`Invalid regex: ${e?.message || e}`)
      }
      const all = [...raw.matchAll(re)]
      const first = all[0] || null
      const match = first?.[0] ?? ''
      const group = first?.[groupIndex] ?? ''
      ctx.log(`Regex /${pattern}/${flagsRaw} → ${all.length} match(es)`)
      return { outputs: { match, group, all: all.map((m) => m[0]) } }
    },
  },
  {
    type: 'datetime',
    label: 'Date / Time',
    labelZh: '日期时间',
    category: 'data',
    color: 'var(--flow-node-datetime)',
    icon: CalendarClock,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [
      { id: 'text', label: 'text', dataType: 'string' },
      { id: 'timestamp', label: 'timestamp', dataType: 'number' },
    ],
    fields: [
      { key: 'mode', label: '操作', kind: 'select', options: [
        { value: 'now', label: '当前时间' },
        { value: 'format', label: '格式化输入时间' },
        { value: 'offset', label: '当前时间加减' },
      ] },
      { key: 'format', label: '输出格式（format 模式）', kind: 'select', options: [
        { value: 'iso', label: 'ISO 8601' },
        { value: 'date', label: 'YYYY-MM-DD' },
        { value: 'datetime', label: 'YYYY-MM-DD HH:mm:ss' },
        { value: 'time', label: 'HH:mm:ss' },
        { value: 'locale', label: '本地化字符串' },
      ] },
      { key: 'offsetValue', label: '数量（offset 模式，可为负）', kind: 'number' },
      { key: 'offsetUnit', label: '单位（offset 模式）', kind: 'select', options: [
        { value: 'seconds', label: '秒' },
        { value: 'minutes', label: '分' },
        { value: 'hours', label: '小时' },
        { value: 'days', label: '天' },
      ] },
    ],
    defaults: { label: '日期时间', mode: 'now', format: 'datetime', offsetValue: 0, offsetUnit: 'days' },
    execute: async (ctx) => {
      const mode = String(ctx.data.mode || 'now')
      const fmt = String(ctx.data.format || 'datetime')
      let date: Date
      if (mode === 'format') {
        const parsed = new Date(text(ctx.inputs.in))
        if (Number.isNaN(parsed.getTime())) {
          throw new Error(`Cannot parse as a date: ${text(ctx.inputs.in).slice(0, 60)}`)
        }
        date = parsed
      } else if (mode === 'offset') {
        const amount = Number(ctx.data.offsetValue || 0)
        const unit = String(ctx.data.offsetUnit || 'days')
        const ms = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[unit] ?? 86_400_000
        date = new Date(Date.now() + amount * ms)
      } else {
        date = new Date()
      }
      const text$ = formatDate(date, fmt)
      ctx.log(`DateTime [${mode}] → ${text$}`)
      return { outputs: { text: text$, timestamp: date.getTime() } }
    },
  },
  {
    type: 'math',
    label: 'Number',
    labelZh: '数值计算',
    category: 'data',
    color: 'var(--flow-node-math)',
    icon: Calculator,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [
      { id: 'value', label: 'value', dataType: 'number' },
      { id: 'text', label: 'text', dataType: 'string' },
    ],
    fields: [
      { key: 'op', label: '运算', kind: 'select', options: [
        { value: 'round', label: '四舍五入' },
        { value: 'floor', label: '向下取整' },
        { value: 'ceil', label: '向上取整' },
        { value: 'abs', label: '绝对值' },
        { value: 'add', label: '加' },
        { value: 'subtract', label: '减' },
        { value: 'multiply', label: '乘' },
        { value: 'divide', label: '除' },
      ] },
      { key: 'operand', label: '操作数（二元运算用）', kind: 'number' },
      { key: 'decimals', label: '保留小数位（round 用）', kind: 'number' },
    ],
    defaults: { label: '数值计算', op: 'round', operand: 0, decimals: 0 },
    execute: async (ctx) => {
      const n = Number(text(ctx.inputs.in).trim())
      if (Number.isNaN(n)) {
        throw new Error(`Not a number: ${text(ctx.inputs.in).slice(0, 40)}`)
      }
      const op = String(ctx.data.op || 'round')
      const operand = Number(ctx.data.operand || 0)
      const decimals = Math.max(0, Math.min(10, Number(ctx.data.decimals || 0)))
      let value: number
      switch (op) {
        case 'floor': value = Math.floor(n); break
        case 'ceil': value = Math.ceil(n); break
        case 'abs': value = Math.abs(n); break
        case 'add': value = n + operand; break
        case 'subtract': value = n - operand; break
        case 'multiply': value = n * operand; break
        case 'divide':
          if (operand === 0) throw new Error('Division by zero')
          value = n / operand
          break
        default: {
          const factor = 10 ** decimals
          value = Math.round(n * factor) / factor
        }
      }
      ctx.log(`Number ${n} ${op} → ${value}`)
      return { outputs: { value, text: String(value) } }
    },
  },
  {
    type: 'setvar',
    label: 'Set Variable',
    labelZh: '设置变量',
    category: 'data',
    color: 'var(--flow-node-setvar)',
    icon: Variable,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [{ id: 'out', label: 'out', dataType: 'any' }],
    fields: [
      { key: 'name', label: '变量名', kind: 'text', placeholder: 'token' },
      { key: 'value', label: '值（留空则透传 in 端口；支持 {{input}}）', kind: 'textarea', rows: 3, placeholder: '{{input}}' },
    ],
    defaults: { label: '设置变量', name: 'myVar', value: '' },
    execute: async (ctx) => {
      const name = String(ctx.data.name || '').trim()
      if (!name) throw new Error('Set Variable: variable name is required')
      const template = String(ctx.data.value ?? '')
      // An empty template means "store whatever arrived on the in port".
      const value = template.trim()
        ? (interpolate(template, scopeOf(ctx)) as FlowValue)
        : ctx.inputs.in
      ctx.vars[name] = value
      ctx.log(`Set ${name} = ${text(value).slice(0, 100)}`)
      return { outputs: { out: value } }
    },
  },
  {
    type: 'getvar',
    label: 'Get Variable',
    labelZh: '读取变量',
    category: 'data',
    color: 'var(--flow-node-getvar)',
    icon: Variable,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [
      { id: 'value', label: 'value', dataType: 'any' },
      { id: 'text', label: 'text', dataType: 'string' },
    ],
    fields: [
      { key: 'name', label: '变量名', kind: 'text', placeholder: 'token' },
      { key: 'fallback', label: '未设置时的默认值', kind: 'text' },
      { key: 'required', label: '变量不存在时报错', kind: 'select', options: [
        { value: 'no', label: '否（用默认值）' },
        { value: 'yes', label: '是' },
      ] },
    ],
    defaults: { label: '读取变量', name: 'myVar', fallback: '', required: 'no' },
    execute: async (ctx) => {
      const name = String(ctx.data.name || '').trim()
      if (!name) throw new Error('Get Variable: variable name is required')
      const exists = Object.prototype.hasOwnProperty.call(ctx.vars, name)
      if (!exists && String(ctx.data.required || 'no') === 'yes') {
        // Naming the variable is the recovery: the operator forgot to Set it.
        const known = Object.keys(ctx.vars)
        throw new Error(
          `Variable "${name}" was never set${known.length ? ` (known: ${known.join(', ')})` : ''}`,
        )
      }
      const value = exists ? ctx.vars[name] : ((ctx.data.fallback ?? '') as FlowValue)
      ctx.log(`Get ${name} = ${text(value).slice(0, 100)}${exists ? '' : ' (fallback)'}`)
      return { outputs: { value, text: text(value) } }
    },
  },
  {
    type: 'fileread',
    label: 'Read File',
    labelZh: '读取文件',
    category: 'tool',
    color: 'var(--flow-node-fileread)',
    icon: FileText,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [
      { id: 'text', label: 'text', dataType: 'string' },
      { id: 'path', label: 'path', dataType: 'string' },
    ],
    fields: [
      { key: 'root', label: '允许访问的根目录（绝对路径）', kind: 'text', placeholder: 'D:\\项目\\HakusAgent' },
      { key: 'path', label: '相对路径（支持 {{input}}）', kind: 'text', placeholder: 'doc/notes.md' },
    ],
    defaults: { label: '读取文件', root: '', path: 'README.md' },
    execute: async (ctx) => {
      const wideScope = scopeOf(ctx)
      const root = String(ctx.data.root || '').trim()
      const rel = interpolate(String(ctx.data.path || ''), wideScope).trim()
      if (!root) throw new Error('Read File: set the allowed root directory first')
      if (!rel) throw new Error('Read File: file path is empty')
      ctx.log(`Read ${rel} (root=${root})`)
      const { fsOs } = await import('@/api/tauriBridge')
      const res = await fsOs.readText(root, rel)
      ctx.log(`Read → ${res.bytes} bytes`)
      return { outputs: { text: res.content, path: res.path } }
    },
  },
  {
    type: 'filewrite',
    label: 'Write File',
    labelZh: '写入文件',
    category: 'tool',
    color: 'var(--flow-node-filewrite)',
    icon: FileText,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [
      { id: 'path', label: 'path', dataType: 'string' },
      { id: 'text', label: 'text', dataType: 'string' },
    ],
    fields: [
      { key: 'root', label: '允许访问的根目录（绝对路径）', kind: 'text', placeholder: 'D:\\项目\\HakusAgent' },
      { key: 'path', label: '相对路径（支持 {{input}}）', kind: 'text', placeholder: 'out/result.md' },
      { key: 'content', label: '内容（默认写入 in 端口；支持 {{input}}）', kind: 'textarea', rows: 5, placeholder: '{{input}}' },
      { key: 'append', label: '追加而非覆盖', kind: 'select', options: [
        { value: 'no', label: '否（覆盖）' },
        { value: 'yes', label: '是（追加）' },
      ] },
    ],
    defaults: { label: '写入文件', root: '', path: 'out/result.md', content: '', append: 'no' },
    execute: async (ctx) => {
      const wideScope = scopeOf(ctx)
      const root = String(ctx.data.root || '').trim()
      const rel = interpolate(String(ctx.data.path || ''), wideScope).trim()
      if (!root) throw new Error('Write File: set the allowed root directory first')
      if (!rel) throw new Error('Write File: file path is empty')
      const template = String(ctx.data.content ?? '')
      const body = template.trim() ? interpolate(template, wideScope) : text(ctx.inputs.in)
      const append = String(ctx.data.append || 'no') === 'yes'
      ctx.log(`Write ${rel} (${body.length} chars${append ? ', append' : ''})`)
      const { fsOs } = await import('@/api/tauriBridge')
      let payload = body
      if (append) {
        // Read-then-write keeps the Rust side to two simple commands rather
        // than an append mode the operator cannot inspect before using.
        try {
          const existing = await fsOs.readText(root, rel)
          payload = existing.content + body
        } catch {
          /* file does not exist yet — plain create */
        }
      }
      const written = await fsOs.writeText(root, rel, payload)
      ctx.log(`Wrote → ${written}`)
      return { outputs: { path: written, text: body } }
    },
  },
  {
    type: 'filelist',
    label: 'List Directory',
    labelZh: '列出目录',
    category: 'tool',
    color: 'var(--flow-node-filelist)',
    icon: FileText,
    inputs: [{ id: 'in', label: 'in', dataType: 'any' }],
    outputs: [
      { id: 'items', label: 'items', dataType: 'array' },
      { id: 'text', label: 'text', dataType: 'string' },
    ],
    fields: [
      { key: 'root', label: '允许访问的根目录（绝对路径）', kind: 'text', placeholder: 'D:\\项目\\HakusAgent' },
      { key: 'path', label: '相对路径（支持 {{input}}）', kind: 'text', placeholder: 'doc' },
      { key: 'filter', label: '名称包含（可空）', kind: 'text', placeholder: '.md' },
    ],
    defaults: { label: '列出目录', root: '', path: '.', filter: '' },
    execute: async (ctx) => {
      const wideScope = scopeOf(ctx)
      const root = String(ctx.data.root || '').trim()
      const rel = interpolate(String(ctx.data.path || '.'), wideScope).trim() || '.'
      if (!root) throw new Error('List Directory: set the allowed root directory first')
      const needle = String(ctx.data.filter || '').trim().toLowerCase()
      ctx.log(`List ${rel} (root=${root})`)
      const { fsOs } = await import('@/api/tauriBridge')
      const entries = await fsOs.listDir(root, rel)
      const filtered = needle ? entries.filter((e) => e.name.toLowerCase().includes(needle)) : entries
      const items = filtered.map((e) => `${e.isDir ? '[dir] ' : ''}${e.name}`)
      ctx.log(`Listed ${filtered.length}/${entries.length} entries`)
      return { outputs: { items, text: items.join('\n') } }
    },
  },
]

export const FLOW_NODE_MAP: Record<string, FlowNodeDef> = Object.fromEntries(
  FLOW_NODE_DEFS.map((d) => [d.type, d]),
)

export function getNodeDef(type: string): FlowNodeDef | undefined {
  return FLOW_NODE_MAP[type]
}

export function defaultNodeData(type: string): Record<string, unknown> {
  const def = getNodeDef(type)
  return { ...(def?.defaults || { label: type }) }
}

const edgeKeyOf = (e: FlowEdge) => `${e.source}->${e.target}:${e.sourceHandle || ''}:${e.targetHandle || ''}`

/** Does a source handle carry a value for this execution? */
export function handleIsLive(
  outputs: Record<string, FlowValue>,
  handle: string,
  active: Set<string> | undefined,
): boolean {
  const branch = handle === 'true' || handle === 'false'
  if (branch) {
    if (outputs[handle] !== true) return false
    return !active || active.has(handle)
  }
  if (handle in outputs) return !active || active.has(handle) || active.has('out')
  // Node emits other ports (e.g. `text`); a generic `out` edge still carries data.
  return handle === 'out' && Object.keys(outputs).length > 0
}

/**
 * Resolve incoming values for a node from prior outputs + edges.
 * Pure: dead edges are reported, never mutated — the executor owns edge state.
 */
export interface ResolvedInputs {
  inputs: Record<string, FlowValue>
  incoming: IncomingEdge[]
  /** Every live upstream node has finished. */
  ready: boolean
  /** All incoming edges resolved and none carried a value (dead path). */
  dead: boolean
  /** How many live edges delivered a value. */
  delivered: number
}

export function resolveNodeInputs(
  targetId: string,
  edges: FlowEdge[],
  outputsByNode: Record<string, Record<string, FlowValue>>,
  activeByNode: Record<string, Set<string> | undefined>,
  failedEdges?: Set<string>,
): ResolvedInputs {
  const incoming = edges.filter((e) => e.target === targetId)
  if (incoming.length === 0) {
    return { inputs: {}, incoming: [], ready: true, dead: false, delivered: 0 }
  }

  const inputs: Record<string, FlowValue> = {}
  const live: IncomingEdge[] = []
  let pending = 0

  for (const e of incoming) {
    if (failedEdges?.has(edgeKeyOf(e))) continue
    const srcOut = outputsByNode[e.source]
    if (!srcOut) {
      pending += 1
      continue
    }
    const handle = e.sourceHandle || 'out'
    if (!handleIsLive(srcOut, handle, activeByNode[e.source])) continue
    const port = e.targetHandle || 'in'
    const value = e.targetHandle
      ? (srcOut[e.targetHandle] ?? srcOut[handle] ?? srcOut.out)
      : (srcOut[handle] ?? srcOut.out ?? srcOut.text ?? srcOut.result)
    inputs[port] = value as FlowValue
    // Templates rely on the bare `in` alias.
    if (port === 'in') inputs.in = value as FlowValue
    live.push({
      source: e.source,
      sourceHandle: handle,
      targetHandle: e.targetHandle || 'in',
      value: value as FlowValue,
    })
  }

  return {
    inputs,
    incoming: live,
    ready: pending === 0,
    dead: pending === 0 && live.length === 0,
    delivered: live.length,
  }
}
