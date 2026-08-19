# Released 0.2.3 static result-cost baseline

> Evidence kind: released/static contract measurement.
> Source catalog snapshot SHA-256:
> `89064b413f28a822461525a83abe5e6b4fcbfb6e2f1d915776d1eb1c329d8faf`.
> This report is not a live provider-usage or UI measurement.

## Measurement boundary

- ZCode is pinned to 3.7.7 build 3.7.7.4926. Its installed XuanLing 0.2.3 launch contract SHA-256 is
  `9bf92480f30f0fc89ba698ff6503bbb87faefbd89232492a6f61c0580235215f`; the installed formatter
  source contract SHA-256 is `29a85476133c8946fcf821156a11d2364c19f7f7ddfbbd12a4b3a8122c2d1381`.
- DeepSeek Harness is pinned to revision `47f943859bef60e4160492346772ded9b24f765a`. The Memory
  bundle projects its nine input schemas through `projectInputSchemaForDsh`; the full tools bundles use the raw
  input schemas because their launch path does not include the Memory schema adapter.
- Catalog bytes are the UTF-8 length of the deterministic model-facing
  `name + description + input schema` JSON projection. Output schemas and annotations are not included.
- Result-layer bytes are totals for one frozen read-only result represented once in a cold fixture and once in a
  warm fixture. They are not an agent task-usage sample.
- No provider tokenizer, billable model call, or host UI capture was used. Schema tokens, cold/warm provider usage,
  cache tokens, and UI bytes therefore remain `unknown`; the report verifier correctly exits nonzero.

## Results

| Host/profile | Tools | Catalog bytes | Prefix digest | Wire bytes | Model text bytes | Structured bytes | Token/usage/UI | Report SHA-256 (3 identical runs) |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |
| ZCode all | 42 | 52,448 | `6e57660ed831c57c7941d080f2ac50e572ea651099a46afa5e599de80807772b` | 300 | 178 | 68 | unknown | `9eb6947e35ad2e232d354d2287b1961f2cf4659bb79839f7b31779184a1d0cbe` |
| DSH memory | 9 | 13,413 | `aebf8c982bd4a21cb7152c2c17eb7154fd64d42deb8e0ce336fb012cd3df00bc` | 300 | 68 | 68 | unknown | `b1d57aff8a4e180a019c430a6317583fb5bd7e6a290cd27d24bfaa840dda52a1` |
| DSH all | 42 | 52,406 | `7c55d7ad608f909334f0190456044ce194a513f69a35deb76c1ac308a47d3930` | 300 | 68 | 68 | unknown | `68fdecad21060046150b1c912837efa573980abe1bb0e45ad58e18abadde84e2` |

The ZCode model-text delta is a confirmed projection effect for the frozen result: raw 0.2.3 contributes the JSON
text block and the host formatter appends the same structured value. DSH Native consumes the single text block and
retains `structuredContent` separately for Code Mode. This static comparison does not establish provider token cost.

## Commands

```text
node test/host-integration/measure-released-result-cost.mjs --host zcode --profile all
node test/host-integration/measure-released-result-cost.mjs --host dsh --profile memory
node test/host-integration/measure-released-result-cost.mjs --host dsh --profile all
```

Each command returns a deterministic JSON report and exits 1 with the exact unresolved fields:
`catalog:schema_tokens_unknown`, two missing usage candidates, and `result_layers:ui_bytes_unknown`. W4 must replace
those unknowns with isolated real-host evidence before a complete cost conclusion is allowed.
