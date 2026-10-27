/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import React from 'react'
import type { BlueprintWorkspace } from '../../logic/workspace/workspace-controller.ts'
import type { BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'
import type { BlueprintTemplate, TemplateSummary, PreparationManifest } from '../../../../../templates/contracts.ts'
import type { AgentDocumentSummary } from '../../../../../host/agent-documents.ts'
import { downloadBlueprint } from '../overlays/interaction-overlays.tsx'

/** Definition reuse remains separate from Run admission. All writes retain the
 * workspace controller's busy/dirty ownership and Host revision checks. */
export function LibraryActions({ workspace, t }: BlueprintLocaleProps & { workspace: BlueprintWorkspace }) {
  const host = workspace.host
  const [templates, setTemplates] = React.useState<TemplateSummary[]>([])
  const [template, setTemplate] = React.useState<BlueprintTemplate | null>(null)
  const [templateDraft, setTemplateDraft] = React.useState('')
  const [parameters, setParameters] = React.useState<Record<string, string>>({})
  const [manifest, setManifest] = React.useState<PreparationManifest | null>(null)
  const [agents, setAgents] = React.useState<AgentDocumentSummary[]>([])
  const [notice, setNotice] = React.useState('')
  const request = React.useRef(crypto.randomUUID())
  const perform = (action: () => Promise<void>) =>
    void workspace.perform(async () => {
      setNotice('')
      try {
        await action()
      } catch (error) {
        setNotice(t('status.error', { code: (error as { code?: string }).code ?? 'blueprint/operation-failed' }))
      }
    })
  const select = (value: BlueprintTemplate) => {
    setTemplate(value)
    setTemplateDraft(JSON.stringify(value, null, 2))
    setParameters(Object.fromEntries(value.parameters.filter(p => p.default !== undefined).map(p => [p.key, p.default!])))
    request.current = crypto.randomUUID()
    setManifest(null)
  }
  if (!host?.extractTemplate) return null
  return (
    <details className="bp-library-actions" data-bp-library-actions>
      <summary>{t('library.reuse')}</summary>
      <p>{t('library.shareHelp')}</p>
      <button
        type="button"
        disabled={workspace.busy || !workspace.blueprintId}
        onClick={() =>
          perform(async () => {
            const archive = await workspace.exportArchive()
            downloadBlueprint(
              Uint8Array.from(atob(archive.archiveBase64), c => c.charCodeAt(0)),
              `${archive.blueprintId}.zip`,
              'application/zip'
            )
          })
        }
      >
        {t('library.exportCurrent')}
      </button>
      <button
        type="button"
        disabled={workspace.busy || !workspace.blueprintId}
        onClick={() =>
          perform(async () => {
            const saved = await workspace.save()
            const result = await host.extractTemplate!({
              blueprintId: saved.blueprintId,
              documentRevision: saved.documentRevision,
              requestId: crypto.randomUUID(),
              library: workspace.library
            })
            select(result.template)
            setNotice(result.portable ? t('library.reviewTemplate') : `${t('library.residual')} ${result.residual.join(', ')}`)
          })
        }
      >
        {t('library.extractTemplate')}
      </button>
      {template && (
        <>
          <label className="bp-field">
            {t('library.templateDefinition')}
            <textarea aria-label={t('library.templateDefinition')} rows={8} value={templateDraft} onChange={event => setTemplateDraft(event.target.value)} />
          </label>
          <button
            type="button"
            disabled={workspace.busy}
            onClick={() =>
              perform(async () => {
                const value = JSON.parse(templateDraft) as BlueprintTemplate
                if (templateDraft !== JSON.stringify(template, null, 2)) {
                  value.templateId = `tpl-${crypto.randomUUID()}`
                  request.current = crypto.randomUUID()
                }
                const saved = await host.saveTemplate!(value, `save-${request.current}`)
                select(saved.template)
                downloadBlueprint(new TextEncoder().encode(JSON.stringify(saved.template, null, 2)), `${saved.template.templateId}.json`, 'application/json')
                setTemplates(await host.listTemplates!())
                setNotice(t('library.templateSaved'))
              })
            }
          >
            {t('library.saveTemplate')}
          </button>
        </>
      )}
      <hr />
      <button type="button" disabled={workspace.busy} onClick={() => perform(async () => setTemplates(await host.listTemplates!()))}>
        {t('library.useTemplate')}
      </button>
      <select
        aria-label={t('library.useTemplate')}
        value={template?.templateId ?? ''}
        disabled={workspace.busy}
        onChange={event => {
          const id = event.target.value
          if (id) perform(async () => select(await host.loadTemplate!(id)))
        }}
      >
        <option value="">{t('library.chooseTemplate')}</option>
        {templates.map(item => (
          <option key={item.templateId} value={item.templateId}>
            {item.name}
          </option>
        ))}
      </select>
      <label className="bp-field">
        {t('library.importTemplate')}
        <input
          type="file"
          accept="application/json,.json"
          disabled={workspace.busy}
          onChange={event => {
            const file = event.target.files?.[0]
            if (file)
              perform(async () => {
                const value = JSON.parse(await file.text()) as BlueprintTemplate
                const saved = await host.saveTemplate!(value, crypto.randomUUID())
                select(saved.template)
                setTemplates(await host.listTemplates!())
              })
          }}
        />
      </label>
      {template?.parameters.map(parameter => (
        <label className="bp-field" key={parameter.key}>
          {parameter.label}
          <input
            value={parameters[parameter.key] ?? ''}
            onChange={event => {
              setParameters({ ...parameters, [parameter.key]: event.target.value })
              request.current = crypto.randomUUID()
            }}
          />
        </label>
      ))}
      {workspace.library?.kind !== 'workspace' && <p>{t('status.workspaceRequired')}</p>}
      <button
        type="button"
        disabled={workspace.busy || !template || templateDraft !== JSON.stringify(template, null, 2) || workspace.library?.kind !== 'workspace'}
        onClick={() =>
          perform(async () => {
            if (!template || workspace.library?.kind !== 'workspace') return
            if (workspace.blueprintId && workspace.dirty) await workspace.save()
            const saved = await host.saveTemplate!(template, `save-${request.current}`)
            const result = await host.instantiateTemplate!({
              templateId: saved.template.templateId,
              workspaceId: workspace.library.workspaceId,
              requestId: request.current,
              parameters
            })
            setManifest(result.manifest)
            if (result.instance) {
              await workspace.refreshLibraries()
              await workspace.load(result.instance.asset.blueprintId)
            }
          })
        }
      >
        {t('library.prepareTemplate')}
      </button>
      {manifest && (
        <div role="status" data-bp-preparation={manifest.status}>
          <p>
            {manifest.status}: {manifest.unresolved.join(', ')}
          </p>
          <ul>
            {manifest.facts.map((fact, index) => (
              <li key={index}>
                {fact.value} · <code>{fact.sourcePath}</code> · {fact.status} · {fact.digest.slice(0, 12)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <hr />
      <button
        type="button"
        disabled={workspace.busy}
        onClick={() => perform(async () => setAgents((await host.listAgentDocuments!({ library: workspace.library })).documents))}
      >
        {t('library.agentDocuments')}
      </button>
      {agents.map(agent => (
        <button
          key={agent.documentId}
          type="button"
          disabled={workspace.busy || !workspace.blueprintId}
          onClick={() =>
            perform(async () => {
              const saved = await workspace.save()
              await host.importAgentDocument!({
                documentId: agent.documentId,
                blueprintId: saved.blueprintId,
                expectedRevision: saved.documentRevision,
                library: workspace.library
              })
              await workspace.load(saved.blueprintId)
            })
          }
        >
          {agent.name} · {agent.source}
        </button>
      ))}
      {notice && <p role="status">{notice}</p>}
    </details>
  )
}
