/** Source-boundary oracles, separate from product acceptance.
 * AST evidence proves wiring, not behavioral equivalence; characterization and
 * mounted/live tests remain required. No source execution or build occurs here.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { parseAst } from 'vite/rolldown/parseAst'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
const unwrap = node => {
  while (node && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSInstantiationExpression', 'ParenthesizedExpression'].includes(node.type))
    node = node.expression
  return node
}
const name = node => node?.name ?? node?.value
const member = node => {
  node = unwrap(node)
  if (node?.type === 'ThisExpression') return 'this'
  if (node?.type === 'Identifier') return node.name
  if (node?.type === 'MemberExpression' && (!node.computed || node.property.type === 'Literal')) return `${member(node.object)}.${name(node.property)}`
  return undefined
}
function walk(node, visit, parents = []) {
  if (!node || typeof node.type !== 'string') return
  visit(node, parents)
  for (const [key, value] of Object.entries(node)) {
    if (['parent', 'tokens', 'comments'].includes(key)) continue
    if (Array.isArray(value)) for (const child of value) walk(child, visit, [...parents, node])
    else if (value && typeof value === 'object') walk(value, visit, [...parents, node])
  }
}
const nodes = (root, predicate) => {
  const found = []
  walk(root, node => {
    if (predicate(node)) found.push(node)
  })
  return found
}
const calls = root => nodes(root, node => node.type === 'CallExpression')
const functionOf = declaration => {
  const value = unwrap(declaration?.type === 'VariableDeclarator' ? declaration.init : declaration)
  if (FUNCTIONS.has(value?.type)) return value
  if (value?.type === 'CallExpression' && member(value.callee)?.endsWith('.memo')) return unwrap(value.arguments[0])
  return undefined
}

export class BoundaryOracleError extends Error {
  constructor(code, message, evidence = []) {
    super(message)
    this.code = code
    this.evidence = evidence
  }
}
const requireFact = (condition, code, message, evidence = []) => {
  if (!condition) throw new BoundaryOracleError(code, message, evidence)
}

function sourceGraph(root) {
  const cache = new Map()
  const location = (module, node, symbol) => ({
    path: relative(root, module.path),
    line: module.source.slice(0, node.start).split('\n').length,
    symbol
  })
  function load(path) {
    path = resolve(path)
    if (cache.has(path)) return cache.get(path)
    requireFact(existsSync(path), 'SOURCE_UNAVAILABLE', `Required source unavailable: ${relative(root, path)}`)
    const source = readFileSync(path, 'utf8')
    let ast
    try {
      ast = parseAst(source, { lang: path.endsWith('.tsx') ? 'tsx' : path.endsWith('.ts') ? 'ts' : 'js', sourceType: 'module' }, path)
    } catch {
      throw new BoundaryOracleError('SOURCE_PARSE_ERROR', `Cannot parse production source: ${relative(root, path)}`)
    }
    const module = { path, source, ast, declarations: [], imports: new Map() }
    cache.set(path, module)
    walk(ast, (node, parents) => {
      if (['FunctionDeclaration', 'ClassDeclaration'].includes(node.type) && node.id) module.declarations.push({ name: node.id.name, node, parents })
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') module.declarations.push({ name: node.id.name, node, parents })
    })
    for (const node of ast.body.filter(item => item.type === 'ImportDeclaration')) {
      for (const specifier of node.specifiers)
        module.imports.set(specifier.local.name, {
          node,
          source: node.source.value,
          imported: specifier.type === 'ImportDefaultSpecifier' ? 'default' : name(specifier.imported),
          typeOnly: node.importKind === 'type' || specifier.importKind === 'type'
        })
    }
    return module
  }
  const importedModule = (module, entry) => {
    requireFact(entry.source.startsWith('.'), 'UNRESOLVED_BINDING', 'Expected a local production binding', [location(module, entry.node, entry.source)])
    return load(resolve(dirname(module.path), entry.source))
  }
  function exported(module, symbol, seen = new Set()) {
    const key = `${module.path}:${symbol}`
    requireFact(!seen.has(key), 'IMPORT_CYCLE', `Cyclic export binding: ${symbol}`)
    seen.add(key)
    for (const item of module.ast.body) {
      if (item.type === 'ExportNamedDeclaration' && item.exportKind !== 'type') {
        if (item.declaration) {
          const match = module.declarations.find(entry => entry.name === symbol && entry.parents.includes(item))
          if (match) return { module, declaration: match.node }
        }
        for (const specifier of item.specifiers ?? [])
          if (name(specifier.exported) === symbol && specifier.exportKind !== 'type') {
            if (item.source) return exported(importedModule(module, { source: item.source.value, node: item }), name(specifier.local), seen)
            return binding(module, specifier.local, seen)
          }
      }
      if (item.type === 'ExportDefaultDeclaration' && symbol === 'default') return { module, declaration: item.declaration }
    }
    throw new BoundaryOracleError('UNRESOLVED_BINDING', `No runtime export ${symbol} in ${relative(root, module.path)}`)
  }
  function binding(module, identifier, seen = new Set()) {
    const symbol = name(identifier)
    const imported = module.imports.get(symbol)
    if (imported && !imported.typeOnly) return exported(importedModule(module, imported), imported.imported, seen)
    // Resolve lexical declarations by containment, including the Panel closure.
    const candidates = module.declarations.filter(
      entry =>
        entry.name === symbol &&
        entry.parents.every(parent => !FUNCTIONS.has(parent.type) || (parent.start <= identifier.start && parent.end >= identifier.end))
    )
    candidates.sort((a, b) => b.parents.length - a.parents.length)
    requireFact(candidates.length, 'UNRESOLVED_BINDING', `No declaration for ${symbol}`, [location(module, identifier, symbol)])
    return { module, declaration: candidates[0].node }
  }
  function validateImports(module, visited = new Set()) {
    if (visited.has(module.path)) return
    visited.add(module.path)
    for (const item of module.ast.body) {
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(item.type) || !item.source) continue
      const source = item.source.value
      if (source.startsWith('.')) validateImports(importedModule(module, { source, node: item }), visited)
      else if (
        item.importKind !== 'type' &&
        item.exportKind !== 'type' &&
        (item.type !== 'ImportDeclaration' || !item.specifiers.length || item.specifiers.some(specifier => specifier.importKind !== 'type'))
      ) {
        try {
          createRequire(module.path).resolve(source)
        } catch {
          throw new BoundaryOracleError('IMPORT_UNAVAILABLE', 'Production runtime import cannot be resolved', [location(module, item, source)])
        }
      }
    }
  }
  return { root, load, binding, exported, importedModule, location, validateImports }
}

function callable(graph, resolved, symbol) {
  const fn = functionOf(resolved.declaration)
  requireFact(fn && FUNCTIONS.has(fn.type) && fn.body, 'BOUNDARY_IMPLEMENTATION_INVALID', `Expected implemented callable ${symbol}`, [
    graph.location(resolved.module, resolved.declaration, symbol)
  ])
  requireFact(
    fn.body.type !== 'BlockStatement' || fn.body.body.some(statement => statement.type !== 'EmptyStatement'),
    'BOUNDARY_IMPLEMENTATION_INVALID',
    `Empty callable ${symbol}`,
    [graph.location(resolved.module, resolved.declaration, symbol)]
  )
  return fn
}
const sameBinding = (a, b) => a.module.path === b.module.path && a.declaration.start === b.declaration.start
const thisCalls = node =>
  calls(node)
    .map(call => ({ call, path: member(call.callee) }))
    .filter(entry => entry.path?.startsWith('this.'))
const methodTable = cl => new Map(cl.body.body.filter(node => node.type === 'MethodDefinition' && node.value?.body).map(node => [name(node.key), node]))
function reaches(methods, start, accept, seen = new Set()) {
  if (seen.has(start) || !methods.has(start)) return []
  seen.add(start)
  for (const entry of thisCalls(methods.get(start).value.body)) {
    if (accept(entry)) return [start, entry.path]
    const parts = entry.path.split('.')
    if (parts.length === 2) {
      const tail = reaches(methods, parts[1], accept, seen)
      if (tail.length) return [start, ...tail]
    }
  }
  return []
}

function pureDependencies(graph, entry) {
  const visited = new Set(),
    evidence = []
  function inspect(module) {
    if (visited.has(module.path)) return
    visited.add(module.path)
    const badGlobal = nodes(
      module.ast,
      node =>
        node.type === 'Identifier' &&
        ['window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'Document', 'Window', 'BlueprintWorkspace'].includes(node.name)
    )
    requireFact(
      !badGlobal.length,
      'IMPURE_MODEL_DEPENDENCY',
      'Pure model references DOM or workspace state',
      badGlobal.map(node => graph.location(module, node, node.name))
    )
    for (const item of module.ast.body) {
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(item.type) || !item.source) continue
      const source = item.source.value
      const runtime =
        item.importKind !== 'type' &&
        item.exportKind !== 'type' &&
        (item.type !== 'ImportDeclaration' || !item.specifiers.length || item.specifiers.some(specifier => specifier.importKind !== 'type'))
      if (!runtime) continue
      const forbidden =
        ['react', '@xyflow/react', '@xyflow/system'].includes(source) ||
        /(?:^|\/)ui(?:\/|$)/.test(source) ||
        /(?:^|\/)(?:panel(?:-[^/]+)?|workspace(?:\/[^/]+)?|conversation-controller)\.(?:ts|tsx)$/.test(source) ||
        source.includes('/service/')
      requireFact(!forbidden, 'IMPURE_MODEL_DEPENDENCY', 'Pure model imports a UI/workspace/service dependency', [graph.location(module, item, source)])
      requireFact(source.startsWith('.'), 'IMPURE_MODEL_DEPENDENCY', 'Pure model has an external runtime dependency', [graph.location(module, item, source)])
      const dependency = graph.importedModule(module, { source, node: item })
      evidence.push(graph.location(module, item, source))
      inspect(dependency)
    }
    requireFact(
      !nodes(
        module.ast,
        node => ['ImportExpression'].includes(node.type) || (node.type === 'CallExpression' && ['require', 'eval'].includes(member(node.callee)))
      ).length,
      'UNSUPPORTED_DYNAMIC_DEPENDENCY',
      'Pure model graph must have statically observable imports'
    )
  }
  inspect(entry)
  return evidence
}

/** Shared role checks used by W3.2 mutation tests. Pure owners must not pull
 * framework/browser/controller effects; props-only leaf views must emit
 * intents without directly mutating graph, Host or storage state. */
