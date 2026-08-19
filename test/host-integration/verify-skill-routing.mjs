#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function fail(message) {
  process.stderr.write(`skill-routing-verifier: ${message}\n`);
  process.exitCode = 1;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--fixture" || argv[2] !== "--host") {
    throw new Error("usage: verify-skill-routing.mjs --fixture <path> --host <id>");
  }
  return { fixturePath: argv[1], host: argv[3] };
}

function validateCase(candidate, index) {
  if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.skill !== "string") {
    throw new Error(`cases[${index}] must define string id and skill`);
  }
  if (!Array.isArray(candidate.all) || candidate.all.length === 0) {
    throw new Error(`cases[${index}].all must be a non-empty regex array`);
  }
  for (const [field, values] of Object.entries({
    all: candidate.all,
    ordered: candidate.ordered ?? [],
    forbidden: candidate.forbidden ?? [],
  })) {
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
      throw new Error(`cases[${index}].${field} must be a string array`);
    }
    for (const value of values) new RegExp(value, "i");
  }
}

function validateFixture(fixture, host) {
  if (!isRecord(fixture) || fixture.schema_version !== 1 || !isRecord(fixture.hosts)) {
    throw new Error("fixture must be a schema_version=1 object with hosts");
  }
  const contract = fixture.hosts[host];
  if (!isRecord(contract) || !Array.isArray(contract.cases)) {
    throw new Error(`unknown or malformed host contract: ${host}`);
  }
  contract.cases.forEach(validateCase);
  return contract;
}

function paragraphs(markdown) {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readSkill(skillPath) {
  const text = readFileSync(skillPath, "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!frontmatter) throw new Error(`${skillPath} has no YAML frontmatter`);
  const fields = Object.fromEntries(
    frontmatter[1]
      .split("\n")
      .map((line) => /^([a-z][a-z0-9_-]*):\s*(.*)$/.exec(line))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
  if (typeof fields.name !== "string" || typeof fields.description !== "string") {
    throw new Error(`${skillPath} must define one-line name and description fields`);
  }
  return {
    text,
    paragraphs: paragraphs(text),
    name: fields.name,
    description: fields.description,
  };
}

function orderedMatch(text, patterns) {
  let offset = 0;
  for (const source of patterns) {
    const match = new RegExp(source, "i").exec(text.slice(offset));
    if (!match) return false;
    offset += match.index + match[0].length;
  }
  return true;
}

function evaluateCase(candidate, cache) {
  const skillPath = path.join(repoRoot, candidate.skill);
  let skill = cache.get(skillPath);
  if (!skill) {
    skill = readSkill(skillPath);
    cache.set(skillPath, skill);
  }

  const allPatterns = candidate.all.map((source) => new RegExp(source, "i"));
  const forbiddenPatterns = (candidate.forbidden ?? []).map((source) => new RegExp(source, "i"));
  const paragraphIndex = skill.paragraphs.findIndex((paragraph) =>
    allPatterns.every((pattern) => pattern.test(paragraph)) &&
    orderedMatch(paragraph, candidate.ordered ?? []) &&
    forbiddenPatterns.every((pattern) => !pattern.test(paragraph)),
  );
  return {
    id: candidate.id,
    skill: candidate.skill,
    matched: paragraphIndex !== -1,
    paragraph_index: paragraphIndex === -1 ? null : paragraphIndex,
  };
}

export function analyzeSkillRouting(fixture, host) {
  const contract = validateFixture(fixture, host);
  const cache = new Map();
  const cases = contract.cases.map((candidate) => evaluateCase(candidate, cache));
  const documents = [...new Set(contract.cases.map((candidate) => candidate.skill))]
    .sort()
    .map((relative) => {
      const absolute = path.join(repoRoot, relative);
      const skill = cache.get(absolute) ?? readSkill(absolute);
      return {
        skill: relative,
        file_bytes: Buffer.byteLength(skill.text),
        file_sha256: sha256(skill.text),
        name: skill.name,
        description: skill.description,
      };
    });
  const triggerCatalog = documents.map(({ name, description }) => ({ name, description }));
  const triggerCatalogJson = JSON.stringify(triggerCatalog);
  return {
    schema_version: 1,
    host,
    measurement: {
      unique_skill_files: documents.length,
      total_skill_file_bytes: documents.reduce((total, document) => total + document.file_bytes, 0),
      trigger_catalog_bytes: Buffer.byteLength(triggerCatalogJson),
      trigger_catalog_sha256: sha256(triggerCatalogJson),
      token_count: null,
      token_count_status: "unknown_without_provider_tokenizer",
      documents: documents.map(({ description: _description, ...document }) => document),
    },
    cases,
    passed_case_ids: cases.filter((candidate) => candidate.matched).map((candidate) => candidate.id),
    missing_case_ids: cases.filter((candidate) => !candidate.matched).map((candidate) => candidate.id),
  };
}

function main() {
  try {
    const { fixturePath, host } = parseArgs(process.argv.slice(2));
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const report = analyzeSkillRouting(fixture, host);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.missing_case_ids.length > 0) {
      fail(`routing_contract_incomplete: ${report.missing_case_ids.join(",")}`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
