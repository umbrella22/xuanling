/** Definition module barrel: codec, validator, revisions, persistence. */
export { decodeDefinition, idPattern, pathPattern } from './codec.ts'
export { validateDefinition } from './validator.ts'
export { computeRevision, semanticProjection, type DefinitionRevision } from './revision.ts'
export { loadDefinition, readStoredRevision, saveDefinition, type SaveOptions, type SaveResult } from './persist.ts'
export {
  DefinitionInvalidError,
  IoWriteFailedError,
  RevisionConflictError,
  SCHEMA_VERSION,
  type BlueprintDefinition,
  type GraphEdge,
  type GraphNode,
  type Presentation,
  type ResourceRef,
  type ValidationIssue,
  type ValidationIssueCode,
} from './types.ts'