function roleBoundaries(graph) {
  const pureRoles = [
    ['src/client/features/authoring/logic/resources/resource-library-model.ts', 'resourceRows'],
    ['src/client/shared/controls/command-facts.ts', 'deriveCommandFacts'],
    ['src/client/features/authoring/presenters/inspector-presenter.ts', 'projectInspector'],
    ['src/client/features/conversation/presenters/conversation-presenter.ts', 'presentConversation']
  ]
  const viewRoles = [
    ['src/client/features/authoring/ui/panel/panel-view.tsx', ['panelView']],
    ['src/client/features/compact/ui/compact-chrome-view.tsx', ['compactChromeView']],
    ['src/client/shared/controls/styled-controls-view.tsx', ['styledSelectView', 'confirmationDialogView']],
    ['src/client/shared/controls/tooltip-view.tsx', ['tooltipView']],
    ['src/client/shared/diagnostics/diagnostics-view.tsx', ['AttemptDiagnosticsView']],
    ['src/client/shared/icons/icons-view.tsx', ['blueprintIcon']],
    ['src/client/features/authoring/ui/inspector/inspector-view.tsx', ['inspectorView']],
    ['src/client/features/conversation/ui/conversation-renderers.tsx', ['FrozenNode', 'FrozenGroup', 'FrozenEdge']]
  ]
  const evidence = []
  for (const [path, symbol] of pureRoles) {
    const module = graph.load(resolve(graph.root, path))
    graph.validateImports(module)
    callable(graph, graph.exported(module, symbol), symbol)
    evidence.push({ path: relative(graph.root, module.path), line: 1, symbol: 'pure role owner' })
    evidence.push(...pureDependencies(graph, module))
  }
  const forbiddenGlobals = new Set([
    'window',
    'document',
    'navigator',
    'localStorage',
    'sessionStorage',
    'fetch',
    'XMLHttpRequest',
    'MutationObserver',
    'ResizeObserver',
    'GraphEditor',
    'BlueprintWorkspace',
    'HostLink'
  ])
  const forbiddenCalls = new Set([
    'dispatch',
    'patchNode',
    'updateNode',
    'removeNode',
    'addNode',
    'addEdge',
    'removeEdge',
    'updateResource',
    'saveDefinition',
    'startRun',
    'cancelRun',
    'setItem',
    'removeItem'
  ])
  for (const [path, symbols] of viewRoles) {
    const module = graph.load(resolve(graph.root, path))
    graph.validateImports(module)
    for (const symbol of symbols) callable(graph, graph.exported(module, symbol), symbol)
    for (const item of module.ast.body.filter(node => node.type === 'ImportDeclaration')) {
      const runtime = item.importKind !== 'type' && (item.specifiers.length === 0 || item.specifiers.some(specifier => specifier.importKind !== 'type'))
      requireFact(
        !runtime ||
          !/(?:^|\/)(?:adapters\/(?:host|browser)|logic\/(?:graph\/graph-editor|workspace\/workspace-controller|conversation-controller)|remote\.)/.test(
            item.source.value
          ),
        'VIEW_DIRECT_EFFECT',
        'Props-only view imports a controller, Host or browser effect',
        [graph.location(module, item, item.source.value)]
      )
    }
    walk(module.ast, (node, parents) => {
      if (parents.some(parent => parent.type.startsWith('TS') && !['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression'].includes(parent.type)))
        return
      const parent = parents.at(-1)
      const isPropertyName =
        parent &&
        ((parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
          (parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand))
      if (node.type === 'Identifier' && !isPropertyName && forbiddenGlobals.has(node.name))
        throw new BoundaryOracleError('VIEW_DIRECT_EFFECT', 'Props-only view references a browser, Host or graph owner', [
          graph.location(module, node, node.name)
        ])
      if (node.type === 'MemberExpression' && !node.computed && forbiddenCalls.has(name(node.property)))
        throw new BoundaryOracleError('VIEW_DIRECT_EFFECT', 'Props-only view invokes a graph, Host or storage mutation', [
          graph.location(module, node, name(node.property))
        ])
    })
    evidence.push({ path: relative(graph.root, module.path), line: 1, symbol: 'props-only view owner' })
  }
  return evidence
}

function resources(graph) {
  // Resource and command ownership lives in the WorkspacePanel controller;
  // the composition module remains the public factory/re-export boundary.
  const panel = graph.load(resolve(graph.root, 'src/client/features/authoring/ui/panel/panel-controller.tsx'))
  const panelFactory = graph.exported(panel, 'WorkspacePanel')
  const factory = callable(graph, panelFactory, 'WorkspacePanel')
  const resourceCalls = calls(factory.body).filter(call => name(call.callee) === 'resourceRows')
  requireFact(resourceCalls.length, 'PRODUCTION_WIRING_MISSING', 'Panel does not call its resourceRows binding')
  const resourceBinding = graph.binding(panel, resourceCalls[0].callee)
  callable(graph, resourceBinding, 'resourceRows')
  const policyCalls = calls(factory.body).filter(call => name(call.callee) === 'commandDisabledReason')
  const dispatch = panel.declarations.find(entry => entry.name === 'dispatch' && entry.parents.includes(factory))
  requireFact(dispatch && policyCalls.length, 'PRODUCTION_WIRING_MISSING', 'Panel dispatch must retain command-policy authorization')
  const dispatchPolicies = calls(callable(graph, { module: panel, declaration: dispatch.node }, 'dispatch').body).filter(
    call => name(call.callee) === 'commandDisabledReason'
  )
  requireFact(
    dispatchPolicies.length && dispatchPolicies[0].arguments[1]?.type === 'CallExpression',
    'FACTS_NOT_SAMPLED',
    'Dispatch must sample command facts on each call'
  )
  const factsCall = dispatchPolicies[0].arguments[1]
  const factsBinding = graph.binding(panel, factsCall.callee)
  const facts = callable(graph, factsBinding, 'commandFacts')
  const central = []
  if (resourceBinding.module.path === panel.path) central.push(graph.location(panel, resourceBinding.declaration, 'resourceRows'))
  if (
    factsBinding.module.path === panel.path &&
    !calls(facts.body).some(call => {
      const imported = panel.imports.get(name(call.callee))
      return imported?.source.endsWith('/command-facts.ts')
    })
  )
    central.push(graph.location(panel, factsBinding.declaration, 'commandFacts'))
  requireFact(!central.length, 'BOUNDARY_STILL_CENTRALIZED', 'Production resource/command derivation remains implemented in Panel', [
    ...central,
    graph.location(panel, resourceCalls[0], 'Panel → resourceRows'),
    graph.location(panel, factsCall, 'dispatch → commandFacts')
  ])
  const model = graph.load(resolve(graph.root, 'src/client/features/authoring/logic/resources/resource-library-model.ts'))
  const expectedResource = graph.exported(model, 'resourceRows')
  requireFact(
    sameBinding(resourceBinding, expectedResource) && sameBinding(graph.exported(panel, 'resourceRows'), expectedResource),
    'PRODUCTION_WIRING_MISSING',
    'Panel call and legacy resourceRows export must resolve to the same model implementation'
  )
  const command = graph.load(resolve(graph.root, 'src/client/shared/controls/command-facts.ts'))
  let adapter = factsBinding
  if (factsBinding.module.path === panel.path) {
    const adapterCalls = calls(facts.body).filter(call => panel.imports.get(name(call.callee))?.source.endsWith('/command-facts.ts'))
    requireFact(adapterCalls.length === 1, 'PRODUCTION_WIRING_MISSING', 'Fresh Panel facts must call exactly one pure command adapter')
    requireFact(
      facts.body === adapterCalls[0] || nodes(facts.body, node => node.type === 'ReturnStatement' && unwrap(node.argument) === adapterCalls[0]).length,
      'PRODUCTION_WIRING_MISSING',
      'Panel must return the command adapter result, not discard a decorative adapter call'
    )
    adapter = graph.binding(panel, adapterCalls[0].callee)
    requireFact(
      nodes(facts.body, node => member(node) === 'workspace.editor').length,
      'FACTS_NOT_SAMPLED',
      'Panel facts wrapper must read the current workspace editor'
    )
  } else {
    requireFact(
      nodes(factsCall, node => member(node) === 'workspace.editor').length,
      'FACTS_NOT_SAMPLED',
      'Dispatch adapter must receive the current workspace editor'
    )
  }
  requireFact(adapter.module.path === command.path, 'PRODUCTION_WIRING_MISSING', 'Command facts implementation is not in the pure adapter')
  callable(graph, adapter, 'command facts adapter')
  const policy = panel.imports.get('commandDisabledReason')
  requireFact(
    policy?.source === '../../../../shared/controls/command-policy.ts' && !policy.typeOnly,
    'PRODUCTION_WIRING_MISSING',
    'Panel must use the existing command policy'
  )
  const dependencies = [...pureDependencies(graph, model), ...pureDependencies(graph, command)]
  return [
    graph.location(model, expectedResource.declaration, 'resourceRows'),
    graph.location(command, adapter.declaration, 'command facts adapter'),
    ...dependencies
  ]
}

/** Check executable references, without mistaking DTO keys such as `document`
 * or type-only imports for browser access. This supplements the type checker;
 * behavior fixtures still prove the projection and dispatch contracts. */
function workspacePresentationDependencies(graph, entry) {
  const visited = new Set(),
    evidence = []
  const globals = new Set([
    'window',
    'document',
    'navigator',
    'localStorage',
    'sessionStorage',
    'fetch',
    'XMLHttpRequest',
    'setTimeout',
    'setInterval',
    'queueMicrotask'
  ])
  function inspect(module) {
    if (visited.has(module.path)) return
    visited.add(module.path)
    for (const item of module.ast.body) {
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(item.type) || !item.source) continue
      const runtime =
        item.importKind !== 'type' &&
        item.exportKind !== 'type' &&
        (item.type !== 'ImportDeclaration' || !item.specifiers.length || item.specifiers.some(specifier => specifier.importKind !== 'type'))
      if (!runtime) continue
      const source = item.source.value
      requireFact(
        source.startsWith('.') && !/(?:^|\/)(?:workspace|remote|graph-editor|model|conversation-controller|panel)\.[cm]?[jt]sx?$/.test(source),
        'IMPURE_PRESENTER_DEPENDENCY',
        'Presenter must consume snapshot data, not runtime adapters',
        [graph.location(module, item, source)]
      )
      const dependency = graph.importedModule(module, { source, node: item })
      evidence.push(graph.location(module, item, source))
      inspect(dependency)
    }
    walk(module.ast, (node, parents) => {
      if (parents.some(parent => parent.type.startsWith('TS') && !['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression'].includes(parent.type)))
        return
      const parent = parents.at(-1)
      const propertyName =
        parent &&
        ((parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
          (parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand))
      if (node.type === 'Identifier' && globals.has(node.name) && !propertyName) {
        const declaration = parent?.type === 'VariableDeclarator' && parent.id === node
        const local = module.declarations.some(
          item =>
            item.name === node.name &&
            item.node.type === 'VariableDeclarator' &&
            item.parents.filter(scope => FUNCTIONS.has(scope.type) || scope.type === 'BlockStatement').every(scope => parents.includes(scope))
        )
        const parameter = parents.some(
          scope => FUNCTIONS.has(scope.type) && scope.params.some(param => param.type === 'Identifier' && param.name === node.name)
        )
        requireFact(declaration || local || parameter, 'PRESENTER_BROWSER_ACCESS', 'Presenter references a browser effect', [
          graph.location(module, node, node.name)
        ])
      }
      if (node.type === 'MemberExpression' && ['globalThis', 'self'].includes(member(node.object)) && globals.has(name(node.property)))
        throw new BoundaryOracleError('PRESENTER_BROWSER_ACCESS', 'Presenter references a browser effect', [graph.location(module, node, member(node))])
      requireFact(
        node.type !== 'ImportExpression' && !(node.type === 'CallExpression' && ['require', 'eval'].includes(member(node.callee))),
        'UNSUPPORTED_DYNAMIC_DEPENDENCY',
        'Presenter dependencies must be static',
        [graph.location(module, node, member(node.callee) ?? node.type)]
      )
      if (node.type === 'CallExpression') {
        const operation = member(node.callee)?.split('.').at(-1)
        requireFact(
          ![
            'updateNode',
            'removeNode',
            'addNode',
            'addEdge',
            'removeEdge',
            'updateResource',
            'transaction',
            'setSelection',
            'saveDefinition',
            'startRun',
            'cancelRun'
          ].includes(operation),
          'PRESENTER_MUTATION',
          'Presenter invokes a graph or Host command',
          [graph.location(module, node, operation)]
        )
      }
    })
  }
  inspect(entry)
  return evidence
}

function workspace(graph) {
  const controller = graph.load(resolve(graph.root, 'src/client/features/authoring/logic/workspace/workspace-controller.ts'))
  const resolved = graph.exported(controller, 'BlueprintWorkspace')
  requireFact(resolved.declaration.type === 'ClassDeclaration', 'PRODUCTION_WIRING_MISSING', 'Workspace must retain its controller class')
  const methods = methodTable(resolved.declaration)
  const fields = resolved.declaration.body.body
  const reader = fields.find(field => name(field.key) === 'getSnapshot')
  const subscriber = fields.find(field => name(field.key) === 'subscribe')
  const dispatch = methods.get('dispatch')
  requireFact(
    reader?.value?.type === 'ArrowFunctionExpression' &&
      member(reader.value.body) === 'this.published' &&
      subscriber?.value?.type === 'ArrowFunctionExpression' &&
      methods.has('dispose') &&
      dispatch,
    'WORKSPACE_CONTRACT_MISSING',
    'Workspace requires its cached reader, subscription, disposal and dispatch',
    [graph.location(controller, resolved.declaration, 'BlueprintWorkspace')]
  )
  const validation = calls(dispatch).find(call => name(call.callee) === 'assertWorkspaceIntent')
  requireFact(
    validation && controller.imports.get('assertWorkspaceIntent')?.source === './workspace-intents.ts',
    'WORKSPACE_INTENT_VALIDATION_MISSING',
    'Dispatch must validate the actual client intent binding',
    [graph.location(controller, dispatch, 'dispatch')]
  )
  const validator = graph.binding(controller, validation.callee)
  callable(graph, validator, 'assertWorkspaceIntent')
  for (const imported of controller.ast.body.filter(item => item.type === 'ImportDeclaration')) {
    const typeOnly = imported.importKind === 'type' || (imported.specifiers.length > 0 && imported.specifiers.every(item => item.importKind === 'type'))
    requireFact(
      typeOnly || !/^(?:react(?:\/|$)|react-dom(?:\/|$)|@xyflow\/)/.test(imported.source.value),
      'CONTROLLER_UI_DEPENDENCY',
      'Workspace controller cannot import the renderer runtime',
      [graph.location(controller, imported, imported.source.value)]
    )
  }
  const path = resolve(graph.root, 'src/client/features/authoring/presenters/workspace-presenter.ts')
  requireFact(existsSync(path), 'WORKSPACE_PRESENTER_MISSING', 'Workspace presentation boundary has not been extracted', [
    graph.location(controller, reader, 'getSnapshot'),
    graph.location(controller, dispatch, 'dispatch')
  ])
  const presenter = graph.load(path)
  graph.validateImports(presenter)
  const projection = graph.exported(presenter, 'presentWorkspace')
  const fn = callable(graph, projection, 'presentWorkspace')
  const inputs = new Set(fn.params.filter(param => param.type === 'Identifier').map(param => param.name))
  const rootOf = value => {
    value = unwrap(value)
    while (value?.type === 'MemberExpression' || value?.type === 'ChainExpression')
      value = unwrap(value.type === 'ChainExpression' ? value.expression : value.object)
    return value?.type === 'Identifier' ? value.name : undefined
  }
  // Resolve simple aliases so moving a mutation behind a local variable cannot
  // turn a direct snapshot write into an apparently pure projection.
  let changed = true
  while (changed) {
    changed = false
    for (const node of nodes(fn.body, item => item.type === 'VariableDeclarator' && item.id.type === 'Identifier')) {
      if (inputs.has(rootOf(node.init)) && !inputs.has(node.id.name)) {
        inputs.add(node.id.name)
        changed = true
      }
    }
  }
  const mutations = nodes(
    fn.body,
    node =>
      ((node.type === 'AssignmentExpression' || node.type === 'UpdateExpression' || (node.type === 'UnaryExpression' && node.operator === 'delete')) &&
        inputs.has(rootOf(node.left ?? node.argument))) ||
      (node.type === 'CallExpression' &&
        [
          'push',
          'pop',
          'shift',
          'unshift',
          'splice',
          'sort',
          'reverse',
          'fill',
          'copyWithin',
          'set',
          'delete',
          'clear',
          'updateNode',
          'removeNode',
          'addNode',
          'addEdge',
          'removeEdge',
          'updateResource',
          'transaction',
          'setSelection'
        ].includes(name(node.callee.property)) &&
        inputs.has(rootOf(node.callee.object)))
  )
  requireFact(
    !mutations.length,
    'PRESENTER_MUTATION',
    'Presenter writes its input snapshot',
    mutations.map(node => graph.location(presenter, node, 'snapshot mutation'))
  )
  const requiredProjectionFields = ['capabilities', 'document', 'resources', 'resourceState', 'run', 'preflight', 'inputJson', 'notice', 'busy']
  const returnObjects = nodes(fn.body, node => node.type === 'ReturnStatement')
    .map(node => unwrap(node.argument))
    .filter(node => node?.type === 'ObjectExpression')
  const returned = new Set(
    returnObjects.flatMap(node => node.properties.filter(item => item.type === 'Property' && !item.computed).map(item => name(item.key)))
  )
  requireFact(
    requiredProjectionFields.every(field => returned.has(field)),
    'WORKSPACE_PRESENTER_CONTRACT_MISSING',
    'Presenter must return the complete public workspace projection',
    [graph.location(presenter, projection.declaration, 'presentWorkspace')]
  )
  const readFields = new Set(
    nodes(fn.body, node => node.type === 'MemberExpression' && !node.computed && inputs.has(rootOf(node.object))).map(node => name(node.property))
  )
  // `resourceState` is intentionally derived from the snapshot.resources
  // observation, so the read contract accepts that segment as its source.
  const requiredReadFields = requiredProjectionFields.filter(field => field !== 'resourceState')
  requireFact(
    requiredReadFields.every(field => readFields.has(field)),
    'WORKSPACE_PRESENTER_CONTRACT_MISSING',
    'Presenter must read every required snapshot segment',
    [graph.location(presenter, projection.declaration, 'presentWorkspace')]
  )
  const dependencies = workspacePresentationDependencies(graph, presenter)
  return [
    graph.location(controller, reader, 'getSnapshot'),
    graph.location(controller, subscriber, 'subscribe'),
    graph.location(controller, dispatch, 'dispatch'),
    graph.location(presenter, projection.declaration, 'presentWorkspace'),
    ...dependencies
  ]
}

function canvas(graph) {
  const controller = graph.load(resolve(graph.root, 'src/client/features/authoring/ui/panel/panel-controller.tsx'))
  const surface = graph.load(resolve(graph.root, 'src/client/features/authoring/ui/canvas/canvas-surface.tsx'))
  const surfaceImport = [...controller.imports].find(([, entry]) => entry.source === '../canvas/canvas-surface.tsx' && entry.imported === 'CanvasSurface')
  requireFact(surfaceImport, 'PRODUCTION_WIRING_MISSING', 'Panel controller must use the extracted CanvasSurface')
  const flowImport = [...surface.imports].find(([, entry]) => entry.source === '@xyflow/react' && entry.imported === 'ReactFlow')
  requireFact(flowImport, 'PRODUCTION_WIRING_MISSING', 'CanvasSurface must use the installed ReactFlow component')
  // JSX is the canonical renderer syntax after the Panel migration, while
  // older checkpoints used React.createElement/automatic h calls. Accept
  // either representation so the oracle continues to inspect the real
  // production wiring instead of treating a JSX migration as a missing flow.
  const flow = [
    ...calls(surface.ast)
      .filter(call => name(unwrap(call.arguments[0])) === flowImport[0] && unwrap(call.arguments[1])?.type === 'ObjectExpression')
      .map(call => ({ node: call, props: unwrap(call.arguments[1]), location: call })),
    ...nodes(
      surface.ast,
      node => node.type === 'JSXElement' && node.openingElement?.name?.type === 'JSXIdentifier' && node.openingElement.name.name === flowImport[0]
    ).map(element => ({
      node: element,
      props: {
        properties: element.openingElement.attributes
          .filter(attribute => attribute.type === 'JSXAttribute' && attribute.name?.type === 'JSXIdentifier')
          .map(attribute => ({
            type: 'Property',
            key: { type: 'Identifier', name: attribute.name.name },
            value:
              attribute.value?.type === 'JSXExpressionContainer'
                ? unwrap(attribute.value.expression)
                : attribute.value?.type === 'JSXElement'
                  ? attribute.value
                  : attribute.value
          }))
      },
      location: element
    }))
  ]
  requireFact(flow.length === 1, 'PRODUCTION_WIRING_MISSING', 'Expected one production ReactFlow props object')
  const props = flow[0].props,
    resolved = [],
    maps = []
  for (const [prop, expected] of [
    ['nodeTypes', ['blueprint', 'presentationGroup']],
    ['edgeTypes', ['blueprintEdge']]
  ]) {
    const value = props.properties.find(item => name(item.key) === prop)?.value
    requireFact(value?.type === 'Identifier', 'UNSTABLE_RENDERER_MAP', prop + ' must use a stable module binding')
    const map = graph.binding(surface, value)
    const declaration = map.module.declarations.find(item => item.node === map.declaration)
    requireFact(
      declaration &&
        declaration.parents.some(parent => parent.type === 'VariableDeclaration' && parent.kind === 'const') &&
        !declaration.parents.some(parent => FUNCTIONS.has(parent.type)) &&
        map.declaration.init?.type === 'ObjectExpression',
      'UNSTABLE_RENDERER_MAP',
      prop + ' must be a module-scope object',
      [graph.location(map.module, map.declaration, prop)]
    )
    maps.push(graph.location(map.module, map.declaration, prop))
    for (const key of expected) {
      const renderer = map.declaration.init.properties.find(item => name(item.key) === key)?.value
      requireFact(renderer?.type === 'Identifier', 'PRODUCTION_WIRING_MISSING', prop + '.' + key + ' must reference an actual renderer')
      const binding = graph.binding(map.module, renderer)
      callable(graph, binding, key)
      resolved.push({ key, ...binding })
    }
  }
  const centralized = resolved.filter(entry => entry.module.path === surface.path)
  requireFact(!centralized.length, 'BOUNDARY_STILL_CENTRALIZED', 'Production ReactFlow maps still resolve to renderer implementations in CanvasSurface', [
    ...centralized.map(entry => graph.location(entry.module, entry.declaration, entry.key)),
    ...maps,
    graph.location(surface, flow[0].location, 'ReactFlow props')
  ])
  const renderers = graph.load(resolve(graph.root, 'src/client/features/authoring/ui/canvas/canvas-renderers.tsx'))
  for (const entry of resolved)
    requireFact(entry.module.path === renderers.path, 'PRODUCTION_WIRING_MISSING', 'All three renderers must resolve to canvas-renderers.tsx')
  const visited = new Set()
  function inspect(module) {
    if (visited.has(module.path)) return
    visited.add(module.path)
    for (const imported of module.imports.values()) {
      requireFact(
        !/(?:^|\/)(?:panel|workspace|conversation-controller)\.ts$/.test(imported.source),
        'RENDERER_COORDINATION_DEPENDENCY',
        'Renderer dependency graph points back to coordination state',
        [graph.location(module, imported.node, imported.source)]
      )
      if (!imported.typeOnly && imported.source.startsWith('.')) inspect(graph.importedModule(module, imported))
    }
    requireFact(
      !nodes(module.ast, node => node.type === 'NewExpression' && ['BlueprintWorkspace', 'CanvasInteractions'].includes(name(node.callee))).length,
      'RENDERER_COORDINATION_DEPENDENCY',
      'Renderer graph creates a second workspace/controller'
    )
  }
  inspect(renderers)
  return [
    graph.location(controller, surfaceImport[1].node, 'Panel controller → CanvasSurface'),
    ...resolved.map(entry => graph.location(entry.module, entry.declaration, entry.key)),
    ...maps,
    graph.location(surface, flow[0].location, 'ReactFlow props')
  ]
}

function graphEditor(graph) {
  const editor = graph.load(resolve(graph.root, 'src/client/features/authoring/logic/graph/graph-editor.ts'))
  const editorSourceLines = editor.source.split('\n').length
  const classDeclaration = editor.ast.body
    .filter(item => item.type === 'ExportNamedDeclaration' && item.declaration?.type === 'ClassDeclaration')
    .map(item => item.declaration)
    .find(item => item.id?.name === 'GraphEditor')
  requireFact(classDeclaration, 'GRAPH_EDITOR_OWNER_MISSING', 'GraphEditor must remain the canonical graph state owner')
  const roles = [
    ['types', './graph-types.ts', ['EditorNode', 'EditorEdge', 'EditorGroup', 'CanvasPort']],
    ['history', './graph-history.ts', ['snapshotGraph', 'restoreGraph']],
    ['commands', './graph-commands.ts', ['canConnect', 'EditorCommandError']],
    ['layout', './graph-layout.ts', ['alignNodes', 'distributeNodes']],
    ['clipboard', './graph-clipboard.ts', ['createClipboardFragment', 'pasteClipboardFragment']],
    ['serialization', './graph-serialization.ts', ['exportGraphDefinition', 'importGraphDefinition']]
  ]
  const evidence = [graph.location(editor, classDeclaration, 'GraphEditor')]
  const resolvedRoles = []
  for (const [role, source, symbols] of roles) {
    const imports = [...editor.imports].filter(([, entry]) => entry.source === source)
    if (!imports.length) {
      if (editorSourceLines > 700) {
        throw new BoundaryOracleError('GRAPH_ROLE_CENTRALIZED', `GraphEditor still centralizes ${role} responsibilities`, [
          graph.location(editor, classDeclaration, `GraphEditor ${role} role`)
        ])
      }
      throw new BoundaryOracleError('GRAPH_ROLE_WIRING_MISSING', `GraphEditor has no ${role} role module import`, evidence)
    }
    const imported = graph.importedModule(editor, imports[0][1])
    graph.validateImports(imported)
    requireFact(existsSync(imported.path), 'SOURCE_UNAVAILABLE', `GraphEditor ${role} module is unavailable`)
    requireFact(readFileSync(imported.path, 'utf8').trim().length > 0, 'BOUNDARY_IMPLEMENTATION_INVALID', `GraphEditor ${role} module is empty`)
    for (const symbol of symbols) {
      const entry = [...imported.ast.body]
        .filter(item => item.type === 'ExportNamedDeclaration')
        .flatMap(item => {
          if (item.declaration?.id?.name === symbol) return [item.declaration]
          return (item.specifiers ?? []).filter(specifier => name(specifier.exported) === symbol)
        })[0]
      requireFact(entry, 'GRAPH_ROLE_EXPORT_MISSING', `${role} module must export ${symbol}`, [graph.location(imported, imported.ast, symbol)])
      evidence.push(graph.location(imported, entry, `${role}.${symbol}`))
    }
    resolvedRoles.push({ role, module: imported, imports })
  }
  requireFact(editorSourceLines <= 700, 'GRAPH_ROLE_CENTRALIZED', `GraphEditor remains a ${editorSourceLines}-line mixed responsibility owner`, [
    graph.location(editor, classDeclaration, `GraphEditor lines=${editorSourceLines}`)
  ])
  const runtimeImports = resolvedRoles.filter(({ imports }) => imports.some(([, entry]) => !entry.typeOnly))
  requireFact(runtimeImports.length >= 5, 'GRAPH_ROLE_WIRING_MISSING', 'GraphEditor must delegate runtime roles through canonical modules')
  return evidence
}
function documents(graph) {
  const service = graph.load(resolve(graph.root, 'src/index.ts'))
  const cl = graph.exported(service, 'BlueprintService').declaration
  requireFact(cl.type === 'ClassDeclaration', 'PRODUCTION_WIRING_MISSING', 'BlueprintService must retain its public class')
  const methods = methodTable(cl)
  const entries = [
    'listDefinitions',
    'loadDefinition',
    'saveDefinition',
    'createDefinition',
    'deleteDefinition',
    'describeBlueprint',
    'createBlueprint',
    'preflightRun',
    'startRun',
    'startSessionRun',
    'startConfiguredRun',
    'exportDefinition',
    'importDefinition',
    'hostProbe'
  ]
  for (const entry of entries) requireFact(methods.has(entry), 'PRODUCTION_WIRING_MISSING', `Missing Service entry ${entry}`)
  const fields = cl.body.body.filter(node => node.type === 'PropertyDefinition')
  const tails = fields.filter(node => ['documentTails', 'libraryTail'].includes(name(node.key)))
  if (tails.length) {
    const paths = entries.map(entry => ({
      entry,
      path: reaches(methods, entry, edge => (entry === 'hostProbe' ? edge.path === 'this.loadConfigured' : edge.path === 'this.withDocument'))
    }))
    requireFact(
      tails.length === 2 && methods.has('withDocument') && methods.has('withLibraryMutation') && paths.every(item => item.path.length),
      'DOCUMENT_WIRING_INCOMPLETE',
      'Service has queue state but its expected document callers cannot all be traced'
    )
    requireFact(
      nodes(methods.get('constructor'), node => node.type === 'AwaitExpression' && member(node.argument) === 'this.libraryTail').length,
      'DOCUMENT_DRAIN_MISSING',
      'Service queue baseline has no observed disposal drain'
    )
    const mutationCall = nodes(methods.get('withDocument'), node => node.type === 'CallExpression' && member(node.callee) === 'this.withLibraryMutation')[0]
    throw new BoundaryOracleError('BOUNDARY_STILL_CENTRALIZED', 'Document queues, CRUD callers and disposal drain remain owned by BlueprintService', [
      ...tails.map(node => graph.location(service, node, name(node.key))),
      ...paths.map(item => ({ ...graph.location(service, methods.get(item.entry), item.entry), calls: item.path })),
      graph.location(service, mutationCall ?? methods.get('withDocument'), 'withDocument → withLibraryMutation'),
      graph.location(service, tails.find(node => name(node.key) === 'libraryTail') ?? methods.get('constructor'), 'dispose → libraryTail')
    ])
  }
  // The public façade keeps its RPC names, while definition CRUD/resource
  // authoring and package portability now live in dedicated use-case owners.
  // Resolve both collaborators from the actual constructor and trace every
  // façade entry to the retained instance; source movement alone cannot satisfy
  // this boundary.
  const definitionUseCases = graph.load(resolve(graph.root, 'src/service/definition-use-cases.ts'))
  const definitionClass = graph.exported(definitionUseCases, 'BlueprintDefinitionUseCases').declaration
  requireFact(definitionClass.type === 'ClassDeclaration', 'DOCUMENT_WIRING_INCOMPLETE', 'Expected implemented BlueprintDefinitionUseCases class')
  const applyService = graph.load(resolve(graph.root, 'src/service/apply-service.ts'))
  const applyClass = graph.exported(applyService, 'ApplyService').declaration
  requireFact(applyClass.type === 'ClassDeclaration', 'DOCUMENT_WIRING_INCOMPLETE', 'Expected implemented ApplyService class')
  const portabilityUseCases = graph.load(resolve(graph.root, 'src/service/portability-use-cases.ts'))
  const portabilityClass = graph.exported(portabilityUseCases, 'BlueprintPortabilityUseCases').declaration
  requireFact(portabilityClass.type === 'ClassDeclaration', 'DOCUMENT_WIRING_INCOMPLETE', 'Expected implemented BlueprintPortabilityUseCases class')
  const definitionBinding = [...service.imports].find(
    ([, entry]) => entry.source === './service/definition-use-cases.ts' && entry.imported === 'BlueprintDefinitionUseCases'
  )
  const portabilityBinding = [...service.imports].find(
    ([, entry]) => entry.source === './service/portability-use-cases.ts' && entry.imported === 'BlueprintPortabilityUseCases'
  )
  const applyBinding = [...service.imports].find(([, entry]) => entry.source === './service/apply-service.ts' && entry.imported === 'ApplyService')
  requireFact(definitionBinding && applyBinding && portabilityBinding, 'DOCUMENT_WIRING_INCOMPLETE', 'Service must import the definition, apply and portability collaborators')
  const definitionCreation = nodes(cl, node => node.type === 'NewExpression' && name(node.callee) === definitionBinding[0])
  const applyCreation = nodes(cl, node => node.type === 'NewExpression' && name(node.callee) === applyBinding[0])
  const portabilityCreation = nodes(cl, node => node.type === 'NewExpression' && name(node.callee) === portabilityBinding[0])
  requireFact(
    definitionCreation.length === 1 && applyCreation.length === 1 && portabilityCreation.length === 1,
    'DOCUMENT_INSTANCE_COUNT',
    'Service must construct one definition, one apply and one portability collaborator'
  )
  const collaboratorField = creation => {
    let field
    walk(cl, node => {
      if (node.type === 'PropertyDefinition' && node.value === creation) field = name(node.key)
      if (node.type === 'AssignmentExpression' && node.right === creation && member(node.left)?.startsWith('this.')) field = member(node.left).slice(5)
    })
    return field
  }
  const definitionField = collaboratorField(definitionCreation[0])
  const applyField = collaboratorField(applyCreation[0])
  const portabilityField = collaboratorField(portabilityCreation[0])
  requireFact(definitionField && applyField && portabilityField, 'DOCUMENT_INSTANCE_COUNT', 'Use-case collaborators must be retained on BlueprintService')
  const definitionEntries = [
    'listDefinitions',
    'loadDefinition',
    'createDefinition',
    'deleteDefinition',
    'describeBlueprint',
    'createBlueprint'
  ]
  const portabilityEntries = ['exportDefinition', 'importDefinition']
  const definitionRoutes = definitionEntries.map(entry => ({ entry, path: reaches(methods, entry, edge => edge.path.startsWith(`this.${definitionField}.`)) }))
  const portabilityRoutes = portabilityEntries.map(entry => ({
    entry,
    path: reaches(methods, entry, edge => edge.path.startsWith(`this.${portabilityField}.`))
  }))
  const applyRoutes = [
    {
      entry: 'saveDefinition',
      path: reaches(methods, 'saveDefinition', edge => edge.path.startsWith(`this.${applyField}.`))
    }
  ]
  requireFact(
    definitionRoutes.every(item => item.path.length) && applyRoutes.every(item => item.path.length) && portabilityRoutes.every(item => item.path.length),
    'DOCUMENT_WIRING_INCOMPLETE',
    'Definition, apply and portability façade entries must reach their dedicated collaborators',
    [...definitionRoutes, ...applyRoutes, ...portabilityRoutes].filter(item => !item.path.length).map(item => graph.location(service, methods.get(item.entry), item.entry))
  )
  const definitionMethods = methodTable(definitionClass)
  const applyMethods = methodTable(applyClass)
  const portabilityMethods = methodTable(portabilityClass)
  requireFact(
    [
      'listDefinitions',
      'loadDefinition',
      'saveDefinition',
      'createDefinition',
      'deleteDefinition',
      'describeBlueprint',
      'validateBlueprint',
      'createBlueprint'
    ].every(method => definitionMethods.has(method)) &&
      ['exportConfigured', 'importConfigured', 'exportInternal', 'importInternal'].every(method => portabilityMethods.has(method)),
    'DOCUMENT_WIRING_INCOMPLETE',
    'Dedicated use-case collaborators must retain implemented authoring and portability methods'
  )
  requireFact(applyMethods.has('apply') && applyMethods.has('propose') && applyMethods.has('validate'), 'DOCUMENT_WIRING_INCOMPLETE', 'ApplyService must retain candidate validation, diff and CAS methods')
  requireFact(
    calls(definitionClass.body).some(call => member(call.callee)?.startsWith('this.context.documents.')) &&
      calls(portabilityClass.body).some(call => member(call.callee)?.startsWith('this.context.documents.')),
    'DOCUMENT_WIRING_INCOMPLETE',
    'Use-case collaborators must route document access through BlueprintDocumentLibrary'
  )
  const library = graph.load(resolve(graph.root, 'src/service/document-library.ts'))
  const libraryClass = graph.exported(library, 'BlueprintDocumentLibrary').declaration
  requireFact(libraryClass.type === 'ClassDeclaration', 'DOCUMENT_WIRING_INCOMPLETE', 'Expected implemented BlueprintDocumentLibrary class')
  const constructorBindings = [...service.imports].filter(
    ([, entry]) => entry.source === './service/document-library.ts' && entry.imported === 'BlueprintDocumentLibrary'
  )
  const creations = nodes(cl, node => node.type === 'NewExpression' && constructorBindings.some(([local]) => local === name(node.callee)))
  requireFact(creations.length === 1, 'DOCUMENT_INSTANCE_COUNT', 'Each Service must construct exactly one document/library collaborator')
  const creation = creations[0]
  let field
  walk(cl, node => {
    if (node.type === 'PropertyDefinition' && node.value === creation) field = name(node.key)
    if (node.type === 'AssignmentExpression' && node.right === creation && member(node.left)?.startsWith('this.')) field = member(node.left).slice(5)
  })
  requireFact(
    field &&
      (fields.some(node => name(node.key) === field && node.value === creation) ||
        nodes(methods.get('constructor'), node => node.type === 'AssignmentExpression' && node.right === creation).length),
    'DOCUMENT_INSTANCE_COUNT',
    'Document collaborator must be retained on this Service at construction'
  )
  const assignments = nodes(
    cl,
    node => ['AssignmentExpression', 'UpdateExpression'].includes(node.type) && member(node.left ?? node.argument) === `this.${field}`
  )
  requireFact(
    assignments.length <= (creation === fields.find(node => name(node.key) === field)?.value ? 0 : 1),
    'DOCUMENT_INSTANCE_COUNT',
    'Service replaces its document collaborator'
  )
  const libraryMethods = methodTable(libraryClass)
  const documentEntries = ['preflightRun', 'startConfiguredRun', 'startSessionRun', 'hostProbe']
  const routes = documentEntries.map(entry => ({
    entry,
    path: reaches(methods, entry, edge => {
      const parts = edge.path.split('.')
      return parts.length === 3 && parts[1] === field && libraryMethods.has(parts[2])
    })
  }))
  requireFact(
    routes.every(item => item.path.length),
    'DOCUMENT_WIRING_INCOMPLETE',
    'Every document facade/orchestrator must reach the same retained collaborator',
    routes.filter(item => !item.path.length).map(item => graph.location(service, methods.get(item.entry), item.entry))
  )
  for (const route of routes) {
    const target = route.path.at(-1).split('.').at(-1)
    const implementation = libraryMethods.get(target)
    callable(graph, { module: library, declaration: implementation.value }, target)
    requireFact(calls(implementation.value.body).length, 'BOUNDARY_IMPLEMENTATION_INVALID', `Collaborator ${target} has no operational calls`, [
      graph.location(library, implementation, target)
    ])
  }
  const forbiddenCalls = new Set([
    'saveDefinitionDocument',
    'loadDefinitionDocument',
    'loadDefinitionPackage',
    'readPackageFiles',
    'readLibraryDeletion',
    'writeLibraryDeletion',
    'publishPackage',
    'acquireLibraryWriter',
    'libraryIds',
    'libraryDocumentRoot'
  ])
  const bypass = calls(cl).filter(call => forbiddenCalls.has(service.imports.get(name(call.callee))?.imported ?? name(call.callee)))
  requireFact(
    !bypass.length,
    'DOCUMENT_QUEUE_BYPASS',
    'Service still performs document/library persistence outside its collaborator',
    bypass.map(node => graph.location(service, node, name(node.callee)))
  )
  const libraryFields = libraryClass.body.body.filter(node => node.type === 'PropertyDefinition')
  for (const method of ['withDocument', 'withLibraryMutation', 'drainLibrary'])
    requireFact(libraryMethods.has(method), 'DOCUMENT_QUEUE_OWNERSHIP', `Collaborator missing ${method}`)
  const queue = libraryMethods.get('withDocument')
  const queueFields = libraryFields.filter(field =>
    ['get', 'set', 'delete'].every(operation => thisCalls(queue).some(edge => edge.path === `this.${name(field.key)}.${operation}`))
  )
  requireFact(
    queueFields.length === 1 &&
      calls(queue).some(call => (library.imports.get(name(call.callee))?.imported ?? name(call.callee)) === 'realpathSync') &&
      thisCalls(queue).some(edge => edge.path === 'this.withLibraryMutation'),
    'DOCUMENT_QUEUE_OWNERSHIP',
    'Document scope must retain physical-root queue and mutation routing'
  )
  const mutation = libraryMethods.get('withLibraryMutation')
  const libraryTails = libraryFields.filter(field => thisCalls(mutation).some(edge => edge.path === `this.${name(field.key)}.then`))
  requireFact(
    libraryTails.length === 1 &&
      calls(mutation).some(call => (library.imports.get(name(call.callee))?.imported ?? name(call.callee)) === 'acquireLibraryWriter') &&
      nodes(mutation, node => node.type === 'TryStatement' && node.finalizer && calls(node.finalizer).some(call => member(call.callee)?.endsWith('.release')))
        .length,
    'DOCUMENT_LEASE_LIFECYCLE',
    'Library mutation must chain its tail and release writer in finally'
  )
  requireFact(
    nodes(
      libraryMethods.get('drainLibrary'),
      node => ['AwaitExpression', 'ReturnStatement'].includes(node.type) && member(node.argument) === `this.${name(libraryTails[0].key)}`
    ).length,
    'DOCUMENT_DRAIN_MISSING',
    'Collaborator drain must observe its actual library tail'
  )
  const ctor = methods.get('constructor')
  const drains = nodes(ctor, node => node.type === 'AwaitExpression' && member(node.argument?.callee) === `this.${field}.drainLibrary`)
  const openingWait = nodes(ctor, node => node.type === 'AwaitExpression' && nodes(node, child => member(child) === 'this.opening').length)
  const closing = nodes(ctor, node => node.type === 'AssignmentExpression' && member(node.left) === 'this.closing' && node.right.value === true)
  requireFact(
    drains.length === 1 && openingWait.length && closing.some(node => node.start < drains[0].start) && drains[0].start < openingWait[0].start,
    'DOCUMENT_DRAIN_MISSING',
    'Service disposal must await collaborator drain after closing and before opening/runtime cleanup'
  )
  const visited = new Set()
  function inspect(module) {
    if (visited.has(module.path)) return
    visited.add(module.path)
    for (const item of module.ast.body) {
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(item.type) || !item.source?.value.startsWith('.')) continue
      const dependency = graph.importedModule(module, { source: item.source.value, node: item })
      requireFact(dependency.path !== service.path, 'DOCUMENT_REVERSE_DEPENDENCY', 'Document collaborator graph imports the Service facade', [
        graph.location(module, item, item.source.value)
      ])
      inspect(dependency)
    }
  }
  inspect(library)
  return [
    graph.location(service, creation, `this.${field}`),
    ...routes.map(item => ({ ...graph.location(service, methods.get(item.entry), item.entry), calls: item.path })),
    ...applyRoutes.map(item => ({ ...graph.location(service, methods.get(item.entry), item.entry), calls: item.path })),
    graph.location(service, drains[0], `await this.${field}.drainLibrary`)
  ]
}

