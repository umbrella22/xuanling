/**
 * Scheduling pure logic (C-07/§8.2): from a validated definition and the run
 * snapshot, compute which nodes are ready / skipped / blocked. Pure JSON
 * in-out, no I/O, no clocks (budgets arrive as parameters) — the coordinator
 * persists decisions, this module only computes them. Only actually selected
 * paths execute; join policies are explicit; `partial_success` does not
 * exist (§8.2).
 */
import type { BlueprintDefinition, GraphNode } from '../definition/types.ts'
import { TERMINAL_RUN_STATES, type AttemptState } from '../persistence/records.ts'

export interface NodeView {
  nodeId: string
  /** Terminal per-attempt states observed for this node ('skipped' means control-unselected). */
  states: AttemptState[]
}

export interface RunSnapshot {
  attempts: NodeView[]
  /** Condition decisions keyed by condition nodeId → selected branch id. */
  decisions: Record<string, string>
}

export interface ScheduleResult {
  ready: string[]
  skipped: string[]
  blocked: string[]
  /** Join nodes with a decided-but-unmet policy stay blocked, never waited forever: listed for diagnostics. */
  joinsPending: string[]
}

export class BudgetExceededError extends Error {
  override readonly name = 'BudgetExceededError'
  readonly code = 'BUDGET_EXCEEDED'
  readonly nodeId: string
  constructor(nodeId: string, detail: string) {
    super(`budget exceeded at "${nodeId}": ${detail}`)
    this.nodeId = nodeId
  }
}

function latestState(node: NodeView | undefined): AttemptState | undefined {
  if (node === undefined || node.states.length === 0) return undefined
  return node.states[node.states.length - 1]
}

function isTerminalSuccess(state: AttemptState | undefined): boolean {
  return state === 'succeeded'
}

function isTerminal(state: AttemptState | undefined): boolean {
  return state !== undefined && (TERMINAL_RUN_STATES.includes(state as never) || ['succeeded', 'failed', 'cancelled', 'timed_out', 'skipped'].includes(state))
}

export function compileGraph(definition: BlueprintDefinition): {
  nodeById: Map<string, GraphNode>
  dataDeps: Map<string, Array<{ fromNode: string; fromPort: string; toPort: string }>>
  controlParents: Map<string, Array<{ fromNode: string; branch?: string }>>
} {
  const nodeById = new Map(definition.graph.nodes.map(n => [n.id, n]))
  const dataDeps = new Map<string, Array<{ fromNode: string; fromPort: string; toPort: string }>>()
  const controlParents = new Map<string, Array<{ fromNode: string; branch?: string }>>()
  for (const edge of definition.graph.edges) {
    if (edge.kind === 'data') {
      const dot = edge.from.indexOf('.')
      const toDot = edge.to.indexOf('.')
      const fromNode = edge.from.slice(0, dot)
      const toNode = edge.to.slice(0, toDot)
      dataDeps.set(toNode, [...(dataDeps.get(toNode) ?? []), { fromNode, fromPort: edge.from.slice(dot + 1), toPort: edge.to.slice(toDot + 1) }])
    } else {
      const [fromNode, branch] = edge.from.split('@')
      const toNode = edge.to.split('@')[0]!
      const parent = branch === undefined ? { fromNode: fromNode! } : { fromNode: fromNode!, branch }
      controlParents.set(toNode, [...(controlParents.get(toNode) ?? []), parent])
    }
  }
  return { nodeById, dataDeps, controlParents }
}

/** Compute the next schedule view. A node is READY when every data parent
 * succeeded, every control parent resolved in its favor (conditions decide;
 * join policies 'all'/'any' evaluated over selected paths only), and it has
 * no live attempt. Skipped propagates along unselected paths. */
