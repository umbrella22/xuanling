#!/usr/bin/env tsx
// Direct (non-model) probe harness for the two file-tool families (C-08).
//
// XuanLing battery: drives the real adapter + xuanling-mcp over stdio MCP and
// records typed outcomes for the primitives native tools do not carry:
// duplicate-match refusal, CAS-protected writes, strict patch preimage,
// bounded output + continuation, over-cap pagination, invalid UTF-8, and the
// workspace capability boundary.
//
// Native battery: assembles the harness's own fs-local service + observation
// policy + tool-fs in a bare cordis Context and records the read-before-edit
// guard (FS_NOT_OBSERVED). The agent-owned positive/stale contracts are run by
// their exact DSH integration-test names; a suite total is not evidence.
//
// Usage:
//   tsx probe-filesystem-tools.ts --dsh-root <dsh> --binary <xuanling-mcp>
// Prints one JSON report; exit 0 = every probe has a verdict and no
// expectation mismatch.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import readline from 'node:readline'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 || index + 1 >= process.argv.length ? undefined : process.argv[index + 1]
}

const dshRootArg = argValue('--dsh-root')
const binaryArg = argValue('--binary')
if (!dshRootArg || !binaryArg) {
  console.error('probe-filesystem-tools: --dsh-root and --binary are required')
  process.exit(2)
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..', '..', '..', '..')
const integrationRoot = path.join(repoRoot, 'integrations', 'deepseek-harness')
const adapterPath = path.join(integrationRoot, 'xuanling-memory', 'schema-adapter.mjs')
const dshRoot = path.resolve(dshRootArg)
const binary = path.resolve(binaryArg)

function nonSecretChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, ...extra }
}

type Probe = {
  family: 'xuanling' | 'native'
  name: string
  expectation: string
  status: 'observed' | 'mismatch' | 'harness_error'
  outcome: string
  wrote: boolean | null
}

const probes: Probe[] = []
function record(family: Probe['family'], name: string, expectation: string, status: Probe['status'], outcome: string, wrote: boolean | null = null) {
  probes.push({ family, name, expectation, status, outcome, wrote })
}

function hasTypedError(result: { isError: boolean; code?: string }, code: string): boolean {
  return result.isError && result.code === code
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] | undefined {
  const field = value[key]
  return Array.isArray(field) ? field : undefined
}

// ---------------------------------------------------------------------------
// XuanLing MCP battery.
// ---------------------------------------------------------------------------

interface McpFrame {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> }
  error?: { message?: string; code?: number }
}