/** Inspector's direct view boundary deliberately stops at legitimate child controls. */
function inspector(graph) {
  const facade = graph.load(resolve(graph.root, 'src/client/features/authoring/ui/inspector/inspector-composition.tsx'))
  const renderer = graph.exported(facade, 'renderNodeInspector')
  const render = callable(graph, renderer, 'renderNodeInspector')
  const sessionCommands = new Set([
    'bindResource',
    'patch',
    'setPort',
    'removePort',
    'addPort',
    'applyPorts',
    'setExplicitModel',
    'setModelRoute',
    'applyModelRoute',
    'setPortVisibility',
    'setJson',
    'applyJson'
  ])
  const centralized = calls(render.body).filter(call => sessionCommands.has(name(call.callee.property)))
  requireFact(
    !centralized.length,
    'INSPECTOR_DISPATCH_STILL_CENTRALIZED',
    'Inspector renderer must delegate typed commands to its adapter',
    centralized.map(call => graph.location(facade, call, member(call.callee)))
  )
  function route(source) {
    const candidates = calls(render.body).filter(
      call => call.callee.type === 'Identifier' && facade.imports.get(call.callee.name)?.source === source && !facade.imports.get(call.callee.name)?.typeOnly
    )
    requireFact(candidates.length, 'INSPECTOR_PRODUCTION_WIRING_MISSING', `Inspector renderer must call its actual ${source} binding`, [
      graph.location(facade, render, 'renderNodeInspector')
    ])
    const resolved = graph.binding(facade, candidates[0].callee)
    return { ...resolved, fn: callable(graph, resolved, facade.imports.get(candidates[0].callee.name).imported), call: candidates[0] }
  }
  const projection = route('../../presenters/inspector-presenter.ts'),
    view = route('./inspector-view.tsx'),
    adapter = route('../../logic/inspector/inspector-command-adapter.ts')
  const runtimeImports = module =>
    module.ast.body.filter(
      item =>
        item.type === 'ImportDeclaration' &&
        item.importKind !== 'type' &&
        (!item.specifiers.length || item.specifiers.some(specifier => specifier.importKind !== 'type'))
    )
  function pure(module, role) {
    for (const item of runtimeImports(module)) {
      const source = item.source.value
      const forbidden =
        /^(?:react(?:-dom)?(?:\/|$)|@codemirror\/|@xyflow\/)/.test(source) ||
        /(?:^|\/)(?:inspector-session|inspector|workspace|remote|graph-editor|.*browser.*)\.[cm]?[jt]sx?$/.test(source)
      requireFact(!forbidden, 'INSPECTOR_PURE_DEPENDENCY', `${role} imports a runtime adapter`, [graph.location(module, item, source)])
    }
    directEffects(module, role, false)
  }
  function directEffects(module, role, isView) {
    const globals = new Set([
      'window',
      'document',
      'localStorage',
      'fetch',
      'MutationObserver',
      'ResizeObserver',
      'IntersectionObserver',
      'BlueprintWorkspace',
      'GraphEditor',
      'InspectorSession'
    ])
    walk(module.ast, (node, parents) => {
      if (
        parents.some(
          parent => (parent.type === 'ImportDeclaration' && parent.importKind === 'type') || (parent.type === 'ImportSpecifier' && parent.importKind === 'type')
        )
      )
        return
      if (parents.some(parent => parent.type.startsWith('TS') && !['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression'].includes(parent.type)))
        return
      if (node.type === 'Identifier') {
        const parent = parents.at(-1)
        const property = parent?.type === 'MemberExpression' && parent.property === node && !parent.computed
        requireFact(property || !globals.has(node.name), 'INSPECTOR_DIRECT_EFFECT', `${role} references a browser or controller runtime`, [
          graph.location(module, node, node.name)
        ])
      }
      if (node.type === 'CallExpression') {
        const operation = name(node.callee.property)
        const forbidden = new Set([
          'useEffect',
          'useLayoutEffect',
          'useMemo',
          'useSyncExternalStore',
          'saveDefinition',
          'loadDefinition',
          'startRun',
          'importDefinition',
          'focus',
          'getBoundingClientRect',
          'setItem'
        ])
        if (isView || role === 'commands' || role === 'presenter')
          for (const command of [...sessionCommands, 'updateNode', 'updateResource', 'patchPresentation', 'transaction', 'dispatch']) forbidden.add(command)
        requireFact(!forbidden.has(operation), 'INSPECTOR_DIRECT_MUTATION', `${role} invokes a forbidden side effect`, [
          graph.location(module, node, operation)
        ])
      }
    })
  }
  pure(projection.module, 'presenter')
  const commands = graph.load(resolve(graph.root, 'src/client/features/authoring/logic/inspector/inspector-commands.ts'))
  pure(commands, 'commands')
  for (const symbol of ['parseInspectorJson', 'deriveInspectorPatch']) callable(graph, graph.exported(commands, symbol), symbol)
  for (const item of runtimeImports(view.module))
    requireFact(
      !/(?:^|\/)(?:inspector-session|inspector-command-adapter|inspector|workspace|remote|graph-editor)\.[cm]?[jt]sx?$/.test(item.source.value),
      'INSPECTOR_VIEW_ADAPTER_DEPENDENCY',
      'Inspector view cannot import a command/runtime adapter',
      [graph.location(view.module, item, item.source.value)]
    )
  directEffects(view.module, 'view', true)
  const markup = nodes(view.fn.body, node => node.type === 'JSXElement' || node.type === 'JSXFragment')
  const emitParam = view.fn.params[2]
  requireFact(
    markup.length && emitParam?.type === 'Identifier' && calls(view.fn.body).some(call => member(call.callee) === emitParam.name),
    'INSPECTOR_VIEW_CONTRACT_MISSING',
    'Inspector view must render markup and emit typed intents',
    [graph.location(view.module, view.fn, 'inspectorView')]
  )
  const returnedFields = new Set(
    nodes(projection.fn.body, node => node.type === 'ReturnStatement' && unwrap(node.argument)?.type === 'ObjectExpression').flatMap(node =>
      unwrap(node.argument)
        .properties.filter(item => item.type === 'Property')
        .map(item => name(item.key))
    )
  )
  requireFact(
    ['node', 'choices', 'snapshot', 'capability', 'disabled'].every(field => returnedFields.has(field)),
    'INSPECTOR_PROJECTION_CONTRACT_MISSING',
    'Inspector presenter must return its actual display contract',
    [graph.location(projection.module, projection.fn, 'projectInspector')]
  )
  pure(adapter.module, 'adapter')
  const dispatched = calls(adapter.fn.body).filter(call => sessionCommands.has(name(call.callee.property)))
  requireFact(
    dispatched.length &&
      calls(adapter.fn.body).some(call => name(call.callee.property) === 'isCurrent') &&
      calls(adapter.fn.body).some(call => name(call.callee.property) === 'isDisabled'),
    'INSPECTOR_COMMAND_DISPATCH_MISSING',
    'Inspector command adapter must guard admission and route to actual session commands',
    [graph.location(adapter.module, adapter.fn, 'dispatchInspectorIntent')]
  )
  return [
    graph.location(facade, render, 'renderNodeInspector'),
    ...[projection, view, adapter].map(target => graph.location(target.module, target.fn, target.fn.id?.name ?? 'inspector boundary')),
    ...dispatched.map(call => graph.location(adapter.module, call, member(call.callee)))
  ]
}

