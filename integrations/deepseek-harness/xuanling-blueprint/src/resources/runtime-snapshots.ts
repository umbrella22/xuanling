/** Internal durable byte closure, separate from the portable definition/domain schema.
 * Run package bytes are immutable; only a NEW Attempt resolves shared roots again.
 * Snapshots are committed before dispatch intent. Unknown effects retain their cwd.
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertObjectJsonSchema, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { BlueprintDefinition, GraphNode } from '../definition/types.ts'
import { admitResources, admitSnapshotPaths } from '../security/resource-admission.ts'
import { ResourceUnavailableError, resolveResource, type SkillRoot } from './resolver.ts'
import { snapshotDirectory, snapshotFile, type SnapshotFile } from './snapshotter.ts'
import { parseHostAgentComposition, validatePackagedPreset, type PackagedPreset, type HostAgentComposition } from '../portability/host-resources.ts'

interface FrozenFile {
  path: string
  digest: string
  base64: string
}
interface Bundle {
  version: 1
  files: FrozenFile[]
  digest: string
}
export interface Prepared {
  agentMd: string
  /** Host-owned preset selected for this Attempt. The preset body is never
   * copied into the package; the Agent factory resolves this identity. */
  agentPreset?: string
  agentComposition?: PackagedPreset
  hostAgentComposition?: HostAgentComposition
  outputSchema?: ObjectJsonSchema
  skills: Array<{ name: string; content: string; digest: string }>
  resourceDigests: Record<string, string>
  materialize(attemptId: string): string
}

/** Optional adapter for DSH-owned resources. Keeping this seam structural
 * lets callers provide `ctx.agentPresets`/`ctx.skills` without coupling the
 * portable blueprint package to a particular DSH release. */
export interface HostResourceProvider {
  getAgentPreset(id: string): Promise<{ composition?: HostAgentComposition } | undefined>
  getSkill(
    id: string,
    options: { cwd: string }
  ): Promise<
    | {
        content?: string
        /** Provider-relative files. Absolute paths are deliberately not accepted. */
        files?: Record<string, string | Buffer> | Array<{ path: string; bytes: Buffer }>
      }
    | undefined
  >
}
/** Resolve DSH registry winners on every call. File-backed Skills keep their
 * full safe directory; virtual Skills with external relative assets fail
 * closed because those assets cannot be frozen into an Attempt cwd. */
export function createHostResourceProvider(ownerCtx: { get(service: string): unknown }): HostResourceProvider {
  return {
    async getAgentPreset(id) {
      let registry:
        | {
            resolve?(id: string): Promise<{ id?: string; broken?: unknown }>
            list?(): Promise<Array<{ id: string; broken?: unknown }>>
            readDocument?(id: string): Promise<{ content: string }>
          }
        | undefined
      try {
        registry = ownerCtx.get('agentPresets') as typeof registry
      } catch {
        return undefined
      }
      try {
        if (typeof registry?.resolve === 'function') {
          const preset = await registry.resolve(id)
          if (preset.id !== id || preset.broken !== undefined) return undefined
        } else if (typeof registry?.list === 'function') {
          if (!(await registry.list()).some(preset => preset.id === id && preset.broken === undefined)) return undefined
        } else return undefined
        if (typeof registry.readDocument === 'function') {
          const document = await registry.readDocument(id)
          return { composition: parseHostAgentComposition(document.content) }
        }
        return {}
      } catch {
        return undefined
      }
    },
    async getSkill(id, options) {
      let registry:
        | {
            get?(
              id: string,
              options: { cwd: string }
            ): Promise<
              | {
                  content: string
                  path?: string
                  resourceBase?: { kind: string; path?: string }
                }
              | undefined
            >
          }
        | undefined
      try {
        registry = ownerCtx.get('skills') as typeof registry
      } catch {
        return undefined
      }
      if (typeof registry?.get !== 'function') return undefined
      const skill = await registry.get(id, options)
      if (skill === undefined || typeof skill.content !== 'string') return undefined
      const base = skill.resourceBase
      if (base !== undefined && (base.kind !== 'directory' || typeof base.path !== 'string'))
        throw new ResourceUnavailableError(id, 'Host Skill assets cannot be materialized')
      const directory = base?.path ?? (skill.path === undefined ? undefined : dirname(skill.path))
      if (directory === undefined) return { content: skill.content }
      const tree = snapshotDirectory(directory, { kind: 'package-path', absolutePath: directory })
      return { content: skill.content, files: tree.files.map(file => ({ path: file.path, bytes: file.bytes })) }
    }
  }
}
export interface PreparedTeam extends Prepared {
  members: Array<{ logicalName: string; agentMd: string; resourceDigests: Record<string, string> }>
}
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
function bundle(files: SnapshotFile[]): Bundle {
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (admitSnapshotPaths(files.map(f => f.path)).length || new Set(files.map(f => f.path.normalize('NFC').toLowerCase())).size !== files.length)
    throw new Error('resource closure paths rejected')
  return {
    version: 1,
    files: files.map(f => ({ path: f.path, digest: f.digest, base64: f.bytes.toString('base64') })),
    digest: hash(files.map(f => `${f.path}\0${f.digest}\n`).join(''))
  }
}
function verify(value: Bundle): Bundle {
  if (value.version !== 1 || !Array.isArray(value.files)) throw new Error('snapshot format rejected')
  const checked = bundle(
    value.files.map(f => {
      const bytes = Buffer.from(f.base64, 'base64')
      if (hash(bytes) !== f.digest) throw new Error('snapshot integrity rejected')
      return { path: f.path, digest: f.digest, bytes }
    })
  )
  if (checked.digest !== value.digest) throw new Error('snapshot tree integrity rejected')
  return checked
}
function durableWrite(path: string, value: Bundle): void {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    if (load(path).digest !== value.digest) throw new Error('immutable snapshot conflict')
    return
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    // Directory durability matters: a successful file fsync alone is not a commit.
    const dir = openSync(dirname(path), 'r')
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}
function load(path: string): Bundle {
  return verify(JSON.parse(readFileSync(path, 'utf8')) as Bundle)
}
function fileBytes(value: Bundle, path: string): Buffer {
  const file = value.files.find(f => f.path === path)
  if (!file) throw new Error('required frozen package resource unavailable')
  return Buffer.from(file.base64, 'base64')
}
function putFiles(cwd: string, value: Bundle, prefix = ''): void {
  for (const file of value.files) {
    const target = join(cwd, prefix, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, Buffer.from(file.base64, 'base64'), { mode: 0o600, flag: 'wx' })
  }
}

