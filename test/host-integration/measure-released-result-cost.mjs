#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { projectInputSchemaForDsh } from "../../integrations/deepseek-harness/xuanling-memory/schema-projection.mjs";
import { buildResultCostReport } from "./verify-result-cost-report.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const snapshotPath = path.join(repoRoot, "crates", "xuanling-mcp", "tests", "snapshots", "tools-list.json");
const zcodeResultFixture = path.join(
  repoRoot,
  "test",
  "host-integration",
  "fixtures",
  "result-projection",
  "zcode-3.7.7-raw-0.2.3.json",
);
const dshResultFixture = path.join(
  repoRoot,
  "test",
  "host-integration",
  "fixtures",
  "result-projection",
  "dsh-47f94385-canonical.json",
);

function fail(message) {
  process.stderr.write(`released-cost-measurement: ${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--host" || argv[2] !== "--profile") {
    throw new Error("usage: measure-released-result-cost.mjs --host <zcode|dsh> --profile <all|memory>");
  }
  if (!["zcode", "dsh"].includes(argv[1]) || !["all", "memory"].includes(argv[3])) {
    throw new Error("host must be zcode or dsh; profile must be all or memory");
  }
  if (argv[1] === "zcode" && argv[3] !== "all") throw new Error("ZCode released profile is all");
  return { host: argv[1], profile: argv[3] };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function projectCatalog(rawCatalog, host, profile) {
  const selected = profile === "memory"
    ? rawCatalog.filter((tool) => tool.name.startsWith("memory_"))
    : rawCatalog;
  return selected.map((tool) => {
    if (host === "dsh" && profile === "memory") {
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: projectInputSchemaForDsh(tool.input_schema),
      };
    }
    return {
      name: tool.name,
      description: tool.description,
      ...(host === "dsh" ? { inputSchema: tool.input_schema } : { input_schema: tool.input_schema }),
    };
  });
}

function resultForHost(host) {
  const fixture = JSON.parse(readFileSync(host === "zcode" ? zcodeResultFixture : dshResultFixture, "utf8"));
  const structured = fixture.result.structuredContent;
  const contentText = fixture.result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const modelText = host === "zcode"
    ? `${contentText}\nStructured content:\n${JSON.stringify(structured)}`
    : contentText;
  return {
    call_id: `${host}-released-0.2.3-read-only`,
    tool_name: "fs_read_text",
    retry_of: null,
    wire_payload: fixture.result,
    model_text: modelText,
    structured_payload: structured,
    ui_text: null,
  };
}

export function buildReleasedEvidence({ host, profile }) {
  const snapshotBytes = readFileSync(snapshotPath);
  const rawCatalog = JSON.parse(snapshotBytes.toString("utf8"));
  const catalog = projectCatalog(rawCatalog, host, profile);
  const catalogDigest = sha256(Buffer.from(JSON.stringify(catalog)));
  const sourceContract = {
    snapshot_sha256: sha256(snapshotBytes),
    catalog_projection: host === "zcode"
      ? "name+description+input_schema"
      : profile === "memory"
        ? "name+description+projectInputSchemaForDsh(input_schema)"
        : "name+description+input_schema",
  };
  if (host === "zcode") {
    sourceContract.installed_mcp_json_sha256 = "9bf92480f30f0fc89ba698ff6503bbb87faefbd89232492a6f61c0580235215f";
    sourceContract.formatter_source_sha256 = "29a85476133c8946fcf821156a11d2364c19f7f7ddfbbd12a4b3a8122c2d1381";
  } else {
    sourceContract.dsh_revision = "47f943859bef60e4160492346772ded9b24f765a";
  }
  const toolResult = resultForHost(host);
  return {
    schema_version: 1,
    evidence_id: `released-0.2.3-${host}-${profile}-static`,
    evidence_kind: "released-static",
    host,
    host_version: host === "zcode" ? "3.7.7+3.7.7.4926" : "47f943859bef60e4160492346772ded9b24f765a",
    source_contract: sourceContract,
    catalog: {
      tools: catalog,
      schema_tokens: {
        value: null,
        source: "unknown-no-provider-tokenizer-in-static-measurement",
      },
      prefix_digests: [catalogDigest, catalogDigest, catalogDigest],
    },
    trials: [
      {
        trial_id: `${host}-${profile}-cold-static`,
        task_id: `${host}-${profile}-read-only-static`,
        phase: "cold",
        usage_candidates: [],
        tool_results: [toolResult],
      },
      {
        trial_id: `${host}-${profile}-warm-static`,
        task_id: `${host}-${profile}-read-only-static`,
        phase: "warm",
        usage_candidates: [],
        tool_results: [toolResult],
      },
    ],
  };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const evidence = buildReleasedEvidence(options);
    const evidenceBytes = Buffer.from(JSON.stringify(evidence));
    const report = buildResultCostReport(evidence, evidenceBytes);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.verification.status !== "pass") {
      fail(`report_incomplete: ${report.verification.problems.join(",")}`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
