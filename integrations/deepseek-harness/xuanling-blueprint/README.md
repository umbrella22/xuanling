# @xuanling-rs/xuanling-dsh-blueprint

[简体中文](README-ZH.md)

A DeepSeek Harness plugin for editing typed agent graphs and running them with
persistent state, resource snapshots, approvals, cancellation and recovery.

## Installation

The 0.5.0 plugin is distributed as a GitHub Release tarball. Add it to an
explicit DSH profile running the latest official channel for its capabilities:

```sh
dsh plugin --profile web add https://github.com/umbrella22/xuanling/releases/download/xuanling-mcp-v0.5.0/xuanling-rs-xuanling-dsh-blueprint-0.5.0.tgz
```

Restart that profile after installation. TeamStage additionally requires the
native Agent Teams profile to be enabled explicitly. The release includes
`blueprint.pack.json` with the source commit and SHA-256 for every packaged
file. The Blueprint npm package name is not published by this release.

## Runtime contract

A blueprint contains `blueprint.json` and `lib/` for agent instructions, scripts
and package-local resources. Shared Skills are logical references to configured
roots, including a project or user `.agents/skills` directory. No symlink or
user-facing Skill version pin is required. Each new Attempt captures the latest
complete directory of each bound shared Skill, including supporting files; the
same Attempt and its recovery use those frozen bytes. Run admission freezes the graph and
package-local resources. Export materializes the declared resource closure
without modifying shared Skills.

The React Flow (`@xyflow/react`) canvas provides ComfyUI-inspired graph editing:
context menus, node search, typed connections, clipboard operations, presentation
groups, layout tools and undo/redo. The DSH sidebar connects these edits to
configured definitions, Host validation, saving and Run inspection. Execution
continues through DSH's typed graph and permission contracts. The plugin does
not bundle ComfyUI or provide its model/media workflow domain.

The host dispatches scoped Agents through the public DSH registry. Successful
Agent output enters downstream ports. Each Attempt captures the current host
default model once and passes its provider/model/optional reasoning through the
public Agent options; a new Attempt reads the current selection. Without the
default-model service, the host request-routing extension remains responsible.
No model choice is inferred from credentials or added as a blueprint version pin. Scoped tool calls, human
decisions and cancellation follow the host execution path. Runs record command
admission, attempts and terminal states in the storage domain; unknown external
effects require reconciliation instead of blind replay. JSON and SQLite are
separate persistence verification targets.

### Admission, tools and accepted output

**Check** saves the document and requests read-only `preflightRun` for its
`documentRevision` and captured input JSON. The report lists `block`, `warning`,
`info` and `pass` checks; blocking checks prevent a new Run. Semantic edits,
input changes or switching blueprints invalidate the report, and late responses
cannot replace the current binding. **Run** follows save → preflight → start →
inspect. The Host independently rechecks admission; the report is not an
execution authorization token. A profile without this API reports
`blueprint/capability-unavailable` and cannot silently start. Preflight does not
prove MCP reachability or final Host approval.

Agent tools are restricted in the actual Agent scope, with a monotonic guard.
Effective business tools are the currently visible Host tools intersected with
the declared `toolsetRefs` binding union and optional `toolAllowlist`. No declared
toolsets means no business tool grants. Host denial and approval remain final
authority; a node cannot broaden them. `run_code` is transport, not a business
grant. `structured_output` is available only in the Attempt's schema attachment
scope and cannot be added as a general business permission.

`outputSchemaRef` uses the Run-frozen package schema and DSH's strict supported
object-root JSON Schema subset; unsupported keywords and external `$ref` are
rejected. Structured output is accepted only from authoritative
`structured_output` tool results, not from assistant text containing JSON.
Schema-valid capture enters JSON ports as an object and string ports as its JSON
serialization. The accepted result and diagnostics are durably committed
atomically. Missing or invalid capture fails the Attempt without feeding
invalid output downstream; schema acceptance does not establish business quality.

### Native TeamStage

TeamStage is optional. A blueprint opts in through `agentTask.teamStage`; an
ordinary `agentTask` uses the existing scoped Agent path. The current graph
supports one TeamStage aggregate, with one native Team task. The plugin uses an
explicitly enabled DSH Agent Teams profile and never enables that profile itself.
Admission rejects missing Team capability or an unavailable exact Lead identity.