/** Conversation is a read-only seat: the controller owns observation and the
 * canvas owns frozen DTO -> XYFlow projection, while the view only composes
 * pure presenters and renderer/attempt subviews. */
function conversation(graph) {
  const view = graph.load(resolve(graph.root, 'src/client/features/conversation/ui/conversation-view.tsx'))
  const entry = graph.exported(view, 'ConversationBlueprintView')
  const render = callable(graph, entry, 'ConversationBlueprintView')
  const required = [
    ['./conversation-renderers.tsx', ['FrozenNode', 'FrozenGroup', 'FrozenEdge', 'frozenContentShape', 'nodeTypes', 'edgeTypes']],
    ['./conversation-attempts.tsx', ['renderConversationAttempts']],
    ['../presenters/conversation-presenter.ts', ['displayState', 'presentConversation']]
  ]
  const importsFor = source => [...view.imports].filter(([, item]) => item.source === source && !item.typeOnly)
  const missing = required.filter(([source]) => importsFor(source).length === 0)
  if (missing.length) {
    throw new BoundaryOracleError('CONVERSATION_VIEW_CENTRALIZED', 'Conversation view still owns renderer, TeamStage, attempts or display projection roles', [
      graph.location(view, render, `missing extracted role imports: ${missing.map(([source]) => source).join(', ')}`)
    ])
  }
  const declarations = new Set(view.declarations.filter(item => item.parents.some(parent => parent.type === 'Program')).map(item => item.name))
  const inlineRoles = ['FrozenNode', 'FrozenGroup', 'FrozenEdge', 'frozenContentShape', 'renderTeamStage', 'displayState']
  requireFact(
    !inlineRoles.some(role => declarations.has(role)),
    'CONVERSATION_VIEW_CENTRALIZED',
    'Conversation view still declares an extracted renderer or projection role',
    inlineRoles.filter(role => declarations.has(role)).map(role => graph.location(view, view.declarations.find(item => item.name === role).node, role))
  )
  const callImport = (source, imported) => {
    const local = importsFor(source).find(([, item]) => item.imported === imported)?.[0]
    requireFact(local, 'CONVERSATION_PRODUCTION_WIRING_MISSING', `Conversation view must import ${imported} from ${source}`)
    const callsTo = calls(render.body).filter(call => call.callee.type === 'Identifier' && call.callee.name === local)
    requireFact(callsTo.length > 0, 'CONVERSATION_PRODUCTION_WIRING_MISSING', `Conversation view must consume ${imported}`)
    return { local, calls: callsTo }
  }
  const projection = callImport('../presenters/conversation-presenter.ts', 'presentConversation')
  callImport('./conversation-renderers.tsx', 'frozenContentShape')
  callImport('../presenters/conversation-presenter.ts', 'displayState')
  callImport('./conversation-attempts.tsx', 'renderConversationAttempts')
  for (const symbol of ['nodeTypes', 'edgeTypes']) {
    const local = importsFor('./conversation-renderers.tsx').find(([, item]) => item.imported === symbol)?.[0]
    requireFact(local, 'CONVERSATION_PRODUCTION_WIRING_MISSING', `Conversation view must import ${symbol} from the renderer module`)
    requireFact(
      nodes(render.body, node => node.type === 'Identifier' && node.name === local).length > 0,
      'CONVERSATION_PRODUCTION_WIRING_MISSING',
      `Conversation view must consume the ${symbol} renderer map`
    )
  }
  for (const [source, names] of required) {
    const moduleImport = importsFor(source)[0]
    const module = graph.importedModule(view, moduleImport[1])
    graph.validateImports(module)
    for (const symbol of names) {
      const resolved = graph.exported(module, symbol)
      if (
        [
          'FrozenNode',
          'FrozenGroup',
          'FrozenEdge',
          'frozenContentShape',
          'renderTeamStage',
          'renderConversationAttempts',
          'displayState',
          'presentConversation'
        ].includes(symbol)
      )
        callable(graph, resolved, symbol)
    }
  }
  const renderer = graph.importedModule(view, importsFor('./conversation-renderers.tsx')[0][1])
  const rendererRuntime = renderer.ast.body.filter(
    item => item.type === 'ImportDeclaration' && item.importKind !== 'type' && item.specifiers.some(specifier => specifier.importKind !== 'type')
  )
  requireFact(
    !rendererRuntime.some(item =>
      /(?:^|\/)(?:conversation-view|conversation-controller|conversation-attempts|conversation-team-stage)\.[cm]?[jt]sx?$/.test(item.source.value)
    ),
    'CONVERSATION_RENDERER_COORDINATION_DEPENDENCY',
    'Conversation renderers cannot import the view, controller or sibling coordination view',
    rendererRuntime
      .filter(item =>
        /(?:^|\/)(?:conversation-view|conversation-controller|conversation-attempts|conversation-team-stage)\.[cm]?[jt]sx?$/.test(item.source.value)
      )
      .map(item => graph.location(renderer, item, item.source.value))
  )
  const attemptsModule = graph.importedModule(view, importsFor('./conversation-attempts.tsx')[0][1])
  const attemptsImport = attemptsModule.imports.get('renderTeamStage')
  requireFact(
    attemptsImport?.source === './conversation-team-stage.tsx' && !attemptsImport.typeOnly,
    'CONVERSATION_ATTEMPTS_WIRING_MISSING',
    'Conversation attempts view must own the TeamStage composition through its extracted renderer'
  )
  const attemptsFn = graph.exported(attemptsModule, 'renderConversationAttempts')
  const attemptsBody = callable(graph, attemptsFn, 'renderConversationAttempts')
  requireFact(
    calls(attemptsBody).some(call => call.callee.type === 'Identifier' && call.callee.name === 'renderTeamStage'),
    'CONVERSATION_ATTEMPTS_WIRING_MISSING',
    'Conversation attempts view must render the TeamStage projection'
  )
  const teamStageModule = graph.importedModule(attemptsModule, attemptsImport)
  graph.validateImports(teamStageModule)
  callable(graph, graph.exported(teamStageModule, 'renderTeamStage'), 'renderTeamStage')
  const presenter = graph.importedModule(view, importsFor('../presenters/conversation-presenter.ts')[0][1])
  const presenterRuntime = presenter.ast.body.filter(
    item => item.type === 'ImportDeclaration' && item.importKind !== 'type' && item.specifiers.some(specifier => specifier.importKind !== 'type')
  )
  requireFact(
    !presenterRuntime.some(item => /^(?:react(?:\/|$)|@xyflow\/|.*conversation-(?:view|controller|canvas)\.)/.test(item.source.value)),
    'CONVERSATION_PRESENTER_DEPENDENCY',
    'Conversation presenter must remain a pure snapshot/display projection',
    presenterRuntime
      .filter(item => /^(?:react(?:\/|$)|@xyflow\/|.*conversation-(?:view|controller|canvas)\.)/.test(item.source.value))
      .map(item => graph.location(presenter, item, item.source.value))
  )
  const forbiddenGlobals = nodes(
    presenter.ast,
    node => node.type === 'Identifier' && ['window', 'document', 'navigator', 'fetch', 'BlueprintWorkspace', 'ConversationController'].includes(node.name)
  )
  requireFact(
    !forbiddenGlobals.length,
    'CONVERSATION_PRESENTER_EFFECT',
    'Conversation presenter references browser or controller state',
    forbiddenGlobals.map(node => graph.location(presenter, node, node.name))
  )
  const display = graph.exported(presenter, 'displayState')
  const project = graph.exported(presenter, 'presentConversation')
  callable(graph, display, 'displayState')
  callable(graph, project, 'presentConversation')
  const returned = new Set(
    nodes(functionOf(project.declaration).body, node => node.type === 'ReturnStatement' && unwrap(node.argument)?.type === 'ObjectExpression').flatMap(node =>
      unwrap(node.argument)
        .properties.filter(item => item.type === 'Property')
        .map(item => name(item.key))
    )
  )
  requireFact(
    ['value', 'connection', 'bound', 'status'].every(field => returned.has(field)),
    'CONVERSATION_PRESENTER_CONTRACT_MISSING',
    'Conversation presenter must return the stable view projection fields',
    [graph.location(presenter, project.declaration, 'presentConversation')]
  )
  return [
    graph.location(view, render, 'ConversationBlueprintView'),
    graph.location(view, projection.calls[0], 'presentConversation'),
    graph.location(attemptsModule, attemptsFn.declaration, 'renderConversationAttempts'),
    graph.location(teamStageModule, graph.exported(teamStageModule, 'renderTeamStage').declaration, 'renderTeamStage'),
    graph.location(presenter, project.declaration, 'presentConversation'),
    graph.location(renderer, graph.exported(renderer, 'FrozenNode').declaration, 'FrozenNode'),
    graph.location(renderer, graph.exported(renderer, 'FrozenGroup').declaration, 'FrozenGroup'),
    graph.location(renderer, graph.exported(renderer, 'FrozenEdge').declaration, 'FrozenEdge')
  ]
}