export function readyNodes(definition: BlueprintDefinition, snapshot: RunSnapshot): ScheduleResult {
  const { nodeById, dataDeps, controlParents } = compileGraph(definition)
  const byNode = new Map(snapshot.attempts.map(a => [a.nodeId, a]))
  const result: ScheduleResult = { ready: [], skipped: [], blocked: [], joinsPending: [] }

  const stateOf = (nodeId: string): AttemptState | undefined => latestState(byNode.get(nodeId))
  const mark = (nodeId: string, bucket: 'ready' | 'skipped' | 'blocked'): void => {
    ;(bucket === 'ready' ? result.ready : bucket === 'skipped' ? result.skipped : result.blocked).push(nodeId)
  }

  for (const node of definition.graph.nodes) {
    const live = byNode.get(node.id)
    const state = latestState(live)
    if (state !== undefined && !isTerminal(state)) {
      mark(node.id, 'blocked') // already dispatched / waiting
      continue
    }
    if (isTerminal(state)) continue

    // A normal node is gated by every control edge. A join instead merges
    // selected control AND data parents: an unselected control path must not
    // suppress the successful sibling, nor make its absent data mandatory.
    let skippedByControl = false
    let blockedByControl = false
    const controlStates: Array<AttemptState | undefined> = []
    for (const parent of controlParents.get(node.id) ?? []) {
      const parentState = stateOf(parent.fromNode)
      if (parentState === 'skipped') {
        skippedByControl = true
        continue
      }
      if (!isTerminal(parentState)) {
        blockedByControl = true
        controlStates.push(parentState)
        continue
      }
      const parentNode = nodeById.get(parent.fromNode)
      if (parentState === 'succeeded' && (parentNode?.kind === 'condition' || parentNode?.kind === 'humanDecision') && parent.branch !== undefined) {
        const selected = snapshot.decisions[parent.fromNode]
        if (selected === undefined) {
          blockedByControl = true
          controlStates.push(undefined)
          continue
        }
        if (selected !== parent.branch) {
          skippedByControl = true
          continue
        }
      }
      controlStates.push(parentState)
      if (!isTerminalSuccess(parentState)) blockedByControl = true
    }

    const deps = dataDeps.get(node.id) ?? []
    const states = deps.map(d => stateOf(d.fromNode))
    if (node.kind === 'join') {
      const selected = [...controlStates, ...states.filter(s => s !== 'skipped')]
      const succeededCount = selected.filter(isTerminalSuccess).length
      const anyPending = selected.some(s => !isTerminal(s))
      // Preserve the readable scheduler vocabulary for future join-any, but
      // admission/dispatch still refuse it. Only all/default-all executes.
      if (node.join === 'any') {
        if (succeededCount >= 1) mark(node.id, 'ready')
        else if (anyPending) {
          mark(node.id, 'blocked')
          result.joinsPending.push(node.id)
        } else mark(node.id, 'skipped')
      } else {
        if (selected.length > 0 && succeededCount === selected.length) mark(node.id, 'ready')
        else if (anyPending) {
          mark(node.id, 'blocked')
          result.joinsPending.push(node.id)
        } else mark(node.id, 'skipped') // selected failures are settled by the driver
      }
      continue
    }
    if (skippedByControl || states.includes('skipped')) {
      mark(node.id, 'skipped')
      continue
    }
    if (blockedByControl) {
      mark(node.id, 'blocked')
      continue
    }
    if (states.every(isTerminalSuccess)) mark(node.id, 'ready')
    else mark(node.id, 'blocked') // upstream failure is settled by the driver
  }
  return result
}

/** Iteration budget check (C-07): explicit bounds only. */
export function checkBudget(nodeId: string, budget: { maxIterations: number; maxDurationMs: number }, used: { iterations: number; elapsedMs: number }): void {
  if (used.iterations > budget.maxIterations) {
    throw new BudgetExceededError(nodeId, `iterations ${used.iterations} > max ${budget.maxIterations}`)
  }
  if (used.elapsedMs > budget.maxDurationMs) {
    throw new BudgetExceededError(nodeId, `elapsed ${used.elapsedMs}ms > max ${budget.maxDurationMs}ms`)
  }
}