The stage declares `task`, `members` and `requiredChecks`; each member references
an agent resource and selects `fresh` or `fork` context. The node also requires
`outputSchemaRef`. Members share the native task and collaborate through DSH's
public tools. The host accepts output only after verified structured capture,
required member agreement, schema/digests, physical artifact provenance and the
native completed task. Acceptance settles the original graph Attempt and feeds
its downstream ports.

The conversation Blueprint view shows the Lead, Run, task revision, member
state and acceptance evidence. Native member navigation resolves the same
Run/Attempt through its persisted Session ID. Viewing, switching and refreshing
are read-only; DSH provides the composer, drafts, model stream and approval UI.
Cancellation drains the stage's full bound member set and updates its task by
expected revision. Unknown external effects become `recovery_required`; restart
inspection does not dispatch models, tools or members again.

DSH runtime support follows the latest official channel providing the required
capabilities. Each upgrade and acceptance run resolves an exact current package
and profile tuple. Breaking DSH changes are allowed; older runtime versions,
compatibility shims, downgrade paths and old-profile migrations are unsupported.
XuanLing's own RunRecord legacy reads and backup/restore contracts remain valid.
The current external verification covers macOS/native Edge/real GLM single-member
execution, with deterministic installed multi-member/fork/cancellation/direct/PTC
checks and actual JSON/SQLite persistence tests. Other platforms, real providers
and real multi-member/fork execution require their own acceptance.

### Automatic control flow

`condition` uses `{inputPort,trueBranch,falseBranch}`: `inputPort` must declare
`boolean`, and the two distinct branches must already be declared. An actual
boolean automatically chooses exactly one branch; it does not wait for human
approval or coerce strings/truthy values. The unselected path is skipped. Older
conditions without configuration remain readable, but preflight blocks new Runs.

`join` defaults to `all`. It waits for successful selected parents and binds
only their data outputs, ignoring missing outputs from skipped parents. No
selected parents makes the join skipped; a selected failure is not success.
`join=any` remains readable as a legacy definition but cannot start a new Run.

### Durable Attempt diagnostics

Inspection shows whitelisted input type/byte count/SHA summary, resource digests,
the captured provider/model/reasoning selection, effective tool names, static
denial/acceptance codes and recovery guidance. Legacy records without those
facts display **unavailable**, not inferred facts. These added diagnostics do
not include raw prompts, resource bodies, tool arguments, absolute roots or
provider errors; existing explicit `outputJson` results retain their meaning.
A digest is not input content or anonymization. Inspection/recovery guidance
never implicitly replays an Attempt.

## Native language and workspace

The Blueprint panel follows DSH **Settings → General → Language**: Chinese
(`zh`) and English (`en`). DSH stores the language preference and resolves the
browser/system language when no registered preference applies. The plugin has
no separate language selector or preference. Missing translations follow the
host's per-key fallback chain: `zh` falls back to `en`; additional language
packs declare a chain ending in `en`. A key unresolved by the host is displayed
as its key.

Language changes update controls, accessibility labels, generated node titles
and status messages without replacing the editor or Inspector drafts. They do
not translate blueprint names, resource/Prompt content, input/output JSON or
Agent output, and do not set the Agent's execution language. IDs, `kind`
values, resource references, port names and branch names remain verbatim.
Viewport, selection, undo/redo history, unsaved edits and the bound Run are
independent of display language. The canvas uses the host's light/dark theme.

### Toolbar and panels

The top toolbar groups its icon buttons into history and save, Pan/Select, and
Run and tools. Each icon has a 40×40 pointer target and a localized accessible
name. Hover or keyboard focus shows its name, shortcut and, when disabled, the
reason it cannot run. The configured blueprint selector stays at the top.

Use DSH's native controls for its host sidebars. The blueprint's node library
and Inspector stay visible in the workspace. Selectors, text fields, JSON
inputs and buttons follow DSH's fonts, neutral surfaces, borders and light/dark
themes. Forms use 12px rounded corners; compact buttons and icons use 8px.
Run uses the host's primary button style. Hover, pressed, keyboard focus and
disabled states provide consistent feedback, and selectors retain native
keyboard operation.

**More** groups the less frequent actions:

| Group | Actions |
| --- | --- |
| Files | Import ZIP, export ZIP, export legacy JSON without `lib/` |
| View | Motion and minimap toggles |
| Tools | Run checks, refresh configured definitions, shortcut help |

