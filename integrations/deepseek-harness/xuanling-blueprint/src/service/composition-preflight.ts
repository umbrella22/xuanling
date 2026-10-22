import type { Context } from '@deepseek-ai/cordis'
import { decodeDefinition } from '../definition/codec.ts'
import { BlueprintCompositionError, resolveBlueprintClosure } from '../definition/composition.ts'
import type { DefinitionPackage } from '../definition/persist.ts'
import type { BlueprintReference } from '../definition/types.ts'
import { collectPreflight } from '../host/preflight.ts'
import { packagedReferenceLoader } from '../portability/packaged-reference.ts'

export async function collectCompositionPreflight(
  ctx: Context,
  snapshot: DefinitionPackage,
  load: (ref: BlueprintReference) => DefinitionPackage,
  options: Parameters<typeof collectPreflight>[3]
) {
  const definition = decodeDefinition(snapshot.document.definitionJson)
  const report = await collectPreflight(ctx, snapshot, definition, options)
  let closure = new Map<string, DefinitionPackage>()
  try {
    closure = resolveBlueprintClosure(definition, packagedReferenceLoader(snapshot, load))
    const { input: _input, ...childOptions } = options
    for (const child of closure.values()) {
      const result = await collectPreflight(ctx, child, decodeDefinition(child.document.definitionJson), childOptions)
      report.checks.push(...result.checks.map(check => ({ ...check, nodeId: `${child.document.blueprintId}/${check.nodeId ?? ''}` })))
    }
  } catch (error) {
    report.checks.push({
      code: error instanceof BlueprintCompositionError ? error.code : 'blueprint-revision-unavailable',
      status: 'block',
      ...(error instanceof BlueprintCompositionError && error.nodeId ? { nodeId: error.nodeId } : {})
    })
  }
  report.canStart = !report.checks.some(check => check.status === 'block')
  return { report, closure }
}
