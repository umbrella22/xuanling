/** @jsxRuntime classic */
/** @jsx React.createElement */
/**
 * Inspector sections that close the product loop on the canvas side:
 * revision history (list, diff, restore), Run report, operator recovery, and
 * resource provenance. Every write goes through the Host with CAS
 * (`expectedRevision` / `expectedSeq`); nothing here replays work.
 */
import React from 'react'
import { BlueprintRemoteError, type HostLink } from '../../../../adapters/host/remote.ts'
import type { BlueprintWorkspace } from '../../logic/workspace/workspace-controller.ts'
import { en as enDictionary } from '../../../../shared/i18n/locales.ts'
import type { BlueprintLocaleKey, BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'
import { REPORT_GUIDANCE_CODES } from '../../../../shared/i18n/history.ts'
import { readRevisionEntries, revisionResourceFilesChanged, summarizeDefinitionDiff, type RevisionEntry } from '../../logic/history/revision-history.ts'
import { runStateTitle } from '../../presenters/canvas-presentation.ts'
import { teamStageBlocksRecovery } from '../../../../../host/teamstage-recovery.ts'
import type { ResourceRef } from '../../../../../definition/types.ts'

type Perform = (action: () => Promise<unknown>) => void

const KNOWN_CODES = new Set<string>(REPORT_GUIDANCE_CODES)

function shortRevision(revision: string): string {
  return revision.length > 12 ? revision.slice(0, 12) : revision
}

function formatTime(at: number): string {
  try {
    return new Date(at).toLocaleString()
  } catch {
    return String(at)
  }
}

function seconds(ms: number | undefined): string {
  return ms === undefined ? '-' : `${(ms / 1000).toFixed(1)}s`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Typed Host business answer that the reviewed cut moved: re-read before retry. */
export function isRecoveryLifecycleConflict(error: unknown): boolean {
  return error instanceof BlueprintRemoteError && error.code === 'blueprint/run-lifecycle-conflict'
}

/** Localized product copy when the key exists; otherwise the raw Host value. */
function localizedValue(key: string, fallback: string, t: BlueprintLocaleProps['t']): string {
  return Object.hasOwn(enDictionary, key) ? t(key as BlueprintLocaleKey) : fallback
}

export interface RevisionHistoryProps extends BlueprintLocaleProps {
  hostLink: HostLink | undefined
  workspace: BlueprintWorkspace
  editable: boolean
  perform: Perform
}

export function RevisionHistorySection({ t, hostLink, workspace, editable, perform }: RevisionHistoryProps): React.ReactElement | null {
  const [entries, setEntries] = React.useState<RevisionEntry[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const blueprintId = workspace.document?.blueprintId ?? null
  React.useEffect(() => {
    setEntries(null)
    setError(null)
    setNotice(null)
  }, [blueprintId])
  if (hostLink?.workflowRevisions === undefined || blueprintId === null) return null
  const current = workspace.document
  const load = () =>
    perform(async () => {
      setError(null)
      try {
        setEntries(readRevisionEntries(await hostLink.workflowRevisions!(blueprintId)))
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  const restore = (entry: RevisionEntry) =>
    perform(async () => {
      if (current === null || hostLink.restoreDefinitionRevision === undefined) return
      setError(null)
      setNotice(null)
      try {
        await hostLink.restoreDefinitionRevision(blueprintId, entry.revision, current.documentRevision)
      } catch (cause) {
        setError(errorMessage(cause))
        return
      }
      // The Host already committed the restore; a client reload failure must not
      // read as a failed restore (retrying would hit a revision conflict).
      setNotice(t('history.restored'))
      try {
        await workspace.load(blueprintId)
        setEntries(readRevisionEntries(await hostLink.workflowRevisions!(blueprintId)))
      } catch {
        setError(t('history.reloadFailed'))
      }
    })
  const dirty = workspace.dirty
  return (
    <details data-bp-section={'history'} data-bp-disclosure={'history'}>
      <summary data-bp-disclosure-toggle={'history'}>
        <strong>{t('history.title')}</strong>
      </summary>
      <button type={'button'} data-bp-action={'load-history'} disabled={workspace.busy} onClick={load}>
        {t('history.load')}
      </button>
      {error !== null && (
        <p role={'alert'} data-bp-history-error={true}>
          {error}
        </p>
      )}
      {notice !== null && (
        <p role={'status'} data-bp-history-notice={true}>
          {notice}
        </p>
      )}
      {entries !== null && entries.length === 0 && <p className={'bp-muted'}>{t('history.empty')}</p>}
      {entries !== null && entries.length > 0 && (
        <ol className={'bp-history'}>
          {entries.map(entry => {
            const isCurrent = current?.documentRevision === entry.revision
            const diff = current === null ? null : summarizeDefinitionDiff(current.definitionJson, entry.definitionJson)
            const filesChanged =
              diff !== null &&
              revisionResourceFilesChanged({
                isCurrent,
                semanticChanged: diff.semanticChanged,
                entrySemanticRevision: entry.semanticRevision,
                currentSemanticRevision: current?.semanticRevision
              })
            return (
              <li key={entry.revision} data-bp-revision={entry.revision} data-bp-revision-current={isCurrent}>
                <p>
                  <strong>
                    {t('history.entry', {
                      time: formatTime(entry.createdAt),
                      origin: localizedValue(`history.origin.${entry.origin}`, entry.origin, t)
                    })}
                  </strong>
                  {' · '}
                  <code className={'bp-run-revision'}>{shortRevision(entry.revision)}</code>
                  {isCurrent && ` · ${t('history.current')}`}
                </p>
                {entry.message !== undefined && <p className={'bp-help'}>{entry.message}</p>}
                {diff !== null && !isCurrent && (
                  <ul data-bp-revision-diff={entry.revision} data-bp-revision-files-changed={filesChanged}>
                    {filesChanged ? (
                      <li>{t('history.diffResourceFiles')}</li>
                    ) : (
                      <React.Fragment>
                        {diff.identical && <li>{t('history.diffIdentical')}</li>}
                        {diff.layoutOnly && <li>{t('history.diffLayoutOnly')}</li>}
                      </React.Fragment>
                    )}
                    {diff.metadataChanged && <li>{t('history.diffMetadata')}</li>}
                    {diff.nameChanged && <li>{t('history.diffName')}</li>}
                    {diff.nodesAdded.length > 0 && <li>{t('history.diffNodesAdded', { ids: diff.nodesAdded.join(', ') })}</li>}
                    {diff.nodesRemoved.length > 0 && <li>{t('history.diffNodesRemoved', { ids: diff.nodesRemoved.join(', ') })}</li>}
                    {diff.nodesChanged.length > 0 && <li>{t('history.diffNodesChanged', { ids: diff.nodesChanged.join(', ') })}</li>}
                    {diff.edgesAdded + diff.edgesRemoved > 0 && <li>{t('history.diffEdges', { added: diff.edgesAdded, removed: diff.edgesRemoved })}</li>}
                    {diff.resourcesAdded.length + diff.resourcesRemoved.length + diff.resourcesChanged.length > 0 && (
                      <li>
                        {t('history.diffResources', {
                          added: diff.resourcesAdded.length,
                          removed: diff.resourcesRemoved.length,
                          changed: diff.resourcesChanged.length
                        })}
                      </li>
                    )}
                  </ul>
                )}
                {!isCurrent && hostLink.restoreDefinitionRevision !== undefined && (
                  <button
                    type={'button'}
                    data-bp-action={'restore-revision'}
                    data-bp-restore={entry.revision}
                    disabled={!editable || dirty || workspace.busy || current === null}
                    title={dirty ? t('history.restoreDirty') : undefined}
                    onClick={() => restore(entry)}
                  >
                    {t('history.restore')}
                  </button>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {dirty && entries !== null && entries.length > 0 && <p className={'bp-help'}>{t('history.restoreDirty')}</p>}
    </details>
  )
}

interface ReportView {
  outcome: string
  summary: { steps: number; succeeded: number; failed: number; skipped: number; pending: number }
  steps: Array<{ nodeId: string; title?: string; attemptId: string; state: string; durationMs?: number; model?: { provider: string; model: string } }>
  problems: Array<{ nodeId?: string; code: string; why: string; avoid: string }>
  markdown: string
}

function readReport(value: unknown): ReportView | null {
  if (value === null || typeof value !== 'object') return null
  const report = value as Partial<ReportView>
  if (typeof report.outcome !== 'string' || !Array.isArray(report.steps) || !Array.isArray(report.problems) || typeof report.markdown !== 'string') return null
  return report as ReportView
}

export interface RunInsightsProps extends BlueprintLocaleProps {
  hostLink: HostLink | undefined
  workspace: BlueprintWorkspace
  /** Read-only Run projection; `team` explains when only native Team cleanup can recover. */
  snapshot: { runId: string; state: string; seq?: number; team?: { state: string } | undefined } | null | undefined
  perform: Perform
}

export function RunReportSection({ t, hostLink, workspace, snapshot, perform }: RunInsightsProps): React.ReactElement | null {
  const [report, setReport] = React.useState<ReportView | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [note, setNote] = React.useState('')
  const [resolved, setResolved] = React.useState<string | null>(null)
  const runId = snapshot?.runId ?? null
  React.useEffect(() => {
    setReport(null)
    setError(null)
    setNote('')
    setResolved(null)
  }, [runId])
  if (hostLink === undefined || snapshot === null || snapshot === undefined) return null
  const guidance = (code: string, field: 'why' | 'avoid', fallback: string) =>
    KNOWN_CODES.has(code) ? t(`report.code.${code}.${field}` as BlueprintLocaleKey) : fallback
  const load = () =>
    perform(async () => {
      if (hostLink.workflowReport === undefined) return
      setError(null)
      try {
        const value = readReport(await hostLink.workflowReport(snapshot.runId))
        if (value === null) throw new Error(t('report.unavailableError'))
        setReport(value)
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  const resolve = (resolution: 'failed' | 'succeeded') =>
    perform(async () => {
      if (hostLink.resolveRecovery === undefined || snapshot.seq === undefined) return
      setError(null)
      try {
        const value = await hostLink.resolveRecovery({ runId: snapshot.runId, resolution, note: note.trim(), expectedSeq: snapshot.seq })
        setResolved(value.state)
        await workspace.inspect()
        setReport(null)
      } catch (cause) {
        if (isRecoveryLifecycleConflict(cause)) {
          // The reviewed cut moved (another reviewer, a settled Run, or Team
          // cleanup). This is a business answer from a healthy Host: re-read so
          // the form can retry with the current seq; keep the original code visible.
          try {
            await workspace.inspect()
          } catch {
            // Keep the conflict visible; the next retry re-reads again.
          }
        }
        setError(errorMessage(cause))
      }
    })
  const needsRecovery = snapshot.state === 'recovery_required' && hostLink.resolveRecovery !== undefined && snapshot.seq !== undefined
  // The Host always rejects a TeamStage recovery from the UI (native Team cleanup
  // is required first), so explain that instead of offering a dead action.
  const teamManual = snapshot.state === 'recovery_required' && teamStageBlocksRecovery(snapshot.team?.state)
  return (
    <div data-bp-section={'run-report'}>
      {teamManual && (
        <p className={'bp-help'} role={'status'} data-bp-recovery-team-manual={true}>
          {t('recovery.teamManual')}
        </p>
      )}
      {needsRecovery && !teamManual && (
        <fieldset data-bp-recovery={snapshot.runId}>
          <legend>{t('recovery.title')}</legend>
          <p className={'bp-help'}>{t('recovery.help')}</p>
          <label className={'bp-field'}>
            {t('recovery.note')}
            <textarea
              data-bp-recovery-note={true}
              rows={3}
              maxLength={500}
              value={note}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setNote(event.currentTarget.value)}
            />
          </label>
          <button type={'button'} data-bp-action={'recovery-failed'} disabled={workspace.busy || note.trim().length === 0} onClick={() => resolve('failed')}>
            {t('recovery.markFailed')}
          </button>
          <button
            type={'button'}
            data-bp-action={'recovery-succeeded'}
            disabled={workspace.busy || note.trim().length === 0}
            onClick={() => resolve('succeeded')}
          >
            {t('recovery.markSucceeded')}
          </button>
        </fieldset>
      )}
      {resolved !== null && (
        <p role={'status'} data-bp-recovery-resolved={resolved}>
          {t('recovery.resolved', { state: runStateTitle(resolved, t) })}
        </p>
      )}
      {hostLink.workflowReport !== undefined && (
        <button type={'button'} data-bp-action={'load-report'} disabled={workspace.busy} onClick={load}>
          {t('report.load')}
        </button>
      )}
      {error !== null && (
        <p role={'alert'} data-bp-report-error={true}>
          {error}
        </p>
      )}
      {report !== null && (
        <section data-bp-report={snapshot.runId}>
          <h3>{t('report.title')}</h3>
          <p data-bp-report-outcome={report.outcome}>
            {t('report.outcome', { outcome: localizedValue(`report.outcomeValue.${report.outcome}`, report.outcome, t) })}
          </p>
          <p>{t('report.summary', report.summary)}</p>
          <ol>
            {report.steps.map(step => (
              <li key={step.attemptId} data-bp-report-step={step.nodeId}>
                {t('report.step', {
                  step: step.title === undefined ? step.nodeId : `${step.title} (${step.nodeId})`,
                  state: runStateTitle(step.state, t),
                  duration: seconds(step.durationMs)
                })}
                {step.model !== undefined && <small>{` · ${t('report.model', { model: `${step.model.provider}/${step.model.model}` })}`}</small>}
              </li>
            ))}
          </ol>
          {report.problems.length === 0 ? (
            <p className={'bp-muted'}>{t('report.noProblems')}</p>
          ) : (
            <ul>
              {report.problems.map((problem, index) => (
                <li key={`${problem.code}-${index}`} data-bp-report-problem={problem.code}>
                  <strong>{problem.nodeId === undefined ? problem.code : `${problem.nodeId} · ${problem.code}`}</strong>
                  <p>
                    {t('report.why')}
                    {guidance(problem.code, 'why', problem.why)}
                  </p>
                  <p>
                    {t('report.avoid')}
                    {guidance(problem.code, 'avoid', problem.avoid)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {typeof navigator !== 'undefined' && navigator.clipboard !== undefined && (
            <button type={'button'} data-bp-action={'copy-report'} onClick={() => void navigator.clipboard.writeText(report.markdown).catch(() => undefined)}>
              {t('report.copyMarkdown')}
            </button>
          )}
        </section>
      )}
    </div>
  )
}

function nestedValue(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined
}

/** Resource keys a node references: every `*Ref` string, every `*Refs` list and
 * every TeamStage member `agentRef` (nested, but still a resource reference). */
export function nodeResourceRefs(node: object): string[] {
  const refs: string[] = []
  for (const [key, value] of Object.entries(node)) {
    if (key.endsWith('Ref') && typeof value === 'string') refs.push(value)
    else if (key.endsWith('Refs') && Array.isArray(value)) for (const item of value) if (typeof item === 'string') refs.push(item)
  }
  const members = nestedValue(nestedValue(node, 'teamStage'), 'members')
  if (Array.isArray(members)) {
    for (const member of members) {
      const agentRef = nestedValue(member, 'agentRef')
      if (typeof agentRef === 'string') refs.push(agentRef)
    }
  }
  return [...new Set(refs)]
}

export interface ResourceProvenanceProps extends BlueprintLocaleProps {
  nodeId: string
  refs: readonly string[]
  resources: Readonly<Record<string, ResourceRef>>
  bindingDigests: Readonly<Record<string, string>> | undefined
}

/** Read-only: where each referenced resource comes from, and what the latest
 * Run froze for this node. Out-of-package resources are flagged because
 * editing them changes every workflow that references them. */
export function ResourceProvenance({ t, nodeId, refs, resources, bindingDigests }: ResourceProvenanceProps): React.ReactElement | null {
  const prefix = `node:${nodeId}:`
  const digests = Object.entries(bindingDigests ?? {}).filter(([key]) => key.startsWith(prefix))
  if (refs.length === 0 && digests.length === 0) return null
  let outside = false
  const rows = refs.map(ref => {
    const resource = resources[ref]
    const source = resource?.source
    let label: string
    if (source?.kind === 'package') label = t('resource.provenancePackage', { path: source.path })
    else if (source?.kind === 'shared') {
      outside = true
      label = t('resource.provenanceShared', { root: source.rootId, path: source.path })
    } else if (source?.kind === 'host') {
      outside = true
      label = t('resource.provenanceHost', { id: source.id })
    } else if (resource?.path !== undefined) label = t('resource.provenancePackage', { path: resource.path })
    else if (resource?.kind === 'mcp' && resource.bindingId !== undefined) {
      // Host-configured MCP binding: the binding id is the stable Host identity.
      outside = true
      label = t('resource.provenanceHost', { id: resource.bindingId })
    } else label = t('resource.provenanceUnknown')
    return (
      <li key={ref} data-bp-provenance={ref}>
        <code>{ref}</code>
        {' · '}
        {label}
      </li>
    )
  })
  return (
    <details data-bp-section={'provenance'}>
      <summary>{t('resource.provenanceTitle')}</summary>
      <ul>{rows}</ul>
      {outside && <p className={'bp-help'}>{t('resource.notInPackage')}</p>}
      {digests.length > 0 && (
        <div data-bp-frozen-digests={nodeId}>
          <p className={'bp-muted'}>{t('resource.frozenDigest')}</p>
          <ul>
            {digests.map(([key, digest]) => (
              <li key={key}>
                <code title={digest}>{`${key.slice(prefix.length)} · ${digest.slice(0, 12)}`}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  )
}