Right-click the canvas or an object for actions appropriate to that target.
Node colors are under **Appearance**; alignment and distribution are under
**Layout**. Menu entries keep visible names and shortcut hints. Right Arrow or
Enter opens a submenu; Left Arrow or the first Escape returns to its parent.
A second Escape closes the menu and restores its initiating control's focus.
Tab or an outside click also closes it. Pin/unpin and collapse/expand labels
follow the current selection. Disabled actions keep their existing restrictions.

The Inspector's **Run checks** and **Durable Run** sections start folded.
Click or keyboard-activate a section heading to reveal it. Closed headings show
the check/Run status and warnings, including waiting input and recovery states.
Folding retains the input JSON, selected nodes, bound Run, draft, undo history
and viewport. The cancel icon remains in the toolbar, outside these sections.

### Node catalogue and search

The palette creates six node kinds. Search matches Chinese and English
aliases, the current translated title/description and stable `kind` strings,
regardless of the selected display language.
Entries show an icon and a visible node name; hover or keyboard focus reveals
the description. Search and adding nodes use the same catalogue.

| Kind | English label | Chinese label |
| --- | --- | --- |
| `input` | Input | 输入 |
| `agentTask` | Agent task | 智能体任务 |
| `humanDecision` | Approval | 人工决策 |
| `condition` | Condition | 条件 |
| `join` | Join (all) | 汇合（全部） |
| `output` | Output | 输出 |

Other imported kinds display their original kind strings; importing a kind
does not add executor support. Search does not rename nodes or references.

### Canvas interactions and shortcuts

Choose **Pan** or **Select** in the toolbar. Pan mode drags the blank canvas;
Select mode drags a selection rectangle. Shift also enables rectangle selection,
and Ctrl/⌘ adds nodes to a selection. Holding Space or dragging with the middle
button pans in either mode. A vertical wheel zooms, a horizontal wheel pans, and
Ctrl-wheel or pinch zooms. The minimap and zoom controls remain available.
React Flow supplies touch navigation; physical touch-device behavior needs
separate validation.

Right-click the canvas, a node, an edge or a group header for commands appropriate
to that target and the current selection. Menus remain inside the workspace;
arrows, Home/End and Enter select commands, and Escape or an outside click closes
them and restores focus. Disabled commands reflect missing selection, pinned
members, an editing lock or a busy Host operation. Shortcuts apply in the canvas;
text fields, native controls and IME composition retain their normal input.

Double-click blank canvas, press Tab with canvas focus, or choose Search from the
canvas menu to add a node at that position. Dropping a connection on blank canvas
opens compatible node search. Candidates use declared data type, connection kind
and direction; creating the node and connecting it form one undo step. Escape or
closing search leaves the graph unchanged. Double-clicking a node title opens
presentation rename. Type to filter search results; arrows and Home/End select a
candidate, and Enter adds it.

| Shortcut | Action |
| --- | --- |
| Ctrl/⌘ C, X, V | Copy, cut, paste selection |
| Ctrl/⌘ Shift V | Paste with incoming connections from the same blueprint |
| Alt-drag nodes or selection | Clone with a preview; commit as one undo step |
| Ctrl/⌘ A; Delete / Backspace | Select all nodes; delete selected nodes/edges |
| Arrow keys | Move selected unpinned nodes by 10 graph units |
| Ctrl/⌘ Z; Ctrl/⌘ Shift Z or Y | Undo; redo |
| Ctrl/⌘ G | Group selected nodes |
| Tab; blank double-click | Open node search |
| Space; middle-button drag | Temporarily pan; release Space or lose focus to end |
| F or `.`; Shift F | Fit graph; fit selection |
| P; C or Alt C | Toggle pin; toggle collapse |
| H; V | Lock graph editing and import; unlock (viewport navigation remains available) |
| M or Alt Shift M | Toggle minimap |
| `+` / `=` / `-`; Alt `+` / `=` / `-` | Zoom in/out |
| Ctrl/⌘ S; Ctrl/⌘ O | Save; open archive import |
| Ctrl/⌘ Enter; Ctrl/⌘ Alt Enter | Run through admission; cancel the bound Run |
| R | Refresh configured definitions |
| Escape | Cancel an active gesture or overlay; clear canvas selection |

**More → Tools → Shortcut help** provides the common combinations. Repeated keydown
does not repeat Run, cut or other one-shot commands. Drag, group move, resize and
reroute gestures commit once on a valid release; Escape, pointer cancellation or
release outside the workspace cancels their preview without adding history.

