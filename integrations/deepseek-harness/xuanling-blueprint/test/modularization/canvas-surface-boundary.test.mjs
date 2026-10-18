import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const plugin = join(import.meta.dirname, '../..')
const controllerPath = join(plugin, 'src/client/features/authoring/ui/panel/panel-controller.tsx')
const surfacePath = join(plugin, 'src/client/features/authoring/ui/canvas/canvas-surface.tsx')

test('canvas surface owns XYFlow and canvas DOM instead of the Panel controller', () => {
  assert.equal(existsSync(surfacePath), true, 'canvas surface must be a production module')
  assert.ok(readFileSync(surfacePath, 'utf8'), 'canvas surface must not be empty')
  const controller = readFileSync(controllerPath, 'utf8')
  const surface = readFileSync(surfacePath, 'utf8')
  assert.match(controller, /<CanvasSurface\b/, 'Panel must mount CanvasSurface through a JSX component boundary')
  assert.doesNotMatch(controller, /\bCanvasSurface\(\{/, 'Panel must not invoke the CanvasSurface function directly')
  assert.doesNotMatch(controller, /\b(?:ReactFlow|ReactFlowProvider|useReactFlow)\b/)
  assert.doesNotMatch(controller, /<ReactFlow(?:Provider)?\b/)
  assert.doesNotMatch(controller, /data-bp-canvas=\{['"]surface['"]\}/)
  assert.match(surface, /<ReactFlowProvider\b/)
  assert.match(surface, /<ReactFlow\b/)
  assert.match(surface, /data-bp-canvas=\{['"]surface['"]\}/)
})