/** Locale dictionaries are assembled from feature namespaces.  The registry
 * owns only the namespace registration and parity assembly; copy stays in the
 * canonical namespace modules. */
function locale(graph) {
  const registry = graph.load(resolve(graph.root, 'src/client/shared/i18n/locales.ts'))
  const namespaces = ['./conversation.ts', './commands.ts', './interaction.ts', './resources.ts', './inspector.ts', './document.ts', './history.ts']
  const runtimeImports = source => [...registry.imports].filter(([, entry]) => entry.source === source && !entry.typeOnly)
  const missing = namespaces.filter(source => runtimeImports(source).length === 0)
  if (missing.length) {
    throw new BoundaryOracleError('LOCALE_NAMESPACE_CENTRALIZED', 'Locale registry still owns one or more namespace dictionaries', [
      graph.location(registry, registry.ast, `missing namespace imports: ${missing.join(', ')}`)
    ])
  }

  const objectDeclaration = (module, symbol) => {
    const exported = graph.exported(module, symbol)
    const declaration = exported.declaration
    const init = declaration.type === 'VariableDeclarator' ? unwrap(declaration.init) : undefined
    requireFact(init?.type === 'ObjectExpression', 'LOCALE_NAMESPACE_CONTRACT_MISSING', `${symbol} must be an object dictionary`, [
      graph.location(module, declaration, symbol)
    ])
    return { module, declaration, object: init }
  }
  const objectKeys = object =>
    new Set(
      object.properties
        .filter(property => property.type === 'Property' && !property.computed && (property.key.type === 'Identifier' || property.key.type === 'Literal'))
        .map(property => name(property.key))
    )
  const namespaceObjects = []
  for (const source of namespaces) {
    const imported = graph.importedModule(registry, runtimeImports(source)[0][1])
    graph.validateImports(imported)
    const zh = objectDeclaration(imported, 'zh')
    const en = objectDeclaration(imported, 'en')
    const zhKeys = objectKeys(zh.object)
    const enKeys = objectKeys(en.object)
    requireFact(zhKeys.size === enKeys.size && [...zhKeys].every(key => enKeys.has(key)), 'LOCALE_KEY_MISMATCH', `Locale namespace keys differ in ${source}`, [
      graph.location(imported, zh.object, `${source}:zh`),
      graph.location(imported, en.object, `${source}:en`)
    ])
    requireFact(zhKeys.size > 0, 'LOCALE_NAMESPACE_CONTRACT_MISSING', `Locale namespace is empty: ${source}`, [graph.location(imported, zh.object, source)])
    namespaceObjects.push({ source, zh: zhKeys, en: enKeys })
  }

  const registryZh = objectDeclaration(registry, 'zh')
  const registryEn = objectDeclaration(registry, 'en')
  const spreads = object =>
    object.properties.filter(property => property.type === 'SpreadElement' && property.argument.type === 'Identifier').map(property => property.argument.name)
  for (const [symbol, object] of [
    ['zh', registryZh.object],
    ['en', registryEn.object]
  ]) {
    const spreadNames = new Set(spreads(object))
    for (const source of namespaces) {
      const imported = runtimeImports(source).find(([, entry]) => entry.imported === symbol)?.[1]
      const namespaceLocal = imported && [...registry.imports].find(([, entry]) => entry === imported)?.[0]
      requireFact(namespaceLocal && spreadNames.has(namespaceLocal), 'LOCALE_REGISTRY_WIRING_MISSING', `Locale registry ${symbol} does not spread ${source}`, [
        graph.location(registry, object, `${symbol} namespace assembly`)
      ])
    }
  }
  const combined = key => new Set(namespaceObjects.flatMap(namespace => [...namespace[key]]))
  const directKeys = object => objectKeys(object)
  for (const [symbol, object] of [
    ['zh', registryZh.object],
    ['en', registryEn.object]
  ]) {
    const direct = directKeys(object)
    const expected = combined(symbol)
    requireFact(
      [...direct].every(key => expected.has(key)) && direct.size === 0,
      'LOCALE_REGISTRY_WIRING_MISSING',
      `Locale registry ${symbol} must contain only namespace spreads`,
      [graph.location(registry, object, `${symbol} namespace assembly`)]
    )
  }
  requireFact(
    combined('zh').size === combined('en').size && [...combined('zh')].every(key => combined('en').has(key)),
    'LOCALE_KEY_MISMATCH',
    'Combined locale namespace keys differ'
  )
  return [
    graph.location(registry, registryZh.object, 'zh namespace registry'),
    graph.location(registry, registryEn.object, 'en namespace registry'),
    ...namespaceObjects.flatMap(namespace => [
      { path: namespace.source, line: 1, symbol: `${namespace.source}:zh` },
      { path: namespace.source, line: 1, symbol: `${namespace.source}:en` }
    ])
  ]
}