### Clipboard and connection editing

Copy/cut/paste use the browser clipboard API. Cut removes the selection only after
clipboard writing succeeds and the editor, document and selection still match.
A late clipboard result after cancellation, editing or blueprint switching cannot
change the new graph. Unavailable or denied clipboard access reports a failure;
it does not silently fall back to a partial copy.

A fragment contains selected node declarations, internal connections, presentation
and directly referenced resource declarations. Paste assigns fresh node/group IDs
and remaps endpoints. It contains no `lib/` bytes, Run inputs/outputs or diagnostics.
Referenced resource IDs must already exist in the target with identical
declarations. Across blueprints, only identical shared Skill or MCP declarations
can be reused; matching package-relative paths do not establish resource identity.
Nodes without resource references can be copied across blueprints. Paste with
incoming connections requires the same blueprint and still-valid original source
ports; ordinary paste uses internal connections only. Invalid fragments or
resource conflicts leave the graph and history unchanged.

Connections use declared data ports with matching types, or declared control
handles/branches. Node and connection drags near the canvas boundary
automatically pan the viewport. Drag an existing edge's reconnect anchor to change an endpoint;
hold Shift when starting reconnect to copy the connection and preserve the
original edge and its reroute points. Invalid, duplicate or cancelled reconnects
retain the original connection without adding history. The node/edge menu's
Disconnect command removes selected edges or edges incident to the selected nodes
in one undo step.

Alt-click an edge or use its menu to add a visual reroute point. Drag points to
adjust the displayed path; right-click or Delete/Backspace removes the focused
point, and arrow keys move it by 10 graph units. Escape cancels a point drag.
Reroutes belong to complete logical connections; they create no executable node
or floating unconnected edge.

### Structured Inspector and advanced JSON

The Inspector edits input/output ports and the existing `agentRef`,
`skillRefs`, `toolsetRefs` and `outputSchemaRef` bindings, the optional
`toolAllowlist`, boolean condition ports/branches and default-all join strategy.
A legacy `join=any` is shown as unavailable. Advanced JSON exposes
input/output maps and existing node options such as `branches`, `budget`,
`join` and `subflowRef`. Editing one field preserves untouched fields; malformed
JSON retains the input and the previous editor value. Local edit feedback does
not establish Host validation: **Save** remains subject to the Host's strict
schema and document-revision checks.

Only existing schema fields are editable. The current node schema has no
independent node `name` or `prompt` field; blueprint-level names and
instructions/prompts in resources remain user content. Resource bindings are
declarations, not execution edges. **Availability unchecked** does not prove
that a Skill is readable or that MCP tools are reachable or permitted for an
AgentTask.

### Node presentation, groups and layout

The node menu renames the displayed title, collapses detail/port captions, pins
position and size, and chooses default, blue, green, amber, red or purple accents.
Resize controls appear for selected movable nodes and respect the minimum content
footprint. Collapse retains all declared handles and their layout footprint.
These fields are presentation; rename does not create a graph `name` field or
change the node ID. Pinned nodes remain selectable, copyable and deletable, but
cannot be moved or resized.

Multi-selected nodes can form a visible group. Double-click the group header to
rename it; drag the header to move its members, or use the group menu to copy,
fit or ungroup them. A drag containing a pinned member is rejected as a whole.
Group membership is stored in `presentation.groups`; an empty label uses a
localized display title without storing translated copy. Creating or removing a
group does not reposition or reparent its members. Groups do not change execution
order and are not subflows or TeamStages.

Node menus align two or more movable selected nodes by edges or horizontal/vertical
centres, and distribute three or more along either axis. Commands that require
node extents use their measured sizes. Presentation edits and compound layout
operations support undo/redo, save and reload. Node title/collapse/pin/size/colour
and edge reroute points change document/layout revisions without changing
execution semantics. Reroutes are saved by `(kind, from, to)`, independently of
transient editor edge IDs.

### Viewport preferences and workflow files

Each configured blueprint has local UI preferences for viewport `{x,y,zoom}`,
Pan/Select mode, minimap, motion and editing lock. Switching blueprints or reloading
restores the saved numeric viewport without rounding it to the displayed CSS
transform. A missing or invalid preference record uses defaults and fits the
loaded graph. Viewport navigation and UI preferences do not dirty the document,
write its draft or add undo history. Late callbacks from an old document cannot
overwrite another blueprint's preferences, including switching away and back.
**Save** persists graph/presentation changes through the Host's document-revision
checks; local viewport preferences are separate.

