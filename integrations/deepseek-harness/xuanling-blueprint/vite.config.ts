import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: [
    {
      // Host face: public service entry + hand-written typert artifact. ESM
      // with @deepseek-ai/* and zod externals so the runtime supplies the
      // single framework instance (two-anchor resolution; W0.2 evidence).
      entry: {
        index: 'src/index.ts',
        'typert.host': 'src/typert.host.ts',
        'typert.remote': 'src/typert.remote.ts',
        definition: 'src/definition/index.ts',
        resources: 'src/resources/index.ts',
        'resource-admission': 'src/security/resource-admission.ts',
        'tool-adapter': 'src/host/tool-adapter.ts',
        portability: 'src/portability/index.ts',
        'client-model': 'src/client/model.ts',
        'client-editor': 'src/client/graph-editor.ts',
        persistence: 'src/persistence/index.ts',
        orchestration: 'src/orchestration/index.ts',
      },
      format: 'esm',
      outDir: 'lib',
      outExtensions: () => ({ js: '.js' }),
      platform: 'node',
      external: [/^@deepseek-ai\//, /^node:/, 'zod'],
      dts: false,
      clean: true,
      minify: false,
    },
    {
      // Client face: the official closure-factory bundle format consumed by
      // the DSH browser module table (W0.2 probe format; template parity with
      // packages/client/tsdown.client.ts banner/footer).
      entry: { client: 'src/client/index.ts' },
      format: 'cjs',
      outDir: 'lib',
      outExtensions: () => ({ js: '.js' }),
      platform: 'browser',
      // Fold bundled third-party dev/production branches in the client only.
      // DSH's browser factory has no process global; do not install a shim.
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      // The shared strict codec is a peer on the host, not a DSH browser seed.
      deps: { alwaysBundle: ['zod'] },
      external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'],
      banner: `window.__ModuleLoader__.load({ id: '@xuanling-rs/xuanling-dsh-blueprint', factory(require) { var module = { exports: {} }; var exports = module.exports;`,
      footer: `return module.exports; } });`,
      dts: false,
      clean: false,
      minify: false,
    },
  ],
  lint: {
    categories: {
      correctness: 'error',
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'consistent-type-imports': 'error',
    },
    ignorePatterns: ['lib/**', 'node_modules/**', 'dist/**'],
  },
})
