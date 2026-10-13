# XuanLing Blueprint

[简体中文](README-ZH.md) · `@xuanling-rs/xuanling-dsh-blueprint`

Turn inputs, Agent tasks, decisions and outputs into reusable workflows inside DeepSeek Harness (DSH).
Edit a graph, choose existing DSH Agents, Skills and MCP tools, select a model for each Agent task,
then inspect the recorded results. DSH provides models, native conversations and tool permissions;
Blueprint adds the canvas, saved definitions, resource snapshots and durable Run records.

## Install

Install the published package into the same profile as your DSH browser:

```sh
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-blueprint@0.6.0
```

Restart that profile and refresh DSH. Replace `web` with your actual profile;
a new custom profile does not automatically include the Web application.
Use the latest official DSH channel that provides the required capabilities.
TeamStage additionally needs the native Agent Teams profile enabled explicitly.

## Two Places to Work

| Entry | Purpose |
| --- | --- |
| Sidebar **XuanLing Blueprint** | Create and edit graphs, select resources, save, check, run and inspect results. |
| **Blueprint** view in a native conversation | Read the frozen graph and Attempts linked to that conversation. |

An ordinary conversation can show **This conversation has no linked blueprint**.
This is a normal empty view. Start a blueprint explicitly from that conversation
to create a Run association; a sidebar Run does not automatically link the chat.
Read failures and offline connections have their own loading/error states.
The interface follows DSH's language and light/dark theme settings.

## Your First Workflow

First configure a working model in DSH. Open **XuanLing Blueprint**, choose a
saved blueprint or click **New**, and give the draft a name. An empty library
opens a draft automatically. Creating or saving a blueprint does not run it.

1. Drag **Input**, **Agent task** and **Output** from the node library onto the
   canvas. Double-clicking empty space also opens node search.
2. Select each node and set these ports in **Inspector**. Remove unused default
   ports and click **Apply ports** after editing.

   | Node | Input port | Output port |
   | --- | --- | --- |
   | Input | None | `request: string` |
   | Agent task | `input: string` | `result: string` |
   | Output | `value: string` | None |

3. Connect `Input.request → Agent task.input` and
   `Agent task.result → Output.value`. Data connections require matching types.
4. Select the Agent task. In **Agent binding**, choose an existing DSH Agent
   preset. DSH resources appear first; blueprint resources follow. Optionally
   select **Skill bindings** and **Toolset bindings** for the task.
5. In **Model route**, keep **DSH default** or choose **Selected model**, enter
   the configured provider/model and optional reasoning effort, then click
   **Apply node options**. Explicit selection takes priority; each new Attempt
   captures its model and resources, so an existing Attempt does not change
   when the DSH default changes.
6. Click **Save**. Expand **Durable Run** and enter valid JSON, for example:

   ```json
   {"request":"Write a short summary of this text: The project added a reusable review workflow."}
   ```

7. Open **More actions → Tools → Check and save**. Expand **Run checks** and
   resolve every `block`. Editing the graph or input makes the report stale.
8. Click **Run**, then expand node Attempts in **Durable Run** to read outputs,
   error codes and diagnostics. The Run button also saves and checks before
   starting. A returned Run ID means admission; `succeeded` is the final result.

For a first exercise without a model, connect `Input.request` directly to `Output.value`
with the same string ports and input JSON. The output preserves the supplied text.
Add the Agent task once this path works.

Without a declared toolset, the Agent has no business tools. Host permissions and
approvals still apply to selected tools. Preflight does not establish MCP reachability or approval.
For plain text, leave **Output schema binding** empty. A bound output schema
requires DSH's accepted structured-output capture; JSON in ordinary assistant
text does not satisfy that schema contract.

## Let the Native Agent Create a Blueprint

In a DSH root conversation, ask the Agent to build and save a complete graph:

```text
Call blueprint_describe for the current schema and AgentTask example.
Create an Input → Agent task → Output workflow that summarizes supplied text.
Declare the Agent resource and include its instruction file.
Validate the definition and files with blueprint_validate, then save them with
blueprint_create and a stable requestId. Return blueprintId and documentRevision.
Do not start a Run yet.
```

After checking the saved graph, provide the actual text and ask the Agent to
call `blueprint_preflight`, then `blueprint_start` **once** for that revision.
Both tools take `input` as a JSON value, such as `{"request":"Text to summarize"}`.
Use `blueprint_inspect` for subsequent reads; opening or refreshing the view
does not start another Run. Input supplies existing nodes and does not create Agents.

`blueprint_describe` supplies the current schema and creation example without a separate download.
`blueprint_create` saves declared text files alongside the definition. The canvas resource form
only declares references; it does not create package-local Agent, Skill or schema file contents.

## Share a Workflow

Open **More actions → Files** to export or import a complete ZIP.

- **Export ZIP package** saves edits and packages declared resources. Custom DSH
  Agent presets, full Skill directories and MCP definitions are included.
  Only resources with verified official DSH builtin provenance keep logical
  references without their bodies. Unknown provenance must be materialized too;
  export fails when safe packaging is not possible.
- Credentials and machine-specific values are excluded and become destination
  `requiredBindings`. Bind the destination's models, resource roots and exact
  MCP tools before running. Re-export retains those binding requirements.
- **Import ZIP package** requires an already configured empty target with the
  same blueprint ID as the archive. It does not overwrite a nonempty target,
  activate packaged plugins, connect MCP servers or import Run history.

## Results and Troubleshooting

| What you see | Next action |
| --- | --- |
| No sidebar entry | Check the current profile, restart it and refresh DSH. |
| Unlinked conversation | Normal empty state; use the sidebar or explicitly start a Run in that conversation. |
| A `block` or missing resource/model | Read Run checks, configure the dependency and check again. |
| `stale` checks | Save the current graph/input and check again. |
| `waiting_input` | Use **Approve** or **Reject** in the sidebar's Durable Run section. |
| Offline/read failure | Restore the connection and refresh or reconnect; inspect confirmed Run facts. |
| `recovery_required` | Preserve the Run ID and review external effects with the Host operator before another run. |

**Cancel run** requests cancellation; the recorded state confirms its result.
Page reload and inspection do not replay model or tool calls. **Delete blueprint**
requires confirmation and retains existing Runs; it does not cancel a running Run.

TeamStage needs a separately prepared `agentTask.teamStage` definition, package
Markdown Agent resources, native Team capability and a source Lead conversation.
It is not created by canvas grouping; its members have a separate model contract.
The node palette is Input, Agent task, Approval, Condition, Join (all) and Output.
Other imported node kinds may be readable without an executor;
preflight blocks unsupported execution. There is no legacy downgrade export.

For the broader installation setup, see the [DSH integration guide](https://github.com/umbrella22/xuanling/blob/main/integrations/deepseek-harness/README.md).
The [code-review definition](https://github.com/umbrella22/xuanling/blob/main/integrations/deepseek-harness/xuanling-blueprint/examples/code-review/blueprint.json)
is a format reference; prepare its resource files and Host bindings before use.
