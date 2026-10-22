# Blueprint v1 to v2 compatibility guide

This guide targets definition `schemaVersion: 2`. Confirm the destination's
schema through `blueprint_describe` and its creation example. Runtime record
versions and Skill versions are separate contracts; do not upgrade them by
changing the definition version.

## The hard break is intentional

The v2 decoder rejects an explicit v1 definition before checking its other
fields. The local error is `DEFINITION_INVALID` with issue
`definition-unsupported-version` at `/schemaVersion`; Host admission maps it
to `blueprint/definition-invalid`. This proves neither that the rest of the
graph is compatible nor that a version bump is the whole migration.

After inspecting the graph, change the version only in the staged candidate
and validate it to uncover further issues. Retain their codes and JSON
Pointers. Unknown behavioral fields are errors; `metadata` is non-executable
extension data and `presentation` is display data.

## Review each construct in context

| Source construct | Target contract and migration decision |
| --- | --- |
| `input`, `output`, `agentTask`, `condition`, `join`, `humanDecision` | The six executable kinds. Their presence alone does not prove port, resource or runtime compatibility. |
| `toolCall`, `scriptCall` | No executable equivalent. Keep the intended inputs, outputs, side effects and failure policy in the change proposal. An `agentTask` with a declared Host tool binding is a possible redesign, but it changes who decides whether/how to call a tool; obtain a behavior decision. |
| Executable node `subflow`, `iteration`, node `subflowRef` | Not supported. Do not flatten nested control flow, unroll loops, or delete references automatically. Stop that part of the migration until an explicit supported design is chosen. |
| `join: "any"` | Not supported. `join: "all"` waits for the selected inputs and is not equivalent to first-completer behavior. |
| Node `budget` | Not supported in the definition. Determine the intended limit and whether the target Host can enforce it; do not simply drop a user-required bound. Host/model token budgets are a different contract. |
| `condition` node without a `condition` object | May pass shape checks but fails preflight with `condition-config-unavailable`. Define `inputPort`, `trueBranch`, `falseBranch`, matching declared branches and boolean input explicitly; do not guess the branch meaning. |
| Resource `kind: "script"` or `kind: "subflow"` | Retained resource kinds. A subflow path identifies a package directory with its own `blueprint.json` and resource closure; review nested definitions recursively. These resources do not restore removed executable node kinds. |
| Host `toolCallId`, `toolCallDeltas`, `toolCalls`; unrelated budgets | Retained contracts outside executable-node vocabulary. Never remove them with a global text replacement. |
| `modelSelection` | Only on `agentTask`, as `{provider, model, reasoningEffort?}`. Resolve identities against the destination DSH model catalog. Credentials/endpoints belong in Host configuration. Keep the route unless the user authorizes a replacement. |
| `toolsetRefs`, `toolAllowlist` | `toolsetRefs` refers to MCP capability resources and configured Host bindings; `toolAllowlist` only narrows the declared union. No declared binding means no business tools. A prompt or Skill asking to read files grants no filesystem access. |
| `outputSchemaRef` | Refers to a schema resource. Target runtime output must pass accepted structured-output capture; JSON-looking assistant text is insufficient. Do not remove the schema to bypass a failed capture. |
| `teamStage` | An explicit `agentTask` collaboration contract with schema and Host Team requirements. Canvas groups or several parallel agents do not imply TeamStage; do not add it during migration without a requirement. |

Preserve data/control edges and port types. Input-node outputs take a matching
named input field, otherwise the whole input value. A join's explicitly named
array output collects selected values in declared input-port order; it does
not coerce those values to strings. Verify downstream expectations before
altering either ports or the sample input. A code-review graph can need actual
source snapshots as input when it has no file-tool bindings.

## Resources and destination bindings

Use these serialized shapes; inspect the current validator for refinements:

| Origin | Definition form | Required migration evidence |
| --- | --- | --- |
| Package Agent/prompt/schema/script/subflow | `{kind, path: "relative/path"}` | Readable resource bytes; subflows include their recursively reviewed packages. |
| Package Skill | `{kind: "skill", path: "skills/reviewer"}` | Complete directory with `SKILL.md` and supporting scripts/references/assets, including binary assets. |
| Shared Skill | `{kind: "skill", source: {kind: "shared", rootId, path}}` | Destination configured root and the exact resolved Skill; do not assume the source machine's root exists. |
| Host Agent/Skill | `{kind: "agent" or "skill", source: {kind: "host", id}}` | Exact destination registry identity and resolved content; no package path or artifact format. |
| MCP capability | `{kind: "mcp", bindingId}`; optionally `source: {kind: "host", id}` | Destination binding to exact tools. Do not infer access from the resource's display name. |
| Portable Agent/MCP artifact | Agent with `format: "agent-preset"` or MCP with `format: "mcp-definition"`, package `path`, and MCP `bindingId` | Artifact content plus destination `requiredBindings`; packaging does not activate plugins or connect a server. |

Package paths are relative and contained. Serialized package resources use
`path`, not `source: {kind: "package", ...}`; the current decoder only accepts
`shared` and `host` source variants. Avoid arbitrary renaming or sanitizing:
when a path must change, review every reference and preserve its bytes.

Use the supported export mechanism to materialize portable Host resources
when the source runtime can export them. Official builtin references and
custom/unknown provenance have different packaging requirements. If a safe
export is unavailable, record the binding/resource gap rather than guessing
an Agent preset or MCP configuration. Keep secrets out of definitions, ZIPs,
logs and migration reports.

## Validation sequence and interpretation

1. Record the original failure without saving or starting anything.
2. On the adapted copy, validate definition shape and graph semantics, then
   the complete resource package. `blueprint_validate({definition, files})`
   validates declared text resources, nested subflows and schemas without
   saving; a bare definition check cannot prove resources exist.
3. Save through the target's supported authoring/import route, read back the
   returned ID/revision, and inspect the graph/resources in the intended
   workspace. Check that the original hashes are unchanged.
4. Run `blueprint_preflight` with the saved revision and actual representative
   JSON input. Resolve reported blocks. A missing model/tool/root is a Host
   binding issue; changing definition syntax will not repair it.
5. Only when execution is authorized, run that checked revision once and
   inspect node outputs, joins and final output, including a reload of the
   saved Run. Record provider/tool failures as observed, and leave untested
   branches or environments explicitly `not-run`.

In a source checkout, the package manifest defines `pnpm build`; run it from
`integrations/deepseek-harness/xuanling-blueprint` before checking built code.
An additional local definition-only check can use the built module:

```js
// Inside the Blueprint package directory; read only, no migration or saving.
import { readFileSync } from 'node:fs';
import { decodeDefinition, validateDefinition } from './lib/definition.js';
const candidate = decodeDefinition(readFileSync(process.argv[2], 'utf8'));
validateDefinition(candidate); // Throws on failure; returns undefined on success.
```

This module path is a checkout build artifact, not a promised public npm
subpath. For installed users, prefer the Host tools; never patch installed
runtime code to gain a validator. If the required validation surface is
unavailable, retain the staged candidate and report that gap.

## Distinguish outcomes

- **Version-only candidate:** the reviewed graph and complete resource closure
  already meet v2 semantics, and the staged change only updates the version.
  Still validate, save, preflight and report live status separately. One such
  successful package is not evidence for other v1 packages.
- **Semantic redesign required:** unsupported execution or a required limit
  has no proven equivalent. Preserve the source and ask for the specific
  behavior decision with the affected nodes and proposed diff.
- **Binding blocked:** the definition/package is valid but the destination
  lacks a model, Agent, Skill root, tool, schema capability or Team driver.
  Retain the precise block; do not weaken permissions or output contracts.
- **Historical Run:** preserve its frozen definition, attempts and events.
  Re-author an editable workflow as a separate package; do not transform the
  old Run to make it appear resumable or successful in v2.
