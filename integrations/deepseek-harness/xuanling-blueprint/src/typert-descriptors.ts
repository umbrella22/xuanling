import { associateDefinitionArgsCodec, associationViewCodec } from './conversation/association-contracts.ts'
/** Shared, browser-safe strict invocation codecs; host and client select the same descriptors. */
import { z } from 'zod'
import { blueprintReferenceArgsCodec, blueprintReferenceViewCodec } from './conversation/blueprint-reference-contracts.ts'
import { nodeMessageArgsCodec, nodeMessageReceiptCodec, nodeSessionArgsCodec, nodeSessionCodec } from './conversation/managed-node-contracts.ts'
import { listBlueprintLibrariesCodec } from './definition/library-ref.ts'
import {
  extractTemplateArgsCodec,
  extractTemplateValueCodec,
  instantiateTemplateArgsCodec,
  instantiateTemplateValueCodec,
  saveTemplateArgsCodec,
  templateCodec,
  templateSummaryCodec
} from './templates/contracts.ts'
import {
  startSessionRunArgsCodec,
  runIdCodec,
  runAdmissionCodec,
  inspectSessionArgsCodec,
  inspectSessionCodec,
  inspectRunViewArgsCodec,
  inspectRunViewCodec,
  runQueryArgsCodec,
  runQueryCodec,
  runLifecycleActionArgsCodec,
  runLifecycleActionCodec,
  resolveRecoveryArgsCodec,
  resolveRecoveryValueCodec,
  runReportCodec,
  runSnapshotCodec,
  startTeamStageArgsCodec,
  cancelTeamStageArgsCodec,
  acceptTeamStageOutputArgsCodec,
  teamStageActionCodec
} from './conversation/contracts.ts'

export const BLUEPRINT_PACKAGE = '@xuanling-rs/xuanling-dsh-blueprint'

const object = z.strictObject
const text = () => z.string()
const id = () => z.string().min(1)
const document = () => object({ blueprintId: id(), definitionJson: text(), documentRevision: id(), semanticRevision: id(), layoutRevision: id() })
/** Optional library/target selectors. Absent keeps the legacy default-library
 * behaviour; present values are logical IDs only. */
const libraryRef = () => z.discriminatedUnion('kind', [object({ kind: z.literal('global') }), object({ kind: z.literal('workspace'), workspaceId: id() })])
const librarySelector = () => ({ library: libraryRef().optional() })
const targetSelector = () => ({ library: libraryRef().optional(), workspaceId: id().optional() })
const resourceCatalogEntry = () =>
  object({
    id: id(),
    kind: z.enum(['agent', 'skill', 'mcp']),
    displayName: text(),
    description: text(),
    source: z.literal('dsh'),
    availability: z.enum(['available', 'unavailable']),
    bindingId: text().optional(),
    provenance: z.enum(['builtin', 'custom', 'unknown'])
  })
const resultSymbols: Record<string, string> = {
  exportDefinition: 'ExportValue',
  importDefinition: 'ImportValue',
  loadDefinition: 'DefinitionDocument',
  createDefinition: 'DefinitionDocument',
  saveDefinition: 'DefinitionDocument',
  restoreDefinitionRevision: 'DefinitionDocument',
  queryRuns: 'RunQueryValue',
  archiveRun: 'RunLifecycleActionValue',
  restoreRun: 'RunLifecycleActionValue',
  startTeamStage: 'TeamStageActionView',
  cancelTeamStage: 'TeamStageActionView',
  acceptTeamStageOutput: 'TeamStageActionView'
}
const symbol = (method: string) => method[0]!.toUpperCase() + method.slice(1)
const invocation = (method: string, args: (() => z.ZodType) | undefined, result: () => z.ZodType) => ({
  id: `${BLUEPRINT_PACKAGE}#blueprint/${method}`,
  service: 'blueprint',
  namespace: 'blueprint',
  method,
  invocation: { kind: 'direct' } as const,
  parameters:
    args === undefined
      ? []
      : [
          {
            name: 'args',
            wire: 'args',
            source: 'json' as const,
            codec: {
              mode: 'strict' as const,
              typeSymbol: `${BLUEPRINT_PACKAGE}/types#${symbol(method)}Args`,
              create: args
            }
          }
        ],
  result: { mode: 'strict' as const, typeSymbol: `${BLUEPRINT_PACKAGE}/types#${resultSymbols[method] ?? `${symbol(method)}Value`}`, create: result }
})