export class RuntimeSnapshots {
  constructor(
    private readonly runtimeRoot: string,
    private readonly configuredRoots?: () => SkillRoot[],
    private readonly hostResources?: HostResourceProvider
  ) {}
  private packagePath(runId: string): string {
    return join(this.runtimeRoot, 'snapshots', runId, 'package.json')
  }

  async freezePackage(runId: string, definition: BlueprintDefinition, rootDir?: string): Promise<void> {
    if (admitResources(definition.resources).length) throw new Error('resource admission rejected')
    const files = new Map<string, SnapshotFile>()
    if (rootDir !== undefined) {
      const root = resolve(rootDir)
      const lib = join(root, 'lib')
      if (existsSync(lib)) {
        const rel = relative(realpathSync(root), realpathSync(lib))
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('package lib escapes root')
        for (const file of snapshotDirectory(lib, { kind: 'package-path', absolutePath: lib }).files) {
          files.set(`lib/${file.path}`, { ...file, path: `lib/${file.path}` })
        }
      }
      for (const [id, ref] of Object.entries(definition.resources)) {
        const path = ref.path ?? (ref.source?.kind === 'package' ? ref.source.path : undefined)
        if (path === undefined) continue
        // Package Skill directories are full closures, not a single SKILL.md.
        if (ref.kind === 'skill') {
          const resource = await resolveResource(id, { kind: ref.kind, path: `${path}/SKILL.md` }, { blueprintRoot: root, roots: [] })
          if (resource.kind !== 'package-file') throw new Error('package Skill rejected')
          for (const file of snapshotDirectory(dirname(resource.absolutePath), { kind: 'package-path', absolutePath: dirname(resource.absolutePath) }).files) {
            files.set(`${path}/${file.path}`, { ...file, path: `${path}/${file.path}` })
          }
        } else {
          const resource = await resolveResource(id, { kind: ref.kind === 'mcp' ? 'schema' : ref.kind, path }, { blueprintRoot: root, roots: [] })
          if (resource.kind !== 'package-file') throw new Error('package resource rejected')
          const file = snapshotFile(resource.absolutePath, { kind: 'package-path', absolutePath: resource.absolutePath }).files[0]!
          files.set(path, { ...file, path })
        }
      }
    } else if (Object.values(definition.resources).some(r => r.path || r.source?.kind === 'package')) {
      throw new Error('package root required')
    }
    durableWrite(this.packagePath(runId), bundle([...files.values()]))
  }

