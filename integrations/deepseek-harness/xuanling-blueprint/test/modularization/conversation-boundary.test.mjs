import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { checkModularization } from '../../scripts/check-modularization.mjs'

const plugin = resolve(import.meta.dirname, '../..')
const view = 'src/client/features/conversation/ui/conversation-view.tsx'
const check = root => checkModularization({ root, boundary: 'conversation' })

function sourceCopy(action) {
  const root = mkdtempSync(join(tmpdir(), 'bp-conversation-boundary-'))
  try {
    cpSync(join(plugin, 'src'), join(root, 'src'), { recursive: true })
    cpSync(join(plugin, 'package.json'), join(root, 'package.json'))
    symlinkSync(join(plugin, 'node_modules'), join(root, 'node_modules'), 'dir')
    return action(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('Conversation boundary resolves the extracted renderer, attempts and presenter owners', () => {
  const result = check(plugin)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.code, 'BOUNDARY_EXTRACTED', JSON.stringify(result))
  assert.deepEqual(check(plugin), result, 'conversation red evidence must be deterministic')
  for (const file of [
    'features/conversation/ui/conversation-view.tsx',
    'features/conversation/ui/conversation-renderers.tsx',
    'features/conversation/ui/conversation-team-stage.tsx',
    'features/conversation/ui/conversation-attempts.tsx',
    'features/conversation/presenters/conversation-presenter.ts'
  ])
    assert.ok(
      result.evidence.some(entry => entry.path === `src/client/${file}`),
      `${file} owner missing`
    )
})

test('Conversation view cannot regain inline renderer ownership', () => {
  sourceCopy(root => {
    const path = join(root, view)
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nexport function FrozenNode(){ return null }\n`)
    assert.equal(check(root).code, 'CONVERSATION_VIEW_CENTRALIZED')
  })
})

test('Conversation presenter and attempts keep their extracted contracts', () => {
  sourceCopy(root => {
    const presenter = join(root, 'src/client/features/conversation/presenters/conversation-presenter.ts')
    writeFileSync(presenter, 'export function presentConversation(){ return {} }\nexport function displayState(){ return "" }\n')
    assert.equal(check(root).code, 'CONVERSATION_PRESENTER_CONTRACT_MISSING')
    const attempts = join(root, 'src/client/features/conversation/ui/conversation-attempts.tsx')
    const source = readFileSync(attempts, 'utf8').replace("import { renderTeamStage } from './conversation-team-stage.tsx'\n", '')
    writeFileSync(attempts, source)
    assert.equal(check(root).code, 'CONVERSATION_ATTEMPTS_WIRING_MISSING')
  })
})

test('Conversation source parse and import failures stay distinct from structural centralization', () => {
  sourceCopy(root => {
    const path = join(root, view)
    const source = readFileSync(path, 'utf8')
    writeFileSync(path, `const = invalid syntax\n${source}`)
    assert.equal(check(root).code, 'SOURCE_PARSE_ERROR')
    writeFileSync(path, `import './missing-conversation-source.ts'\n${source}`)
    assert.equal(check(root).code, 'SOURCE_UNAVAILABLE')
  })
})
