import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BlueprintService } from '../src/index.ts'

export const definition = (id = 'feedback') => ({
  schemaVersion: 2,
  id,
  name: id,
  resources: {},
  graph: { nodes: [{ id: 'input', kind: 'input', outputs: { value: 'string' } }], edges: [] }
})

export async function fixture(t, { emptyConfig = false, workspace = true, approval, preExecute } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bp-feedback-'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(`${root}/profile/`).href
  ctx.provide('systemPrompt', { tools: () => () => {} })
  const tools = new ToolRuntime(ctx, { mode: 'native' })
  if (preExecute) ctx.on('tools/pre-execute', preExecute)
  if (workspace) ctx.provide('workspaceController', { initializeDefault: async () => ({ workspace: { path: join(root, 'workspace') } }) })
  if (approval) ctx.provide('approval', { request: approval })
  await ctx.plugin(BlueprintService, emptyConfig ? {} : { workspaceRoot: join(root, 'workspace') })
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  let call = 0
  const dispatch = (name, args, signal = new AbortController().signal) =>
    tools.execute({
      name,
      arguments: args,
      callId: `feedback-${++call}`,
      signal,
      agent: { ctx, session: { id: 'feedback-session' } }
    })
  return { ctx, tools, root, workflow: join(root, 'workspace', '.xuanling', 'workflows', 'feedback'), dispatch }
}
