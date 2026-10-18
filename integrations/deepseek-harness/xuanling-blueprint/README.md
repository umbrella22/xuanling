# XuanLing Blueprint

[简体中文](README-ZH.md) · `@xuanling-rs/xuanling-dsh-blueprint`

Visual agent workflows with durable execution, inside DeepSeek Harness.

Blueprint adds a graph editor and a durable Run runtime to DeepSeek Harness (DSH). Connect Input,
Agent task, Approval, Condition, Join (all) and Output nodes; bind existing DSH Agents, Skills and
MCP tools; choose a model for each Agent task; then inspect the Attempts the Host recorded. DSH
provides models, native conversations and tool permissions. Blueprint adds the canvas, saved
definitions, resource snapshots and durable Run records.

![A four-specialist Rust review workflow on the Blueprint canvas](assets/readme/rust-review-blueprint.png)

*The node library, canvas, resource sidebar and Inspector in a local DSH Web profile. This workflow
runs static analysis, security review, test-quality review and Rust architecture review in
parallel, joins the four reviews, and writes a synthesized report. The graph is a saved example,
not a bundled template. Screenshots use the Chinese locale; the interface follows DSH's language and
light/dark theme settings.*

## What Blueprint provides

- **Typed graph editing.** Data edges require matching port types, data cycles are rejected, and
  control edges drive conditions, approvals and joins. Layout, pinning, grouping and port
  visibility change presentation only; they never change execution.
- **DSH-native resources.** Bind existing Agent presets, Skills and exact MCP tool identities
  available to the profile. The resource sidebar groups Agent, Skill, MCP and other resources.
- **Per-task model routes.** Keep the DSH default or pin Provider, Model and Reasoning effort from
  the DSH model catalog. Each new Attempt records the route it actually used.
- **Durable Runs and Attempts.** The definition revision and package resources are frozen at
  admission. Every dispatch writes an intent before the external effect and a result after it.
  Reloading or inspecting a Run never resends work.
- **Preflight before execution.** Run checks verify declared resources, Host tool bindings and
  source-node port values. Blocks stop admission; the same checks run again when a Run starts.
  Model routes and downstream values are checked when the Attempt runs.
- **Portable workflow packages.** Export and import a ZIP with the definition and the custom
  resources it declares. Credentials and machine-specific settings become target bindings.
- **Optional TeamStage.** Run one Agent task as a native DSH Agent Teams stage with durable task,
  member and artifact facts.

## Requirements

- A DSH Web profile. The current development and CI fixture is DSH `0.2.1-rc.2` from the `next`
  channel. The public runtime peer floor is `>=0.2.1-alpha.5`; the compatibility preflight compares
  prerelease versions.
- A configured model provider in DSH for workflows with Agent tasks. Input → Output graphs run
  without a model.
- Node.js 22.14 or newer only when building the plugin from source.
- The native Agent Teams profile enabled separately when using TeamStage.

## Install

Install the published package into the same profile that serves your DSH Web UI:

```sh
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-blueprint@0.6.1
```

Restart that profile and refresh the DSH page. Replace `web` with the profile you use. A new custom
profile contains only the base bundle and does not include the Web application.

