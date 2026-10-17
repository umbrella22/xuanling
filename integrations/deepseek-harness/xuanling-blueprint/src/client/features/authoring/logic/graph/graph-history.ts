import type { GraphEditorState, HistoryEntry } from './graph-types.ts'
import { EditorCommandError } from './graph-commands.ts'

export const HISTORY_CAP = 100

export function snapshotGraph(state: Pick<GraphEditorState, 'definition' | 'nodes' | 'edges' | 'groups' | 'selection'>): HistoryEntry {
  return {
    ...(state.definition ? { definition: structuredClone(state.definition) } : {}),
    nodes: state.nodes.map(node => ({ ...structuredClone(node), inputs: { ...node.inputs }, outputs: { ...node.outputs } })),
    edges: structuredClone(state.edges),
    groups: state.groups.map(group => ({ ...group, nodeIds: [...group.nodeIds] })),
    selection: [...state.selection]
  }
}

export function restoreGraph(state: Pick<GraphEditorState, 'definition' | 'nodes' | 'edges' | 'groups' | 'selection'>, entry: HistoryEntry): void {
  state.definition = entry.definition
  state.nodes = entry.nodes
  state.edges = entry.edges
  state.groups = entry.groups
  state.selection = new Set(entry.selection)
}

export function pushHistory(state: GraphEditorState): void {
  if (state.transactionDepth) return
  state.undoStack.push(state.layoutBefore ?? snapshotGraph(state))
  state.layoutBefore = undefined
  if (state.undoStack.length > HISTORY_CAP) state.undoStack.shift()
  state.redoStack = []
}

export function commitTransaction(state: GraphEditorState, before: HistoryEntry, pending: HistoryEntry | undefined, after: HistoryEntry): void {
  const historyBefore = pending ?? before
  const { selection: _oldSelection, ...oldState } = historyBefore
  state.layoutBefore = undefined
  const { selection: _newSelection, ...newState } = after
  if (JSON.stringify(oldState) !== JSON.stringify(newState)) {
    state.undoStack.push(historyBefore)
    if (state.undoStack.length > HISTORY_CAP) state.undoStack.shift()
    state.redoStack = []
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) state.emit()
}

export function undoGraph(state: GraphEditorState): boolean {
  if (state.transactionDepth) throw new EditorCommandError('transaction-history')
  if (state.layoutBefore) throw new EditorCommandError('layout-pending')
  const previous = state.undoStack.pop()
  if (previous === undefined) return false
  state.redoStack.push(snapshotGraph(state))
  restoreGraph(state, previous)
  state.selection.clear()
  state.emit()
  return true
}

export function redoGraph(state: GraphEditorState): boolean {
  if (state.transactionDepth) throw new EditorCommandError('transaction-history')
  if (state.layoutBefore) throw new EditorCommandError('layout-pending')
  const next = state.redoStack.pop()
  if (next === undefined) return false
  state.undoStack.push(snapshotGraph(state))
  restoreGraph(state, next)
  state.selection.clear()
  state.emit()
  return true
}
