/** Explicitly authorized use of the selected web-profile provider in a fresh profile. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import * as yaml from 'js-yaml'
import { prepareProfile, bootHost, stopHost, makeGateway } from './conversation-runtime.mjs'

if (process.argv.includes('--help')) {
  console.log(
    'authoring-live.mjs --authorized-web-profile <absolute profile> --report-dir <fresh absolute directory>\nCopies only the selected provider and its credential into an ephemeral profile; uses actual native Agent tools. No existing blueprint changes.'
  )
  process.exit(0)
}
assert.equal(process.argv[2], '--authorized-web-profile')
assert.equal(process.argv[4], '--report-dir')
const authorizedProfile = resolve(process.argv[3]),
  reportDir = resolve(process.argv[5])
mkdirSync(reportDir, { recursive: true })
const root = mkdtempSync(join(realpathSync(tmpdir()), 'bp-authoring-live-'))
const receipt = {
  planId: 'dsh-blueprint-agent-authoring-v1',
  startedAt: new Date().toISOString(),
  steps: [],
  rpc: [],
  checks: [],
  providerEvidence: false
}
let host, profile
try {
  const patch = yaml.load(readFileSync(join(authorizedProfile, 'cordis.patch.yml'), 'utf8'))
  const model = patch.find(entry => entry.id === 'agent-default-model').config
  const provider = patch.find(entry => entry.id === 'llm-pi-ai').config.providers[model.provider]
  assert.ok(provider && typeof provider.apiKeyEnv === 'string')
  const credentials = yaml.load(readFileSync(resolve(authorizedProfile, '../../.credentials.yaml'), 'utf8'))
  const key = process.env[provider.apiKeyEnv] ?? credentials.refs?.[provider.apiKeyEnv]
  assert.ok(typeof key === 'string' && key.length > 0, 'Selected provider credential unavailable')
  const toolsFile = join(root, 'native-tools.json')
  const errorsFile = join(root, 'native-errors.json')
  const fixture = {
    prepare: async () => {
      const observer = join(root, 'authoring-observer.mjs')
      writeFileSync(
        observer,
        `import {writeFileSync} from 'node:fs';\nexport const inject=['agents'];\nexport function apply(ctx){const facts=[],errors=[];ctx.on('agent/error',({agent,error,turn,step})=>{const code=error?.info?.code??error?.code;const text=String(error?.message??'');errors.push({sessionId:agent.id,turn,step,name:['Error','TypeError','HarnessError','AbortError'].includes(error?.name)?error.name:'other',code:typeof code==='string'&&/^[A-Z_]{1,80}$/.test(code)?code:'unclassified',categories:['timeout','rate limit','tool','parse','json','abort','network','fetch','response','schema'].filter(k=>text.toLowerCase().includes(k))});writeFileSync(${JSON.stringify(errorsFile)},JSON.stringify(errors),{mode:0o600})});ctx.on('tools/result',(exec,result)=>{if(!exec.name.startsWith('blueprint_'))return;let value={};try{value=JSON.parse(result.content.map(c=>c.text??'').join(''))}catch{};facts.push({name:exec.name,sessionId:exec.agent.id,callId:exec.callId,isError:result.isError,blueprintId:value.blueprintId,runId:value.runId,canStart:value.canStart,validationOk:value.ok,errorCode:result.error?.info?.code});writeFileSync(${JSON.stringify(toolsFile)},JSON.stringify(facts),{mode:0o600})})}\n`,
        { mode: 0o600 }
      )
      return { blueprints: {}, operatorModules: [observer] }
    }
  }
  profile = await prepareProfile({ mode: 'keyless', installMode: 'cli', pnpmExecutable: process.env.BP_AUTHORING_PNPM }, fixture, root, receipt.steps)
  receipt.artifacts = Object.fromEntries(
    ['index.js', 'client.js'].map(name => [
      name,
      createHash('sha256')
        .update(readFileSync(join(profile.installedPackage, 'lib', name)))
        .digest('hex')
    ])
  )
  const overlay = join(profile.profileDir, 'cordis.patch.yml'),
    entries = yaml.load(readFileSync(overlay, 'utf8'))
  const pi = entries.find(entry => entry.id === 'llm-pi-ai')
  delete pi.disabled
  pi.config = { providers: { [model.provider]: provider } }
  entries.push({ id: 'agent-default-model', config: model })
  entries.find(entry => entry.id === 'xuanling-blueprint').config = {}
  writeFileSync(overlay, yaml.dump(entries), { mode: 0o600 })
  writeFileSync(join(profile.home, 'dsh/.credentials.yaml'), yaml.dump({ version: credentials.version, refs: { [provider.apiKeyEnv]: key }, records: {} }), {
    mode: 0o600
  })
  receipt.model = model.model
  receipt.provider = model.provider
  receipt.credentialsRecorded = false
  host = bootHost(profile, receipt.steps)
  const authUrl = await host.ready
  const gateway = makeGateway(authUrl, receipt.rpc, 'live')
  await gateway.authenticate()
  await gateway.call('workspace/initializeDefault', {})
  const sessionId = `authoring-live-${randomUUID()}`
  await gateway.call('session/create', {
    request: { sessionId, cwd: profile.cwd, agentPreset: 'standard' }
  })
  receipt.sessionId = sessionId
  await gateway.call('session/prompt', {
    request: {
      sessionId,
      requestId: randomUUID(),
      mode: 'queue',
      content: [
        {
          type: 'text',
          text: 'Verify native blueprint authoring in this isolated test profile. Use only blueprint tools. First call blueprint_describe with no blueprintId. Use its current AgentTask example, name it "Native authoring acceptance", and set the Agent file to the instruction "Reply exactly: BLUEPRINT_AUTHORING_OK. Do not use tools." Call blueprint_validate, then blueprint_create with a stable requestId. Use returned blueprintId and documentRevision with blueprint_preflight and input {"task":"Reply BLUEPRINT_AUTHORING_OK"}; if canStart call blueprint_start with exactly that same input object. Call blueprint_inspect with the returned runId until the Run succeeds (bounded to 10 inspections). Do not edit existing blueprints, access files, or use shell tools. End with a short result. Create must include the declared Agent file bytes; an input field never creates agents.'
        }
      ]
    }
  })
  const deadline = Date.now() + 300000
  let facts = [],
    sessions
  while (Date.now() < deadline) {
    facts = existsSync(toolsFile) ? JSON.parse(readFileSync(toolsFile, 'utf8')) : []
    sessions = await gateway.call('session/list', { _request: {} })
    const item = sessions.items.find(item => item.sessionId === sessionId)
    if (item && !item.running && !item.blank && facts.length) break
    await new Promise(done => setTimeout(done, 1000))
  }
  receipt.nativeErrors = existsSync(errorsFile) ? JSON.parse(readFileSync(errorsFile, 'utf8')) : []
  receipt.tools = facts
  receipt.observer = JSON.parse(readFileSync(profile.observerFile, 'utf8'))
  for (const name of ['blueprint_describe', 'blueprint_validate', 'blueprint_create', 'blueprint_preflight', 'blueprint_start', 'blueprint_inspect']) {
    assert.ok(
      facts.some(call => call.sessionId === sessionId && call.name === name && call.isError === false),
      `Missing successful native ${name}`
    )
    receipt.checks.push(name)
  }
  const created = facts.find(call => call.name === 'blueprint_create' && call.blueprintId)
  const run = facts.find(call => call.name === 'blueprint_start' && call.runId)
  const document = await gateway.call('blueprint/loadDefinition', {
    args: { blueprintId: created.blueprintId }
  })
  const inspection = await gateway.call('blueprint/inspectRun', { args: { runId: run.runId } })
  receipt.definition = {
    blueprintId: document.blueprintId,
    documentRevision: document.documentRevision,
    graph: JSON.parse(document.definitionJson).graph
  }
  receipt.run = {
    runId: run.runId,
    state: inspection.state,
    attempts: inspection.attempts.map(a => ({
      nodeId: a.nodeId,
      state: a.state,
      errorCode: a.errorCode
    }))
  }
  assert.equal(inspection.state, 'succeeded')
  assert.ok(receipt.observer.sessions.some(s => s.requests.some(r => !r.failed && r.finishedAt)))
  receipt.providerEvidence = true
  receipt.ok = true
  console.log(JSON.stringify({ ok: true, model: receipt.model, tools: receipt.checks, run: receipt.run }))
} catch (error) {
  receipt.ok = false
  receipt.failure = error.code ?? error.name
  receipt.failedAssertion = error.name === 'AssertionError' ? error.message : undefined
  console.error(JSON.stringify({ ok: false, failure: receipt.failure, assertion: receipt.failedAssertion }))
} finally {
  if (profile && existsSync(profile.observerFile)) receipt.observer = JSON.parse(readFileSync(profile.observerFile, 'utf8'))
  await stopHost(host?.child)
  receipt.finishedAt = new Date().toISOString()
  writeFileSync(join(reportDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
  rmSync(root, { recursive: true, force: true })
}
process.exitCode = receipt.ok ? 0 : 1