The published `0.6.1` package declares the older DSH `0.2.1-alpha.3` peer set. To run this
revision on the current DSH `next` channel, install the linked checkout build described under
[Development](#development). This README follows the current main branch; the published package can
lag behind it.

TeamStage additionally requires the native Agent Teams profile to be enabled explicitly.

## First workflow

1. Open **XuanLing Blueprint** in the DSH sidebar and click **New**. Name the draft. An empty
   library opens a draft automatically; creating or saving a blueprint does not run it.
2. Drag **Input**, **Agent task** and **Output** from the node library onto the canvas.
   Double-clicking empty space also opens node search.
3. Select each node and set its ports in **Inspector**. Click **Apply ports** after editing.

   | Node | Input port | Output port |
   | --- | --- | --- |
   | Input | None | `request: string` |
   | Agent task | `input: string` | `result: string` |
   | Output | `value: string` | None |

4. Connect `Input.request → Agent task.input` and `Agent task.result → Output.value`. Data
   connections require matching types.
5. Select the Agent task. In **Agent binding**, choose an existing DSH Agent preset. DSH resources
   appear first; blueprint resources follow. Optionally add **Skill bindings** and **Toolset
   bindings** for that task.
6. In **Model route**, keep **DSH default** or choose **Selected model**, then pick Provider, Model
   and optional Reasoning effort from the DSH catalog. Click **Apply node options**.
7. Click **Save**. Expand **Durable Run** and enter the run input JSON, for example
   `{"request":"Summarize the supplied text."}`. Open
   **More actions → Tools → Check and save** and resolve every Block. Editing the graph or input
   makes the report stale.
8. Click **Run**. The Run button saves and checks before starting. Expand each Attempt under
   **Durable Run** to read outputs, error codes and diagnostics. A returned Run ID means the Run
   was admitted; `succeeded` is the final result.

For a first exercise without a model, connect `Input.request` directly to `Output.value` with the
same string ports and run the supplied JSON. The output preserves the text. Add the Agent task once
that path works.

The Inspector for an Agent task combines the node bindings, port declarations and model route:

![Rust review static-review Inspector](assets/readme/rust-review-static-inspector.png)

*Agent binding, the model route read from the DSH catalog, and Skill bindings on one Agent task.*

## Walkthrough: a saved multi-agent review (not bundled)

The screenshots show a saved Blueprint named `ops-service Rust 多 Agent 代码审查（可见技能版）`
from a local DSH profile. It is an example, not a bundled template: the plugin does not ship this
graph or its Agent and Skill resources.

The graph starts at `review-request`, fans out to four specialist Agent tasks (static, security,
test quality and Rust architecture), joins their `review` strings at `parallel-reviews`, sends
the collected evidence and the original request to `synthesize-review`, and writes `report` to
`review-result`. The serving profile must contain the five referenced Agents and five Skills. The
flow does not need an MCP binding, but it needs a working DSH model.

1. Open **XuanLing Blueprint** in the DSH Web profile and select the saved example.
2. Select an Agent task. In **Agent binding**, confirm the referenced Agent and Skills. In
   **Model route** keep **DSH default** or choose **Selected model**, then pick Provider, Model and
   Reasoning effort from the DSH catalog and click **Apply node options**.
3. Check the ports and bindings, then click **Save**.
4. Expand **Durable Run**, enter a request object that matches `review-request.request`, then open
   **More actions → Tools → Check and save** and resolve every Block.
5. Click **Run** once. Follow the four specialist Attempts, the join, the synthesizer Attempt and
   the final `report` output. Refreshing reads the recorded Run and Attempts; it does not replay
   model or tool calls.

If the profile has no provider credentials, the Run ends in a typed preflight or provider failure
and the saved Blueprint stays intact. To build an equivalent graph without the private resources,
use `examples/code-review` as a portable format reference and supply your own Agent and Skill files.

## How a Run executes

Admission writes the Run record with the exact definition revision, freezes the package resources
the Run needs, and resolves shared and Host resources for each Attempt. Ready nodes execute
concurrently. Each node Attempt records an intent before the external effect and a result after it;
an outcome the Host cannot confirm becomes `recovery_required` instead of a fabricated result.

| Run state | Meaning |
| --- | --- |
| `queued` | Admitted; waiting for the runtime to start it. |
| `running` | At least one node is eligible or in flight. |
| `waiting_input` | An Approval node is waiting for **Approve** or **Reject**. |
| `cancelling` | A cancel was requested; in-flight work is being interrupted and drained. |
| `recovery_required` | An external effect is unknown; the Run is not redispatched automatically. |
| `succeeded` / `failed` / `cancelled` / `timed_out` | Terminal states. A terminal state is immutable. |

- A node failure stops new dispatch and interrupts and drains live siblings. The recorded failure
  is the reason the Run ends, even when a sibling cancellation races it.
- Approvals and TeamStage nodes take exclusive Run ownership while the Run is waiting for a human
  or the native Team state.
- On Host restart, a dispatched Attempt with no recorded result reopens as
  `recovery_required`. Review the recorded external effect with the Host operator before starting
  another Run; Blueprint never replays an unknown effect.
- **Cancel run** requests cancellation. The recorded state is the result; inspection and page
  reload do not replay model or tool calls.
- Deleting a blueprint retains its Runs and Run history. It does not cancel a running Run.

Independent ready nodes execute concurrently. The plugin setting `maxConcurrentNodes` defaults to
`4` and accepts a positive safe integer; set it to `1` for serial execution. A completed node frees
its slot immediately, so a fast branch can advance while another branch is still running. Runs
sharing one runtime remain queued in order.

## Canvas, resources and the Inspector

**Inspector** shows the selected node's ports, resources and options. Agent tasks expose Agent,
Skill, Toolset, output-schema and model-route controls. Input, Output, Condition, Join and Approval
nodes hide execution bindings; original references remain in the definition and stay subject to
Host preflight. A node without a declared toolset has no business tools; Host permissions and
approvals still apply to selected tools. Preflight does not establish MCP reachability or approval.

**Port visibility and connections** toggles control inputs, data inputs and data outputs
independently. These switches affect visibility and new connections only. They do not delete port
declarations, execution order, data flow or existing edges; a direction with a connected edge stays
visible until that edge is disconnected.

**Groups** and layout metadata are presentation. Group titles reserve a header area, measured node
content participates in collision handling, and the first mount and **Fit View** include group
headers. The runtime blueprint view uses the Host's remaining canvas height and is read-only: pan,
zoom, refresh and Fit View do not save layout, start Runs, cancel Runs or retry Runs.

**Resources** are grouped as Agent, Skill, MCP and Other. Click **+** beside the resource library to
open the add-resource dialog; click a row to inspect it. The dialog shows resource type, logical ID,
display name, description, source, availability, a public configuration summary and advanced JSON.
**Apply** creates one blueprint history edit; **Cancel** and Escape leave no partial write. Host
resources that cannot be edited are shown in view mode.

Resource details never read or display Host URLs, headers, environment values, secrets, raw Skill
bodies or private MCP configuration. Opening a resource does not probe or call MCP. When the Host
catalog is loading or unavailable, existing references are retained and shown as unknown or
unavailable instead of being silently replaced.

## Two places to work

| Entry | Purpose |
| --- | --- |
| Sidebar **XuanLing Blueprint** | Create and edit graphs, select resources, save, check, run and inspect results. |
| **Blueprint** view in a native conversation | Read the frozen graph and Attempts linked to that conversation. |

An ordinary conversation shows **This conversation has no linked blueprint**. That is a normal
empty view. Ask the Agent in that conversation to start a blueprint explicitly to create a Run
association; a sidebar Run does not automatically link the current chat. Read failures and offline connections
have their own loading and error states.

In a conversation's Blueprint view, clicking an Agent node with one Attempt opens its native chat
while it is running or after it finishes. For multiple Attempts, choose **View chat history** on
the intended record. Sidebar Run details and Team members also provide chat actions. Legacy records
without a verifiable session show that the chat is unavailable.

Automatic retries within one call follow that Attempt's final result. Once a node has failed, its
record stays failed even if the main chat continues the task. The failure explanation offers
**Return to main chat** to view that later work. Sidebar Runs without a source chat do not show this
action.

## Approval and TeamStage

An **Approval** node moves the Run to `waiting_input`. Use **Approve** or **Reject** in the
sidebar's **Durable Run** section. **Approve** records the node as succeeded and resumes the Run;
**Reject** records the decision and cancels the Run.

TeamStage runs one Agent task as a native DSH Agent Teams stage. It requires a prepared
`agentTask.teamStage` definition, package Markdown Agent resources, the native Team capability and
a source Lead conversation. Canvas grouping does not create a Team. Team members use a separate
model contract.

## Create blueprints from a native conversation

Root conversations can create and start blueprints through native tools:

| Tool | Purpose |
| --- | --- |
| `blueprint_describe` | Read the current schema, executable node kinds, example and Host tool bindings; with an ID, read a saved graph and revision. |
| `blueprint_list` | List configured blueprints and their current document revisions. |
| `blueprint_validate` | Validate a candidate definition and its declared text files without saving or running. |
| `blueprint_create` | Save a new blueprint and its declared resource text files atomically. Does not run it. |
| `blueprint_preflight` | Run read-only checks for a saved revision and input. |
| `blueprint_start` | Explicitly start a saved blueprint with its current revision and a JSON input value. |
| `blueprint_inspect` | Read the frozen Run associated with the conversation. |

Example request:

```text
Call blueprint_describe for the current schema and AgentTask example.
Create an Input → Agent task → Output workflow that summarizes supplied text.
Declare the Agent resource and include its instruction file.
Validate the definition and files with blueprint_validate, then save them with
blueprint_create and a stable requestId. Return blueprintId and documentRevision.
Do not start a Run yet.
```

After checking the saved graph, provide the actual text and ask the Agent to call
`blueprint_preflight`, then `blueprint_start` once for that revision. Both tools take `input` as a
JSON value, such as `{"request":"Text to summarize"}`. Use `blueprint_inspect` for later reads;
opening or refreshing the view does not start another Run. Input supplies existing nodes and does
not create Agents.

`blueprint_describe` returns the current schema and creation example without a separate download.
`blueprint_create` saves declared text files alongside the definition. The canvas resource form
declares references only; it does not create package-local Agent, Skill or schema file contents.

## Share and migrate workflows

Open **More actions → Files** to export or import a complete ZIP.

- **Export ZIP package** saves edits and packages declared resources. Custom DSH Agent presets,
  full Skill directories and MCP definitions are included. Only resources with verified official
  DSH builtin provenance keep logical references without their bodies. Unknown provenance must be
  materialized too; export fails when safe packaging is not possible.
- Credentials and machine-specific values are excluded and become destination
  `requiredBindings`. Bind the destination's models, resource roots and exact MCP tools before
  running. Re-export retains those binding requirements.
- **Import ZIP package** requires an already configured empty target with the same blueprint ID as
  the archive. It does not overwrite a nonempty target, activate packaged plugins, connect MCP
  servers or import Run history.

## Troubleshooting

| What you see | Next action |
| --- | --- |
| No sidebar entry | Check the current profile, restart it and refresh DSH. |
| Unlinked conversation | Normal empty state; use the sidebar or ask the Agent in this conversation to start a Run. |
| A Block or a missing resource | Read **Run checks**, configure the dependency and check again. |
| Provider or model error at run time | Configure the model provider in DSH, then check and run again. |
| Stale checks | Save the current graph and input, then check again. |
| Waiting for input | Use **Approve** or **Reject** in the sidebar's Durable Run section. |
| Offline or read failure | Restore the connection and refresh or reconnect; inspect confirmed Run facts. |
| `recovery_required` | Preserve the Run ID and review external effects with the Host operator before another run. |
| Import refused | The target must be configured, empty and match the archive's blueprint ID. |

## Limits

- The definition vocabulary contains only Input, Agent task, Approval, Condition, Join (all) and
  Output. The removed `toolCall`, `scriptCall`, node `subflow`, `iteration`, `Join (any)`, node
  `budget` and node `subflowRef` fields are hard breaks: re-reading an old blueprint or Run
  definition returns typed `blueprint/definition-invalid` at the decode boundary. `ResourceKind`
  `subflow` remains available for portable nested blueprint resources; it is not an executable node.
- A bound output schema requires DSH's accepted structured-output capture. JSON in ordinary
  assistant text does not satisfy the schema contract.
- Without a declared toolset an Agent task has no business tools. Host permissions and approvals
  still apply to selected tools, and preflight does not establish MCP reachability.
- TeamStage is optional and is not created by canvas grouping.
- Run records are durable and retained; deleting a blueprint retains them.

## Development

Build the package from this checkout, link the directory into the profile that serves the Web UI,
then start only the Web application:

```sh
BLUEPRINT_DIR=/absolute/path/to/xuanling/integrations/deepseek-harness/xuanling-blueprint
pnpm --dir "$BLUEPRINT_DIR" install --frozen-lockfile
pnpm --dir "$BLUEPRINT_DIR" build
dsh plugin --profile web add "link:$BLUEPRINT_DIR"
dsh --profile web --no-open
```

Restart the Web profile after rebuilding so the plugin bundle reloads. The linked profile reads
`lib/` from the checkout; it does not use the published package. The `link:` install is a
development workflow for profiles that load a checkout; regular installs use the published package.
The screenshots in this README were captured from this linked build.

Checks:

```sh
pnpm --dir "$BLUEPRINT_DIR" typecheck
pnpm --dir "$BLUEPRINT_DIR" lint
pnpm --dir "$BLUEPRINT_DIR" test
```

The deterministic suites, browser fixtures and real-host journeys have separate prerequisites and
evidence boundaries; see [CI-VALIDATION.md](CI-VALIDATION.md). The browser fixtures require the
isolated harness under `test/blueprint` and a Playwright browser installation.

For the broader installation setup, see the
[DSH integration guide](https://github.com/umbrella22/xuanling/blob/main/integrations/deepseek-harness/README.md).
The [code-review definition](https://github.com/umbrella22/xuanling/blob/main/integrations/deepseek-harness/xuanling-blueprint/examples/code-review/blueprint.json)
is a portable format reference; prepare its resource files and Host bindings before using it.

## License

MIT