async function xuanlingSession(workspace: string): Promise<void> {
  // Detached: the adapter spawns the xuanling-mcp child; killing only the
  // adapter node process would orphan it. Teardown signals the whole group.
  const child = spawn(process.execPath, [
    adapterPath,
    '--binary', binary,
    '--',
    '--workspace-root', workspace,
    '--memory-db', path.join(workspace, 'memory.db'),
    '--tool-profile', 'fs',
  ], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: nonSecretChildEnv() })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const buffered: McpFrame[] = []
  let wake: (() => void) | undefined
  let finished = false
  const lineReader = readline.createInterface({ input: child.stdout })
  lineReader.on('line', (line: string) => {
    if (!line.trim()) return
    try {
      buffered.push(JSON.parse(line) as McpFrame)
      wake?.()
    } catch {
      finished = true
      wake?.()
    }
  })
  const pending = new Map<number, (frame: McpFrame) => void>()
  void (async () => {
    while (true) {
      while (buffered.length > 0) {
        const frame = buffered.shift() as McpFrame
        if (frame.id === undefined) continue
        pending.get(frame.id)?.(frame)
        pending.delete(frame.id)
      }
      if (finished) return
      await new Promise<void>((resolve) => { wake = resolve })
    }
  })()
  let nextId = 1
  const request = (method: string, params: unknown): Promise<McpFrame> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => reject(new Error(`probe timed out on ${method}`)), 20_000)
      pending.set(id, (frame) => { clearTimeout(timer); resolve(frame) })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  const call = async (name: string, args: Record<string, unknown>) => {
    const frame = await request('tools/call', { name, arguments: args })
    const structured = frame.result?.structuredContent ?? {}
    const text = (frame.result?.content ?? []).map((block) => block.text ?? '').join('\n')
    return {
      error: frame.error,
      isError: frame.result?.isError === true,
      code: typeof structured.code === 'string' ? structured.code : undefined,
      structured,
      text,
    }
  }
  const read = (file: string) => readFileSync(path.join(workspace, file), 'utf8')

  try {
    const init = await request('initialize', {
      capabilities: {},
      clientInfo: { name: 'xuanling-fs-probe', version: '0' },
      protocolVersion: '2024-11-05',
    })
    if (init.error !== undefined) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)

    // 1. Duplicate match must refuse an ambiguous edit.
    writeFileSync(path.join(workspace, 'dup.txt'), 'alpha line\nalpha line\n')
    const duplicate = await call('fs_edit', { path: 'dup.txt', old: 'alpha line', new: 'beta line' })
    record(
      'xuanling', 'duplicate-match edit refuses',
      'typed error, no write',
      hasTypedError(duplicate, 'conflict') && read('dup.txt') === 'alpha line\nalpha line\n' ? 'observed' : 'mismatch',
      duplicate.isError ? `isError code=${JSON.stringify(duplicate.code)} text=${duplicate.text.slice(0, 160)}` : 'unexpected success',
      !duplicate.isError,
    )

    // 2. Stale CAS: expected_sha256 of older content must conflict.
    const beforeEdit = 'v1 content\n'
    writeFileSync(path.join(workspace, 'cas.txt'), beforeEdit)
    const staleHash = '0000000000000000000000000000000000000000000000000000000000000000'
    const stale = await call('fs_replace_text', { path: 'cas.txt', old: 'v1', new: 'v2', expected_sha256: staleHash })
    record(
      'xuanling', 'stale expected_sha256 conflicts',
      'conflict, file unchanged',
      hasTypedError(stale, 'conflict') && read('cas.txt') === beforeEdit ? 'observed' : 'mismatch',
      stale.isError ? `isError code=${JSON.stringify(stale.code)}` : 'unexpected success',
      !stale.isError,
    )

    // 3. fs_patch preimage mismatch refuses with zero writes.
    const patchPreimage = 'aaa\nbbb\n'
    writeFileSync(path.join(workspace, 'patch.txt'), patchPreimage)
    const patched = await call('fs_patch', {
      path: 'patch.txt',
      expected_preimage_sha256: staleHash,
      unified_diff: '--- f\n+++ f\n@@ -1,2 +1,2 @@\n-aaa\n+AAA\n bbb\n',
    })
    record(
      'xuanling', 'patch preimage mismatch refuses',
      'conflict, zero writes',
      hasTypedError(patched, 'conflict') && read('patch.txt') === patchPreimage ? 'observed' : 'mismatch',
      patched.isError ? `isError code=${JSON.stringify(patched.code)}` : 'unexpected success',
      !patched.isError,
    )

    // 4. Over-cap search paginates with a cursor and the continuation works.
    const manyLines = Array.from({ length: 40 }, (_, index) => `needle entry ${index}\n`).join('')
    writeFileSync(path.join(workspace, 'search.txt'), manyLines)
    const page1 = await call('fs_search', { path: '.', pattern: 'needle', literal: true, limit: 15 })
    const searchFrames = [page1]
    let searchCursor = typeof page1.structured.next_cursor === 'string' ? page1.structured.next_cursor : undefined
    for (let pageIndex = 1; pageIndex < 3 && searchCursor !== undefined; pageIndex += 1) {
      const frame = await call('fs_search', {
        path: '.',
        pattern: 'needle',
        literal: true,
        limit: 15,
        cursor: searchCursor,
      })
      searchFrames.push(frame)
      searchCursor = typeof frame.structured.next_cursor === 'string' ? frame.structured.next_cursor : undefined
    }
    const searchPages = searchFrames.map((frame) => ({
      frame,
      matches: arrayField(frame.structured, 'matches'),
      hasMore: frame.structured.has_more === true,
      cursor: typeof frame.structured.next_cursor === 'string' ? frame.structured.next_cursor : undefined,
    }))
    const searchRows = searchPages.flatMap((page) => page.matches ?? [])
    const searchRowsValid = searchRows.every((row) => {
      if (typeof row !== 'object' || row === null) return false
      const value = row as Record<string, unknown>
      return typeof value.path === 'string' && path.basename(value.path) === 'search.txt' &&
        typeof value.line === 'number' && value.line >= 1 && value.line <= 40 && value.match === 'needle'
    })
    const searchSignatures = searchRows.map((row) => {
      if (typeof row !== 'object' || row === null) return 'invalid'
      const value = row as Record<string, unknown>
      return `${String(value.path)}:${String(value.line)}:${String(value.column)}`
    })
    const searchObserved = searchPages.length === 3 &&
      searchPages.every((page) => !page.frame.isError && page.matches !== undefined) &&
      searchPages.map((page) => page.matches?.length ?? 0).join(',') === '15,15,10' &&
      searchPages.map((page) => page.hasMore).join(',') === 'true,true,false' &&
      searchPages[0].cursor !== undefined && searchPages[1].cursor !== undefined &&
      searchPages[2].cursor === undefined && searchRows.length === 40 && searchRowsValid &&
      new Set(searchSignatures).size === 40
    const searchDetail = searchPages.map((page, index) =>
      `page${index + 1} matches=${page.matches?.length ?? 0} has_more=${JSON.stringify(page.frame.structured.has_more ?? null)}`,
    ).join('; ')
    record(
      'xuanling', 'search over-cap paginates',
      'three typed pages (15/15/10), unique matches, final cursor exhausted',
      searchObserved ? 'observed' : 'mismatch',
      searchDetail,
    )

    // 4b. Over-cap glob paginates with a cursor and the continuation works.
    const globDir = path.join(workspace, 'globdir')
    mkdirSync(globDir, { recursive: true })
    for (let index = 0; index < 40; index += 1) {
      writeFileSync(path.join(globDir, `entry-${index}.txt`), `${index}\n`)
    }
    const globPage1 = await call('fs_glob', { path: 'globdir', patterns: ['entry-*.txt'], limit: 15 })
    const globFrames = [globPage1]
    let globCursor = typeof globPage1.structured.next_cursor === 'string' ? globPage1.structured.next_cursor : undefined
    for (let pageIndex = 1; pageIndex < 3 && globCursor !== undefined; pageIndex += 1) {
      const frame = await call('fs_glob', {
        path: 'globdir',
        patterns: ['entry-*.txt'],
        limit: 15,
        cursor: globCursor,
      })
      globFrames.push(frame)
      globCursor = typeof frame.structured.next_cursor === 'string' ? frame.structured.next_cursor : undefined
    }
    const globPages = globFrames.map((frame) => ({
      frame,
      matches: arrayField(frame.structured, 'matches'),
      hasMore: frame.structured.has_more === true,
      cursor: typeof frame.structured.next_cursor === 'string' ? frame.structured.next_cursor : undefined,
    }))
    const globRows = globPages.flatMap((page) => page.matches ?? [])
    const globRowsValid = globRows.every((row) => {
      if (typeof row !== 'object' || row === null) return false
      const value = row as Record<string, unknown>
      return typeof value.path === 'string' && path.basename(value.path).startsWith('entry-') &&
        path.extname(value.path) === '.txt' && value.kind === 'file'
    })
    const globNames = globRows.map((row) => {
      if (typeof row !== 'object' || row === null) return 'invalid'
      return path.basename(String((row as Record<string, unknown>).path))
    })
    const expectedGlobNames = new Set(Array.from({ length: 40 }, (_, index) => `entry-${index}.txt`))
    const globObserved = globPages.length === 3 &&
      globPages.every((page) => !page.frame.isError && page.matches !== undefined) &&
      globPages.map((page) => page.matches?.length ?? 0).join(',') === '15,15,10' &&
      globPages.map((page) => page.hasMore).join(',') === 'true,true,false' &&
      globPages[0].cursor !== undefined && globPages[1].cursor !== undefined &&
      globPages[2].cursor === undefined && globRows.length === 40 && globRowsValid &&
      new Set(globNames).size === 40 && [...expectedGlobNames].every((name) => new Set(globNames).has(name))
    const globDetail = globPages.map((page, index) =>
      `page${index + 1} matches=${page.matches?.length ?? 0} has_more=${JSON.stringify(page.frame.structured.has_more ?? null)}`,
    ).join('; ')
    record(
      'xuanling', 'glob over-cap paginates',
      'canonical matches pages (15/15/10), all 40 file paths, final cursor exhausted',
      globObserved ? 'observed' : 'mismatch',
      globDetail,
    )

    // 5. Bounded read returns a resume token and the resume continues.
    const bigFile = `${'probe line of text\n'.repeat(40)}`
    writeFileSync(path.join(workspace, 'big.txt'), bigFile)
    const bounded = await call('fs_read_text', { path: 'big.txt', output: { mode: 'bounded', max_bytes: 100 } })
    const readPages = [bounded]
    let readResume = bounded.structured.next_resume
    let readComplete = false
    for (let pageIndex = 1; pageIndex < 16 && typeof readResume === 'object' && readResume !== null; pageIndex += 1) {
      const resumedFrame = await call('fs_read_text', {
        path: 'big.txt',
        output: { mode: 'bounded', max_bytes: 100 },
        resume: readResume,
      })
      readPages.push(resumedFrame)
      const next = resumedFrame.structured.next_resume
      readResume = next
      if (!resumedFrame.isError && resumedFrame.structured.truncated !== true) {
        readComplete = true
        break
      }
    }
    const readChunks = readPages.map((frame) => frame.structured.content).filter((content): content is string => typeof content === 'string')
    const readOffsets = readPages.map((frame) => {
      const resume = frame.structured.next_resume
      return typeof resume === 'object' && resume !== null && typeof (resume as Record<string, unknown>).offset_bytes === 'number'
        ? (resume as Record<string, unknown>).offset_bytes as number
        : undefined
    })
    const readObserved = !bounded.isError && bounded.structured.truncated === true &&
      bounded.structured.total_bytes === Buffer.byteLength(bigFile) && readComplete &&
      readPages.every((frame) => !frame.isError && typeof frame.structured.content === 'string') &&
      readChunks.join('') === bigFile && readOffsets.every((offset, index) => index === 0 || offset === undefined || offset > (readOffsets[index - 1] ?? -1))
    const resumed = readPages.length > 1
      ? `pages=${readPages.length} final_truncated=${JSON.stringify(readPages.at(-1)?.structured.truncated ?? null)}`
      : 'not attempted'
    record(
      'xuanling', 'bounded read continues via resume token',
      'bounded pages reassemble exactly and terminate without a resume token',
      readObserved ? 'observed' : 'mismatch',
      `truncated=${JSON.stringify(bounded.structured.truncated ?? null)} total=${JSON.stringify(bounded.structured.total_bytes ?? null)}; ${resumed}`,
    )

    // 6. Invalid UTF-8: text read fails typed, bytes read succeeds.
    const binFile = path.join(workspace, 'binary.bin')
    writeFileSync(binFile, Buffer.from([0x61, 0xff, 0x62, 0xfe]))
    const textRead = await call('fs_read_text', { path: 'binary.bin' })
    const bytesRead = await call('fs_read_bytes', { path: 'binary.bin' })
    record(
      'xuanling', 'invalid UTF-8 handled typed',
      'fs_read_text fails invalid_utf8; fs_read_bytes succeeds',
      hasTypedError(textRead, 'invalid_utf8') && !bytesRead.isError && typeof bytesRead.structured.base64 === 'string' ? 'observed' : 'mismatch',
      `text code=${JSON.stringify(textRead.code)}; bytes isError=${JSON.stringify(bytesRead.isError)} base64=${typeof bytesRead.structured.base64 === 'string'}`,
    )

    // 7. Workspace capability boundary.
    const outside = await call('fs_stat', { path: '/etc/hosts' })
    record(
      'xuanling', 'outside workspace-root denied',
      'outside_capability typed denial',
      hasTypedError(outside, 'outside_capability') ? 'observed' : 'mismatch',
      `isError code=${JSON.stringify(outside.code)}`,
    )
  } catch (error) {
    record('xuanling', 'battery harness', 'all probes run', 'harness_error', String(error))
  } finally {
    child.stdin.end()
    await killProcessGroup(child)
    lineReader.close()
    if (stderr.trim().length > 0) process.stderr.write(`probe: adapter stderr tail: ${stderr.slice(-400)}\n`)
  }
}

