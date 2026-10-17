// Source dependency boundary, not a bundle/mounted browser claim. Uses the
// native TypeScript stripping / TSX transform + ESM parser, not import regexes or a fake loader.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import config from '../../vite.config.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// These are DSH's real shared runtime seeds. Zod is not a seed: its browser
// codecs must be bundled; React Flow is likewise a bundled npm dependency.
const sharedExternals = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client']
const bundledDependencies = [
  '@xyflow/react',
  'zod',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/lang-json'
]
const unsupportedChains = graph => graph.chains.filter(chain => !sharedExternals.includes(chain.at(-1)) && !bundledDependencies.includes(chain.at(-1)))
function runtimeGraph(entry) {
  // Node's actual ESM parser exposes static dependencies after native type
  // stripping. This subprocess only parses; it does not link, build or mount.
  const script = `
    import { stripTypeScriptTypes } from 'node:module';
    import { transformWithOxc } from 'vite';
    import { SourceTextModule } from 'node:vm';
    import { readFileSync } from 'node:fs';
    import { dirname, resolve } from 'node:path';
    const visited = new Set(), external = [], chains = [];
    async function walk(file, chain) {
      if (visited.has(file)) return;
      visited.add(file);
      const input = readFileSync(file, 'utf8');
      const source = file.endsWith('.tsx')
        ? (await transformWithOxc(input, file, { lang: 'tsx', jsx: { runtime: 'automatic' } })).code
        : stripTypeScriptTypes(input, { mode: 'transform' });
      for (const specifier of new SourceTextModule(source, { identifier: file }).dependencySpecifiers) {
        if (specifier.startsWith('.')) await walk(resolve(dirname(file), specifier), [...chain, file]);
        else { external.push(specifier); chains.push([...chain, file, specifier]); }
      }
    }
    await walk(process.argv[1], []);
    console.log(JSON.stringify({ visited: [...visited], external, chains }));
  `
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script, entry], { cwd: packageRoot, encoding: 'utf8' })
  assert.equal(result.status, 0, `source parser harness failure (not a red oracle): ${result.stderr}`)
  return JSON.parse(result.stdout)
}
test('C-08 actual client runtime graph permits bundled codecs, never Node or unseeded runtime externals', () => {
  const graph = runtimeGraph(resolve(packageRoot, 'src/client/index.ts'))
  const client = config.pack.find(pack => pack.platform === 'browser')
  const host = config.pack.find(pack => pack.platform === 'node')
  assert.ok(client)
  assert.ok(host)
  assert.deepEqual(client.deps?.neverBundle, sharedExternals, 'ONLY_REAL_DSH_SEEDS_MAY_REMAIN_EXTERNAL')
  assert.deepEqual(client.deps?.alwaysBundle, ['zod'], 'CLIENT_CODEC_MUST_BE_EXPLICITLY_BUNDLED_NOT_SEEDED')
  assert.equal(host.deps?.alwaysBundle, undefined, 'HOST_CODEC_EXTERNAL_POLICY_MUST_REMAIN_UNCHANGED')
  const unsupported = unsupportedChains(graph)
  assert.deepEqual(unsupported, [], `BROWSER_RUNTIME_DEPENDENCY_NOT_SEEDED:\n${unsupported.map(chain => chain.join(' -> ')).join('\n')}`)
  assert.ok(
    graph.visited.includes(resolve(packageRoot, 'src/client/features/authoring/logic/workspace/workspace-controller.ts')),
    'must follow real entry -> panel -> workspace, not a standalone demo'
  )
  assert.ok(graph.visited.includes(resolve(packageRoot, 'src/typert-descriptors.ts')), 'must follow production shared strict codecs')
  assert.ok(graph.external.includes('zod'), 'reachable codec dependency is bundled by policy, not silently removed or seeded')
})
test('C-08 source parser still detects Node and unknown dependencies; bundled IDs are exact, not wildcard seeds', t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'blueprint-source-boundary-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const forbidden = ['node:module', 'node:fs', 'unseeded-codec', 'zod/unseeded-subpath', '@deepseek-ai/dsh-typert-protocol']
  const entry = resolve(directory, 'control.ts')
  writeFileSync(entry, [...sharedExternals, ...bundledDependencies, ...forbidden].map(id => `import '${id}'`).join('\n'))
  assert.deepEqual(
    unsupportedChains(runtimeGraph(entry)).map(chain => chain.at(-1)),
    forbidden,
    'NODE_AND_UNDECLARED_DEPENDENCIES_MUST_NOT_BECOME_SOURCE_GRAPH_ALLOWLIST_ENTRIES'
  )
})
test('C-08 TSX source parser preserves forbidden dependencies through JSX transformation', t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'blueprint-tsx-boundary-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const entry = resolve(directory, 'control.tsx')
  writeFileSync(entry, "import 'node:fs'; export const View = () => <section />")
  const graph = runtimeGraph(entry)
  assert.ok(graph.external.includes('react/jsx-runtime'), 'automatic JSX introduces a real shared runtime dependency')
  assert.deepEqual(
    unsupportedChains(graph).map(chain => chain.at(-1)),
    ['node:fs']
  )
})
test('C-09 React Flow CSS is included verbatim in the packed JS source style installer', () => {
  const style = readFileSync(resolve(packageRoot, 'src/client/shared/styles/base.ts'), 'utf8')
  const installed = readFileSync(resolve(packageRoot, 'node_modules/@xyflow/react/dist/style.css'), 'utf8')
  const match = /export const baseCss =\s*("(?:\\.|[^"\\])*")/s.exec(style)
  assert.ok(match, 'canonical base style fragment must expose the vendor CSS string')
  const css = JSON.parse(match[1])
  assert.ok(css.includes(installed), 'actual package stylesheet, not only hand-written approximate node/edge CSS')
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
  assert.ok(manifest.files.includes('lib/**/*.js'), 'source installer is within npm-pack closure when built by main')
})