export const BLUEPRINT_INVOCATIONS = [
  invocation('inspectBlueprintReference', blueprintReferenceArgsCodec, blueprintReferenceViewCodec),
  invocation('messageNode', nodeMessageArgsCodec, nodeMessageReceiptCodec),
  invocation('inspectNodeSession', nodeSessionArgsCodec, nodeSessionCodec),
  invocation('ping', undefined, () => object({ status: z.literal('ok'), service: text(), version: text() })),
  invocation(
    'listDefinitions',
    () => object({ ...librarySelector() }).default({}),
    () =>
      object({ definitions: z.array(object({ blueprintId: id(), name: text(), documentRevision: text().nullable(), semanticRevision: text().nullable() })) })
  ),
  invocation('listBlueprintLibraries', () => object({ sessionId: id().optional() }).default({}), listBlueprintLibrariesCodec),
  invocation('associateDefinition', associateDefinitionArgsCodec, associationViewCodec),
  invocation('extractTemplate', extractTemplateArgsCodec, extractTemplateValueCodec),
  invocation('listTemplates', undefined, () => z.array(templateSummaryCodec())),
  invocation('loadTemplate', () => object({ templateId: id() }), templateCodec),
  invocation('saveTemplate', saveTemplateArgsCodec, () => object({ template: templateCodec(), updatedAt: text() })),
  invocation('instantiateTemplate', instantiateTemplateArgsCodec, instantiateTemplateValueCodec),
  invocation(
    'listAgentDocuments',
    () => object({ ...targetSelector(), sessionId: id().optional() }).default({}),
    () =>
      object({
        documents: z.array(
          object({
            documentId: id(),
            name: text(),
            description: text(),
            source: z.enum(['project', 'user']),
            digest: text()
          })
        )
      })
  ),
  invocation(
    'importAgentDocument',
    () => object({ documentId: id(), blueprintId: id(), expectedRevision: id(), ...targetSelector() }),
    () => object({ blueprintId: id(), documentRevision: id(), resourceId: id(), path: text(), digest: text() })
  ),
  invocation(
    'listResources',
    () => object({ ...targetSelector(), sessionId: id().optional() }).default({}),
    () => object({ resources: z.array(resourceCatalogEntry()) })
  ),
  invocation('loadDefinition', () => object({ blueprintId: id(), ...librarySelector() }), document),
  invocation(
    'deleteDefinition',
    () => object({ blueprintId: id(), expectedRevision: id(), requestId: id(), ...librarySelector() }),
    () => object({ blueprintId: id(), deleted: z.literal(true) })
  ),
  invocation('createDefinition', () => object({ requestId: id(), definitionJson: text(), ...librarySelector() }), document),
  invocation(
    'saveDefinition',
    () => object({ blueprintId: id(), definitionJson: text(), expectedRevision: text().nullable(), ...librarySelector() }),
    document
  ),
  invocation(
    'restoreDefinitionRevision',
    () => object({ blueprintId: id(), revision: text().min(1), expectedRevision: text().min(1), ...librarySelector() }),
    document
  ),
  invocation(
    'validate',
    () => object({ definitionJson: text() }),
    () => object({ ok: z.literal(true), semanticRevision: text() })
  ),
  invocation(
    'preflightRun',
    () => object({ blueprintId: id(), expectedRevision: id(), inputJson: text(), ...targetSelector() }),
    () =>
      object({
        blueprintId: id(),
        documentRevision: id(),
        semanticRevision: id(),
        canStart: z.boolean(),
        checks: z.array(
          object({
            code: id(),
            status: z.enum(['block', 'warning', 'info', 'pass']),
            nodeId: id().optional(),
            resourceId: id().optional(),
            toolName: id().optional()
          })
        )
      })
  ),
  invocation(
    'startRun',
    () => object({ blueprintId: id(), expectedRevision: id(), inputJson: text(), requestId: id(), ...targetSelector() }),
    () => object({ runId: runIdCodec(), semanticRevision: text(), state: text(), replayed: z.boolean() })
  ),
  invocation('startSessionRun', startSessionRunArgsCodec, runAdmissionCodec),
  invocation('startTeamStage', startTeamStageArgsCodec, teamStageActionCodec),
  invocation('inspectSession', inspectSessionArgsCodec, inspectSessionCodec),
  invocation('inspectRunView', inspectRunViewArgsCodec, inspectRunViewCodec),
  invocation('queryRuns', runQueryArgsCodec, runQueryCodec),
  invocation('archiveRun', runLifecycleActionArgsCodec, runLifecycleActionCodec),
  invocation('restoreRun', runLifecycleActionArgsCodec, runLifecycleActionCodec),
  invocation('inspectRun', () => object({ runId: runIdCodec(), sessionId: id().optional(), workspaceId: id().optional() }), runSnapshotCodec),
  invocation(
    'cancelRun',
    () => object({ runId: runIdCodec(), workspaceId: id().optional(), sessionId: id().optional() }),
    () => object({ runId: runIdCodec(), state: text() })
  ),
  invocation('resolveRecovery', resolveRecoveryArgsCodec, resolveRecoveryValueCodec),
  invocation('cancelTeamStage', cancelTeamStageArgsCodec, teamStageActionCodec),
  invocation('acceptTeamStageOutput', acceptTeamStageOutputArgsCodec, teamStageActionCodec),
  invocation(
    'decide',
    () => object({ runId: runIdCodec(), workspaceId: id().optional(), sessionId: id().optional(), decisionId: id(), action: z.enum(['approve', 'reject']) }),
    () => object({ runId: runIdCodec(), decisionId: id(), state: text(), applied: z.boolean() })
  ),
  invocation(
    'exportDefinition',
    () => object({ blueprintId: id(), ...librarySelector() }),
    () =>
      object({ blueprintId: id(), closureDigest: text(), files: z.number(), archiveSha256: text(), archiveBase64: text(), requiredBindings: z.array(text()) })
  ),
  invocation(
    'importDefinition',
    () => object({ blueprintId: id(), archiveBase64: id(), ...librarySelector() }),
    () => object({ blueprintId: id(), filesWritten: z.number(), closureDigest: text() })
  ),
  invocation('workflowList', undefined, () => z.unknown()),
  invocation(
    'workflowGet',
    () => object({ workflowId: id(), ...librarySelector() }),
    () => z.unknown()
  ),
  invocation(
    'workflowValidate',
    () => object({ workflowId: id(), definitionJson: text(), ...librarySelector() }),
    () => z.unknown()
  ),
  invocation(
    'workflowPropose',
    () =>
      object({
        workflowId: id(),
        definitionJson: text(),
        expectedRevision: text().nullable().optional(),
        origin: z.enum(['canvas', 'conversation', 'import']).optional(),
        message: text().optional(),
        ...librarySelector()
      }),
    () => z.unknown()
  ),
  invocation(
    'workflowApply',
    () =>
      object({
        workflowId: id(),
        definitionJson: text(),
        expectedRevision: id(),
        origin: z.enum(['canvas', 'conversation', 'import']).optional(),
        message: text().optional(),
        ...librarySelector()
      }),
    () => z.unknown()
  ),
  invocation(
    'workflowRevisions',
    () => object({ workflowId: id(), ...librarySelector() }),
    () => z.unknown()
  ),
  invocation(
    'workflowRevert',
    () => object({ workflowId: id(), revision: id(), expectedRevision: id(), message: text().optional(), ...librarySelector() }),
    () => z.unknown()
  ),
  invocation(
    'workflowRun',
    () => object({ blueprintId: id(), expectedRevision: id(), inputJson: text(), requestId: id(), ...targetSelector() }),
    () => z.unknown()
  ),
  invocation(
    'workflowInspect',
    () => object({ runId: runIdCodec(), sessionId: id().optional(), workspaceId: id().optional() }),
    () => z.unknown()
  ),
  invocation('workflowReport', () => object({ runId: runIdCodec(), sessionId: id().optional(), workspaceId: id().optional() }), runReportCodec)
]