  async prepare(runId: string, definition: BlueprintDefinition, node: GraphNode): Promise<Prepared> {
    const pkg = load(this.packagePath(runId))
    const agentRef = node.agentRef === undefined ? undefined : definition.resources[node.agentRef]
    const source = agentRef?.source
    const hostAgentId = source?.kind === 'host' ? source.id : undefined
    let agentMd = ''
    let agentPreset: string | undefined
    let agentComposition: PackagedPreset | undefined
    let hostAgentComposition: HostAgentComposition | undefined
    const resourceDigests: Record<string, string> = { $package: pkg.digest }
    if (hostAgentId !== undefined) {
      if (!node.agentRef || agentRef?.kind !== 'agent' || this.hostResources === undefined)
        throw new ResourceUnavailableError(node.agentRef ?? 'agent', 'Host Agent preset provider unavailable')
      const preset = await this.hostResources.getAgentPreset(hostAgentId)
      if (preset === undefined) throw new ResourceUnavailableError(node.agentRef, `Host Agent preset "${hostAgentId}" unavailable`)
      agentPreset = hostAgentId
      if (preset.composition !== undefined) {
        hostAgentComposition = structuredClone(preset.composition)
        const bytes = Buffer.from(JSON.stringify(hostAgentComposition))
        resourceDigests[node.agentRef] = hash(bytes)
        durableWrite(join(this.runtimeRoot, 'snapshots', 'host-agents', `${hash(bytes)}.json`), bundle([{ path: 'preset.json', digest: hash(bytes), bytes }]))
      }
    } else {
      const agentPath = agentRef?.path ?? (agentRef?.source?.kind === 'package' ? agentRef.source.path : undefined)
      if (!node.agentRef || !agentPath) throw new Error('agent resource unavailable')
      const agentBytes = fileBytes(pkg, agentPath)
      if (agentRef?.format === 'agent-preset') {
        agentComposition = validatePackagedPreset(JSON.parse(agentBytes.toString('utf8')))
        if (agentComposition.requiredBindings.length > 0)
          throw new ResourceUnavailableError(node.agentRef, 'Packaged preset requires explicit destination bindings')
      } else agentMd = agentBytes.toString('utf8')
      resourceDigests[node.agentRef] = hash(agentBytes)
    }
    let outputSchema: ObjectJsonSchema | undefined
    if (node.outputSchemaRef !== undefined) {
      const ref = definition.resources[node.outputSchemaRef]
      const path = ref?.path ?? (ref?.source?.kind === 'package' ? ref.source.path : undefined)
      if (ref?.kind !== 'schema' || path === undefined) throw new Error('output schema resource unavailable')
      const bytes = fileBytes(pkg, path)
      try {
        const schema: unknown = JSON.parse(bytes.toString('utf8'))
        assertObjectJsonSchema(schema)
        outputSchema = schema
      } catch {
        throw new Error('frozen output schema rejected')
      }
      resourceDigests[node.outputSchemaRef] = hash(bytes)
    }
    const trees: Array<{ value: Bundle; prefix: string }> = []
    const skills: Prepared['skills'] = []
    let roots: SkillRoot[] = []
    const bindings = join(this.runtimeRoot, 'root-bindings.json')
    if (this.configuredRoots !== undefined) roots = this.configuredRoots()
    else if (existsSync(bindings)) roots = (JSON.parse(readFileSync(bindings, 'utf8')) as { roots: SkillRoot[] }).roots
    for (const [index, id] of (node.skillRefs ?? []).entries()) {
      const ref = definition.resources[id]
      if (!ref || ref.kind !== 'skill') throw new Error('Skill resource unavailable')
      let value: Bundle
      const skillSource = ref.source
      if (skillSource?.kind === 'host') {
        if (typeof skillSource.id !== 'string' || this.hostResources === undefined) {
          throw new ResourceUnavailableError(id, 'Host Skill provider unavailable')
        }
        const loaded = await this.hostResources.getSkill(skillSource.id, { cwd: process.cwd() })
        if (loaded === undefined || typeof loaded.content !== 'string') {
          throw new ResourceUnavailableError(id, `Host Skill "${skillSource.id}" unavailable`)
        }
        const hostFiles: SnapshotFile[] = [{ path: 'SKILL.md', bytes: Buffer.from(loaded.content), digest: hash(loaded.content) }]
        if (Array.isArray(loaded.files))
          hostFiles.push(
            ...loaded.files.filter(file => file.path !== 'SKILL.md').map(file => ({ path: file.path, bytes: file.bytes, digest: hash(file.bytes) }))
          )
        else if (loaded.files !== undefined) {
          for (const [path, bytes] of Object.entries(loaded.files)) {
            if (path === 'SKILL.md') continue
            const value = typeof bytes === 'string' ? Buffer.from(bytes) : bytes
            hostFiles.push({ path, bytes: value, digest: hash(value) })
          }
        }
        value = bundle(hostFiles)
      } else if (ref.source?.kind === 'shared') {
        const resource = await resolveResource(id, { kind: ref.kind, source: ref.source }, { blueprintRoot: '', roots })
        if (resource.kind !== 'shared-skill') throw new Error('Skill resource rejected')
        value = bundle(
          snapshotDirectory(resource.skillDir, { kind: 'shared-skill', rootId: resource.rootId, skillDir: resource.skillDir, skillName: resource.skillName })
            .files
        )
      } else {
        const path = ref.path ?? (ref.source?.kind === 'package' ? ref.source.path : undefined)
        if (!path) throw new Error('package Skill path required')
        value = bundle(
          pkg.files
            .filter(f => f.path.startsWith(`${path}/`))
            .map(f => ({ path: f.path.slice(path.length + 1), digest: f.digest, bytes: Buffer.from(f.base64, 'base64') }))
        )
      }
      const content = fileBytes(value, 'SKILL.md').toString('utf8')
      durableWrite(join(this.runtimeRoot, 'snapshots', 'trees', `${value.digest}.json`), value)
      resourceDigests[id] = value.digest
      const prefix = `.blueprint-skills/${index}`
      trees.push({ value, prefix })
      skills.push({ name: id, content: `${content}\n[Full Skill directory: ${prefix}]`, digest: value.digest })
    }
    return {
      agentMd,
      ...(agentPreset === undefined ? {} : { agentPreset }),
      ...(agentComposition === undefined ? {} : { agentComposition }),
      ...(hostAgentComposition === undefined ? {} : { hostAgentComposition }),
      skills,
      resourceDigests,
      ...(outputSchema === undefined ? {} : { outputSchema }),
      materialize: attemptId => {
        const cwd = join(this.runtimeRoot, 'attempts', runId, attemptId)
        mkdirSync(cwd, { recursive: true, mode: 0o700 })
        putFiles(cwd, pkg)
        for (const tree of trees) putFiles(cwd, tree.value, tree.prefix)
        return cwd
      }
    }
  }

