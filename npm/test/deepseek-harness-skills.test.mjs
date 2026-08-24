import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// DSH-specific Skill bundle contract (C-01/C-02/C-03):
//   - `xuanling-skills` is a standalone dsh bundle whose insert block mounts
//     an ISOLATED @deepseek-ai/dsh-skill-filesystem provider (unique
//     providerName, includeDefaultRoots: false) over the bundle's own
//     skills/ directory, resolved via env override or the installed package
//     path — never the user's ~/.dsh/skills — plus the installed bundle's
//     strict XuanLing overwrite policy module;
//   - exactly two on-demand skills ship: xuanling-file-workflow (tool-family
//     routing only) and xuanling-memory-workflow (proposal/review lifecycle);
//   - the memory skill never authorizes memory_review without an explicit
//     user instruction for a concrete proposal, and never presents the agent
//     as a human reviewer;
//   - bodies stay small on-demand guidance, never a copy of the full tool
//     catalog;
//   - the ZCode-only compat shim stays out of every DeepSeek config.
//
// The parser is the same shape-locked mini-parser the bundle contract test
// uses, extended with one config-level list key (customSkillDirs).

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const integrationRoot = path.join(repoRoot, "integrations", "deepseek-harness");
const bundleRoot = path.join(integrationRoot, "xuanling-skills");
const routingVerifier = path.join(repoRoot, "test", "host-integration", "verify-skill-routing.mjs");
const routingFixture = path.join(
  repoRoot,
  "test",
  "host-integration",
  "fixtures",
  "skill-routing",
  "cases.json",
);

function mustExist(relative, what) {
  const absolute = path.join(bundleRoot, relative);
  assert.ok(existsSync(absolute), `${what} missing: ${relative} (W2 creates the xuanling-skills bundle)`);
  return absolute;
}

function readBundle(relative) {
  return readFileSync(mustExist(relative, "skills bundle file"), "utf8");
}

function parsePatch(text) {
  const lines = text.split("\n");
  const entries = [];
  const listKeys = new Set(["args", "customSkillDirs"]);
  let entry;
  let row;
  let listKey = null;

  const value = (raw) => {
    const trimmed = raw.trim();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    if (trimmed.startsWith("!!js ")) return { js: trimmed.slice(5) };
    if (
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  };

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const topEntry = /^- (\w+):(?: (.*))?$/.exec(line);
    const rowEntry = /^ {4}- (\w+): (.*)$/.exec(line);
    const listItem = /^ {10}- (.*)$/.exec(line);
    const field = /^ {2,8}(\w+):(?: (.*))?$/.exec(line);
    const fail = (reason) => {
      throw new Error(`patch line ${index + 1}: ${reason}\n${line}`);
    };

    if (topEntry) {
      const [, key, rest] = topEntry;
      if (key === "insert") {
        entry = { insert: [] };
        entries.push(entry);
        row = null;
        listKey = null;
      } else if (key === "id") {
        entry = { id: value(rest) };
        entries.push(entry);
        row = null;
        listKey = null;
      } else {
        fail(`unexpected top-level key "${key}"`);
      }
      continue;
    }
    if (!entry) fail("content before the first top-level entry");

    if (rowEntry) {
      if (!entry.insert) fail("row entry outside an insert block");
      const [, key, rest] = rowEntry;
      if (key !== "id") fail(`unexpected row key "${key}"`);
      row = { id: value(rest) };
      entry.insert.push(row);
      listKey = null;
      continue;
    }
    if (listItem) {
      if (!listKey || !row?.config) fail(`list item outside a ${[...listKeys].join("/")} block`);
      row.config[listKey].push(value(listItem[1]));
      continue;
    }
    if (field) {
      const indent = rawLine.length - rawLine.trimStart().length;
      const [, key, rest] = field;
      if (entry.insert && !row && indent === 6) {
        if (key === "name") {
          entry.rowName = value(rest ?? "");
          continue;
        }
        fail(`unexpected key "${key}" at insert level`);
      }
      if (entry.insert && row) {
        if (indent === 6) {
          if (key === "name") {
            row.name = value(rest ?? "");
            continue;
          }
          if (key === "config") {
            row.config = {};
            continue;
          }
          fail(`unexpected row key "${key}"`);
        }
        if (indent === 8 && row.config) {
          if (listKeys.has(key)) {
            row.config[key] = [];
            listKey = key;
            continue;
          }
          row.config[key] = value(rest ?? "");
          listKey = null;
          continue;
        }
        fail(`unexpected indent ${indent} inside a row`);
      }
      if (!entry.insert) {
        if (indent === 2) {
          if (key === "name") {
            entry.name = value(rest ?? "");
            continue;
          }
          if (key === "disabled") {
            entry.disabled = value(rest ?? "");
            continue;
          }
        }
      }
      fail(`unexpected key "${key}" on a top-level entry`);
    }
    fail("unrecognized line shape");
  }
  return entries;
}

