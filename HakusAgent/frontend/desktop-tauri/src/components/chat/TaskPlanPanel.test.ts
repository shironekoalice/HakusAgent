import { describe, expect, it } from 'vitest'
import { planRows, planSummary, type PlanRow } from './TaskPlanPanel'

/**
 * The two transports disagree about how a plan is shaped, and the row builder
 * is the single place that reconciles them. These tests pin the reconciliation,
 * because getting it wrong is invisible: a mis-parsed row still renders, it
 * just claims the wrong thing about the agent's progress.
 */
describe('planRows', () => {
  it('prefers per-row status when the Runtime sends items', () => {
    const rows = planRows({
      completed: 1,
      total: 3,
      current_task: 'map the frame',
      tasks: ['inspect the ledger', 'map the frame', 'check the app'],
      items: [
        { content: 'inspect the ledger', status: 'completed' },
        { content: 'map the frame', status: 'in_progress' },
        { content: 'check the app', status: 'pending' },
      ],
    })
    expect(rows).toEqual([
      { content: 'inspect the ledger', status: 'completed' },
      { content: 'map the frame', status: 'in_progress' },
      { content: 'check the app', status: 'pending' },
    ])
  })

  it('keeps a cancelled row distinct from a completed one', () => {
    // The whole reason `items` exists. With only a name list plus `completed`,
    // a cancelled row is indistinguishable from a finished one and would be
    // struck through as if the agent had done the work.
    const rows = planRows({
      completed: 1,
      total: 2,
      current_task: '',
      items: [
        { content: 'abandoned work', status: 'cancelled' },
        { content: 'real work', status: 'completed' },
      ],
    })
    expect(rows.map((row) => row.status)).toEqual(['cancelled', 'completed'])
    expect(planSummary(rows)).toContain('1 已取消')
    expect(planSummary(rows)).toContain('1 已完成')
  })

  it('falls back to the prefix count for legacy name-only frames', () => {
    const rows = planRows({
      completed: 2,
      total: 3,
      current_task: 'third thing',
      tasks: ['first', 'second', 'third thing'],
    })
    expect(rows).toEqual([
      { content: 'first', status: 'completed' },
      { content: 'second', status: 'completed' },
      { content: 'third thing', status: 'in_progress' },
    ])
  })

  it('marks an unknown status pending rather than dropping the row', () => {
    // A future Runtime status must not make rows vanish — a shorter list reads
    // as "the agent removed a task", which is a different claim from "this
    // client cannot render that state".
    const rows = planRows({
      completed: 0,
      total: 1,
      current_task: '',
      items: [{ content: 'mystery', status: 'something_new' }],
    })
    expect(rows).toEqual([{ content: 'mystery', status: 'pending' }])
  })

  it('returns no rows when neither shape is present', () => {
    expect(planRows({ completed: 0, total: 0, current_task: 'just a name' })).toEqual([])
  })
})

describe('planSummary', () => {
  const row = (status: PlanRow['status']): PlanRow => ({ content: 'x', status })

  it('omits zero-count segments', () => {
    // Ported from DSH: a three-item plan with nothing running reads
    // "3 已完成", not "3 已完成 · 0 进行中 · 0 待办".
    const summary = planSummary([row('completed'), row('completed'), row('completed')])
    expect(summary).toBe('3 已完成')
    expect(summary).not.toContain('0')
  })

  it('joins the segments that are present', () => {
    expect(planSummary([row('completed'), row('in_progress'), row('pending')])).toBe(
      '1 已完成 · 1 进行中 · 1 待办',
    )
  })

  it('reports an empty plan as an empty string', () => {
    expect(planSummary([])).toBe('')
  })
})
