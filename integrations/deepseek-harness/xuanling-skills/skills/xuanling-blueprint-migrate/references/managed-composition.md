# Managed nodes and pinned child Blueprints

Check `blueprint_describe({})` on the destination build before preparing a
candidate. Version 2 alone does not prove support for `interaction: managed`
or `blueprintCall`. An older strict v2 decoder rejects these additions.
Preserve the complete original package and its file hashes for downgrade.

## Upgrade an Agent's interaction deliberately

For a selected `agentTask`, add `interaction: "managed"` when the workflow
needs human follow-up during the Attempt. Omit it to retain the existing
one-shot contract. The Web Inspector exposes this choice explicitly; new
palette Agent nodes and the current authoring example default to managed.

Review the Agent instructions and its output contract together. A normal
reply now leaves the node available for clarification. Completion requires
the exposed `structured_output` tool. Without a custom output schema, submit
`{"text":"result"}`; with a schema, use the exact schema supplied by the Host.
Do not simulate completion by emitting JSON text or by treating inactivity
as success. Existing output ports, output schema, tools, model selection,
aggregation nodes, and dependencies retain their meanings.

Run a representative clarification journey only when execution is authorized:
open the active node's actual conversation, send a follow-up using queue or
steer, then have the Agent complete explicitly. Confirm that the original
Session ID remains attached to the same Attempt. Cancellation, completion,
or recovery closes message admission. A closed node cannot become an
independent chat or resume through the ordinary DSH one-shot composer.

Human input may refine the current task's focus; it cannot change frozen
node kinds, graph edges, resources, tools, or output contracts. Start a new
reviewed Run for structural changes. Execution review follows the current
DSH preset: Full access skips human confirmation, Auto uses its reviewer,
and ordinary review uses Host approval. `approval: never` by itself does not
mean Full access. Explicit business `humanDecision` nodes remain decisions.
No Blueprint model-output-budget setting is introduced.

## Compose a saved child in Web

1. Save and validate the child first. Its public input ports come from the
   outputs of its `input` nodes; public output ports come from the inputs of
   its `output` nodes. Duplicate public names are ambiguous and must be
   resolved in the child before use.
2. Add **Call blueprint / 调用蓝图** from the parent editor's palette. In the
   Inspector choose the saved child and an exact saved revision, review the
   displayed interface, and apply. The editor generates the call ports.
3. Connect those ports using the ordinary canvas connections. Open the
   read-only child preview and return to the parent. Save, reload and confirm
   the pin and connections persist.
4. To upgrade a pin, select a specific revision and inspect the interface
   difference. Incompatible edges remain until their removal is explicitly
   confirmed. Pin, ports and removals form one undoable edit. Do not silently
   substitute a same-name current child or a guessed revision.

The saved call contains `blueprintRef: {blueprintId, documentRevision}` plus
the child's exact named `inputs` and `outputs`. Neither file paths nor
`latest` are references. Recursive self-calls, including through an older
revision, are rejected. Preserve existing graph-defined aggregation; a child
call does not create a new Team Lead or add another mandatory summary.

The running preview is immutable. Enter the call's child Run, use breadcrumbs
to return to a parent, and open the actual Attempt Session. Parent cancellation
manages its descendants; navigation never starts or detaches a child.

## Carry the complete package and verify rollback

Use the destination-supported export/import surfaces for a composed package.
Export includes the complete fixed dependency closure under
`lib/blueprint-dependencies/<documentRevision>/`. Shared/custom Host resources
are materialized inside each exported child. This can change a child's
revision, so export updates parent pins in the exported copy from the leaves
upward. Source definitions and histories remain unchanged. Do not manually
rename dependency directories, rewrite digests, or copy only blueprint.json.

Import validates closure identities, content revisions, interfaces and cycles
before publishing one parent package. It does not install children into the
global library or overwrite a same-name local Blueprint. Inspect imported
pins from their parent so Web uses the bundled version. Missing or corrupt
bundled dependencies block execution; a local same-name definition is not a
repair. Bind any required destination Host resources and models, then run
preflight again against the imported parent's returned revision.

Keep the backup outside the package. For rollback, leave the upgraded copy
unused, or restore a compatible earlier complete package through supported
CAS/history operations. Restoring a definition does not undo Run effects.
If the older runtime cannot read new fields, use the unchanged older backup
with its matching runtime; do not strip fields just to pass its decoder.

Report backup/source hashes, the changed node contracts, parent and child
pins, destination readback, UI checks, preflight, live result or `not-run`,
and the complete-package rollback path. A green preflight or a package
roundtrip alone does not establish live completion or restart recovery.
