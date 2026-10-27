/**
 * Shared fixtures for the workspace-library contract tests.
 *
 * These fixtures only use public DSH/Cordis seams: a Workspace registry, an
 * optional workspace controller, a skills provider and the Blueprint service.
 * They never read the real user profile.
 */
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BlueprintService } from '../../src/index.ts'

export const minimalDefinition = (id = 'bp-ready', name = id) => ({
  schemaVersion: 2,
  id,
  name,
  resources: {},
  graph: { nodes: [{ id: 'input', kind: 'input', outputs: { value: 'string' } }], edges: [] }
})

export function writeDefinition(root, blueprintId, definition = minimalDefinition(blueprintId)) {
  const documentDir = join(root, blueprintId)
  mkdirSync(documentDir, { recursive: true })
  writeFileSync(join(documentDir, 'blueprint.json'), JSON.stringify(definition))
  return documentDir
}

/**
 * Build a profile with a global library and several registered workspaces.
 * Default mirrors the confirmed F-01 state: several workspaces, no default.
 */
export async function libraryFixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bp-library-context-'))
  const profile = join(root, 'profile')
  const globalLibraryRoot = join(profile, 'data', 'xuanling-blueprint', 'library-v2')
  mkdirSync(profile, { recursive: true })
  const workspaces = options.workspaces ?? [
    { id: 'ws-ready', title: 'Alpha Docs', assets: ['bp-ready'] },
    { id: 'ws-empty', title: 'Beta Empty', emptyWorkflows: true },
    { id: 'ws-absent', title: 'Gamma Absent', absent: true }
  ]
  const paths = new Map()
  for (const workspace of workspaces) {
    const workspacePath = join(root, workspace.id)
    paths.set(workspace.id, workspacePath)
    if (workspace.absent) continue
    const workflowRoot = join(workspacePath, '.xuanling', 'workflows')
    mkdirSync(workflowRoot, { recursive: true })
    if (workspace.emptyWorkflows) continue
    for (const asset of workspace.assets ?? []) writeDefinition(workflowRoot, asset)
    if (workspace.corrupt) {
      mkdirSync(join(workflowRoot, 'bp-broken'), { recursive: true })
      writeFileSync(join(workflowRoot, 'bp-broken', 'blueprint.json'), '{not json')
    }
  }
  for (const asset of options.globalAssets ?? []) writeDefinition(globalLibraryRoot, asset)

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(`${profile}/`).href
  ctx.provide('systemPrompt', { tools: () => () => {} })
  const tools = new ToolRuntime(ctx, { mode: 'native' })
  ctx.provide('workspaceRegistry', {
    list: () => workspaces.map(workspace => ({ id: workspace.id, path: paths.get(workspace.id), title: workspace.title, sessionIds: [] }))
  })
  if (options.noDefaultWorkspace !== false) {
    ctx.provide('workspaceController', { initializeDefault: async () => undefined })
  }
  options.provide?.(ctx, { root, workspacePath: id => paths.get(id) })

  const config = {
    globalLibraryRoot,
    ...(options.configureWorkspace === undefined || options.configureWorkspace === false ? {} : { workspaceRoot: paths.get(workspaces[0].id) })
  }
  await ctx.plugin(BlueprintService, config)
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  let call = 0
  const dispatch = (name, args, sessionId = 'fixture-session', signal = new AbortController().signal) =>
    tools.execute({
      name,
      arguments: args,
      callId: `library-${++call}`,
      signal,
      agent: { ctx, session: { id: sessionId } }
    })

  return {
    ctx,
    service: ctx.blueprint,
    tools,
    dispatch,
    root,
    profile,
    globalLibraryRoot,
    workspaces,
    workspacePath: id => paths.get(id)
  }
}
