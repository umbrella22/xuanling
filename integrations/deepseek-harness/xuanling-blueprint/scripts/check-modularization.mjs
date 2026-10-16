/** Source-boundary oracles, separate from product acceptance.
 * AST evidence proves wiring, not behavioral equivalence; characterization and
 * mounted/live tests remain required. No source execution or build occurs here.
 */
import { readFileSync, existsSync } from 'node:fs'
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
      ast = parseAst(source, { lang: path.endsWith('.ts') ? 'ts' : 'js', sourceType: 'module' }, path)
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
      const forbidden =
        ['react', '@xyflow/react', '@xyflow/system'].includes(source) ||
        /(?:^|\/)(?:panel|workspace|conversation-controller)\.ts$/.test(source) ||
        source.includes('/service/')
      requireFact(!forbidden, 'IMPURE_MODEL_DEPENDENCY', 'Pure model imports a UI/workspace/service dependency', [graph.location(module, item, source)])
      if (!runtime) continue
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

function resources(graph) {
  const panel = graph.load(resolve(graph.root, 'src/client/panel.ts'))
  const panelFactory = graph.exported(panel, 'createBlueprintPanel')
  const factory = callable(graph, panelFactory, 'createBlueprintPanel')
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
  const model = graph.load(resolve(graph.root, 'src/client/resource-library-model.ts'))
  const expectedResource = graph.exported(model, 'resourceRows')
  requireFact(
    sameBinding(resourceBinding, expectedResource) && sameBinding(graph.exported(panel, 'resourceRows'), expectedResource),
    'PRODUCTION_WIRING_MISSING',
    'Panel call and legacy resourceRows export must resolve to the same model implementation'
  )
  const command = graph.load(resolve(graph.root, 'src/client/command-facts.ts'))
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
  requireFact(policy?.source === './command-policy.ts' && !policy.typeOnly, 'PRODUCTION_WIRING_MISSING', 'Panel must use the existing command policy')
  const dependencies = [...pureDependencies(graph, model), ...pureDependencies(graph, command)]
  return [
    graph.location(model, expectedResource.declaration, 'resourceRows'),
    graph.location(command, adapter.declaration, 'command facts adapter'),
    ...dependencies
  ]
}

function canvas(graph) {
  const panel = graph.load(resolve(graph.root, 'src/client/panel.ts'))
  const flowImport = [...panel.imports].find(([, entry]) => entry.source === '@xyflow/react' && entry.imported === 'ReactFlow')
  requireFact(flowImport, 'PRODUCTION_WIRING_MISSING', 'Panel must use the installed ReactFlow component')
  const flow = calls(panel.ast).filter(call => name(unwrap(call.arguments[0])) === flowImport[0] && unwrap(call.arguments[1])?.type === 'ObjectExpression')
  requireFact(flow.length === 1, 'PRODUCTION_WIRING_MISSING', 'Expected one production ReactFlow props object')
  const props = unwrap(flow[0].arguments[1]),
    resolved = [],
    maps = []
  for (const [prop, expected] of [
    ['nodeTypes', ['blueprint', 'presentationGroup']],
    ['edgeTypes', ['blueprintEdge']]
  ]) {
    const value = props.properties.find(item => name(item.key) === prop)?.value
    requireFact(value?.type === 'Identifier', 'UNSTABLE_RENDERER_MAP', `${prop} must use a stable module binding`)
    const map = graph.binding(panel, value)
    const declaration = map.module.declarations.find(item => item.node === map.declaration)
    requireFact(
      declaration &&
        declaration.parents.some(parent => parent.type === 'VariableDeclaration' && parent.kind === 'const') &&
        !declaration.parents.some(parent => FUNCTIONS.has(parent.type)) &&
        map.declaration.init?.type === 'ObjectExpression',
      'UNSTABLE_RENDERER_MAP',
      `${prop} must be a module-scope object`,
      [graph.location(map.module, map.declaration, prop)]
    )
    maps.push(graph.location(map.module, map.declaration, prop))
    for (const key of expected) {
      const renderer = map.declaration.init.properties.find(item => name(item.key) === key)?.value
      requireFact(renderer?.type === 'Identifier', 'PRODUCTION_WIRING_MISSING', `${prop}.${key} must reference an actual renderer`)
      const binding = graph.binding(map.module, renderer)
      callable(graph, binding, key)
      resolved.push({ key, ...binding })
    }
  }
  const centralized = resolved.filter(entry => entry.module.path === panel.path)
  requireFact(!centralized.length, 'BOUNDARY_STILL_CENTRALIZED', 'Production ReactFlow maps still resolve to renderer implementations in Panel', [
    ...centralized.map(entry => graph.location(entry.module, entry.declaration, entry.key)),
    ...maps,
    graph.location(panel, flow[0], 'ReactFlow props')
  ])
  const renderers = graph.load(resolve(graph.root, 'src/client/canvas-renderers.ts'))
  for (const entry of resolved)
    requireFact(entry.module.path === renderers.path, 'PRODUCTION_WIRING_MISSING', 'All three renderers must resolve to canvas-renderers.ts')
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
  return [...resolved.map(entry => graph.location(entry.module, entry.declaration, entry.key)), ...maps, graph.location(panel, flow[0], 'ReactFlow props')]
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
    throw new BoundaryOracleError('BOUNDARY_STILL_CENTRALIZED', 'Document queues, CRUD callers and disposal drain remain owned by BlueprintService', [
      ...tails.map(node => graph.location(service, node, name(node.key))),
      ...paths.map(item => ({ ...graph.location(service, methods.get(item.entry), item.entry), calls: item.path })),
      graph.location(service, methods.get('withDocument'), 'withDocument → withLibraryMutation'),
      graph.location(service, methods.get('constructor'), 'dispose → libraryTail')
    ])
  }
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
  const routes = entries.map(entry => ({
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
    graph.location(service, drains[0], `await this.${field}.drainLibrary`)
  ]
}

/** Results are JSON-serializable. Unexpected I/O/parser failures never become
 * BOUNDARY_STILL_CENTRALIZED. root supports isolated source-copy calibration.
 */
export function checkModularization({ root = DEFAULT_ROOT, boundary } = {}) {
  requireFact(['resources', 'canvas', 'documents'].includes(boundary), 'INVALID_BOUNDARY', 'Choose resources, canvas or documents')
  const graph = sourceGraph(resolve(root))
  try {
    // Validate the existing graph before classifying centralization. A broken
    // newly wired import must never masquerade as the intended structural red.
    graph.validateImports(graph.load(resolve(graph.root, boundary === 'documents' ? 'src/index.ts' : 'src/client/panel.ts')))
    const evidence = { resources, canvas, documents }[boundary](graph)
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
      args.length === 2 && args[0] === '--boundary',
      'INVALID_ARGUMENTS',
      'Usage: node scripts/check-modularization.mjs --boundary resources|canvas|documents'
    )
    const result = checkModularization({ boundary: args[1] })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, code: error.code ?? 'ORACLE_ERROR', message: error instanceof BoundaryOracleError ? error.message : 'Unexpected oracle failure' })}\n`
    )
    process.exitCode = 2
  }
}
