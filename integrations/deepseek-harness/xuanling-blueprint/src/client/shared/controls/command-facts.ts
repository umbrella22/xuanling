import type { CommandFacts } from './command-policy.ts'

export interface CommandEditorFacts {
  readonly selection: ReadonlySet<string>
  readonly nodes: readonly { readonly id: string; readonly presentation?: { readonly pinned?: boolean } }[]
  readonly groups: readonly { readonly id: string; readonly nodeIds: readonly string[] }[]
  readonly canUndo: boolean
  readonly canRedo: boolean
}
export interface CommandFactsInput extends Omit<CommandFacts, 'selectedNodes' | 'selectedGroups' | 'movableNodes' | 'canUndo' | 'canRedo'> {
  readonly editor: CommandEditorFacts
  readonly targetGroupId?: string | undefined
}
/** Derive new facts from this invocation's editor and public capability values. */
export function deriveCommandFacts(input: CommandFactsInput): CommandFacts {
  const { editor, targetGroupId, ...capabilities } = input
  const group = targetGroupId === undefined ? undefined : editor.groups.find(item => item.id === targetGroupId)
  const members = group ? group.nodeIds : [...editor.selection]
  return {
    ...capabilities,
    selectedNodes: group ? 0 : editor.selection.size,
    selectedEdges: group ? 0 : input.selectedEdges,
    selectedGroups: group ? 1 : 0,
    movableNodes: members.filter(id => editor.nodes.some(node => node.id === id && !node.presentation?.pinned)).length,
    canUndo: editor.canUndo,
    canRedo: editor.canRedo
  }
}
