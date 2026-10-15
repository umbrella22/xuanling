/** Native TeamStage execution of the scheduler's original frozen graph Attempt. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { GraphNode } from '../definition/types.ts'
import type { RunRecord, TeamMemberReservation } from '../persistence/records.ts'
import type { RunStore } from '../persistence/run-store.ts'
import type { PreparedTeam } from '../resources/runtime-snapshots.ts'
import { TeamNativeAdapter } from './native-adapter.ts'
import { TeamStageRunner } from './runner.ts'
import { acceptTeamOutput } from './acceptance.ts'
import { TeamOutputArtifacts } from './output-artifact.ts'
import { admitTeamDriver, TEAM_MEMBER_TOOLS, TeamDriverError, type TeamProviders } from './driver-admission.ts'
import { installTeamMemberScope } from './member-scope.ts'
import { teamStageControl, teamStageAbortError, TeamStageObservations } from './observability.ts'

type PendingMember = { reservation: TeamMemberReservation; agent?: Agent; scope?: ReturnType<typeof installTeamMemberScope> }

function parseSpawnedMember(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TeamDriverError('teamstage-member-identity-unavailable')
  const member = (value as Record<string, unknown>).member
  if (member === null || typeof member !== 'object' || Array.isArray(member)) throw new TeamDriverError('teamstage-member-identity-unavailable')
  return member as Record<string, unknown>
}

export class TeamStageDriver {
  constructor(
    private readonly ctx: Context,
    private readonly store: RunStore,
    private readonly runtimeRoot: string,
    private readonly providers: TeamProviders = {},
    private readonly observations = new TeamStageObservations()
  ) {}

  async execute(args: {
    record: RunRecord
    node: GraphNode
    attemptId: string
    source: Agent
    prepared: PreparedTeam
    effectiveToolNames: readonly string[]
    input: unknown
    cwd: string
    signal: AbortSignal
    mapOutputs(value: unknown): Record<string, unknown>
  }): Promise<void> {
    const { record, node, attemptId, prepared } = args
    const stageControl = new AbortController()
    // DSH owns provider stream-idle and Team disposal budgets. Blueprint only
    // composes caller/stage cancellation and never manufactures a total stage
    // deadline of its own.
    const control = teamStageControl(args.signal, stageControl.signal)
    const signal = control.signal
    try {
      const config = node.teamStage
      if (node.kind !== 'agentTask' || !config || !prepared.outputSchema) throw new TeamDriverError('teamstage-config-unavailable')
      const lead = admitTeamDriver(this.ctx, node, args.source, this.providers)
      if (record.source?.sessionId !== lead.agent.id) throw new TeamDriverError('teamstage-identity-unavailable')
      signal.throwIfAborted()
      if (record.teamStage !== undefined) throw new TeamDriverError('teamstage-replay-requires-recovery')
      const runner = new TeamStageRunner(this.store)
      const adapter = new TeamNativeAdapter(this.ctx)
      const base = { store: this.store, runId: record.runId, stageId: node.id, teamId: lead.teamId, actorSessionId: lead.agent.id }
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ config, resources: prepared.resourceDigests }))
        .digest('hex')
      await this.store.bindTeamStage(record.runId, {
        stageId: node.id,
        attemptId,
        teamId: lead.teamId,
        leadSessionId: lead.agent.id,
        taskSpecificationFingerprint: fingerprint,
        requiredChecks: [...config.requiredChecks]
      })
      await this.store.recordTeamStageExecution(record.runId, attemptId, control.snapshot())
      this.observations.begin(record.runId, attemptId)
      const assertDispatch = async () => {
        signal.throwIfAborted()
        const current = await this.store.get(record.runId)
        if (current.state !== 'running' || current.teamStage?.attemptId !== attemptId || !['provisioning', 'active'].includes(current.teamStage.state))
          throw new TeamDriverError('teamstage-not-dispatching')
        if (adapter.lead(lead.agent).agent !== args.source) throw new TeamDriverError('teamstage-identity-unavailable')
      }
      const stopped = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(teamStageAbortError(signal))
        else signal.addEventListener('abort', () => reject(teamStageAbortError(signal)), { once: true })
      })
      void stopped.catch(() => {})
      const pending: PendingMember[] = []
      let nativePending = false
      let removeCreation: (() => void) | undefined
      try {
        // All native request exceptions are unknown by default: append may have
        // committed before flush/checkpoint rejects. No implicit retry or rename.
        await assertDispatch()
        const task = await runner.dispatch({
          ...base,
          effectId: `team-create:${attemptId}`,
          kind: 'create',
          effect: async () => await Promise.race([adapter.createTask(lead, { ...config.task }), stopped]),
          result: task => {
            if (typeof task.id !== 'string' || !Number.isInteger(task.revision) || task.revision !== 1) throw new TeamDriverError('teamstage-task-invalid')
            return { ok: true, taskId: task.id, taskRevision: task.revision as number }
          },
          unknown: () => true
        })
        const taskId = task.id as string
        await this.store.bindTeamTask(record.runId, { taskId, taskRevision: task.revision as number })
        for (const [index, member] of config.members.entries()) {
          const resource = prepared.members[index]
          if (resource?.logicalName !== member.name) throw new TeamDriverError('teamstage-resource-policy-mismatch')
          const reservation = await this.store.reserveTeamMember(record.runId, {
            attemptId,
            effectId: `team-spawn:${attemptId}:${index}`,
            logicalName: member.name,
            schema: prepared.outputSchema,
            resourceDigests: resource.resourceDigests
          })
          pending.push({ reservation })
        }
        removeCreation = this.ctx.on('agent/created', async ({ agent, signal: creationSignal }) => {
          const roster = adapter.listMembers(lead)
          const row = roster.find(row => row.id === agent.id && pending.some(entry => entry.reservation.nativeName === row.name))
          if (row === undefined) return
          const entry = pending.find(entry => entry.reservation.nativeName === row.name)!
          signal.throwIfAborted()
          creationSignal?.throwIfAborted()
          const registry = this.ctx.get('agents')
          if (registry?.get(SessionId(agent.id)) !== agent) throw new TeamDriverError('teamstage-member-identity-unavailable')
          const membership = lead.service.tryMembership?.(agent) ?? lead.service.membership(agent)
          if (
            membership.root !== lead.agent ||
            membership.role !== 'teammate' ||
            membership.id !== lead.teamId ||
            membership.name !== entry.reservation.nativeName ||
            !['provisioning', 'running', 'inactive'].includes(row.status as string) ||
            entry.agent !== undefined
          ) {
            throw new TeamDriverError('teamstage-member-identity-unavailable')
          }
          if (TEAM_MEMBER_TOOLS.some(name => !agent.ctx.tools.get(name, agent))) throw new TeamDriverError('teamstage-tools-unavailable')
          entry.agent = agent
          const activity = this.observations.bind(record.runId, attemptId, entry.reservation.memberId, agent.id)
          entry.scope = installTeamMemberScope(agent, {
            schema: prepared.outputSchema!,
            effectiveToolNames: args.effectiveToolNames,
            observerContext: this.ctx,
            taskId,
            nativeNames: pending.map(member => member.reservation.nativeName),
            primary: entry === pending[0],
            signal,
            store: this.store,
            runId: record.runId,
            stageId: node.id,
            teamId: lead.teamId,
            attemptId,
            memberId: entry.reservation.memberId,
            nativeName: entry.reservation.nativeName,
            ...(activity === undefined ? {} : { activity }),
            onUnknown: () => {
              stageControl.abort(new TeamDriverError('teamstage-team-effect-unknown'))
            }
          })
          // This RMW is independent of the native creation operation; never wait
          // for spawn completion or a turn in the awaited creation listener.
          await this.store.bindTeamMemberReservation(record.runId, {
            attemptId,
            effectId: entry.reservation.effectId,
            memberId: entry.reservation.memberId,
            sessionId: agent.id
          })
        })
        const order = [...pending.slice(1), pending[0]!]
        for (const entry of order) {
          const index = pending.indexOf(entry)
          const declaration = config.members[index]!
          const resource = prepared.members[index]!
          await assertDispatch()
          const roster = adapter.listMembers(lead)
          if (roster.some(row => row.name === entry.reservation.nativeName)) throw new TeamDriverError('teamstage-native-name-collision')
          const addresses = pending.map(member => ({ logicalName: member.reservation.logicalName, nativeName: member.reservation.nativeName }))
          const instructions = [
            `[Blueprint TeamStage task ${taskId}] ${config.task.subject}\n${config.task.description}`,
            `You are ${declaration.name}; native address ${entry.reservation.nativeName}. Address map: ${JSON.stringify(addresses)}.`,
            index === 0
              ? 'You are the primary producer. Claim this task, coordinate with every collaborator, complete the native task and report the agreed structured value.'
              : 'You are a required collaborator. Work on this common task, coordinate by native peer messages and report the agreed structured value. Only the primary claims/completes it.',
            'Some addresses may still be provisioning or not registered yet. Use list_agents to check before messaging; never infer availability or success from inactive. Do not message yourself. Before reporting structured_output, verify every declared address is registered and agree over native peer messages/shared task. Send contributions before final capture; all members must report identical final JSON.',
            `[Stage agent]\n${prepared.agentMd}\n[Member agent]\n${resource.agentMd}`,
            ...prepared.skills.map(
              (skill, skillIndex) =>
                `[Skill ${skill.name} digest=${skill.digest}]\n${skill.content}\n[Immutable Skill directory: ${join(args.cwd, '.blueprint-skills', String(skillIndex))}]`
            ),
            `[Input]\n${typeof args.input === 'string' ? args.input : JSON.stringify(args.input)}`
          ].join('\n\n')
          nativePending = true
          const view = await runner.dispatch({
            ...base,
            effectId: entry.reservation.effectId,
            kind: 'spawn',
            taskId,
            memberId: entry.reservation.memberId,
            memberName: entry.reservation.nativeName,
            effect: async () =>
              await Promise.race([
                adapter.spawnTeammate(lead, {
                  name: entry.reservation.nativeName,
                  description: declaration.description,
                  context: declaration.context,
                  provider: this.providers[declaration.context] ?? (declaration.context === 'fresh' ? 'spawn' : 'fork'),
                  prompt: [{ type: 'text', text: instructions }],
                  signal
                }),
                stopped
              ]),
            result: value => {
              const row = parseSpawnedMember(value)
              if (!entry.agent || !entry.scope || row.id !== entry.agent.id || row.name !== entry.reservation.nativeName)
                throw new TeamDriverError('teamstage-member-identity-unavailable')
              return { ok: true, memberId: entry.agent.id, status: entry.agent.status === 'running' ? 'running' : 'inactive' }
            },
            unknown: () => true
          })
          nativePending = false
          await this.store.upsertTeamMember(record.runId, {
            memberId: entry.reservation.memberId,
            name: entry.reservation.nativeName,
            logicalName: declaration.name,
            sessionId: entry.agent!.id,
            phase: 'active',
            status: parseSpawnedMember(view).status === 'running' ? 'running' : 'inactive'
          })
        }
        const artifacts = new TeamOutputArtifacts(this.runtimeRoot)
        const completions = await Promise.allSettled(pending.map(entry => entry.scope!.finish(signal)))
        const rejected = completions.find(result => result.status === 'rejected')
        if (rejected?.status === 'rejected') throw rejected.reason
        for (const [index, entry] of pending.entries()) {
          const result = completions[index]!
          if (result.status !== 'fulfilled') throw new TeamDriverError('teamstage-quiescence-unverified')
          const capture = result.value
          await assertDispatch()
          const row = adapter.listMembers(lead).find(row => row.id === entry.agent!.id && row.name === entry.reservation.nativeName)
          if (row?.status !== 'inactive') throw new TeamDriverError('teamstage-quiescence-unverified')
          entry.scope!.assertQuiescent()
          await this.store.upsertTeamMember(record.runId, {
            memberId: entry.reservation.memberId,
            name: entry.reservation.nativeName,
            logicalName: entry.reservation.logicalName,
            sessionId: entry.agent!.id,
            phase: 'active',
            status: 'inactive'
          })
          await artifacts.commitCapture({ store: this.store, runId: record.runId, attemptId, memberId: entry.reservation.memberId, ...capture })
        }
        await assertDispatch()
        const completedTask = adapter.getTask(lead, taskId)
        if (completedTask.id !== taskId || typeof completedTask.revision !== 'number' || completedTask.status !== 'completed')
          throw new TeamDriverError('teamstage-task-not-completed')
        const stage = (await this.store.get(record.runId)).teamStage!
        await this.store.observeTeamTaskRevision(record.runId, { taskId, taskRevision: completedTask.revision }, stage.taskRevision!)
        const observation = { id: taskId, revision: completedTask.revision, status: completedTask.status as string }
        const verified = await artifacts.verifyStage({ store: this.store, runId: record.runId, task: observation })
        const verdict = verified.hostVerdict
        const outputs = args.mapOutputs(verified.primaryValue)
        signal.throwIfAborted()
        for (const entry of pending) entry.scope!.assertQuiescent()
        await acceptTeamOutput({
          store: this.store,
          runId: record.runId,
          attemptId,
          artifacts,
          task: observation,
          hostVerdict: verdict,
          outputs,
          output: {
            code: 'accepted',
            schemaVersion: 1,
            runId: record.runId,
            stageId: node.id,
            taskId,
            attemptId,
            sourceSessionId: verdict.producerSessionId,
            artifactId: verdict.artifactId,
            digest: verdict.digest,
            evidenceDigest: verdict.evidenceDigest,
            checks: [...new Set(['schema', 'digest', 'artifact-digest', 'agreement', ...config.requiredChecks])]
          }
        })
      } catch (error) {
        if (control.snapshot().abort !== undefined) await this.store.recordTeamStageExecution(record.runId, attemptId, control.snapshot())
        throw error
      } finally {
        // A surviving continuation never regains business/mutation authority
        // after either a known failure or accepted settlement.
        stageControl.abort(new TeamDriverError('teamstage-not-dispatching'))
        this.observations.end(record.runId, attemptId)
        // Unknown late creation remains fail-closed under this registered hook.
        if (!nativePending) removeCreation?.()
        for (const member of pending) member.scope?.dispose()
      }
    } finally {
      control.dispose()
    }
  }
}
