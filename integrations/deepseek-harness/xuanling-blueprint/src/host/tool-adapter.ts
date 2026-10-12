/** Blueprint script bodies are registered host tools, never bare RPC runners.
 * Every business dispatch must enter the DSH tools.execute policy pipeline.
 * Abort/deadline settlement drains the child before releasing its temp files;
 * once spawned, external effects remain unknown (never automatically retry).
 */
import { spawn, execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

const MAX_TIMER_DELAY_MS = 2_147_483_647
const ownedScriptDirs = new Set<string>()

export interface ScriptRunResult {
  ok: boolean
  kind: 'succeeded' | 'failed' | 'timeout' | 'cancelled'
  /** A stopped process is not evidence that it had no external effects. */
  effect: 'not-started' | 'unknown'
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
}

/** Internal primitive, NOT a policy boundary. The caller owns any explicit
 * cwd; otherwise the primitive owns and cleans a platform temp directory.
 * stdout is the JSON result channel; --args carries lossless JSON arguments.
 */
export async function runScript(scriptBytes: Buffer, argsJson: unknown, options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ScriptRunResult> {
  const started = Date.now()
  const notStarted = (): ScriptRunResult => ({ ok: false, kind: 'cancelled', effect: 'not-started', exitCode: null, stdout: '', stderr: '', durationMs: Date.now() - started })
  if (options.signal?.aborted) return notStarted()
  const timeoutMs = options.timeoutMs
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS)) {
    throw new RangeError('script timeoutMs must be a positive finite timer delay')
  }
  const args = JSON.stringify(argsJson ?? {})
  if (args === undefined) throw new TypeError('script arguments must be JSON-serializable')
  // Serialization can run user-supplied getters; check again before any file/spawn.
  if (options.signal?.aborted) return notStarted()
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), 'bp-script-'))
  if (options.cwd === undefined) ownedScriptDirs.add(cwd)
  try {
    const scriptPath = join(cwd, 'script.mjs')
    writeFileSync(scriptPath, scriptBytes)
    if (options.signal?.aborted) return notStarted()
    return await new Promise<ScriptRunResult>((resolve, reject) => {
      // A POSIX process group lets cancellation stop ordinary descendants too.
      // This is lifecycle containment, not a sandbox for adversarial scripts.
      const child = spawn(process.execPath, [scriptPath, '--args', args], {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      })
      let stdout = ''
      let stderr = ''
      let stopKind: 'timeout' | 'cancelled' | undefined
      let spawnError: Error | undefined
      let terminationError: Error | undefined
      let termination: Promise<void> = Promise.resolve()
      let stopping = false
      const stopTree = () => {
        if (stopping || child.pid === undefined) return
        stopping = true
        if (process.platform === 'win32') {
          termination = new Promise<void>(done => {
            execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], error => {
              if (error) terminationError = error
              done()
            })
          })
        } else {
          try { process.kill(-child.pid, 'SIGKILL') }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') terminationError = error as Error
          }
        }
      }
      const stop = (kind: 'timeout' | 'cancelled') => {
        stopKind ??= kind
        stopTree()
      }
      const abort = () => stop('cancelled')
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => stop('timeout'), timeoutMs)
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', error => { spawnError = error })
      // Natural parent exit must not leave its ordinary background children running.
      child.on('exit', () => { if (process.platform !== 'win32') stopTree() })
      child.on('close', async code => {
        if (timer !== undefined) clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        await termination
        if (terminationError !== undefined) { reject(terminationError); return }
        resolve({
          ok: stopKind === undefined && spawnError === undefined && code === 0,
          kind: stopKind ?? (spawnError === undefined && code === 0 ? 'succeeded' : 'failed'),
          effect: child.pid === undefined ? 'not-started' : 'unknown',
          exitCode: code, stdout,
          stderr: `${stderr}${spawnError?.message ?? ''}`,
          durationMs: Date.now() - started,
        })
      })
    })
  } finally {
    if (options.cwd === undefined) cleanupScriptDir(cwd)
  }
}

/** Only directories allocated by this adapter may be removed by this helper. */
export function cleanupScriptDir(cwd: string): void {
  if (!ownedScriptDirs.has(cwd)) return
  rmSync(cwd, { recursive: true, force: true })
  ownedScriptDirs.delete(cwd)
}

export interface ToolLayerLike {
  register(definition: Record<string, unknown>): () => void
}

export interface HostToolsContext {
  get(service: string): unknown
}

/** Register a frozen script. Budget is trusted registration metadata, never
 * arguments from a model/RPC. There is deliberately no direct dispatch handle.
 */
export function registerScriptTool(hostCtx: HostToolsContext, spec: { nodeId: string; scriptBytes: Buffer; description: string; timeoutMs?: number }) {
  const tools = hostCtx.get('tools') as ToolLayerLike | undefined
  if (tools === undefined || typeof tools.register !== 'function') {
    const error = new Error("host has no 'tools' service")
    error.name = 'ToolBindingUnavailableError'
    ;(error as { code?: string }).code = 'TOOL_BINDING_UNAVAILABLE'
    throw error
  }
  const timeoutMs = spec.timeoutMs
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS)) {
    throw new RangeError('registered script timeoutMs must be a positive finite timer delay')
  }
  const name = `blueprint_script_${spec.nodeId}`.replace(/[^a-zA-Z0-9_]/g, '_')
  const scriptBytes = Buffer.from(spec.scriptBytes)
  const disposer = tools.register({
    name,
    description: spec.description,
    ...timeoutMs === undefined ? {} : { timeoutMs },
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: 'Whether the script exited successfully within its budget.' },
          kind: { type: 'string', description: 'Settlement kind: succeeded, failed, timeout, or cancelled.' },
        },
      },
      render: (_args: unknown, value: unknown) => [{
        type: 'text', text: JSON.stringify(value)?.slice(0, 4000) ?? 'script produced no output',
      }],
    },
    async execute(args: Record<string, unknown>, context: ToolRunContext) {
      const result = await runScript(scriptBytes, args, { ...timeoutMs === undefined ? {} : { timeoutMs }, signal: context.signal })
      if (!result.ok) {
        const error = new Error(`SCRIPT_${result.kind.toUpperCase()}: script ${result.kind}; effect=${result.effect}`, { cause: result })
        error.name = 'ScriptExecutionError'
        ;(error as Error & { code: string }).code = `SCRIPT_${result.kind.toUpperCase()}`
        throw error
      }
      return result
    },
  })
  return { name, disposer }
}

/** C-16 allowlist intersection: effective tools = host policy ∩ blueprint
 * bindings ∩ node allowlist. Pure computation over explicit lists. */
export function effectiveToolAllowlist(hostPolicy: string[] | null, blueprintBindings: string[], nodeAllowlist: string[] | null): string[] {
  let effective = blueprintBindings
  if (hostPolicy !== null) effective = effective.filter(t => hostPolicy.includes(t))
  if (nodeAllowlist !== null) effective = effective.filter(t => nodeAllowlist.includes(t))
  return [...new Set(effective)].sort()
}
