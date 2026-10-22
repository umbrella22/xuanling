// Mounted production panel with synthetic Host DTOs and isolated local browser storage.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { createBlueprintPanel } from '../../src/client/features/authoring/ui/panel/panel-composition.tsx'
import { installCanvasStyles } from '../../src/client/shared/styles/styles.ts'
import { en } from '../../src/client/shared/i18n/locales.ts'
const definition = (id: string) => ({
  schemaVersion: 2 as const,
  id,
  name: `Fixture ${id}`,
  resources: {
    tools: { kind: 'mcp' as const, bindingId: 'fixture' },
    agent: { kind: 'agent' as const, path: 'agents/test.md' },
    skill: { kind: 'skill' as const, path: 'skills/test/SKILL.md' },
    prompt: { kind: 'prompt' as const, path: 'prompts/test.md' }
  },
  graph: { nodes: [{ id: 'source', kind: 'input' as const, outputs: { value: 'string' as const } }], edges: [] },
  presentation: {
    nodes: { source: { x: 100, y: 100 } },
    resources: { tools: { title: 'Review tools', description: 'Full synthetic description for retained resource tooltip.' } }
  }
})
const documents = ['alpha', 'beta'].map(id => ({
  blueprintId: id,
  definitionJson: JSON.stringify(definition(id)),
  documentRevision: `doc-${id}`,
  semanticRevision: `sem-${id}`,
  layoutRevision: `layout-${id}`
}))
const calls: string[] = []
const host = {
  async listDefinitions() {
    return {
      definitions: documents.map(({ blueprintId, documentRevision, semanticRevision }) => ({
        blueprintId,
        name: `Fixture ${blueprintId}`,
        documentRevision,
        semanticRevision
      }))
    }
  },
  async loadDefinition(id: string) {
    calls.push(`load:${id}`)
    return structuredClone(documents.find(doc => doc.blueprintId === id)!)
  },
  async validate() {
    return { ok: true as const, semanticRevision: 'synthetic' }
  },
  async listResources() {
    return { resources: [] }
  }
}
const Panel = createBlueprintPanel({ hostLink: host, storage: localStorage })
const t = (key: keyof typeof en, params: Record<string, unknown> = {}) => en[key].replace(/\{([^}]+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
Object.assign(window, { fixtureCalls: calls })
installCanvasStyles()
document.body.style.margin = '0'
createRoot(document.getElementById('root')!).render(React.createElement('div', { style: { height: '100vh' } }, React.createElement(Panel, { t })))