/** Styles are grouped by owner while one installer retains the DOM lifecycle. */
function styles(graph) {
  const registry = graph.load(resolve(graph.root, 'src/client/shared/styles/styles.ts'))
  const fragments = [
    ['./base.ts', 'baseCss'],
    ['./canvas.ts', 'canvasCss'],
    ['./panel.ts', 'panelCss']
  ]
  const runtimeImports = source => [...registry.imports].filter(([, entry]) => entry.source === source && !entry.typeOnly)
  const missing = fragments.filter(([source]) => runtimeImports(source).length === 0)
  if (missing.length) {
    throw new BoundaryOracleError('STYLE_FRAGMENT_CENTRALIZED', 'Canvas style registry still owns one or more style fragments', [
      graph.location(registry, registry.ast, `missing fragment imports: ${missing.map(([source]) => source).join(', ')}`)
    ])
  }
  const conversation = graph.load(resolve(graph.root, 'src/client/shared/styles/conversation.ts'))
  const feature = graph.load(resolve(graph.root, 'src/client/features/conversation/ui/conversation-styles.ts'))
  const exportedObject = (module, symbol) => {
    const resolved = graph.exported(module, symbol)
    const declaration = resolved.declaration
    const init = declaration.type === 'VariableDeclarator' ? unwrap(declaration.init) : undefined
    requireFact(
      init && ['TemplateLiteral', 'Literal', 'BinaryExpression'].includes(init.type),
      'STYLE_FRAGMENT_CONTRACT_MISSING',
      `${symbol} must be CSS text`,
      [graph.location(module, declaration, symbol)]
    )
    requireFact(readFileSync(module.path, 'utf8').trim().length > 0, 'STYLE_FRAGMENT_CONTRACT_MISSING', `Style fragment is empty: ${symbol}`)
    return resolved
  }
  for (const [source, symbol] of fragments) {
    const imported = graph.importedModule(registry, runtimeImports(source)[0][1])
    graph.validateImports(imported)
    exportedObject(imported, symbol)
    const local = [...registry.imports].find(([, entry]) => entry.source === source && entry.imported === symbol)?.[0]
    requireFact(local, 'STYLE_REGISTRY_WIRING_MISSING', `Style registry must import ${symbol} from ${source}`)
    const installer = graph.exported(registry, 'installCanvasStyles')
    const fn = callable(graph, installer, 'installCanvasStyles')
    requireFact(
      nodes(fn.body, node => node.type === 'Identifier' && node.name === local).length > 0,
      'STYLE_REGISTRY_WIRING_MISSING',
      `Style installer must consume ${symbol}`,
      [graph.location(registry, fn, 'installCanvasStyles')]
    )
  }
  const conversationImport = [...feature.imports].find(([, entry]) => entry.source === '../../../shared/styles/conversation.ts' && !entry.typeOnly)
  requireFact(conversationImport, 'STYLE_CONVERSATION_WIRING_MISSING', 'Conversation style owner must consume shared conversation CSS')
  const conversationLocal = conversationImport[0]
  const conversationExport = graph.exported(conversation, 'conversationCss')
  exportedObject(conversation, 'conversationCss')
  requireFact(
    nodes(graph.exported(feature, 'installConversationStyles').declaration, node => node.type === 'Identifier' && node.name === conversationLocal).length > 0,
    'STYLE_CONVERSATION_WIRING_MISSING',
    'Conversation style installer must consume shared conversation CSS'
  )
  return [
    graph.location(registry, graph.exported(registry, 'installCanvasStyles').declaration, 'installCanvasStyles'),
    ...fragments.map(([source, symbol]) => ({ path: `src/client/shared/styles/${source.slice(2)}`, line: 1, symbol })),
    graph.location(conversation, conversationExport.declaration, 'conversationCss')
  ]
}

/** Traverse every canonical TypeScript source, classify deleted flat-path
 * imports before generic source failures, and reject direct client-root
 * implementation files. This is an import-graph oracle only: it does not
 * execute source or claim package/host behavior. */