**Export blueprint** downloads the Host's portable ZIP, including the declared
resource closure. Dirty edits are saved first; stale document results are refused.
**Export legacy** downloads definition JSON for an older reader: it strips the
new node presentation fields and edge reroutes while preserving coordinates,
groups, graph, resources and metadata. This JSON contains no resource file bytes
and cannot replace a portable ZIP.

**Import blueprint** opens the native file picker for a ZIP. Choose an already
configured empty blueprint ID and explicitly confirm that target before Apply.
The target and archive identity must match. Import does not create a configured
root, overwrite a nonempty package or silently rebind shared Skills. The Host
checks identity, archive integrity and portability, then the UI reloads the
accepted definition. Invalid archives or nonempty targets are refused. Import
and Apply are disabled while editing is locked or the workspace is busy; Close
and Escape remain available.

The strict `schemaVersion: 1` reader accepts older definitions and validates the
optional presentation fields, finite positive sizes, known colour tokens and
node/edge references. Older readers reject the added fields. Before rolling back
the plugin, export the explicit legacy definition and preserve the original
package; no compatibility path silently discards fields from the saved document.

### Run revision and motion

Run details display `runId` and `definitionRevision`. Node captions and motion use
the same raw Attempt projection: when ordinals are valid, the highest wins, with
a later entry winning equal ordinals. No matching Attempt displays **Not running**;
an unrecognised latest state or an invalid ordinal for that node displays
**Unknown state**. Translated
captions never decide execution or movement.

Attempt state decorates the graph only when the bound Run identity matches,
`definitionRevision` matches the saved `semanticRevision`, and the edited graph
still has the saved execution semantics. A mismatch suppresses the old overlay
while Run details, outputs and error codes remain inspectable. Presentation-only
and language changes preserve that match. Reconnection inspects the existing
durable Run without replaying start or decision commands.

During an eligible running Run, preparing/running nodes receive an opacity-only
emphasis. One directed light travels source-to-target along a proven edge's exact
rendered path, including reroutes. A data path requires matching declared ports,
a running/succeeded source and a preparing/running target. Control paths require
a succeeded source and an active target; a condition branch additionally requires
the Attempt's actual boolean `outputJson.value` and its matching configuration. Unknown condition or human-decision branches
remain static. Hover or keyboard focus highlights the node and its immediate
connected neighbours independently of the Motion toggle.

Hidden documents, reduced-motion preference, Motion off, a stale/disconnected
connection, unmatched Run semantics, and unknown, waiting or terminal Runs stop continuous
effects. Available raw status and relation highlights remain static. Native
CSS/SVG effects change neither node/handle geometry nor graph facts and do not
perform per-frame editor writes or React updates.

## Install a candidate

```sh
dsh plugin --profile <isolated-profile> add <candidate.tgz>
```

The host supplies the Cordis, Typert and Zod peers. This checkout targets
`@deepseek-ai/dsh` 0.2.1-alpha.2 and Node 24. Retired alpha.1 activation, drain and
mailbox APIs are unsupported. Candidate installation must use
an explicit isolated profile, never the user's default profile. Packaging,
installation, web/headless enable/disable and restart each need their own
current-artifact evidence; installation alone proves none of the other steps.
No publish or push is part of this workflow.

## Verification and evidence

Runtime contracts are tracked by
[`dsh-blueprint-runtime-contracts-v1`](../../../docs/plans/dsh-blueprint-runtime-contracts-development-plan.md)
and its [execution ledger](../../../docs/plans/dsh-blueprint-runtime-contracts-execution-ledger.md).
Current-artifact live provider, MCP, browser, storage/restart and packed lifecycle
evidence is required separately; fixture success does not complete final
integration acceptance. Accepted platform evidence is limited to macOS;
Linux/Windows are unverified conditional targets for this runtime-contract scope
and the older takeover plan's cross-platform blockers remain unchanged.


The takeover verification suites use `dsh-blueprint-takeover-v1`. Reports apply
to their recorded source and built-artifact fingerprints; relevant changes
require fresh evidence.