/** TERM the child's whole process group, then force-KILL it after a grace. */
async function killProcessGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal)
    } catch {
      // The group may already be gone.
    }
  }
  const waitForExit = (timeoutMs: number) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    let timer: NodeJS.Timeout | undefined
    const done = () => {
      if (timer !== undefined) clearTimeout(timer)
      child.off('close', done)
      child.off('error', done)
      resolve()
    }
    child.once('close', done)
    child.once('error', done)
    timer = setTimeout(done, timeoutMs)
  })

  signalGroup('SIGTERM')
  await new Promise<void>((resolve) => setTimeout(resolve, 300))
  // Always send the second signal after the grace period. The adapter may have
  // exited while its MCP child remains in the same process group.
  signalGroup('SIGKILL')
  await waitForExit(1_000)
}

// ---------------------------------------------------------------------------
// Native battery (harness's own fs stack in a bare Context).
// ---------------------------------------------------------------------------

async function nativeSession(workspace: string): Promise<void> {
  try {
    const src = (pkg: string) => pathToFileURL(path.join(dshRoot, pkg)).href
    const [{ Context }, SystemPrompt, Tools, FsLocal, ObservationPolicy, ToolFs] = await Promise.all([
      import(src('vendor/cordis/src/index.ts')),
      import(src('packages/core/system-prompt/src/index.ts')),
      import(src('packages/core/tools/src/index.ts')),
      import(src('packages/fs/fs-local/src/index.ts')),
      import(src('packages/fs/fs-observation-policy/src/index.ts')),
      import(src('packages/fs/tool-fs/src/index.ts')),
    ])
    const plugin = (module: { default?: unknown }) => (module.default ?? module) as never
    const ctx = new Context()
    await ctx.plugin(plugin(SystemPrompt))
    await ctx.plugin(plugin(Tools))
    await ctx.plugin(plugin(FsLocal))
    await ctx.plugin(plugin(ObservationPolicy))
    await ctx.plugin(plugin(ToolFs))

    const file = path.join(workspace, 'native.txt')
    writeFileSync(file, 'one\ntwo\n')

    // tools.execute resolves with a result object rather than throwing;
    // every probe must inspect the resolved outcome for the guard codes.
    // The registry contract is ToolExecutionInput: {callId, name, arguments,
    // signal} — calling it as execute(name, args) is rejected by the
    // lossless-serializability check on the arguments field.
    let probeCall = 0
    // The observation policy keys prior reads by input.agent.session and the
    // sandbox layer reads further agent properties (cwd): a bare harness has
    // no agent loop, so the positive read->edit path is UNREACHABLE here by
    // design ("actors without an agent session can never satisfy the
    // policy"). Guards 2/3 therefore record a precisely-attributed
    // harness_error; their evidence surface is the W5 A/C live transcripts.
    const execute = async (name: string, args: Record<string, unknown>) => {
      probeCall += 1
      const result = await (ctx as any).tools.execute({
        callId: `xuanling-fs-probe-${probeCall}`,
        name,
        arguments: args,
        signal: AbortSignal.timeout(20_000),
      })
      const text = JSON.stringify(result)
      const nestedCode = result?.error !== null && typeof result?.error === 'object' && typeof result.error.code === 'string'
        ? result.error.code
        : typeof result?.code === 'string' ? result.code : undefined
      const code = nestedCode ?? /FS_[A-Z_]+/.exec(text)?.[0]
      return { result, code: code ?? (result?.isError === true ? 'isError' : 'none'), isError: result?.isError === true, snippet: text.slice(0, 160) }
    }

    // Guard 1: edit without a prior tool read is rejected (native edit takes
    // file_path/old_string/new_string, NOT path/old/new).
    const guard1 = await execute('edit', { file_path: file, old_string: 'one', new_string: 'ONE' })
    const guard1Status = guard1.snippet.includes('losslessly') ? 'harness_error' : guard1.code === 'FS_NOT_OBSERVED' ? 'observed' : 'mismatch'
    record(
      'native', 'edit without prior read rejected',
      'FS_NOT_OBSERVED',
      guard1Status,
      `code=${guard1.code} isError=${JSON.stringify(guard1.isError)} result=${guard1.snippet}`,
    )

    // Guards 2/3: the positive read->edit and stale-CAS paths are owned by
    // agent-loop executions (the sandbox keys off agent properties a bare
    // harness cannot supply). Run the two exact DSH integration contracts by
    // name; an unrelated aggregate suite count is not evidence for either one.
    const contracts = await runDshNativeContracts()
    const contractEvidence = `${contracts.detail} — live agent-path evidence additionally arrives with the W5 A/C transcripts`
    record('native', 'edit after read succeeds', 'file rewritten', contracts.pass ? 'observed' : 'mismatch', contractEvidence)
    record('native', 'stale observed version rejected', 'FS_STALE_VERSION', contracts.pass ? 'observed' : 'mismatch', contractEvidence)
    await (ctx as any).fiber.dispose()
  } catch (error) {
    record('native', 'battery harness', 'assembly works', 'harness_error', String(error).slice(0, 400))
  }
}

