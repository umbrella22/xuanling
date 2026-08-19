# ZCode 0.2.4 candidate live result-cost report

> Evidence kind: isolated live host measurement. The candidate was installed in a temporary ZCode
> marketplace and used with a temporary workspace and Memory database. No release, promotion, or
> default project data was changed by this measurement.

## Scope and source contract

The evidence fixture is [zcode-restart-live-0.2.4.json](../fixtures/result-cost/zcode-restart-live-0.2.4.json),
and the verified analyzer output is [zcode-restart-live-0.2.4-cost.json](zcode-restart-live-0.2.4-cost.json).
It contains two read-only trials against `xuanling-mcp-w4@0.2.4`:

| Field | Value |
| --- | --- |
| Host | ZCode `3.7.7` build `3.7.7.4926` |
| Candidate workspace | `/private/tmp/xuanling-zcode-w4-a1/workspace` |
| Candidate Memory DB | `/private/tmp/xuanling-zcode-w4-a1/workspace/.xuanling-w4-memory.db` |
| Tool call | `fs_read_text` |
| Trial phases | one `cold`, one `warm` |
| Retry count | `0` |
| Catalog projection | `name + description + input_schema` |
| Catalog snapshot SHA-256 | `89064b413f28a822461525a83abe5e6b4fcbfb6e2f1d915776d1eb1c329d8faf` |
| Installed `.mcp.json` SHA-256 | `f1219c7f665f731a33898f609d64964401e1584095e9b34921f1cfeaa3e952ea` |
| Formatter source SHA-256 | `ad965011984b28428d9d203595717c7180437fd3068758a9516c0a4aaff8dbe1` |

The candidate was the only enabled XuanLing plugin during the restart smoke. Both trials returned
`zcode-candidate-read-only-fixture-v1` and used the explicit temporary Memory DB.

## Layered measurements

The analyzer output is deterministic across three runs. Each run verifies successfully while
preserving `schema_tokens` as `unknown`, because ZCode does not expose the provider tokenizer used
for the tool catalog.

| Layer | Measured value | Meaning |
| --- | ---: | --- |
| Available tools | 42 | Stable catalog contains 42 tools |
| Catalog bytes | 52,448 | UTF-8 bytes for the model-facing catalog projection |
| Catalog prefix | `6e57660ed831c57c7941d080f2ac50e572ea651099a46afa5e599de80807772b` | Same digest across 3 reads |
| Provider input tokens, cold | 39,514 | Provider-reported input for the cold trial |
| Provider input tokens, warm | 39,782 | Provider-reported input for the warm trial |
| Provider cache-read tokens | 79,104 | Sum of the two provider usage records |
| Provider cache-write tokens | 0 | Sum of the two provider usage records |
| Provider output tokens | 36 | Sum of the two provider usage records |
| Raw wire payload | 750 bytes | Two MCP results, including `content` and `structuredContent` |
| Model-visible text | 452 bytes | Two host-projected text blocks delivered to the model path |
| Structured payload | 282 bytes | Two structured values retained by the host |
| Session/UI projection | 452 bytes | The captured ZCode text projection for both trials |
| Called-tool rate | 1 of 42 | `fs_read_text` only; `2.38%` distinct-tool rate |

`schema_tokens` is `unknown`; no byte-to-token estimate is used in this report. Provider token usage
is known for these two trials, but it does not reveal how the catalog bytes were tokenized.

The current DSH source cannot fill this gap: its token meter uses a fixed
`CHARS_PER_TOKEN = 4` density heuristic in `packages/llm/token-meter/src/estimate.ts`. That estimate
is excluded because it is not the tokenizer used by the provider. The provider's aggregate input
usage also cannot isolate the catalog from system, history, and request framing tokens.

## Projection interpretation

The raw MCP result contains a JSON text item and a structurally equivalent `structuredContent` value.
ZCode's formatter renders a stable text marker and the structured value in the model/session
projection. The measured 452 model-visible bytes and 452 session/UI bytes are therefore projection
measurements, not provider-token measurements. The provider records above are the only token values
used for cost accounting.

The two representations must remain distinct in the evidence model:

- `wire_bytes` measures the MCP transport representation.
- `model_visible_text_bytes` measures text passed through the host model projection.
- `structured_bytes` measures the retained structured value.
- `ui_bytes` measures the captured session/UI text projection.
- `provider_usage` measures provider-reported input, cache, and output tokens.

Equal text and UI byte totals do not prove that the provider charged the structured value twice. A
provider request capture or an exposed tokenizer would be required to make that claim.

## Reproduction and verification

```text
node -e 'const fs=require("fs"); JSON.parse(fs.readFileSync("test/host-integration/fixtures/result-cost/zcode-restart-live-0.2.4.json", "utf8"));'
node test/host-integration/verify-result-cost-report.mjs --analyze test/host-integration/fixtures/result-cost/zcode-restart-live-0.2.4.json
node test/host-integration/verify-result-cost-report.mjs --verify test/host-integration/reports/zcode-restart-live-0.2.4-cost.json
node --test --test-name-pattern='unavailable schema tokenization|cost report verification' npm/test/mcp-result-projection.test.mjs
```

The JSON parser exits `0`. Three analyzer runs produced the identical SHA-256
`8dd781e61e1ccd38bd466f58040d7c36a7ef414ebf155b57a4cd65e351000736` and all exited `0` with
`verification.status=pass`. The generated metric remains
`{status: "unknown", value: null, reason: "token_measurement_unavailable"}` with the ZCode source
boundary. Missing or ambiguous provider usage, prefix drift, and incomplete result layers still
produce nonzero verification.

## Acceptance status

This evidence proves the isolated ZCode restart/read-only path and the separation of wire, model,
structured, session/UI, and provider layers. W4.5 is complete under the explicit tokenizer-
unavailable contract: every observable layer and provider usage field is known, the prefix is stable
across three reads, and the exact schema token metric remains typed `unknown`. The report does not
prove an exact schema token count, a provider charge for each representation, or any catalog-removal
decision. Other W4 work-package gates remain separate.
