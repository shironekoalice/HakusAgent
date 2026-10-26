import { describe, expect, it } from 'vitest'
import { defaultNodeData } from './registry'
import type { FlowEdge, FlowGraph, FlowNode } from './types'
import { nodesOnCycles, unwiredInputPorts, validateGraph } from './validation'

let seq = 0
function node(type: string, id?: string): FlowNode {
  return {
    id: id || `${type}_${++seq}`,
    type,
    position: { x: 0, y: 0 },
    data: { ...defaultNodeData(type) },
  }
}

function edge(source: string, target: string, targetHandle?: string): FlowEdge {
  return {
    id: `e_${++seq}`,
    source,
    target,
    sourceHandle: 'out',
    targetHandle: targetHandle || null,
  }
}

function graph(nodes: FlowNode[], edges: FlowEdge[]): FlowGraph {
  return { id: 'g', name: 'g', version: 1, nodes, edges, updated_at: 0 }
}

describe('nodesOnCycles', () => {
  it('returns nothing for a DAG', () => {
    const a = node('start')
    const b = node('llm')
    const c = node('output')
    const cycles = nodesOnCycles([a, b, c], [edge(a.id, b.id), edge(b.id, c.id)])
    expect(cycles.size).toBe(0)
  })

  it('flags every node of a two-node cycle', () => {
    const a = node('llm')
    const b = node('prompt')
    const cycles = nodesOnCycles([a, b], [edge(a.id, b.id), edge(b.id, a.id)])
    expect([...cycles].sort()).toEqual([a.id, b.id].sort())
  })

  it('flags a self-loop', () => {
    const a = node('llm')
    expect(nodesOnCycles([a], [edge(a.id, a.id)]).has(a.id)).toBe(true)
  })

  it('excludes nodes that are only downstream of a cycle', () => {
    const a = node('llm')
    const b = node('prompt')
    const victim = node('output')
    const cycles = nodesOnCycles(
      [a, b, victim],
      [edge(a.id, b.id), edge(b.id, a.id), edge(b.id, victim.id)],
    )
    expect(cycles.has(victim.id)).toBe(false)
  })

  it('flags a longer cycle through several nodes', () => {
    const a = node('llm')
    const b = node('prompt')
    const c = node('transform')
    const cycles = nodesOnCycles([a, b, c], [edge(a.id, b.id), edge(b.id, c.id), edge(c.id, a.id)])
    expect(cycles.size).toBe(3)
  })

  it('ignores edges that reference nodes missing from the graph', () => {
    const a = node('llm')
    const cycles = nodesOnCycles([a], [edge(a.id, 'ghost'), edge('ghost', a.id)])
    expect(cycles.size).toBe(0)
  })
})

describe('unwiredInputPorts', () => {
  it('reports the declared input of an unwired node', () => {
    const a = node('llm')
    expect(unwiredInputPorts(a, [])).toEqual(['in'])
  })

  it('treats a bare edge (no targetHandle) as wiring "in"', () => {
    const a = node('start')
    const b = node('llm')
    expect(unwiredInputPorts(b, [edge(a.id, b.id)])).toEqual([])
  })

  it('treats an explicit targetHandle as wiring that port only', () => {
    const a = node('start')
    const b = node('join')
    // join declares `in`; feed it via an explicit handle and it is wired.
    expect(unwiredInputPorts(b, [edge(a.id, b.id, 'in')])).toEqual([])
    // A handle that matches no declared port leaves `in` unwired.
    expect(unwiredInputPorts(b, [edge(a.id, b.id, 'zzz')])).toEqual(['in'])
  })

  it('never flags a node whose type declares no inputs (start)', () => {
    const a = node('start')
    expect(unwiredInputPorts(a, [])).toEqual([])
  })

  it('skips unknown node types — the executor already errors on those at run time', () => {
    const a = node('no-such-type')
    expect(unwiredInputPorts(a, [])).toEqual([])
  })
})

describe('validateGraph', () => {
  it('is clean for a fully wired DAG', () => {
    const a = node('start')
    const b = node('llm')
    const c = node('output')
    const result = validateGraph(graph([a, b, c], [edge(a.id, b.id), edge(b.id, c.id)]))
    expect(result.cycleNodeIds.size).toBe(0)
    expect(result.unwired).toEqual([])
  })

  it('collects unwired nodes with their missing ports', () => {
    const a = node('start')
    const b = node('llm')
    const c = node('output')
    const result = validateGraph(graph([a, b, c], [edge(a.id, b.id)]))
    expect(result.cycleNodeIds.size).toBe(0)
    expect(result.unwired).toEqual([{ nodeId: c.id, portIds: ['in'] }])
  })

  it('does not double-report unwired inputs on nodes already flagged for a cycle', () => {
    const a = node('llm')
    const b = node('prompt')
    // a→b→a forms the cycle; a additionally has its `in` unwired, but the
    // cycle is the finding — one chip per defect, not two on the same node.
    const result = validateGraph(graph([a, b], [edge(a.id, b.id), edge(b.id, a.id)]))
    expect(result.cycleNodeIds.size).toBe(2)
    expect(result.unwired).toEqual([])
  })

  it('flags an unknown-type node that participates in a cycle', () => {
    const a = node('llm')
    const ghost = node('no-such-type')
    const result = validateGraph(graph([a, ghost], [edge(a.id, ghost.id), edge(ghost.id, a.id)]))
    expect(result.cycleNodeIds.has(ghost.id)).toBe(true)
  })
})
