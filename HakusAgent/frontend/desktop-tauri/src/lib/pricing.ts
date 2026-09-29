/**
 * Local USD pricing table + cost aggregation for the Usage panel.
 * The client computes usage from
 * per-message token events using configurable $/1M-token rates.
 */

import type {
  ChatMessage,
  ModelPricing,
  UsageBreakdown,
  UsageModelShare,
  UsageTurnRow,
} from '@/api/types'

/** First-match-wins. Keep most specific keys first. */
export const DEFAULT_PRICING: ModelPricing[] = [
  { match: 'deepseek-chat', label: 'DeepSeek Chat', input_per_mtok: 0.27, output_per_mtok: 1.1, cache_hit_per_mtok: 0.07, cache_miss_per_mtok: 0.27 },
  { match: 'deepseek-reasoner', label: 'DeepSeek Reasoner', input_per_mtok: 0.55, output_per_mtok: 2.19, cache_hit_per_mtok: 0.14, cache_miss_per_mtok: 0.55 },
  { match: 'deepseek', label: 'DeepSeek', input_per_mtok: 0.27, output_per_mtok: 1.1, cache_hit_per_mtok: 0.07, cache_miss_per_mtok: 0.27 },
  { match: 'gpt-4o-mini', label: 'GPT-4o mini', input_per_mtok: 0.15, output_per_mtok: 0.6 },
  { match: 'gpt-4o', label: 'GPT-4o', input_per_mtok: 2.5, output_per_mtok: 10 },
  { match: 'o1-mini', label: 'o1-mini', input_per_mtok: 3, output_per_mtok: 12 },
  { match: 'o1', label: 'o1', input_per_mtok: 15, output_per_mtok: 60 },
  { match: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet', input_per_mtok: 3, output_per_mtok: 15 },
  { match: 'claude-3-5-haiku', label: 'Claude 3.5 Haiku', input_per_mtok: 0.8, output_per_mtok: 4 },
  { match: 'claude-sonnet', label: 'Claude Sonnet', input_per_mtok: 3, output_per_mtok: 15 },
  { match: 'claude-haiku', label: 'Claude Haiku', input_per_mtok: 0.8, output_per_mtok: 4 },
  { match: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', input_per_mtok: 1.25, output_per_mtok: 5 },
  { match: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', input_per_mtok: 0.075, output_per_mtok: 0.3 },
  { match: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', input_per_mtok: 0.1, output_per_mtok: 0.4 },
  { match: 'qwen', label: 'Qwen', input_per_mtok: 0.3, output_per_mtok: 0.9 },
  { match: 'glm', label: 'GLM', input_per_mtok: 0.5, output_per_mtok: 1.5 },
]

const PRICING_KEY = 'hakusai:model-pricing'

export function loadPricing(): ModelPricing[] {
  try {
    const raw = localStorage.getItem(PRICING_KEY)
    if (!raw) return DEFAULT_PRICING
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_PRICING
    return parsed as ModelPricing[]
  } catch {
    return DEFAULT_PRICING
  }
}

export function savePricing(pricing: ModelPricing[]): void {
  try {
    localStorage.setItem(PRICING_KEY, JSON.stringify(pricing))
  } catch {
    /* ignore */
  }
}

export function findPricing(modelKey: string | undefined, pricing: ModelPricing[]): ModelPricing | null {
  if (!modelKey) return null
  const lower = modelKey.toLowerCase()
  return pricing.find((p) => lower.includes(p.match.toLowerCase())) || null
}

export function computeTurnCost(
  modelKey: string | undefined,
  input: number,
  output: number,
  cacheHit: number,
  cacheMiss: number,
  pricing: ModelPricing[],
): number {
  const p = findPricing(modelKey, pricing)
  if (!p) return 0
  const inRate = p.input_per_mtok
  const outRate = p.output_per_mtok
  const hitRate = p.cache_hit_per_mtok ?? inRate * 0.1
  const missRate = p.cache_miss_per_mtok ?? inRate
  // cache_miss is a subset of input for DeepSeek-style accounting; avoid
  // double-counting when the provider already splits input tokens.
  const netInput = Math.max(0, input - cacheHit - cacheMiss)
  return (
    (netInput * inRate + cacheHit * hitRate + cacheMiss * missRate + output * outRate) / 1_000_000
  )
}

export function formatUsd(value: number): string {
  const abs = Math.abs(value)
  const digits = abs > 0 && abs < 0.01 ? 6 : 2
  return `$${value.toFixed(digits)}`
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Aggregate chat messages into a usage breakdown. */
export function buildUsageBreakdown(
  messages: ChatMessage[],
  defaultModel?: string,
  pricing: ModelPricing[] = loadPricing(),
): UsageBreakdown {
  const turns: UsageTurnRow[] = []
  const byModel = new Map<string, UsageModelShare>()

  let idx = 0
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const input = msg.input_tokens ?? 0
    const output = msg.output_tokens ?? 0
    const cacheHit = msg.cache_hit_tokens ?? 0
    const cacheMiss = msg.cache_miss_tokens ?? 0
    if (input === 0 && output === 0 && cacheHit === 0 && cacheMiss === 0) continue
    idx += 1
    const modelKey = defaultModel || 'unknown'
    const pricingHit = findPricing(modelKey, pricing)
    const cost = computeTurnCost(modelKey, input, output, cacheHit, cacheMiss, pricing)
    turns.push({
      index: idx,
      timestamp: msg.updated_at || msg.created_at,
      model: modelKey,
      input_tokens: input,
      output_tokens: output,
      cache_hit_tokens: cacheHit,
      cache_miss_tokens: cacheMiss,
      cost_usd: cost,
    })
    const key = modelKey
    const existing = byModel.get(key)
    if (existing) {
      existing.input_tokens += input
      existing.output_tokens += output
      existing.cache_hit_tokens += cacheHit
      existing.cache_miss_tokens += cacheMiss
      existing.cost_usd += cost
    } else {
      byModel.set(key, {
        key,
        label: pricingHit?.label || modelKey,
        input_tokens: input,
        output_tokens: output,
        cache_hit_tokens: cacheHit,
        cache_miss_tokens: cacheMiss,
        cost_usd: cost,
        share_pct: 0,
      })
    }
  }

  const modelList = [...byModel.values()]
  const totalCost = modelList.reduce((s, m) => s + m.cost_usd, 0)
  for (const m of modelList) {
    m.share_pct = totalCost > 0 ? Math.round((m.cost_usd / totalCost) * 100) : 0
  }
  modelList.sort((a, b) => b.cost_usd - a.cost_usd)

  const totals = {
    input_tokens: modelList.reduce((s, m) => s + m.input_tokens, 0),
    output_tokens: modelList.reduce((s, m) => s + m.output_tokens, 0),
    cache_hit_tokens: modelList.reduce((s, m) => s + m.cache_hit_tokens, 0),
    cache_miss_tokens: modelList.reduce((s, m) => s + m.cache_miss_tokens, 0),
    cost_usd: totalCost,
    turn_count: turns.length,
  }

  return { turns: turns.slice().reverse(), totals, by_model: modelList }
}