function canonicalSourceGraph(graph) {
  const sourceRoot = resolve(graph.root, 'src')
  const clientRoot = resolve(sourceRoot, 'client')
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx']
  const files = []
  const collect = directory => {
    requireFact(existsSync(directory), 'SOURCE_UNAVAILABLE', `Required source directory unavailable: ${relative(graph.root, directory)}`)
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, item.name)
      if (item.isDirectory()) collect(path)
      else if (item.isFile() && /\.(?:ts|tsx)$/.test(item.name)) files.push(path)
    }
  }
  // The W3.1 contract is the client source graph. Imports into server/domain
  // modules are resolved and parsed below, while their independent runtime
  // cycles remain outside this client-boundary oracle.
  requireFact(existsSync(sourceRoot), 'SOURCE_UNAVAILABLE', 'Canonical source root is unavailable')
  collect(clientRoot)
  const legacy = readdirSync(clientRoot, { withFileTypes: true })
    .filter(item => item.isFile() && /\.(?:ts|tsx)$/.test(item.name) && item.name !== 'index.ts')
    .map(item => resolve(clientRoot, item.name))
  requireFact(
    legacy.length === 0,
    'LEGACY_PATH_PRESENT',
    'Direct client-root implementation path remains after canonical migration',
    legacy.map(path => ({ path: relative(graph.root, path), line: 1, symbol: 'legacy root implementation' }))
  )

  const resolveLocal = (modulePath, source) => {
    const candidate = resolve(dirname(modulePath), source)
    const choices = [candidate, ...extensions.slice(1).map(extension => `${candidate}${extension}`)]
    return choices.find(path => existsSync(path) && statSync(path).isFile())
  }
  const isLegacyCandidate = path => dirname(path) === clientRoot && path !== resolve(clientRoot, 'index.ts')
  const isTypeOnly = item =>
    item.importKind === 'type' ||
    item.exportKind === 'type' ||
    (item.type === 'ImportDeclaration' && item.specifiers.length > 0 && item.specifiers.every(specifier => specifier.importKind === 'type'))
  const modules = new Map()
  const dependencies = new Map()
  for (const path of files.sort()) {
    const module = graph.load(path)
    modules.set(path, module)
    const local = []
    for (const item of module.ast.body.filter(
      node => ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source
    )) {
      const source = item.source.value
      if (source.startsWith('.')) {
        const candidate = resolve(dirname(path), source)
        const target = resolveLocal(path, source)
        requireFact(
          target,
          isLegacyCandidate(candidate) ? 'SOURCE_PATH_STALE' : 'SOURCE_UNAVAILABLE',
          isLegacyCandidate(candidate) ? `Canonical source still references deleted flat path: ${source}` : `Required local source unavailable: ${source}`,
          [{ path: relative(graph.root, path), line: module.source.slice(0, item.start).split('\n').length, symbol: source }]
        )
        if (!isTypeOnly(item) && target.startsWith(`${clientRoot}/`)) local.push(target)
      } else if (!isTypeOnly(item)) {
        try {
          createRequire(path).resolve(source)
        } catch {
          throw new BoundaryOracleError('IMPORT_UNAVAILABLE', `Production runtime import cannot be resolved: ${source}`, [
            { path: relative(graph.root, path), line: module.source.slice(0, item.start).split('\n').length, symbol: source }
          ])
        }
      }
    }
    dependencies.set(path, local)
  }

  const states = new Map()
  const stack = []
  const visit = path => {
    const state = states.get(path)
    if (state === 1) {
      const start = stack.indexOf(path)
      const cycle = [...stack.slice(start), path]
      throw new BoundaryOracleError('IMPORT_CYCLE', `Canonical source graph contains a cycle: ${cycle.map(item => relative(graph.root, item)).join(' -> ')}`, [
        { path: relative(graph.root, stack.at(-1)), line: 1, symbol: `cycle -> ${relative(graph.root, path)}` }
      ])
    }
    if (state === 2) return
    states.set(path, 1)
    stack.push(path)
    for (const dependency of dependencies.get(path) ?? []) visit(dependency)
    stack.pop()
    states.set(path, 2)
  }
  for (const path of files) visit(path)
  const entry = resolve(clientRoot, 'index.ts')
  requireFact(modules.has(entry), 'SOURCE_UNAVAILABLE', 'Canonical client public entry is unavailable')
  const localEdgeCount = [...dependencies.values()].reduce((sum, entries) => sum + entries.length, 0)
  return [{ path: relative(graph.root, entry), line: 1, symbol: `canonical source graph (${files.length} modules, ${localEdgeCount} local edges)` }]
}

/** Results are JSON-serializable. Unexpected I/O/parser failures never become
 * BOUNDARY_STILL_CENTRALIZED. root supports isolated source-copy calibration.
 */
function workspaceNavigationUseCases(graph) {
  const facade = graph.load(resolve(graph.root, 'src/client/features/authoring/logic/workspace/workspace-controller.ts'))
  const evidence = []
  for (const methodName of ['newDraft', 'initialize', 'load']) {
    const method = nodes(facade.ast, node => node.type === 'MethodDefinition' && name(node.key) === methodName)[0]
    requireFact(method, 'WORKSPACE_NAVIGATION_FACADE_MISSING', `Workspace ${methodName} facade is required`)
    const delegated = calls(method).filter(
      call => call.callee.type === 'Identifier' && facade.imports.get(call.callee.name)?.source === './workspace-document-navigation.ts'
    )
    requireFact(delegated.length > 0, 'WORKSPACE_NAVIGATION_USE_CASE_STILL_CENTRALIZED', `${methodName} still owns navigation instead of delegating`, [
      graph.location(facade, method, methodName)
    ])
    requireFact(
      delegated.length === 1 && nodes(method, node => node.type === 'ReturnStatement' && unwrap(node.argument) === delegated[0]).length === 1,
      'WORKSPACE_NAVIGATION_USE_CASE_WIRING_MISSING',
      `${methodName} must return its real navigation owner result`
    )
    const target = graph.binding(facade, delegated[0].callee)
    const fn = functionOf(target.declaration)
    requireFact(
      fn && fn.body.type === 'BlockStatement' && fn.body.body.some(statement => statement.type !== 'ReturnStatement'),
      'WORKSPACE_NAVIGATION_USE_CASE_OWNER_MISSING',
      `${methodName} requires a callable nonempty navigation owner`
    )
    evidence.push(graph.location(facade, method, methodName), graph.location(target.module, fn, name(delegated[0].callee)))
  }
  requireFact(
    new Set(evidence.filter(entry => entry.path.endsWith('workspace-document-navigation.ts')).map(entry => entry.line)).size === 3,
    'WORKSPACE_NAVIGATION_USE_CASE_OWNER_MISSING',
    'Three navigation operations must resolve distinct owner callables'
  )
  return evidence
}

function workspaceDocumentUseCases(graph) {
  const facade = graph.load(resolve(graph.root, 'src/client/features/authoring/logic/workspace/workspace-controller.ts'))
  const evidence = []
  for (const methodName of ['save', 'deleteCurrent', 'exportArchive', 'importArchive']) {
    const method = nodes(facade.ast, node => node.type === 'MethodDefinition' && name(node.key) === methodName)[0]
    requireFact(method, 'WORKSPACE_DOCUMENT_FACADE_MISSING', `Workspace ${methodName} facade is required`)
    const delegated = calls(method).filter(
      call => call.callee.type === 'Identifier' && facade.imports.get(call.callee.name)?.source === './workspace-document-writes.ts'
    )
    requireFact(delegated.length > 0, 'WORKSPACE_DOCUMENT_USE_CASE_STILL_CENTRALIZED', `${methodName} still owns document write instead of delegating`, [
      graph.location(facade, method, methodName)
    ])
    requireFact(
      delegated.length === 1 && nodes(method, node => node.type === 'ReturnStatement' && unwrap(node.argument) === delegated[0]).length === 1,
      'WORKSPACE_DOCUMENT_USE_CASE_WIRING_MISSING',
      `${methodName} must return its real document write owner result`
    )
    const target = graph.binding(facade, delegated[0].callee)
    const fn = functionOf(target.declaration)
    requireFact(
      fn && fn.body.type === 'BlockStatement' && fn.body.body.some(statement => statement.type !== 'ReturnStatement'),
      'WORKSPACE_DOCUMENT_USE_CASE_OWNER_MISSING',
      `${methodName} requires a callable nonempty document write owner`
    )
    evidence.push(graph.location(facade, method, methodName), graph.location(target.module, fn, name(delegated[0].callee)))
  }
  requireFact(
    new Set(evidence.filter(entry => entry.path.endsWith('workspace-document-writes.ts')).map(entry => entry.line)).size === 4,
    'WORKSPACE_DOCUMENT_USE_CASE_OWNER_MISSING',
    'Four document write operations must resolve distinct owner callables'
  )
  return evidence
}

function workspaceRunUseCases(graph) {
  const facade = graph.load(resolve(graph.root, 'src/client/features/authoring/logic/workspace/workspace-controller.ts'))
  const evidence = []
  for (const methodName of ['checkRun', 'run', 'inspect', 'cancel', 'decide']) {
    const method = nodes(facade.ast, node => node.type === 'MethodDefinition' && name(node.key) === methodName)[0]
    requireFact(method, 'WORKSPACE_RUN_FACADE_MISSING', `Workspace ${methodName} facade is required`)
    const delegated = calls(method).filter(
      call => call.callee.type === 'Identifier' && facade.imports.get(call.callee.name)?.source === '../run/workspace-run-use-cases.ts'
    )
    requireFact(delegated.length > 0, 'WORKSPACE_RUN_USE_CASE_STILL_CENTRALIZED', `${methodName} still owns run orchestration instead of delegating`, [
      graph.location(facade, method, methodName)
    ])
    requireFact(
      delegated.length === 1 && nodes(method, node => node.type === 'ReturnStatement' && unwrap(node.argument) === delegated[0]).length === 1,
      'WORKSPACE_RUN_USE_CASE_WIRING_MISSING',
      `${methodName} must return its real run owner result`
    )
    const target = graph.binding(facade, delegated[0].callee)
    const fn = functionOf(target.declaration)
    requireFact(
      fn && fn.body.type === 'BlockStatement' && fn.body.body.some(statement => statement.type !== 'ReturnStatement'),
      'WORKSPACE_RUN_USE_CASE_OWNER_MISSING',
      `${methodName} requires a callable nonempty run owner`
    )
    evidence.push(graph.location(facade, method, methodName), graph.location(target.module, fn, name(delegated[0].callee)))
  }
  requireFact(
    new Set(evidence.filter(entry => entry.path.endsWith('workspace-run-use-cases.ts')).map(entry => entry.line)).size === 5,
    'WORKSPACE_RUN_USE_CASE_OWNER_MISSING',
    'Five run operations must resolve distinct owner callables'
  )
  return evidence
}

function workspaceUseCases(graph, slice) {
  if (slice === 'navigation') return workspaceNavigationUseCases(graph)
  if (slice === 'documents') return workspaceDocumentUseCases(graph)
  if (slice === 'run') return workspaceRunUseCases(graph)
  requireFact(slice === 'resources', 'WORKSPACE_USE_CASE_SLICE_LOCKED', 'Only resources, navigation, documents and run slices are unlocked')
  const facade = graph.load(resolve(graph.root, 'src/client/features/authoring/logic/workspace/workspace-controller.ts'))
  const refresh = nodes(facade.ast, node => node.type === 'MethodDefinition' && name(node.key) === 'refreshResources')[0]
  requireFact(refresh, 'WORKSPACE_RESOURCE_FACADE_MISSING', 'Workspace refreshResources facade is required')
  const inline = calls(refresh).filter(call => member(call.callee)?.endsWith('.listResources'))
  requireFact(
    !inline.length,
    'WORKSPACE_RESOURCE_USE_CASE_STILL_CENTRALIZED',
    'Resource refresh still owns Host observations in the Workspace facade',
    inline.map(call => graph.location(facade, call, member(call.callee)))
  )
  const delegated = calls(refresh).filter(
    call => call.callee.type === 'Identifier' && facade.imports.get(call.callee.name)?.source === '../resources/workspace-resource-use-cases.ts'
  )
  requireFact(delegated.length === 1, 'WORKSPACE_RESOURCE_USE_CASE_WIRING_MISSING', 'Actual refreshResources must call its extracted resource owner')
  requireFact(
    nodes(refresh, node => node.type === 'ReturnStatement' && unwrap(node.argument) === delegated[0]).length === 1,
    'WORKSPACE_RESOURCE_USE_CASE_WIRING_MISSING',
    'Resource owner result must be returned by the actual facade'
  )
  const target = graph.binding(facade, delegated[0].callee)
  const fn = functionOf(target.declaration)
  requireFact(fn, 'WORKSPACE_RESOURCE_USE_CASE_CONTRACT_MISSING', 'Resource owner must be callable')
  const hostReads = calls(fn).filter(call => member(call.callee)?.endsWith('.host.listResources'))
  requireFact(hostReads.length === 1, 'WORKSPACE_RESOURCE_USE_CASE_CONTRACT_MISSING', 'Resource owner must perform the actual Host observation')
  const attempts = nodes(fn, node => node.type === 'TryStatement' && calls(node.block).includes(hostReads[0]))
  requireFact(
    attempts.length === 1 && attempts[0].handler,
    'WORKSPACE_RESOURCE_USE_CASE_CONTRACT_MISSING',
    'Resource Host observation must retain failure settlement'
  )
  const attempt = attempts[0]
  for (const block of [attempt.block, attempt.handler.body]) {
    const fence = nodes(
      block,
      node =>
        node.type === 'IfStatement' &&
        ['readGeneration', 'navigationGeneration'].every(field => calls(node.test).some(call => member(call.callee)?.endsWith(`.${field}`)))
    )
    requireFact(
      fence.length === 1 && nodes(fence[0].consequent, node => node.type === 'ReturnStatement').length > 0,
      'WORKSPACE_RESOURCE_SETTLEMENT_FENCE_MISSING',
      'Both resource settlements must reject obsolete read and navigation generations',
      [graph.location(target.module, block, 'resource settlement')]
    )
  }
  const ownerCalls = calls(fn).map(call => member(call.callee))
  requireFact(
    ['assertActive', 'nextReadGeneration', 'isDisposed', 'setCatalogState', 'emit'].every(field => ownerCalls.some(value => value?.endsWith(`.${field}`))),
    'WORKSPACE_RESOURCE_USE_CASE_CONTRACT_MISSING',
    'Resource owner must retain admission, publication and disposal contracts'
  )
  for (const entry of target.module.imports.values()) {
    requireFact(
      entry.typeOnly,
      'WORKSPACE_RESOURCE_USE_CASE_DEPENDENCY',
      'Resource slice accepts type-only dependencies, not runtime controllers or browser effects',
      [graph.location(target.module, entry.node, entry.source)]
    )
  }
  const effects = nodes(fn, node => node.type === 'Identifier' && ['window', 'document', 'localStorage', 'sessionStorage', 'fetch'].includes(node.name))
  requireFact(
    !effects.length,
    'WORKSPACE_RESOURCE_USE_CASE_EFFECT',
    'Resource observation must not acquire browser or transport ownership',
    effects.map(node => graph.location(target.module, node, node.name))
  )
  return [
    graph.location(facade, refresh, 'refreshResources'),
    graph.location(target.module, fn, name(delegated[0].callee)),
    ...hostReads.map(call => graph.location(target.module, call, member(call.callee)))
  ]
}

