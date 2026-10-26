/**
 * Canvas-level graph validation.
 *
 * Two defects the executor cannot report on its own:
 * - a cycle never becomes ready. The scheduler keeps waiting, gives up, marks
 *   those nodes `skipped`, and the run ends `done` — silent success over a
 *   graph that could not execute. Nodes on the cycle (and everything
 *   downstream of it) simply never ran.
 * - a node whose declared input port has no incoming edge runs immediately
 *   with an empty input, which is legal (templates can live on {{run.*}}) but
 *   is almost always a forgotten wire.
 *
 * Both are warnings about the graph, not the run: the canvas shows them before
 * the operator presses Run.
 */

import { getNodeDef } from './registry'
import type { FlowEdge, FlowGraph, FlowNode } from './types'

export interface UnwiredInput {
  nodeId: string
  /** Declared input port ids with no incoming edge. */
  portIds: string[]
}

export interface GraphValidation {
  /** Every node that sits on a directed cycle (self-loops included). */
  cycleNodeIds: Set<string>
  /** Nodes with at least one declared-but-unwired input port. */
  unwired: UnwiredInput[]
}

/**
 * Nodes on a directed cycle, via strongly connected components.
 *
 * SCC is the right unit, not "back edges": the operator must break the loop
 * itself, and every node of an SCC of size >= 2 is loop-forming. Nodes only
 * downstream of a cycle are its victims, not its cause, so they are excluded.
 */
export function nodesOnCycles(nodes: FlowNode[], edges: FlowEdge[]): Set<string> {
  const ids = new Set(nodes.map((n) => n.id))
  const adjacency = new Map<string, string[]>()
  const selfLoops = new Set<string>()
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    if (e.source === e.target) {
      selfLoops.add(e.source)
      continue
    }
    const list = adjacency.get(e.source)
    if (list) list.push(e.target)
    else adjacency.set(e.source, [e.target])
  }

  // Iterative Tarjan: graphs are small, but an explicit stack keeps a
  // pathological hand-built canvas from blowing the JS recursion limit.
  const onCycle = new Set<string>()
  let index = 0
  const indices = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []

  for (const root of ids) {
    if (indices.has(root)) continue
    // Each frame: [node, next-unvisited-child-index, children]
    const frames: [string, number, string[]][] = [[root, 0, adjacency.get(root) || []]]
    indices.set(root, index)
    lowlink.set(root, index)
    index += 1
    stack.push(root)
    onStack.add(root)

    while (frames.length) {
      const frame = frames[frames.length - 1]
      const [node, childIndex, children] = frame
      if (childIndex < children.length) {
        frame[1] += 1
        const child = children[childIndex]
        if (!indices.has(child)) {
          indices.set(child, index)
          lowlink.set(child, index)
          index += 1
          stack.push(child)
          onStack.add(child)
          frames.push([child, 0, adjacency.get(child) || []])
        } else if (onStack.has(child)) {
          lowlink.set(node, Math.min(lowlink.get(node)!, indices.get(child)!))
        }
      } else {
        frames.pop()
        if (frames.length) {
          const parent = frames[frames.length - 1][0]
          lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(node)!))
        }
        if (lowlink.get(node) === indices.get(node)) {
          const component: string[] = []
          let member: string
          do {
            member = stack.pop()!
            onStack.delete(member)
            component.push(member)
          } while (member !== node)
          if (component.length >= 2) component.forEach((id) => onCycle.add(id))
        }
      }
    }
  }

  for (const id of selfLoops) onCycle.add(id)
  return onCycle
}

/** Declared input ports of `node` that no edge feeds. */
export function unwiredInputPorts(node: FlowNode, edges: FlowEdge[]): string[] {
  const def = getNodeDef(node.type)
  if (!def || def.inputs.length === 0) return []
  const wired = new Set(
    edges.filter((e) => e.target === node.id).map((e) => e.targetHandle || 'in'),
  )
  return def.inputs.map((p) => p.id).filter((id) => !wired.has(id))
}

export function validateGraph(graph: FlowGraph): GraphValidation {
  const cycleNodeIds = nodesOnCycles(graph.nodes, graph.edges)
  const unwired: UnwiredInput[] = []
  for (const node of graph.nodes) {
    if (cycleNodeIds.has(node.id)) continue // the cycle is the finding; piling "unwired" on top is noise
    const portIds = unwiredInputPorts(node, graph.edges)
    if (portIds.length) unwired.push({ nodeId: node.id, portIds })
  }
  return { cycleNodeIds, unwired }
}
