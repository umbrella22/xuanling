/** Hand-written host descriptor. Public DTOs contain logical IDs, never machine locators. */
import { BLUEPRINT_PACKAGE, BLUEPRINT_INVOCATIONS } from './typert-descriptors.ts'

export const TYPERT = {
  package: BLUEPRINT_PACKAGE, face: 'host' as const, schemas: [],
  invocations: BLUEPRINT_INVOCATIONS,
  model: { services: [], events: [], objects: [] },
}