function readSync(file: string): string {
  return readFileSync(file, 'utf8')
}

/** Run the two DSH contracts that own the positive and stale paths. */
async function runDshNativeContracts(): Promise<{ pass: boolean; detail: string }> {
  const suite = 'packages/fs/tool-fs/tests/integration.spec.ts'
  const testNames = [
    'applies a unique literal replacement after a read',
    'a stale observed version from an older read fails closed at edit CAS',
  ]
  const testNamePattern = testNames.join('|')
  const { spawnSync } = await import('node:child_process')
  const child = spawnSync(
    path.join(dshRoot, 'node_modules', '.bin', 'vitest'),
    ['run', suite, '--testNamePattern', testNamePattern, '--reporter=verbose'],
    {
    cwd: dshRoot,
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 16 * 1024 * 1024,
    env: nonSecretChildEnv({ NO_COLOR: '1', CI: '1' }),
    },
  )
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
  const testsMatch = /Tests\s+(\d+)\s+passed/.exec(output)
  const filesMatch = /Test Files\s+(\d+)\s+passed/.exec(output)
  const failedMatch = /Tests\s+(\d+)\s+failed/.exec(output)
  const failedFilesMatch = /Test Files\s+(\d+)\s+failed/.exec(output)
  const passed = child.status === 0 && testsMatch !== null && filesMatch !== null &&
    failedMatch === null && failedFilesMatch === null && Number(filesMatch[1]) === 1 &&
    Number(testsMatch[1]) === testNames.length && testNames.every((name) => output.includes(name))
  return {
    pass: passed,
    detail: `DSH native contracts (vitest): exit=${child.status ?? 'null'}, test files=${filesMatch?.[1] ?? '?'}/1, named tests=${testsMatch?.[1] ?? '?'}/${testNames.length} passed` +
      (passed ? '' : `; output head: ${output.slice(0, 200).replace(/\n/g, ' ')}`),
  }
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

const root = mkdtempSync(path.join(tmpdir(), 'xuanling-fs-probe-'))
const xuanlingWorkspace = path.join(root, 'xuanling')
const nativeWorkspace = path.join(root, 'native')
mkdirSync(xuanlingWorkspace, { recursive: true })
mkdirSync(nativeWorkspace, { recursive: true })

await xuanlingSession(xuanlingWorkspace)
await nativeSession(nativeWorkspace)

// Cancel/cleanup evidence: after teardown no probe-owned process or temp
// path may survive (the adapter/binary argv carries the probe workspace name,
// so a leaked child is greppable).
rmSync(root, { recursive: true, force: true })
const { spawnSync: cleanupSpawn } = await import('node:child_process')
const processList = cleanupSpawn('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
const residueLines = (processList.stdout ?? '').split('\n').filter((line) => {
  const match = /^\s*(\d+)\s+(.*)$/.exec(line)
  return match !== null && Number(match[1]) !== process.pid && match[2].includes(root)
}).length
const tempGone = !existsSync(root)
record(
  'xuanling', 'teardown leaves no residue',
  'no leaked processes, temp root removed',
  residueLines === 0 && tempGone ? 'observed' : 'mismatch',
  `leftover processes=${residueLines}, temp root removed=${JSON.stringify(tempGone)}`,
)
const counts = {
  total: probes.length,
  observed: probes.filter((probe) => probe.status === 'observed').length,
  mismatch: probes.filter((probe) => probe.status === 'mismatch').length,
  harness_error: probes.filter((probe) => probe.status === 'harness_error').length,
}
process.stdout.write(`${JSON.stringify({ binary, dsh_root: dshRoot, probes, counts }, null, 2)}\n`)
// A harness_error means NO evidence for that probe: the report must not look
// green while any probe lacks a verdict.
if (counts.total === 0 || counts.observed !== counts.total || counts.mismatch > 0 || counts.harness_error > 0) process.exit(1)
process.exit(0)
