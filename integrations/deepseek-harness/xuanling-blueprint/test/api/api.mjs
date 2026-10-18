// N-API suite (W6.1): client-model stream/seq/gap semantics and the canvas
// editor's semantic/layout separation. Scope 'ui' covers these; scope 'host'
// reuses the runtime service checks. Everything runs against built lib
// modules — no React needed for the model layer.
import { join } from 'node:path'

export async function getCases(helpers) {
  const { packageRoot } = helpers
  const scope = helpers.scope ?? 'all'
  const cases = []

  if (scope === 'ui' || scope === 'all') {
    const modelMod = await import(join(packageRoot, 'lib', 'client-model.js'))
    const editorMod = await import(join(packageRoot, 'lib', 'client-editor.js'))

    cases.push({
      id: 'A1',
      title: 'T14: stream applies in-order events and IGNORES duplicates; a gap marks the view stale (no invented state)',
      contract: 'C-14',
      expect: 'pass',
      run: () => {
        const model = new modelMod.BlueprintClientModel()
        model.applySnapshot({ runId: 'r1', state: 'running', seq: 5, definitionRevision: 'rev', attempts: [], logTail: [] })
        const ok = model.applyEvent({ seq: 6, kind: 'state', detail: { state: 'waiting_input' } })
        const dup = model.applyEvent({ seq: 6, kind: 'state', detail: { state: 'succeeded' } })
        const gap = model.applyEvent({ seq: 9, kind: 'state', detail: { state: 'succeeded' } })
        return (
          ok.accepted === true &&
          ok.gap === false &&
          dup.accepted === false &&
          dup.gap === false &&
          gap.accepted === false &&
          gap.gap === true &&
          model.connectionState === 'stale' &&
          model.view.state === 'waiting_input'
        ) // never adopted the un-sequenced state
      }
    })

    cases.push({
      id: 'A2',
      title: 'T14: reconnect resync reads a snapshot and never re-issues a start; disconnect shows stale, not success',
      contract: 'C-14',
      expect: 'pass',
      run: async () => {
        const model = new modelMod.BlueprintClientModel()
        model.applySnapshot({ runId: 'r1', state: 'running', seq: 3, definitionRevision: 'rev', attempts: [], logTail: [] })
        model.markDisconnected()
        const disconnectedStale = model.connectionState === 'stale' && model.view.state === 'running'
        let startCalls = 0
        const snapshot = await model.resync(
          {
            inspectRun: async runId => {
              if (runId !== 'r1') throw new Error('wrong run')
              return {
                runId: 'r1',
                state: 'succeeded',
                seq: 7,
                definitionRevision: 'rev',
                attempts: [{ nodeId: 'n', attemptId: 'a', state: 'succeeded', attempt: 1 }],
                logTail: []
              }
            }
          },
          'r1'
        )
        return disconnectedStale && model.connectionState === 'connected' && snapshot.state === 'succeeded' && model.resyncCount === 1 && startCalls === 0
      }
    })

    cases.push({
      id: 'A3',
      title: 'T13: resource projection distinguishes shared/package/mcp sources and shows unknown as unknown',
      contract: 'C-13',
      expect: 'pass',
      run: () => {
        const views = modelMod.projectResources(
          {
            resources: {
              skill: { kind: 'skill', source: { kind: 'shared', rootId: 'user-agents-skills', path: 'sample' } },
              agent: { kind: 'agent', path: 'lib/agents/a.md' },
              tools: { kind: 'mcp', bindingId: 'repo' }
            }
          },
          { skill: { availability: 'available' } }
        )
        const byId = Object.fromEntries(views.map(v => [v.refId, v]))
        return (
          byId.skill.followsSharedSource === true &&
          byId.skill.availability === 'available' &&
          byId.agent.sourceKind === 'package' &&
          byId.agent.availability === 'unknown' &&
          byId.tools.sourceKind === 'mcp' &&
          byId.tools.sourceLabel === 'binding:repo'
        )
      }
    })

    cases.push({
      id: 'A4',
      title: 'T12: editor keeps semantic edits and layout edits separate; layout export carries no semantics',
      contract: 'C-10',
      expect: 'pass',
      run: () => {
        const editor = new editorMod.GraphEditor()
        const a = editor.addNode({ kind: 'input', label: 'in', x: 0, y: 0, inputs: {}, outputs: { out: 'string' } })
        const b = editor.addNode({ kind: 'agentTask', label: 'work', x: 200, y: 0, inputs: { in: 'string' }, outputs: { out: 'json' } })
        editor.moveNode(a.id, 40, 40)
        editor.commitLayout()
        const layout = editor.exportLayout()
        const layoutKeys = Object.keys(layout)
        const hasSemantics = Object.hasOwn(layout, 'edges') || Object.hasOwn(layout, 'resources')
        return layout.nodes[a.id].x === 40 && !hasSemantics && layoutKeys.includes('nodes') && layoutKeys.includes('groups') && b.kind === 'agentTask'
      }
    })

    cases.push({
      id: 'A5',
      title: 'T12: typed ports refuse type conflicts/self-loops; undo/redo walks edits; grouping works',
      contract: 'C-12',
      expect: 'pass',
      run: () => {
        const editor = new editorMod.GraphEditor()
        const a = editor.addNode({ kind: 'agentTask', label: 'a', x: 0, y: 0, inputs: { in: 'string' }, outputs: { out: 'string' } })
        const b = editor.addNode({ kind: 'agentTask', label: 'b', x: 100, y: 0, inputs: { stringIn: 'string', jsonIn: 'json' }, outputs: { out: 'string' } })
        const snapshot = () =>
          JSON.stringify({
            nodes: editor.nodes,
            edges: editor.edges,
            groups: editor.groups,
            selection: [...editor.selection],
            canUndo: editor.canUndo,
            canRedo: editor.canRedo
          })
        const rejectInvalidPortsWithoutHistoryChange = () => {
          const before = snapshot()
          const spoofed = editor.connect(
            { nodeId: a.id, port: 'out', direction: 'out', type: 'string' },
            { nodeId: b.id, port: 'jsonIn', direction: 'in', type: 'string' }
          )
          const afterSpoofed = snapshot()
          const undeclared = editor.connect(
            { nodeId: a.id, port: 'out', direction: 'out', type: 'string' },
            { nodeId: b.id, port: 'missing', direction: 'in', type: 'string' }
          )
          return (
            spoofed.ok === false &&
            spoofed.reason === 'undeclared-port' &&
            afterSpoofed === before &&
            undeclared.ok === false &&
            undeclared.reason === 'undeclared-port' &&
            snapshot() === before
          )
        }
        const beforeRejected = snapshot()
        const conflict = editor.connect(
          { nodeId: a.id, port: 'out', direction: 'out', type: 'string' },
          { nodeId: b.id, port: 'jsonIn', direction: 'in', type: 'json' }
        )
        const afterConflict = snapshot()
        const self = editor.connect(
          { nodeId: a.id, port: 'out', direction: 'out', type: 'string' },
          { nodeId: a.id, port: 'in', direction: 'in', type: 'string' }
        )
        const afterSelf = snapshot()
        const good = editor.connect(
          { nodeId: a.id, port: 'out', direction: 'out', type: 'string' },
          { nodeId: b.id, port: 'stringIn', direction: 'in', type: 'string' }
        )
        const afterConnect = editor.edges.length
        const connectedGraph = snapshot()
        // Rejections must not add an undo entry for an unchanged graph.
        const rejectedAfterConnect = rejectInvalidPortsWithoutHistoryChange()
        const undone = editor.undo()
        const afterUndo = editor.edges.length
        const redoAvailable = editor.canRedo === true
        // Rejections must also preserve the existing redo branch.
        const rejectedAfterUndo = rejectInvalidPortsWithoutHistoryChange()
        const redone = editor.redo()
        const afterRedo = editor.edges.length
        const restoredConnectedGraph = snapshot() === connectedGraph
        editor.toggleSelect(a.id, false)
        editor.toggleSelect(b.id, true)
        const group = editor.groupSelection('pair')
        return (
          conflict.ok === false &&
          conflict.reason.startsWith('type-conflict') &&
          afterConflict === beforeRejected &&
          self.ok === false &&
          self.reason === 'self-loop' &&
          afterSelf === beforeRejected &&
          good.ok === true &&
          good.edge?.kind === 'data' &&
          good.edge?.from === `${a.id}.out` &&
          good.edge?.to === `${b.id}.stringIn` &&
          afterConnect === 1 &&
          afterUndo === 0 &&
          afterRedo === 1 &&
          rejectedAfterConnect === true &&
          undone === true &&
          redoAvailable === true &&
          rejectedAfterUndo === true &&
          redone === true &&
          restoredConnectedGraph === true &&
          group !== null &&
          group.nodeIds.length === 2 &&
          group.label === 'pair' &&
          group.nodeIds.includes(a.id) &&
          group.nodeIds.includes(b.id)
        )
      }
    })
  }

  if (scope === 'host' || scope === 'all') {
    // Host-scope API checks ride the runtime suite's store-level cases.
    const runtime = await import(join(packageRoot, 'test', 'runtime', 'runtime.mjs'))
    const all = await runtime.getCases(helpers)
    cases.push(...all.filter(c => c.id === 'RT1'))
  }

  if (cases.length === 0) throw new Error(`api: scope "${scope}" has no cases yet`)
  return cases
}