function panelSnapshot(graph) {
  const panel = graph.load(resolve(graph.root, 'src/client/features/authoring/ui/panel/panel-composition.tsx'))
  const controller = graph.load(resolve(graph.root, 'src/client/features/authoring/ui/panel/panel-controller.tsx'))
  graph.validateImports(controller)
  const entry = graph.exported(panel, 'createBlueprintPanel')
  const fn = functionOf(entry.declaration)
  requireFact(fn, 'PANEL_SNAPSHOT_NOT_CONSUMED', 'Actual Panel factory must consume the external snapshot')
  // The Workspace hook is the canonical owner of the panel snapshot. Keep the
  // panel factory itself out of this search: it also has an unrelated
  // useSyncExternalStore for the DSH model catalog, which must not satisfy the
  // workspace subscription oracle when the real hook is disconnected.
  const targets = []
  for (const call of calls(fn)) {
    if (call.callee.type !== 'Identifier') continue
    const imported = panel.imports.get(call.callee.name)
    if (!imported || imported.typeOnly || !imported.source.endsWith('/panel-workspace-store.ts')) continue
    const target = graph.binding(panel, call.callee)
    const hook = functionOf(target.declaration)
    if (hook) targets.push({ module: target.module, fn: hook })
  }
  const external = targets.flatMap(target =>
    calls(target.fn)
      .filter(call => member(call.callee)?.endsWith('useSyncExternalStore'))
      .map(call => ({ ...target, call }))
  )
  requireFact(external.length > 0, 'PANEL_SNAPSHOT_NOT_CONSUMED', 'Actual Panel factory has no external-store snapshot consumption', [
    graph.location(panel, fn, 'createBlueprintPanel')
  ])
  for (const target of external) {
    requireFact(
      target.call.arguments.length === 3 &&
        ['subscribe', 'getSnapshot', 'getSnapshot'].every((field, index) => member(target.call.arguments[index])?.endsWith(`.${field}`)),
      'PANEL_SNAPSHOT_SUBSCRIPTION_MISSING',
      'External store must consume the real stable subscribe and snapshot readers including SSR'
    )
    const declared = nodes(target.fn, node => node.type === 'VariableDeclarator' && node.init === target.call && node.id.type === 'Identifier')[0]
    requireFact(
      declared &&
        nodes(
          target.fn,
          node => node.type === 'ReturnStatement' && nodes(node.argument, child => child.type === 'Identifier' && child.name === declared.id.name).length > 0
        ).length > 0,
      'PANEL_SNAPSHOT_NOT_CONSUMED',
      'External snapshot must be returned to the real Panel'
    )
  }
  const controllerEntry = graph.exported(controller, 'WorkspacePanel')
  const controllerFn = callable(graph, controllerEntry, 'WorkspacePanel')
  const projector = [...calls(fn), ...calls(controllerFn)].find(call => {
    if (call.callee.type !== 'Identifier') return false
    const owner = call.callee.name === 'presentWorkspace' ? controller : panel
    return owner.imports.get(call.callee.name)?.source === '../../presenters/workspace-presenter.ts'
  })
  requireFact(projector, 'PANEL_SNAPSHOT_PROJECTION_MISSING', 'Actual Panel must consume the Workspace presenter')
  const projectionModule = projector.callee.name === 'presentWorkspace' ? controller : panel
  const projectionOwner = graph.binding(projectionModule, projector.callee)
  requireFact(functionOf(projectionOwner.declaration), 'PANEL_SNAPSHOT_PROJECTION_MISSING', 'Actual presenter must be callable')
  const projectionFn = projector.callee.name === 'presentWorkspace' ? controllerFn : fn
  const projected = nodes(projectionFn, node => node.type === 'VariableDeclarator' && node.init === projector && node.id.type === 'Identifier')[0]
  requireFact(
    projected && nodes(projectionFn, node => node.type === 'MemberExpression' && member(node)?.startsWith(`${projected.id.name}.`)).length > 0,
    'PANEL_SNAPSHOT_PROJECTION_MISSING',
    'Actual Panel display must consume the projected model'
  )
  const snapshot = projector.arguments[0]
  requireFact(
    snapshot?.type === 'Identifier' &&
      snapshot.name === 'workspaceSnapshot' &&
      controllerFn.params.some(param => param.type === 'ObjectPattern' && param.properties.some(property => name(property.key) === snapshot.name)),
    'PANEL_SNAPSHOT_NOT_CONSUMED',
    'Presenter input must come from the actual external-store hook snapshot'
  )
  const oldSubscriptions = [...calls(fn), ...calls(controllerFn)].filter(
    call => member(call.callee)?.endsWith('.subscribe') && calls(call).some(nested => name(nested.callee) === 'setTick')
  )
  requireFact(
    !oldSubscriptions.length,
    'PANEL_SNAPSHOT_TICK_SUBSCRIPTION',
    'Workspace facts must not retain the old tick subscription',
    oldSubscriptions.map(call => graph.location(panel, call, 'tick subscription'))
  )
  return [
    ...external.map(target => graph.location(target.module, target.call, 'useSyncExternalStore')),
    graph.location(projectionModule, projector, name(projector.callee))
  ]
}

function panelComposition(graph) {
  const panel = graph.load(resolve(graph.root, 'src/client/features/authoring/ui/panel/panel-composition.tsx'))
  const controller = graph.load(resolve(graph.root, 'src/client/features/authoring/ui/panel/panel-controller.tsx'))
  graph.validateImports(controller)
  const entry = graph.exported(panel, 'createBlueprintPanel')
  const fn = callable(graph, entry, 'createBlueprintPanel')
  const controllerEntry = graph.exported(controller, 'WorkspacePanel')
  const controllerFn = callable(graph, controllerEntry, 'WorkspacePanel')
  const workspaceImport = panel.imports.get('WorkspacePanel')
  requireFact(
    workspaceImport?.source === './panel-controller.tsx' && !workspaceImport.typeOnly,
    'PANEL_COMPOSITION_BOUNDARY_MISSING',
    'Actual Panel factory must import the runtime Panel controller'
  )
  const workspaceElements = nodes(
    fn,
    node => node.type === 'JSXElement' && node.openingElement?.name?.type === 'JSXIdentifier' && node.openingElement.name.name === 'WorkspacePanel'
  )
  requireFact(workspaceElements.length === 1, 'PANEL_COMPOSITION_BOUNDARY_MISSING', 'Actual Panel factory must render one Panel controller')
  const workspaceProps = workspaceElements[0].openingElement.attributes.filter(attribute => attribute.type === 'JSXAttribute')
  const workspacePropNames = new Set(workspaceProps.map(attribute => name(attribute.name)))
  requireFact(
    ['env', 't', 'workspace', 'workspaceSnapshot', 'workspaceBinding'].every(prop => workspacePropNames.has(prop)),
    'PANEL_COMPOSITION_PROPS_MISSING',
    'Panel controller must receive environment, workspace and snapshot props'
  )
  const viewImport = controller.imports.get('panelView')
  requireFact(
    viewImport?.source === './panel-view.tsx' && !viewImport.typeOnly,
    'PANEL_COMPOSITION_BOUNDARY_MISSING',
    'Actual Panel must import the runtime panel-view composition shell'
  )
  const viewCalls = calls(controllerFn).filter(call => call.callee.type === 'Identifier' && call.callee.name === 'panelView')
  requireFact(viewCalls.length === 1, 'PANEL_COMPOSITION_BOUNDARY_MISSING', 'Actual Panel must invoke one composition shell')
  const view = graph.binding(controller, viewCalls[0].callee)
  requireFact(
    view.module.path.endsWith('/src/client/features/authoring/ui/panel/panel-view.tsx'),
    'PANEL_COMPOSITION_BOUNDARY_MISSING',
    'Panel composition must resolve to panel-view.tsx'
  )
  const props = unwrap(viewCalls[0].arguments[1])
  requireFact(props?.type === 'ObjectExpression', 'PANEL_COMPOSITION_PROPS_MISSING', 'Panel composition must receive an explicit props object')
  const propNames = new Set((props.properties ?? []).filter(property => property.type === 'Property').map(property => name(property.key)))
  requireFact(
    propNames.has('rootProps') && propNames.has('children'),
    'PANEL_COMPOSITION_PROPS_MISSING',
    'Panel shell props must separate root attributes from child views'
  )
  const shell = graph.exported(view.module, 'panelView')
  const shellFn = callable(graph, shell, 'panelView')
  requireFact(
    !nodes(shellFn, node => node.type === 'Identifier' && ['window', 'document', 'localStorage', 'sessionStorage', 'fetch'].includes(node.name)).length,
    'PANEL_COMPOSITION_EFFECT_LEAK',
    'Panel composition shell must remain a pure props-to-view boundary'
  )
  return [
    graph.location(panel, workspaceElements[0], 'WorkspacePanel'),
    graph.location(controller, viewCalls[0], 'panelView'),
    graph.location(view.module, shell.declaration, 'panelView')
  ]
}

export function checkModularization({ root = DEFAULT_ROOT, boundary, slice } = {}) {
  requireFact(
    [
      'resources',
      'workspace',
      'canvas',
      'graph',
      'documents',
      'inspector',
      'conversation',
      'locale',
      'styles',
      'source-graph',
      'roles',
      'workspace-use-cases',
      'panel-snapshot',
      'panel-composition'
    ].includes(boundary),
    'INVALID_BOUNDARY',
    'Choose resources, workspace, canvas, graph, documents, inspector, conversation, locale, styles, source-graph, roles, workspace-use-cases or panel-composition'
  )
  const graph = sourceGraph(resolve(root))
  try {
    // Validate the existing graph before classifying centralization. A broken
    // newly wired import must never masquerade as the intended structural red.
    if (boundary !== 'source-graph') {
      graph.validateImports(
        graph.load(
          resolve(
            graph.root,
            boundary === 'documents'
              ? 'src/index.ts'
              : boundary === 'graph'
                ? 'src/client/features/authoring/logic/graph/graph-editor.ts'
                : boundary === 'workspace' || boundary === 'workspace-use-cases'
                  ? 'src/client/features/authoring/logic/workspace/workspace-controller.ts'
                  : boundary === 'roles'
                    ? 'src/client/features/authoring/logic/resources/resource-library-model.ts'
                    : boundary === 'inspector'
                      ? 'src/client/features/authoring/ui/inspector/inspector-composition.tsx'
                      : boundary === 'conversation'
                        ? 'src/client/features/conversation/ui/conversation-view.tsx'
                        : boundary === 'locale'
                          ? 'src/client/shared/i18n/locales.ts'
                          : boundary === 'styles'
                            ? 'src/client/shared/styles/styles.ts'
                            : 'src/client/features/authoring/ui/panel/panel-composition.tsx'
          )
        )
      )
    }
    const evidence =
      boundary === 'workspace-use-cases'
        ? workspaceUseCases(graph, slice ?? 'all')
        : {
            resources,
            workspace,
            canvas,
            graph: graphEditor,
            documents,
            inspector,
            conversation,
            locale,
            styles,
            'source-graph': canonicalSourceGraph,
            roles: roleBoundaries,
            'panel-snapshot': panelSnapshot,
            'panel-composition': panelComposition
          }[boundary](graph)
    return { boundary, ok: true, code: 'BOUNDARY_EXTRACTED', evidence }
  } catch (error) {
    if (!(error instanceof BoundaryOracleError)) throw error
    return { boundary, ok: false, code: error.code, message: error.message, evidence: error.evidence }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  try {
    requireFact(
      (args.length === 2 || (args.length === 4 && args[2] === '--slice')) && args[0] === '--boundary',
      'INVALID_ARGUMENTS',
      'Usage: node scripts/check-modularization.mjs --boundary resources|workspace|canvas|graph|documents|inspector|conversation|locale|styles|source-graph|roles|workspace-use-cases|panel-snapshot|panel-composition [--slice resources|navigation|documents]'
    )
    const result = checkModularization({ boundary: args[1], slice: args[3] })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, code: error.code ?? 'ORACLE_ERROR', message: error instanceof BoundaryOracleError ? error.message : 'Unexpected oracle failure' })}\n`
    )
    process.exitCode = 2
  }
}