  /** One common Skill closure for this Attempt; member agent bytes come from
   * the same immutable package, never from a second live Skill resolution. */
  async prepareTeam(runId: string, definition: BlueprintDefinition, node: GraphNode): Promise<PreparedTeam> {
    if (node.teamStage === undefined) throw new Error('Team configuration required')
    if (node.modelSelection !== undefined) throw new Error('TeamStage node model selection is unavailable')
    const lead = node.agentRef === undefined ? undefined : definition.resources[node.agentRef]
    if (lead?.source?.kind === 'host') throw new ResourceUnavailableError(node.agentRef ?? 'agent', 'Host Agent presets are not supported for TeamStage lead')
    if (lead?.format === 'agent-preset')
      throw new ResourceUnavailableError(node.agentRef ?? 'agent', 'Packaged Agent presets are not supported for TeamStage lead')
    const common = await this.prepare(runId, definition, node)
    const pkg = load(this.packagePath(runId))
    const members = node.teamStage.members.map(member => {
      const ref = definition.resources[member.agentRef]
      const source = ref?.source
      if (source?.kind === 'host') throw new ResourceUnavailableError(member.agentRef, 'Host Agent presets are not supported for TeamStage members')
      if (ref?.format === 'agent-preset') throw new ResourceUnavailableError(member.agentRef, 'Packaged Agent presets are not supported for TeamStage members')
      const path = ref?.path ?? (ref?.source?.kind === 'package' ? ref.source.path : undefined)
      if (ref?.kind !== 'agent' || path === undefined) throw new Error('member agent resource unavailable')
      const bytes = fileBytes(pkg, path)
      return { logicalName: member.name, agentMd: bytes.toString('utf8'), resourceDigests: { ...common.resourceDigests, [member.agentRef]: hash(bytes) } }
    })
    const resourceDigests = Object.assign({}, common.resourceDigests, ...members.map(member => member.resourceDigests)) as Record<string, string>
    return { ...common, members, resourceDigests }
  }
}