Native locale/workspace acceptance is tracked separately by
[`dsh-blueprint-i18n-workspace-v1`](../../../docs/plans/dsh-blueprint-i18n-workspace-development-plan.md)
and its [execution ledger](../../../docs/plans/dsh-blueprint-i18n-workspace-execution-ledger.md).
It requires installed DSH Settings `zh`/`en` switching, light/dark UI checks,
save/reload and preservation of in-progress inputs, viewport, selection,
history and Run bindings. A fixture translator, static render or screenshot
alone cannot establish native lifecycle or state preservation. Evidence for
this scope does not complete the takeover plan's provider or platform gates.

From the plugin directory:

```sh
npm run typecheck
npm run lint
npm run build
node --experimental-transform-types --test test/takeover/acceptance.test.mjs test/live/journey.test.mjs
node scripts/verify.mjs --plan-id dsh-blueprint-takeover-v1 --report-dir <fresh-evidence-dir> --suite critical --scope all --repeat 3
node scripts/verify.mjs --plan-id dsh-blueprint-takeover-v1 --report-dir <fresh-evidence-dir> --suite live
node scripts/verify.mjs --plan-id dsh-blueprint-takeover-v1 --report-dir <fresh-evidence-dir> --suite acceptance --evidence-manifest <explicit-manifest.json>
```

Suites include foundation, definition, resources, runtime, host, api,
portability, security, recovery, critical, browser, performance, platform, live
and package. API/security/recovery/critical final evidence uses `--scope all`.
`red-oracles` calibrates expected-red behavior; it is not product-success evidence.

Reports bind the plan ID, source fingerprint and built-artifact fingerprint,
including stability before/after execution. The acceptance manifest explicitly
names report paths and SHA256 digests; it cannot replace missing current
reports with a scan of historical report directories. Failed, stale, empty,
tampered, reduced-scope or insufficient-repeat evidence cannot pass acceptance.

The live suite requires `BP_LIVE_PROVIDER_KEY`, `BP_LIVE_PROVIDER_BASE_URL` and
`BP_LIVE_PROVIDER_MODEL`, with optional `BP_LIVE_PROVIDER_PROTOCOL`. It launches
an isolated DSH host and executes a formal blueprint Run through a real scoped
Agent, checking actual nonce output at a downstream node. Import-only checks,
synthetic providers and host probes do not satisfy this gate. Missing
configuration is typed `not-run`, leaves `passed=false` and exits nonzero.
Supply credentials only through memory/environment; do not put them in patches,
reports or screenshots. Provider/protocol availability still requires a real run.

CI records deterministic gates and authentic platform identity for its runner.
Its keyless-live check accepts only the precise configuration-missing `not-run`
report; any ordinary failure still fails the job. All fresh CI reports are
uploaded. CI job success does not imply real provider, package lifecycle,
interactive browser or three-platform acceptance.

## Execution and interaction boundaries

An explicit `agentTask.teamStage` executes through the optional native DSH Team
profile. It binds the original Attempt to the source Lead, one native task and
the declared members; success requires completed native turns, authoritative
structured captures, immutable artifacts and atomic acceptance. Team `inactive`
and task `completed` alone do not settle the stage. Cancellation drains exact
owned children; uncertain effects require recovery. Write scopes are advisory.
Nested Teams remain unsupported. Real provider and browser acceptance are
separate gates; a deterministic model fixture proves neither.

Blueprint supplies no default total stage, Agent or script deadline. DSH provider
request/stream idle settings, Tools signals and Team disposal settings control
their respective operations. Explicit host deadlines retain typed diagnostics;
a collector observation timeout does not change Run state.
Executable `toolCall`, `scriptCall`, `subflow`, `iteration` and `join-any` nodes,
ODAI governance, Rust/ZCode integration and publishing remain deferred. Imported
unsupported nodes remain readable; new Runs fail preflight with
`node-executor-unavailable`.

The canvas covers graph editing, presentation and read-only Run status.
ComfyUI model/media/mask/gallery tools, widget-to-input conversion, execution
bypass/mute, Run Branch and subgraph conversion require separate domain or
execution contracts and are not provided by these interactions.

Browser interaction and motion evidence does not establish provider output,
MCP policy, packed web/headless lifecycle or persistence/recovery behavior.
Those runtime contracts require separate evidence. Platform evidence is limited
to macOS; Linux/Windows, physical touch devices and system clipboard integration
require their own validation. Browser clipboard permission and secure-context
requirements still apply. Missing runtime dependencies or credentials remain
`not-run`; no overall plugin acceptance follows from canvas support alone.
