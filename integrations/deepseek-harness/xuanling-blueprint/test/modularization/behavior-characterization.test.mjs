/** Mutate isolated copies of production source, then run existing behavior
 * assertions. These are deterministic source tests, never live Host evidence. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseAst } from 'vite/rolldown/parseAst'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const repository = resolve(plugin, '../../..')
function find(root, predicate) {
  const found = []
  function visit(node) {
    if (!node || typeof node.type !== 'string') return
    if (predicate(node)) found.push(node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(root)
  return found
}
const one = (items, label) => {
  assert.equal(items.length, 1, `mutation must identify exactly one live production ${label}`)
  return items[0]
}
const memberName = node => node?.property?.name ?? node?.name
const hasIdentifier = (node, name) => find(node, child => child.type === 'Identifier' && child.name === name).length > 0
const method = (ast, name) =>
  one(
    find(ast, node => node.type === 'MethodDefinition' && node.key.name === name && node.value.body),
    name
  )
function edit(source, edits, lang = 'ts') {
  for (const { start, end, text } of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, start) + text + source.slice(end)
  parseAst(source, { lang, sourceType: 'module' })
  return source
}
function sourceCopy() {
  const home = mkdtempSync(join(tmpdir(), 'bp-modularization-mutation-'))
  const repo = join(home, 'repository'),
    root = join(repo, 'integrations/deepseek-harness/xuanling-blueprint')
  mkdirSync(root, { recursive: true })
  for (const path of ['src', 'test', 'package.json']) cpSync(join(plugin, path), join(root, path), { recursive: true })
  mkdirSync(join(root, 'scripts'))
  for (const name of ['test-tsx-register.mjs', 'test-tsx-loader.mjs']) cpSync(join(plugin, 'scripts', name), join(root, 'scripts', name))
  symlinkSync(join(plugin, 'node_modules'), join(root, 'node_modules'), 'dir')
  symlinkSync(join(plugin, 'node_modules'), join(repo, 'node_modules'), 'dir')
  const capabilities = join(repo, 'test/blueprint/capabilities')
  mkdirSync(join(repo, 'test/blueprint'), { recursive: true })
  cpSync(join(repository, 'test/blueprint/capabilities'), capabilities, { recursive: true })
  cpSync(join(repository, 'test/blueprint/package.json'), join(repo, 'test/blueprint/package.json'))
  symlinkSync(join(repository, 'test/blueprint/node_modules'), join(repo, 'test/blueprint/node_modules'), 'dir')
  return { home, root }
}
function run(root, file, title) {
  const pattern = `^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-transform-types',
      '--import',
      join(root, 'scripts/test-tsx-register.mjs'),
      '--test',
      '--test-concurrency=1',
      '--test-reporter=tap',
      `--test-name-pattern=${pattern}`,
      file
    ],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      // Do not inherit NODE_TEST_CONTEXT: this is an independent test runner,
      // not a recursive invocation inside the parent runner's child seat.
      env: {
        PATH: process.env.PATH,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {})
      }
    }
  )
  assert.equal(result.error, undefined, 'behavior subprocess must start normally')
  assert.equal(result.signal, null, 'behavior subprocess must exit normally')
  const output = `${result.stdout}\n${result.stderr}`
  assert.doesNotMatch(
    output,
    /ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|SyntaxError|SOURCE_PARSE_ERROR/,
    'import/compile errors cannot calibrate a behavior oracle'
  )
  assert.match(output, /# tests 1\b/, `exactly the intended existing test must execute:\n${output}`)
  return { status: result.status, output }
}

const cases = [
  {
    id: 'resource-availability',
    file: 'test/browser/resource-library.test.mjs',
    title: 'resource availability distinguishes catalog matches and missing references while loading',
    source: root =>
      existsSync(join(root, 'src/client/features/authoring/logic/resources/resource-library-model.ts'))
        ? 'src/client/features/authoring/logic/resources/resource-library-model.ts'
        : 'src/client/features/authoring/ui/panel/panel-composition.tsx',
    mutate(source, ast) {
      const fn = one(
        find(ast, node => node.type === 'FunctionDeclaration' && node.id?.name === 'resourceRows'),
        'resourceRows'
      )
      const values = find(fn, node => node.type === 'Property' && node.key.name === 'availability')
      assert.ok(values.length >= 2, 'real resource row availability branches must be present')
      return edit(
        source,
        values.map(node => ({ start: node.value.start, end: node.value.end, text: "'available'" }))
      )
    },
    failure: /expected: 'unknown'[\s\S]*actual: 'available'/
  },
  {
    id: 'resource-reference-alias',
    file: 'test/browser/resource-library.test.mjs',
    title: 'resource rows isolate returned reference mutations from canonical definition and future projections',
    source: () => 'src/client/features/authoring/logic/resources/resource-library-model.ts',
    mutate(source, ast) {
      const clones = find(ast, node => node.type === 'CallExpression' && node.callee.name === 'structuredClone' && node.arguments[0]?.name === 'ref')
      assert.equal(clones.length, 3, 'all resource reference output paths must isolate canonical values')
      return edit(
        source,
        clones.map(node => ({ start: node.start, end: node.end, text: 'ref' }))
      )
    },
    failure: /returned resource reference must not alias canonical state/
  },
  {
    id: 'retained-group-facts',
    file: 'test/comfy/ui-panel.test.mjs',
    title: 'retained Panel group command samples current group facts before authorization',
    source: () => 'src/client/features/authoring/ui/panel/panel-controller.tsx',
    mutate(source, ast) {
      const adapter = one(
        find(ast, node => node.type === 'CallExpression' && node.callee.name === 'deriveCommandFacts'),
        'production command facts adapter'
      )
      const editor = one(
        find(adapter.arguments[0], node => node.type === 'Property' && node.key.name === 'editor'),
        'current editor input'
      )
      return edit(source, [{ start: editor.value.start, end: editor.value.end, text: '{ ...current, groups: targetGroup ? [targetGroup] : [] }' }], 'tsx')
    },
    failure: /removed group must not authorize a retained copy command/
  },
  {
    id: 'command-busy-policy',
    file: 'test/comfy/policy.test.mjs',
    title: 'C-02 busy, missing definitions, selection/history/admission and lock facts disable typed intents',
    source: () => 'src/client/shared/controls/command-policy.ts',
    mutate(source, ast) {
      const policy = one(
        find(ast, node => node.type === 'FunctionDeclaration' && node.id?.name === 'commandDisabledReason'),
        'commandDisabledReason'
      )
      const guard = one(
        find(policy, node => node.type === 'IfStatement' && hasIdentifier(node.test, 'busy') && hasIdentifier(node.test, 'viewCommands')),
        'busy fact guard'
      )
      return edit(source, [{ start: guard.test.start, end: guard.test.end, text: 'false' }])
    },
    failure: /expected: 'disabled'[\s\S]*actual: 'command'/
  },
  {
    id: 'panel-binding-admission',
    file: 'test/browser/panel-snapshot-hydrated.test.mjs',
    title: 'actual Panel retained save callback cannot save a later document',
    source: () => 'src/client/features/authoring/ui/panel/panel-workspace-binding.ts',
    mutate(source, ast) {
      const admission = one(
        find(
          ast,
          node =>
            node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === 'isCurrent' && node.init?.type === 'ArrowFunctionExpression'
        ),
        'active binding admission predicate'
      )
      return edit(source, [{ start: admission.init.start, end: admission.init.end, text: '() => true' }])
    },
    failure: /OLD_PANEL_SAVE_CALLBACK_SAVED_NEW_DOCUMENT/
  },
  {
    id: 'workspace-refresh-fence',
    file: 'test/browser/workspace-foundation.test.mjs',
    title: 'resource refresh ignores an older response after a newer refresh',
    source: root => {
      const file = 'src/client/features/authoring/logic/workspace/workspace-controller.ts'
      const source = readFileSync(join(root, file), 'utf8')
      const ast = parseAst(source, { lang: 'ts', sourceType: 'module' })
      const refresh = method(ast, 'refreshResources')
      const importedCalls = find(refresh, node => node.type === 'CallExpression' && node.callee.type === 'Identifier').flatMap(call =>
        ast.body.filter(
          item =>
            item.type === 'ImportDeclaration' &&
            item.source.value.startsWith('.') &&
            item.specifiers.some(specifier => specifier.local.name === call.callee.name && item.importKind !== 'type' && specifier.importKind !== 'type')
        )
      )
      const resourceOwner = importedCalls.find(item => item.source.value === '../resources/workspace-resource-use-cases.ts')
      return resourceOwner ? 'src/client/features/authoring/logic/resources/workspace-resource-use-cases.ts' : file
    },
    mutate(source, ast) {
      // Locate the live Host read and its enclosing try block in either the
      // facade or extracted callable, rather than guessing a class method.
      const attempt = one(
        find(
          ast,
          node =>
            node.type === 'TryStatement' &&
            find(node.block, child => child.type === 'CallExpression' && memberName(child.callee) === 'listResources').length > 0
        ),
        'resource read attempt on actual facade delegation path'
      )
      const fence = one(
        find(
          attempt.block,
          node =>
            node.type === 'IfStatement' && find(node.test, child => child.type === 'BinaryExpression' && ['!==', '!='].includes(child.operator)).length > 0
        ),
        'stale catalog response read/navigation fence'
      )
      return edit(source, [{ start: fence.test.start, end: fence.test.end, text: 'false' }])
    },
    failure: /expected: 'new'[\s\S]*actual: 'old'/
  },
  {
    id: 'renderer-group-marker',
    file: 'test/browser/canvas-presentation.test.mjs',
    title: 'group frame is presentation-only, isolated from executable selection/deletion and reversible history',
    source: root =>
      existsSync(join(root, 'src/client/features/authoring/ui/canvas/canvas-renderers.tsx'))
        ? 'src/client/features/authoring/ui/canvas/canvas-renderers.tsx'
        : 'src/client/features/authoring/ui/panel/panel-composition.tsx',
    mutate(source, ast) {
      const renderer = one(
        find(ast, node => (node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration') && node.id?.name === 'PresentationGroup'),
        'PresentationGroup renderer'
      )
      const marker = one(
        find(
          renderer,
          node =>
            (node.type === 'Property' && node.key.type === 'Literal' && node.key.value === 'data-bp-group') ||
            (node.type === 'JSXAttribute' && node.name?.type === 'JSXIdentifier' && node.name.name === 'data-bp-group')
        ),
        'group frame marker'
      )
      const value = marker.type === 'JSXAttribute' ? marker.value : marker.value
      return edit(source, [{ start: value.start, end: value.end, text: marker.type === 'JSXAttribute' ? "{'mutated'}" : "'mutated'" }], 'tsx')
    },
    failure: /actual: 'mutated'/
  },
  {
    id: 'physical-root-alias-queue',
    file: 'test/api/w3-documents.test.mjs',
    title: 'document queue: physical root aliases serialize facade saves and rejected actions do not poison later writes',
    source: root => (existsSync(join(root, 'src/service/document-library.ts')) ? 'src/service/document-library.ts' : 'src/index.ts'),
    mutate(source, ast) {
      const queue = method(ast, 'withDocument')
      const canonical = one(
        find(queue, node => node.type === 'AssignmentExpression' && node.right.type === 'CallExpression' && memberName(node.right.callee) === 'realpathSync'),
        'physical-root canonicalization'
      )
      return edit(source, [{ start: canonical.right.start, end: canonical.right.end, text: source.slice(canonical.left.start, canonical.left.end) }])
    },
    failure: /(?:alias facade save waits for the physical-root queue|later facade write joins the pending action before its rejection)/
  },
  {
    id: 'admission-replay-before-precheck',
    file: 'test/runtime-contracts/preflight-contracts.test.mjs',
    title: 'C-08 control: command replay survives changed Host capability without redispatch or refreezing',
    source: () => 'src/index.ts',
    prepare(root) {
      // Change a real binding input in the COPY and prove current preflight
      // rejects it. All original identity/count/durable assertions remain.
      const path = join(root, this.file),
        source = readFileSync(path, 'utf8')
      const ast = parseAst(source, { lang: 'js', sourceType: 'module' })
      const target = one(
        find(ast, node => node.type === 'CallExpression' && node.callee.name === 'test' && node.arguments[0]?.value === this.title),
        'existing replay test'
      )
      const replay = one(
        find(target, node => node.type === 'VariableDeclaration' && node.declarations.some(item => item.id.name === 'replay')),
        'replay observation'
      )
      const init = replay.declarations[0].init
      assert.equal(init.type, 'AwaitExpression')
      writeFileSync(
        path,
        edit(source, [
          {
            start: replay.start,
            end: replay.end,
            text: `h.service.config.toolBindings.reader.tools = ['not_registered_after_admission'];
              const changed = await h.service.preflightRun({ blueprintId: args.blueprintId, expectedRevision: args.expectedRevision, inputJson: args.inputJson });
              assert.equal(changed.canStart, false, 'changed live binding must block a new admission');
              let replay; await assert.doesNotReject(async () => { replay = ${source.slice(init.start, init.end)} }, 'admitted replay must not rerun changed Host preflight')`
          }
        ])
      )
    },
    mutate(source, ast) {
      const admission = method(ast, 'admitRun')
      const replay = one(
        find(admission, node => node.type === 'VariableDeclaration' && node.declarations.some(item => item.id.name === 'replay')),
        'admission replay lookup'
      )
      const precheck = one(
        find(admission, node => node.type === 'VariableDeclaration' && node.declarations.some(item => item.id.name === 'rootDir')),
        'new admission precheck'
      )
      assert.ok(precheck.start > replay.end)
      return edit(source, [
        { start: precheck.start, end: precheck.end, text: '' },
        { start: replay.start, end: replay.start, text: `${source.slice(precheck.start, precheck.end)}\n` }
      ])
    },
    failure: /admitted replay must not rerun changed Host preflight[\s\S]*new Run blocked by preflight/
  },
  {
    id: 'admitted-snapshot-bytes',
    file: 'test/api/w3-documents.test.mjs',
    title: 'admission closure race: accepted document revision freezes exactly its package bytes',
    source: () => 'src/index.ts',
    mutate(source, ast) {
      const start = method(ast, 'startConfiguredRun')
      const snapshot = one(
        find(start, node => node.type === 'VariableDeclarator' && node.id.name === 'snapshot' && node.init?.type === 'CallExpression'),
        'admitted package snapshot'
      )
      const materialize = one(
        find(start, node => node.type === 'CallExpression' && memberName(node.callee) === 'materializePackage' && node.arguments[0]?.name === 'snapshot'),
        'production snapshot materialization'
      )
      const argument = materialize.arguments[0]
      return edit(source, [{ start: argument.start, end: argument.end, text: source.slice(snapshot.init.start, snapshot.init.end) }])
    },
    failure: /TARGET: accepted revision A must not freeze later external lib B[\s\S]*expected: 'PACKAGE-A'[\s\S]*actual: 'PACKAGE-B'/
  },
  {
    id: 'run-read-facade-query',
    file: 'test/conversation/host-api.test.mjs',
    title: 'W2.1 RunQuery boundary exposes cursor pagination, filters and typed malformed-cursor failure',
    source: () => 'src/service/run-read-service.ts',
    mutate(source) {
      const original = 'await this.context.query.page(args)'
      assert.equal(source.split(original).length, 2, 'RunReadService must own the query projection')
      return source.replace(original, '{ runs: [] }')
    },
    failure: /runs|nextCursor|pagination/
  }
]

for (const scenario of cases) {
  test(`production behavior oracle rejects ${scenario.id} mutation`, t => {
    const copy = sourceCopy()
    try {
      scenario.prepare?.(copy.root)
      const normal = run(copy.root, scenario.file, scenario.title)
      assert.equal(normal.status, 0, `unmodified production behavior must pass first:\n${normal.output}`)
      const path = join(copy.root, scenario.source(copy.root)),
        before = readFileSync(path, 'utf8')
      const after = scenario.mutate(before, parseAst(before, { lang: path.endsWith('.tsx') ? 'tsx' : 'ts', sourceType: 'module' }))
      assert.notEqual(after, before)
      writeFileSync(path, after)
      const broken = run(copy.root, scenario.file, scenario.title)
      assert.equal(broken.status, 1, `mutation must fail its actual behavior test:\n${broken.output}`)
      assert.match(broken.output, /code: 'ERR_ASSERTION'/, `mutation must reach an assertion:\n${broken.output}`)
      assert.match(broken.output, scenario.failure, `mutation must fail the specific production contract:\n${broken.output}`)
      t.diagnostic(
        JSON.stringify({
          mutation: scenario.id,
          target: scenario.source(copy.root),
          test: scenario.title,
          normal: 'passed',
          mutationResult: 'target-assertion-failed',
          mutationSha256: createHash('sha256').update(after).digest('hex')
        })
      )
    } finally {
      rmSync(copy.home, { recursive: true, force: true })
    }
  })
}
