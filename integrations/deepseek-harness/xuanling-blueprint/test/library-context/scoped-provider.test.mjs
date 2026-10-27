/** Real DSH scope and filesystem Skill provider; no model or user profile. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { BlueprintService } from '../../src/index.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
const load = async pkg => {
  const entry = readdirSync('node_modules/.pnpm').find(x => x.startsWith(`@deepseek-ai+${pkg}@0.2.1-rc.2_`))
  assert.ok(entry, `real installed dependency required: ${pkg}`)
  return import(pathToFileURL(resolve('node_modules/.pnpm', entry, 'node_modules/@deepseek-ai', pkg, 'lib/index.js')).href)
}

test('review: conversation tools and standalone preset reads see the real scoped global Skill provider', async () => {
  const { SkillRegistry } = await load('dsh-skill')
  const filesystem = await load('dsh-skill-filesystem')
  const root = mkdtempSync(join(tmpdir(), 'bp-scoped-skill-'))
  const ctx = new Context()
  let scope,
    acquisitions = 0,
    disposals = 0
  try {
    const project = join(root, 'project')
    mkdirSync(project)
    for (const [base, name] of [
      [join(root, 'agents', 'skills'), 'global-reviewer'],
      [join(project, '.agents', 'skills'), 'project-reviewer']
    ]) {
      mkdirSync(join(base, name), { recursive: true })
      writeFileSync(join(base, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Scoped review\n---\nReview test only.\n`)
    }
    ctx.baseUrl = pathToFileURL(root + '/profile/').href
    ctx.provide('systemPrompt', { tools: () => () => {} })
    new ToolRuntime(ctx, { mode: 'native' })
    new SkillRegistry(ctx)
    const agent = { session: { id: 'session', header: { cwd: project } } }
    scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    ctx.provide('agents', { get: id => (id === 'session' ? agent : undefined) })
    ctx.provide('workspaceRegistry', { list: () => [{ id: 'ws', title: 'Project', path: project, sessionIds: ['session'] }] })
    await scope.ctx.plugin(filesystem, { agentsHome: join(root, 'agents'), dshHome: join(root, 'dsh'), watch: false })
    // Public acquireScope returns the provider's actual DSH scope key, not a mocked skills array.
    ctx.provide('agentPresets', {
      acquireScope: async () => {
        acquisitions++
        return {
          key: agent,
          [Symbol.asyncDispose]: async () => {
            disposals++
          }
        }
      }
    })
    await ctx.plugin(BlueprintService, { globalLibraryRoot: join(root, 'library') })
    const implicit = await ctx.blueprint.withSessionWorkspace('session', () => ctx.blueprint.listResources())
    const described = await ctx.blueprint.withSessionWorkspace('session', () => ctx.blueprint.describeBlueprint())
    const standalone = await ctx.blueprint.listResources({ library: { kind: 'workspace', workspaceId: 'ws' } })
    const global = await ctx.blueprint.listResources({ library: { kind: 'global' }, sessionId: 'session' })
    for (const resources of [implicit.resources, described.resourceCatalog, standalone.resources]) {
      assert.ok(resources.some(x => x.id === 'global-reviewer'))
      assert.ok(resources.some(x => x.id === 'project-reviewer'))
    }
    assert.ok(global.resources.some(x => x.id === 'global-reviewer'))
    assert.equal(
      global.resources.some(x => x.id === 'project-reviewer'),
      false
    )
    assert.ok(acquisitions > 0)
    assert.equal(acquisitions, disposals)
  } finally {
    await scope?.dispose()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
