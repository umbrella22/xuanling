/** Shared, browser-safe strict invocation codecs; host and client select the same descriptors. */
import { z } from 'zod'
import {
  startSessionRunArgsCodec,
  runAdmissionCodec,
  inspectSessionArgsCodec,
  inspectSessionCodec,
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
  hostProbe: 'HostProbeEvidence',
  mcpProbe: 'McpProbeEvidence',
  exportDefinition: 'ExportValue',
  importDefinition: 'ImportValue',
  loadDefinition: 'DefinitionDocument',
  createDefinition: 'DefinitionDocument',
  saveDefinition: 'DefinitionDocument',
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
  invocation('ping', undefined, () => object({ status: z.literal('ok'), service: text(), version: text() })),
  invocation('listDefinitions', undefined, () =>
    object({ definitions: z.array(object({ blueprintId: id(), name: text(), documentRevision: text().nullable(), semanticRevision: text().nullable() })) })
  ),
  invocation('listResources', undefined, () => object({ resources: z.array(resourceCatalogEntry()) })),
  invocation('loadDefinition', () => object({ blueprintId: id() }), document),
  invocation(
    'deleteDefinition',
    () => object({ blueprintId: id(), expectedRevision: id(), requestId: id() }),
    () => object({ blueprintId: id(), deleted: z.literal(true) })
  ),
  invocation('createDefinition', () => object({ requestId: id(), definitionJson: text() }), document),
  invocation('saveDefinition', () => object({ blueprintId: id(), definitionJson: text(), expectedRevision: text().nullable() }), document),
  invocation(
    'validate',
    () => object({ definitionJson: text() }),
    () => object({ ok: z.literal(true), semanticRevision: text() })
  ),
  invocation(
    'preflightRun',
    () => object({ blueprintId: id(), expectedRevision: id(), inputJson: text() }),
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
    () => object({ blueprintId: id(), expectedRevision: id(), inputJson: text(), requestId: id() }),
    () => object({ runId: id(), semanticRevision: text(), state: text(), replayed: z.boolean() })
  ),
  invocation('startSessionRun', startSessionRunArgsCodec, runAdmissionCodec),
  invocation('startTeamStage', startTeamStageArgsCodec, teamStageActionCodec),
  invocation('inspectSession', inspectSessionArgsCodec, inspectSessionCodec),
  invocation('inspectRun', () => object({ runId: id() }), runSnapshotCodec),
  invocation(
    'cancelRun',
    () => object({ runId: id() }),
    () => object({ runId: id(), state: text() })
  ),
  invocation('cancelTeamStage', cancelTeamStageArgsCodec, teamStageActionCodec),
  invocation('acceptTeamStageOutput', acceptTeamStageOutputArgsCodec, teamStageActionCodec),
  invocation(
    'decide',
    () => object({ runId: id(), decisionId: id(), action: z.enum(['approve', 'reject']) }),
    () => object({ runId: id(), decisionId: id(), state: text(), applied: z.boolean() })
  ),
  invocation(
    'hostProbe',
    () => object({ blueprintId: id(), resourceId: id(), input: text() }),
    () =>
      object({
        sessionId: text(),
        agentCreated: z.boolean(),
        scopedInjections: z.array(text()),
        inboxSplicedSeen: z.boolean(),
        outcome: z.union([
          object({ ok: z.literal(true), kind: z.literal('succeeded'), detail: text() }),
          object({ ok: z.literal(false), kind: z.enum(['provider-failed', 'failed', 'timeout']), detail: text() })
        ])
      })
  ),
  invocation(
    'mcpProbe',
    () => object({ serverName: text(), toolName: text(), args: z.record(z.string(), z.unknown()) }),
    () => object({ available: z.boolean(), dispatched: z.boolean(), isError: z.boolean(), text: text(), detail: text().optional() })
  ),
  invocation(
    'exportDefinition',
    () => object({ blueprintId: id() }),
    () =>
      object({ blueprintId: id(), closureDigest: text(), files: z.number(), archiveSha256: text(), archiveBase64: text(), requiredBindings: z.array(text()) })
  ),
  invocation(
    'importDefinition',
    () => object({ blueprintId: id(), archiveBase64: id() }),
    () => object({ blueprintId: id(), filesWritten: z.number(), closureDigest: text() })
  )
]