function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "SKILL.md starts with a --- frontmatter block");
  const fields = {};
  for (const line of match[1].split("\n")) {
    const field = /^(\w[\w-]*):(?: (.*))?$/.exec(line);
    if (!field) continue;
    fields[field[1]] = field[2] ?? "";
  }
  return { fields, body: text.slice(match[0].length) };
}

function loadSkill(name) {
  const relative = path.join("skills", name, "SKILL.md");
  const text = readBundle(relative);
  const { fields, body } = parseFrontmatter(text);
  assert.equal(fields.name, name, `${relative}: frontmatter name matches the directory`);
  assert.match(fields.name ?? "", /^[a-z0-9]+(-[a-z0-9]+)*$/, `${relative}: kebab-case name`);
  assert.ok(fields.description && fields.description.length >= 16, `${relative}: description present`);
  assert.ok(fields.description.length <= 500, `${relative}: description stays catalog-sized`);
  assert.match(fields.description, /DeepSeek Harness|DSH/, `${relative}: description names the harness context`);
  assert.ok(!text.includes("disable-model-invocation: true"), `${relative}: stays model-invocable`);
  assert.ok(body.split("\n").length < 500, `${relative}: body stays on-demand guidance (<500 lines)`);
  return { fields, body };
}

test("current DSH Skills satisfy the frozen routing contract", () => {
  const result = spawnSync(
    process.execPath,
    [routingVerifier, "--fixture", routingFixture, "--host", "dsh"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.passed_case_ids, [
    "repeated_validation_deterministic",
    "existing_overwrite_cas",
    "same_file_multi_hunk_patch",
    "compound_extension_exact",
    "project_local_l1_only",
    "shared_l2_pull_then_pending",
    "explicit_pointer_recall",
    "no_match_or_unavailable_continues",
  ]);
  assert.deepEqual(report.missing_case_ids, []);
  assert.equal(result.stderr, "");
  assert.equal(report.measurement.unique_skill_files, 2);
  assert.ok(report.measurement.total_skill_file_bytes > 0);
  assert.ok(report.measurement.trigger_catalog_bytes > 0);
  assert.match(report.measurement.trigger_catalog_sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.measurement.token_count, null);
  assert.equal(report.measurement.token_count_status, "unknown_without_provider_tokenizer");
  assert.equal(report.measurement.documents.length, 2);
});

test("the skills bundle manifest declares the dsh bundle and pins its dependencies", () => {
  const npmPackage = JSON.parse(
    readFileSync(path.join(repoRoot, "npm", "packages", "xuanling-mcp", "package.json"), "utf8"),
  );
  const manifest = JSON.parse(readBundle("package.json"));
  assert.equal(manifest.name, "@xuanling-rs/xuanling-dsh-skills");
  assert.equal(manifest.version, npmPackage.version, "version tracks the npm package");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.deepEqual(manifest.files, [
    "LICENSE",
    "README.md",
    "README-ZH.md",
    "cordis.patch.yml",
    "strict-overwrite-policy.mjs",
    "skills/xuanling-file-workflow/SKILL.md",
    "skills/xuanling-file-workflow/agents/openai.yaml",
    "skills/xuanling-memory-workflow/SKILL.md",
    "skills/xuanling-memory-workflow/agents/openai.yaml",
  ]);
  assert.equal(
    manifest.dependencies?.["@deepseek-ai/dsh-skill-filesystem"],
    "^0.1.0-rc.5",
    "pins the harness skill provider package",
  );
});

test("the skills patch mounts one isolated provider and one installed policy module", () => {
  const entries = parsePatch(readBundle("cordis.patch.yml"));
  assert.equal(entries.filter((e) => e.insert).length, 1, "exactly one insert entry");
  assert.equal(entries.filter((e) => e.disabled === true).length, 0, "the bundle disables nothing");
  const inserts = entries[0].insert;
  assert.equal(inserts.length, 2, "the insert entry carries provider and policy rows");
  const row = inserts.find((candidate) => candidate.id === "xuanling-skills");
  assert.ok(row, "skill provider row present");
  assert.equal(row.id, "xuanling-skills");
  assert.equal(row.name, "@deepseek-ai/dsh-skill-filesystem");
  const config = row.config ?? {};
  assert.equal(config.providerName, "xuanling-dsh-skills", "unique provider name, no clash with the preset's 'filesystem'");
  assert.equal(config.includeDefaultRoots, false, "never depends on ~/.dsh/skills or project roots");
  assert.equal(config.watch, false, "static npm contents; stable request history");
  assert.ok(Array.isArray(config.customSkillDirs) && config.customSkillDirs.length === 1);
  const [dir] = config.customSkillDirs;
  assert.match(dir.js, /XUANLING_DSH_SKILLS_ROOT/, "source-overlay override");
  assert.match(dir.js, /@xuanling-rs\/xuanling-dsh-skills\/package\.json/, "installed-package self resolution");
  assert.match(dir.js, /skills/, "resolves the bundle's own skills directory");

  const policy = inserts.find((candidate) => candidate.id === "xuanling-file-policy");
  assert.ok(policy, "strict overwrite policy include row present");
  assert.equal(policy.name, "@xuanling-rs/xuanling-dsh-skills/strict-overwrite-policy.mjs");
  assert.equal(policy.config, undefined);
});

test("xuanling-file-workflow routes between the native and XuanLing fs families", () => {
  const { body } = loadSkill("xuanling-file-workflow");
  assert.match(body, /stable package-relative path.*skills\/xuanling-file-workflow\/SKILL\.md/s);
  assert.match(body, /versioned DSH plugin\s+cache path/);
  assert.ok(body.includes("mcp__xuanling__fs_"), "references the XuanLing fs tool family");
  assert.match(body, /native file tools/i, "references the harness-native file tools");
  assert.match(body, /routine (small )?edits?/i, "native tools preferred for routine small edits");
  assert.match(body, /sha256|expected_sha256|CAS/i, "XuanLing chosen for hash/CAS-protected edits");
  assert.match(body, /mode:\s*"create"/i, "whole-file creation uses explicit create mode");
  assert.match(body, /mode:\s*"overwrite"/i, "whole-file replacement uses explicit overwrite mode");
  assert.match(body, /XUANLING_FS_OVERWRITE_REQUIRES_SHA256/, "documents the host policy recovery code");
  assert.match(body, /byte (budget|cap)|bounded|max_bytes/i, "XuanLing chosen for explicit output budgets");
  assert.match(body, /fs_patch|unified diff/i, "XuanLing chosen for strict patch application");
  assert.match(body, /cursor|pagination|resume/i, "XuanLing chosen for bounded continuation");
  assert.match(body, /same argv|repeated validation/i, "repeated validation is identified");
  assert.match(body, /deterministic:\s*true/i, "repeated validation removes volatile duration");
  assert.match(body, /multiple hunks|multi.*hunks/i, "same-file multi-hunk edits use one patch");
  assert.match(body, /file_extensions/i, "exact compound extension filtering is documented");
  assert.match(body, /memory-only bundle does not provide file or process tools/i, "memory-only profiles do not infer absent tools");
  assert.match(body, /background\/job/i, "long-running work stays on the host job surface");
  assert.match(body, /do not (use|invoke|run) (the )?(shell|terminal|bash|pwsh)/i, "file work never routes through shell tools");
  assert.match(body, /must not silently fall back/i, "no silent fallback between families on failure");
  assert.match(body, /typed error|tool error|error/i, "failures surface as tool errors to handle");
  assert.ok(!body.includes("memory_review"), "the file skill never touches the memory lifecycle");
  assert.ok(!body.includes("memory_candidate"), "the file skill never touches the memory lifecycle");
});

test("xuanling-memory-workflow keeps proposal and review in separate turns", () => {
  const { body } = loadSkill("xuanling-memory-workflow");
  assert.match(body, /memory_search|search.*memory_get|memory_get/, "search/get before any write");
  assert.match(body, /memory_candidate_create/, "writes create a pending candidate");
  assert.match(body, /proposal id/, "the candidate's proposal id is reported");
  assert.match(body, /revision/, "the candidate's revision is reported");
  assert.match(body, /memory_review/, "review exists as the gated next step");
  assert.match(
    body,
    /explicit user (instruction|approval|request|decision)/i,
    "memory_review requires an explicit user decision for a concrete proposal",
  );
  assert.match(body, /awaiting review|pending/i, "terminal state without review is awaiting review");
  assert.match(body, /never (describe|present|claim) (yourself|the agent)/i, "never claims human review");
  assert.match(body, /skip (the )?write|do not (write|create)/i, "tool/model failures skip the write");
  assert.match(body, /same idempotency key/, "candidate retries reuse the idempotency key");
  assert.match(body, /same payload/, "candidate retries reuse the same payload");
  assert.match(body, /host file memory \(L1\)/i, "project-local must-see facts stay in L1");
  assert.match(body, /XuanLing L2/i, "shared facts route to L2");
  assert.match(body, /not a lightweight manifest/i, "search cost reflects full record results");
  assert.match(body, /not an instruction\s+to search on every turn/i, "L1 pointers trigger bounded pull recall");
  assert.match(body, /zero canonical write/i, "no-match and unavailable recall do not write canonical facts");
  assert.ok(!/auto-approve|approve it yourself|immediately approve/i.test(body), "no self-approval instruction");
  assert.ok(!body.includes("mcp__xuanling__fs_"), "the memory skill stays out of file-tool routing");
});

test("portable per-skill agent metadata travels with the bundle", () => {
  for (const name of ["xuanling-file-workflow", "xuanling-memory-workflow"]) {
    const metadata = readBundle(path.join("skills", name, "agents", "openai.yaml"));
    assert.ok(metadata.includes(name), `${name}: openai.yaml names the skill`);
    assert.ok(metadata.includes(`$${name}`), `${name}: default_prompt references $${name}`);
  }
});

test("the skills bundle never carries the ZCode-only compat shim", () => {
  const scanned = [
    "package.json",
    "cordis.patch.yml",
    path.join("skills", "xuanling-file-workflow", "SKILL.md"),
    path.join("skills", "xuanling-file-workflow", "agents", "openai.yaml"),
    path.join("skills", "xuanling-memory-workflow", "SKILL.md"),
    path.join("skills", "xuanling-memory-workflow", "agents", "openai.yaml"),
  ];
  for (const relative of scanned) {
    const text = readBundle(relative);
    assert.ok(
      !text.includes("compat-lenient-object-params"),
      `${relative}: the lenient-object-params shim is ZCode-only`,
    );
  }
});
