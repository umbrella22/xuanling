/** Builtin palette metadata; translated display values are never node definitions. */
import { nodeDisplayCapabilities } from './node-capabilities.ts'
import type { NodeKind } from '../../../../../definition/types.ts'
import type { ViewMessageKey, ViewTranslator } from '../../../../shared/contracts/view-contract.ts'

export type BuiltinNodeKind = NodeKind
export interface BuiltinNodeMetadata {
  readonly kind: BuiltinNodeKind
  readonly titleKey: Extract<ViewMessageKey, `node.${BuiltinNodeKind}.title`>
  readonly descriptionKey: Extract<ViewMessageKey, `node.${BuiltinNodeKind}.description`>
  /** Search-only bilingual aliases. Not user content or persisted identity. */
  readonly searchTerms: readonly string[]
}
export const BUILTIN_NODE_CATALOG = [
  { kind: 'input', titleKey: 'node.input.title', descriptionKey: 'node.input.description', searchTerms: ['Input', '输入', '入口'] },
  { kind: 'agentTask', titleKey: 'node.agentTask.title', descriptionKey: 'node.agentTask.description', searchTerms: ['Agent task', '代理任务', '智能体任务'] },
  {
    kind: 'blueprintCall',
    titleKey: 'node.blueprintCall.title',
    descriptionKey: 'node.blueprintCall.description',
    searchTerms: ['Call blueprint', '子蓝图', '调用蓝图', '工作流']
  },
  {
    kind: 'humanDecision',
    titleKey: 'node.humanDecision.title',
    descriptionKey: 'node.humanDecision.description',
    searchTerms: ['Approval', 'Human decision', '审批', '人工决策', '人工确认']
  },
  { kind: 'condition', titleKey: 'node.condition.title', descriptionKey: 'node.condition.description', searchTerms: ['Condition', '条件', '布尔分支'] },
  { kind: 'join', titleKey: 'node.join.title', descriptionKey: 'node.join.description', searchTerms: ['Join all', '汇合', '合流'] },
  { kind: 'output', titleKey: 'node.output.title', descriptionKey: 'node.output.description', searchTerms: ['Output', '输出', '结果'] }
] as const satisfies readonly BuiltinNodeMetadata[]

export function builtinNodeMetadata(kind: string): BuiltinNodeMetadata | undefined {
  return BUILTIN_NODE_CATALOG.find(node => node.kind === kind)
}
export function searchBuiltinNodes(query: string, translate?: ViewTranslator): readonly BuiltinNodeMetadata[] {
  // Case folding/whitespace affect only the search query; never IDs, refs or ports.
  const needle = query.trim().toLowerCase()
  return BUILTIN_NODE_CATALOG.filter(
    node =>
      nodeDisplayCapabilities(node).palette &&
      [node.kind, ...node.searchTerms, ...(translate ? [translate(node.titleKey), translate(node.descriptionKey)] : [])].some(term =>
        term.toLowerCase().includes(needle)
      )
  )
}
export function nodeKindTitle(kind: string, translate: ViewTranslator): string {
  const metadata = builtinNodeMetadata(kind)
  return metadata ? translate(metadata.titleKey) : kind
}
/** Absence of definition.name is the only signal for a generated display title. */
export function nodeDisplayTitle(node: { kind: string; name?: string }, index: number, translate: ViewTranslator): string {
  if (node.name !== undefined) return node.name
  return translate('node.defaultTitle', { title: nodeKindTitle(node.kind, translate), index: index + 1 })
}
export const resourceAvailabilityNotice = { key: 'resource.availabilityUnchecked' } as const
