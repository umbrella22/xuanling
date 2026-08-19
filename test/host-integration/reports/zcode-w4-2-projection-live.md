# ZCode W4.2 Projection Acceptance

> Evidence kind: isolated live host acceptance. The candidate remained local and unpublished. The
> trial workspace and Memory database were isolated from the repository and the default user
> database.

## Acceptance result

ZCode `3.7.7` completed three consecutive read-only candidate trials with one model-visible result
projection per trial. The first two trials are recorded in
[the result-cost fixture](../fixtures/result-cost/zcode-restart-live-0.2.4.json). The third trial is
verified from the raw ZCode model-I/O transcript and isolated SQLite store by
[`verify-zcode-projection-live.mjs`](../verify-zcode-projection-live.mjs). The compact verifier output
is [zcode-w4-2-projection-live.json](zcode-w4-2-projection-live.json).

| Trial | Evidence source | Model | Result | Projection count | Retry |
| --- | --- | --- | --- | ---: | ---: |
| 1 | `zcode-restart-first` | DeepSeek route captured by the cost fixture | `fs_read_text` | 1 | 0 |
| 2 | `zcode-restart-second` | DeepSeek route captured by the cost fixture | `fs_read_text` | 1 | 0 |
| 3 | session `sess_cac8c675-b560-4c3c-a54f-e8640c74243d` | `GLM-5.3` | `fs_read_text` | 1 | 0 |

The model provider differs in trial 3. W4.2 accepts the ZCode formatter and MCP bridge contract, so
the provider variation exercises the same host projection through a second provider serializer. It
does not establish model-quality parity.

## Third-trial oracle

The third trial used workspace `/private/tmp/xuanling-zcode-w4-a1/workspace`, the candidate
`xuanling-mcp-w4@0.2.4`, and a freshly created absolute Memory database inside that workspace. The
raw transcript has SHA-256
`5b57adf03792033388b56e1fab4d3bc42d04357fbf961cb8b1e97ab5ba3a9e18` and contains four
`model_io` records for one session and one turn.

The verified call sequence is:

```text
Skill(xuanling-mcp-w4:xuanling-mcp-tools)
  -> mcp__plugin_xuanling-mcp-w4_xuanling__fs_read_text(path=fixture.txt)
  -> zcode-candidate-read-only-fixture-v1
```

No native filesystem tool, shell, Memory tool, write tool, retry, or second XuanLing result appears
in the transcript. The model-facing result contains one `Structured content:` projection. Its
SHA-256 is `f755b073cf3c45d5a2479856eaad3f7a98f00d09ad3e3ee9b93d4eadde87af5c`.

The isolated Memory store reports schema version `2` and zero proposals, heads, versions, reviews,
and feedback events. The fixture remains byte-identical at SHA-256
`f87e24a5b4622199f9a9b157992539ac2ae00d4d1c1a16884e9c83e91468245d`. After ZCode exited,
the candidate process count and repository-root `.xuanling-w4-memory.db*` count were both zero. The
default Memory database remained
`4c10be200e4984c07927b485b6660ccf7a8787f66f006019028c5de48e489c74`.

## Host version boundary

The accepted third transcript was produced by ZCode `3.7.7`; every provider request records
`x-zcode-app-version: 3.7.7`. After the trial and oracle capture, ZCode's existing updater installed
`3.8.1` during the explicit host restart. That later host version is outside this W4.2 evidence. W6
clean-install acceptance must run against the then-current ZCode version and cannot reuse this
`3.7.7` transcript as current-host evidence.

## Reproduction

```text
node test/host-integration/verify-zcode-projection-live.mjs \
  --baseline test/host-integration/fixtures/result-cost/zcode-restart-live-0.2.4.json \
  --transcript /Users/ikaros/.zcode/cli/rollout/model-io-sess_cac8c675-b560-4c3c-a54f-e8640c74243d.jsonl \
  --workspace /private/tmp/xuanling-zcode-w4-a1/workspace \
  --memory-db /private/tmp/xuanling-zcode-w4-a1/workspace/.xuanling-w4-memory.db \
  --installed-mcp /Users/ikaros/.zcode/cli/plugins/cache/xuanling-w4-candidate/xuanling-mcp-w4/0.2.4/.mcp.json \
  --default-memory-db /Users/ikaros/.xuanling/memory.db \
  --expected-default-db-sha256 4c10be200e4984c07927b485b6660ccf7a8787f66f006019028c5de48e489c74 \
  --expected-host-version 3.7.7
```

The command exits `0` with `verification.status=pass`. W4.2 is complete for the pinned ZCode 3.7.7
host contract. ZCode 3.8.1 remains a later clean-install acceptance target.
