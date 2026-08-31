import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { readWorkspaceVersion } from "../scripts/shared.mjs";

// DeepSeek Harness bundle contract (integrations/deepseek-harness):
//   - all bundles declare the dsh bundle manifest and pin the npm package
//     version;
//   - the patch layers mount @deepseek-ai/dsh-mcp-client with the xuanling
//     server identity and the documented binary/capability resolution;
//   - the recommended memory bundle exposes the complete canonical memory
//     profile without replacing any built-in harness tool;
//   - the replace bundle disables exactly the three built-in filesystem tool
//     rows, with full-row restatement;
//   - public install commands target a shipped runnable profile, never a
//     base-only arbitrary profile;
//   - the ZCode-only compat shim never appears in any DeepSeek config;
//   - the automation verifier carries the C-15 isolation flag.
//
// The repo has no YAML dependency, so this test ships a strict mini-parser
// locked to the exact shape our cordis.patch.yml files use (top-level
// array; `- id:`/`- insert:` entries; nested config maps; `!!js` expressions
// taken verbatim). Anything outside that shape fails loud instead of being
// silently mis-parsed.

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const integrationRoot = path.join(repoRoot, "integrations", "deepseek-harness");
const testRoot = path.join(repoRoot, "test", "deepseek-harness");
const workspaceVersion = await readWorkspaceVersion();
const bundles = ["xuanling-memory", "xuanling-tools", "xuanling-tools-replace"];
const fullCatalogBundles = ["xuanling-tools", "xuanling-tools-replace"];
const publicReadmes = [
  "README.md",
  "README-ZH.md",
  ...["xuanling-memory", "xuanling-skills", "xuanling-tools", "xuanling-tools-replace"]
    .flatMap((bundle) => [path.join(bundle, "README.md"), path.join(bundle, "README-ZH.md")]),
];

function readText(relative) {
  return readFileSync(path.join(integrationRoot, relative), "utf8");
}

function readTestText(relative) {
  return readFileSync(path.join(testRoot, relative), "utf8");
}

function readJson(relative) {
  return JSON.parse(readText(relative));
}

/**
 * Parse one of our cordis.patch.yml files into entries. Shape-locked:
 *   - id: <name>                     (top-level entry start)
 *     name: '<pkg>'
 *     disabled: true
 *   - insert:                        (top-level entry start)
 *       - id: <name>                 (row, indent 4)
 *         name: '<pkg>'
 *         config:                    (indent 6 keys)
 *           serverName: xuanling
 *           toolExposure: lazy
 *           transport: stdio
 *           command: !!js <expr>
 *           args:
 *             - '<literal>'          (indent 10 list items)
 *             - !!js <expr>
 *           toolCallTimeoutMs: 120000
 */
function parsePatch(text) {
  const lines = text.split("\n");
  const entries = [];
  let entry;
  let row;
  let inArgs = false;

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
    return trimmed; // plain scalar (serverName: xuanling)
  };

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const topEntry = /^- (\w+):(?: (.*))?$/.exec(line);
    const rowEntry = /^ {4}- (\w+): (.*)$/.exec(line);
    const argItem = /^ {6}(?: {4})?- (.*)$/.exec(line);
    const field = /^ {2,8}(\w+):(?: (.*))?$/.exec(line);
    const fail = (reason) => {
      throw new Error(`patch line ${index + 1}: ${reason}\n${line}`);
    };

    if (topEntry) {
      const [, key, rest] = topEntry;
      if (key === "insert") {
        if (rest !== undefined && rest !== "") fail("insert entry takes no inline value");
        entry = { insert: [] };
        entries.push(entry);
        row = null;
        inArgs = false;
      } else if (key === "id") {
        entry = { id: value(rest), name: undefined, disabled: undefined };
        entries.push(entry);
        row = null;
        inArgs = false;
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
      inArgs = false;
      continue;
    }
    if (argItem) {
      const config = row?.config ?? entry?.config;
      if (!inArgs || !config) fail("list item outside an args block");
      config.args.push(value(argItem[1]));
      continue;
    }
    if (field) {
      const indent = rawLine.length - rawLine.trimStart().length;
      const [, key, rest] = field;
      if (entry.insert && indent === 6 && !row) {
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
          if (key === "args") {
            row.config.args = [];
            inArgs = true;
            continue;
          }
          row.config[key] = value(rest ?? "");
          continue;
        }
        fail(`unexpected indent ${indent} inside a row`);
      }
      // Top-level (non-insert) entry fields.
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
          if (key === "config") {
            entry.config = {};
            continue;
          }
        }
        if (indent === 4 && entry.config) {
          if (key === "args") {
            entry.config.args = [];
            inArgs = true;
            continue;
          }
          entry.config[key] = value(rest ?? "");
          continue;
        }
      }
      fail(`unexpected key "${key}" on a top-level entry`);
    }
    fail("unrecognized line shape");
  }
  return entries;
}

function mountRow(patchText) {
  const inserts = parsePatch(patchText).filter((entry) => entry.insert);
  assert.equal(inserts.length, 1, "exactly one insert entry mounting the bridge");
  assert.equal(inserts[0].insert.length, 1, "the insert entry carries exactly one row");
  return inserts[0].insert[0];
}

test("bundle manifests declare the dsh bundle and pin the npm version", () => {
  const npmPackage = JSON.parse(
    readFileSync(path.join(repoRoot, "npm", "packages", "xuanling-mcp", "package.json"), "utf8"),
  );
  for (const bundle of bundles) {
    const manifest = readJson(path.join(bundle, "package.json"));
    assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml", `${bundle}: dsh.bundle.patch`);
    assert.equal(manifest.version, npmPackage.version, `${bundle}: version tracks the npm package`);
    assert.equal(manifest.license, "MIT", `${bundle}: license`);
    assert.ok(
      manifest.dependencies?.["@deepseek-ai/dsh-mcp-client"] === "^0.1.0-rc.5",
      `${bundle}: pins the harness MCP bridge package`,
    );
    const expectedFiles = bundle === "xuanling-memory"
      ? [
          "LICENSE",
          "README.md",
          "README-ZH.md",
          "cordis.patch.yml",
          "mcp-result-adapter.mjs",
          "schema-adapter.mjs",
          "schema-projection.mjs",
        ]
      : ["LICENSE", "README.md", "README-ZH.md", "cordis.patch.yml", "mcp-result-adapter.mjs"];
    assert.deepEqual(manifest.files, expectedFiles, `${bundle}: ships the declared runtime files`);
  }
  const additive = readJson(path.join("xuanling-tools", "package.json"));
  const memory = readJson(path.join("xuanling-memory", "package.json"));
  const replace = readJson(path.join("xuanling-tools-replace", "package.json"));
  assert.equal(additive.name, "@xuanling-rs/xuanling-dsh-tools");
  assert.equal(memory.name, "@xuanling-rs/xuanling-dsh-memory");
  assert.deepEqual(memory.bin, { "xuanling-dsh-schema-adapter": "schema-adapter.mjs" });
  assert.equal(replace.name, "@xuanling-rs/xuanling-dsh-tools-replace");
});

test("tool bundles depend on the exact profile-local XuanLing runtime", () => {
  const runtime = JSON.parse(
    readFileSync(path.join(repoRoot, "npm", "packages", "xuanling-mcp", "package.json"), "utf8"),
  );
  for (const bundle of bundles) {
    const manifest = readJson(path.join(bundle, "package.json"));
    assert.equal(
      manifest.dependencies?.["@xuanling-rs/xuanling-mcp"],
      runtime.version,
      `${bundle}: installs the exact launcher and optional native dependency into the DSH profile`,
    );
    assert.equal(manifest.private, false, `${bundle}: publishable bundle`);
    assert.deepEqual(manifest.scripts, undefined, `${bundle}: no install-time lifecycle scripts`);
  }
});

test("tool bundle patches resolve the launcher from their profile-local dependency", () => {
  const localLauncher =
    "process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@xuanling-rs/xuanling-mcp/bin/xuanling-mcp.js')";

  for (const bundle of fullCatalogBundles) {
    const config = mountRow(readText(path.join(bundle, "cordis.patch.yml"))).config;
    assert.deepEqual(config.command, { js: "process.execPath" }, `${bundle}: Node launches the JS shim`);
    assert.match(config.args[0].js, new RegExp(`@xuanling-rs/${bundle.replace("xuanling-", "xuanling-dsh-")}/mcp-result-adapter\\.mjs`));
    assert.deepEqual(config.args.slice(1, 5), [
      "--binary",
      { js: "process.execPath" },
      "--",
      { js: localLauncher },
    ], `${bundle}: result adapter wraps the profile-local launcher`);
  }

  const memoryConfig = mountRow(readText(path.join("xuanling-memory", "cordis.patch.yml"))).config;
  const separator = memoryConfig.args.indexOf("--");
  assert.notEqual(separator, -1, "memory adapter separates its argv from the child argv");
  assert.deepEqual(memoryConfig.args.slice(separator + 1, separator + 2), [{ js: localLauncher }]);

  for (const bundle of bundles) {
    const patch = readText(path.join(bundle, "cordis.patch.yml"));
    assert.doesNotMatch(patch, /\?\?\s*['"]xuanling-mcp['"]|npm\s+(?:i|install)\s+-g|from PATH/i);
  }
});

test("profile-local launcher resolution works with no global command on PATH", () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), "xuanling-dsh-profile-"));
  try {
  const bundleRoot = path.join(profile, "node_modules", "@xuanling-rs", "xuanling-dsh-tools");
  const runtimeRoot = path.join(profile, "node_modules", "@xuanling-rs", "xuanling-mcp");
    mkdirSync(path.join(runtimeRoot, "bin"), { recursive: true });
    mkdirSync(bundleRoot, { recursive: true });
    writeFileSync(path.join(bundleRoot, "package.json"), '{"name":"@xuanling-rs/xuanling-dsh-tools"}\n');
    writeFileSync(path.join(runtimeRoot, "package.json"), '{"name":"@xuanling-rs/xuanling-mcp"}\n');
    writeFileSync(
      path.join(runtimeRoot, "bin", "xuanling-mcp.js"),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    );

    const baseUrl = pathToFileURL(path.join(bundleRoot, "package.json"));
    const launcher = createRequire(baseUrl).resolve("@xuanling-rs/xuanling-mcp/bin/xuanling-mcp.js");
    const result = spawnSync(process.execPath, [launcher, "--profile-local"], {
      encoding: "utf8",
      env: { PATH: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["--profile-local"]);
  } finally {
    rmSync(profile, { force: true, recursive: true });
  }
});

test("runtime patches use unique row ids with one documented server identity", () => {
  const expectedIds = new Map([
    ["xuanling-memory", "xuanling-memory"],
    ["xuanling-tools", "xuanling-tools"],
    ["xuanling-tools-replace", "xuanling-tools-replace"],
  ]);
  const seenIds = new Set();
  for (const bundle of bundles) {
    const row = mountRow(readText(path.join(bundle, "cordis.patch.yml")));
    assert.equal(row.id, expectedIds.get(bundle), `${bundle}: stable package-specific row id`);
    assert.ok(!seenIds.has(row.id), `${bundle}: row id must be unique`);
    seenIds.add(row.id);
    assert.equal(row.name, "@deepseek-ai/dsh-mcp-client", `${bundle}: bridge package`);
    const config = row.config ?? {};
    assert.equal(config.serverName, "xuanling", `${bundle}: serverName fixes the public names`);
    assert.equal(config.toolExposure, "lazy", `${bundle}: host projects exact activations lazily`);
    assert.equal(config.transport, "stdio", `${bundle}: stdio transport`);
    assert.ok(!config.args.includes("--memory-db"), `${bundle}: production uses shared memory DB`);
    assert.equal(config.toolCallTimeoutMs, 120000, `${bundle}: per-call timeout`);
  }
});

test("full-tool bundles require an explicit workspace root and memory has no fs root argv", () => {
  for (const bundle of fullCatalogBundles) {
    const config = mountRow(readText(path.join(bundle, "cordis.patch.yml"))).config;
    assert.deepEqual(config.command, { js: "process.execPath" }, `${bundle}: Node runtime`);
    const rootFlag = config.args.indexOf("--workspace-root");
    assert.notEqual(rootFlag, -1, `${bundle}: contained filesystem root flag`);
    const rootExpression = config.args[rootFlag + 1]?.js ?? "";
    assert.match(rootExpression, /XUANLING_WORKSPACE_ROOT/, `${bundle}: explicit env contract`);
    assert.match(rootExpression, /throw new Error/, `${bundle}: missing root fails loud`);
    assert.doesNotMatch(rootExpression, /process\.cwd/, `${bundle}: ambient cwd is never a capability root`);
  }

  const memoryConfig = mountRow(readText(path.join("xuanling-memory", "cordis.patch.yml"))).config;
  assert.deepEqual(memoryConfig.command, { js: "process.execPath" });
  assert.match(
    memoryConfig.args[0].js,
    /XUANLING_DSH_SCHEMA_ADAPTER.*@xuanling-rs\/xuanling-dsh-memory\/schema-adapter\.mjs/,
  );
  assert.equal(memoryConfig.args.includes("--workspace-root"), false, "memory-only profile carries no ambient fs root");
  assert.deepEqual(memoryConfig.args.slice(-2), ["--tool-profile", "memory"]);
});

test("the recommended bundle exposes only the complete memory profile", () => {
  const row = mountRow(readText(path.join("xuanling-memory", "cordis.patch.yml")));
  assert.deepEqual(
    row.config.args.slice(-2),
    ["--tool-profile", "memory"],
    "memory bundle selects the canonical server-side memory profile",
  );
  const entries = parsePatch(readText(path.join("xuanling-memory", "cordis.patch.yml")));
  assert.equal(
    entries.filter((entry) => entry.disabled === true).length,
    0,
    "memory bundle remains additive and leaves native DSH tools available",
  );
  for (const bundle of fullCatalogBundles) {
    const fullRow = mountRow(readText(path.join(bundle, "cordis.patch.yml")));
    assert.ok(
      !fullRow.config.args.includes("--tool-profile"),
      `${bundle}: compatibility variant still exposes the full catalog`,
    );
  }
});

test("every supported runtime bundle preserves native filesystem and read_image rows", () => {
  for (const bundle of bundles) {
    const entries = parsePatch(readText(path.join(bundle, "cordis.patch.yml")));
    assert.equal(
      entries.filter((entry) => entry.disabled === true).length,
      0,
      `${bundle}: native tool rows remain enabled`,
    );
    const patch = readText(path.join(bundle, "cordis.patch.yml"));
    assert.doesNotMatch(patch, /read_image disappears|Known regressions in this variant/);
  }
});

test("the ZCode-only compat shim never leaks into DeepSeek configs", () => {
  const runtimeFiles = [
    ...bundles.map((bundle) => path.join(bundle, "cordis.patch.yml")),
    ...bundles.map((bundle) => path.join(bundle, "package.json")),
    "README.md",
    path.join("xuanling-memory", "schema-adapter.mjs"),
    path.join("xuanling-memory", "schema-projection.mjs"),
    ...fullCatalogBundles.map((bundle) => path.join(bundle, "mcp-result-adapter.mjs")),
    path.join("xuanling-memory", "mcp-result-adapter.mjs"),
  ];
  for (const relative of runtimeFiles) {
    const text = readText(relative);
    assert.ok(
      !text.includes("compat-lenient-object-params"),
      `${relative}: the lenient-object-params shim is ZCode-only`,
    );
  }
  for (const relative of [path.join("scripts", "verify-deepseek-bridge.mjs")]) {
    const text = readTestText(relative);
    assert.ok(
      !text.includes("compat-lenient-object-params"),
      `${relative}: the lenient-object-params shim is ZCode-only`,
    );
  }
});

test("README documents the mount and the legacy tool surface stays out", () => {
  const readme = readText("README.md");
  assert.ok(readme.includes("mcp__xuanling__"), "public name shape documented");
  assert.ok(readme.includes("dsh plugin --profile"), "profile install path documented");
  assert.ok(
    readme.includes(`@xuanling-rs/xuanling-dsh-memory@${workspaceVersion}`),
    "recommended memory bundle documented",
  );
  assert.ok(
    readme.includes(`Profile-local \`@xuanling-rs/xuanling-mcp@${workspaceVersion}\``),
    "local runtime documented",
  );
  assert.doesNotMatch(readme, /npm\s+(?:i|install)\s+(?:--global|-g)|XUANLING_MCP_BIN/);
  const legacyNames = [
    "memory_put",
    "memory_update",
    "memory_delete",
    "memory_compact",
    "memory_context",
  ];
  for (const legacy of legacyNames) {
    assert.ok(!readme.includes(legacy), `README must not reference removed v1 tool ${legacy}`);
  }
});

test("public install commands use a shipped runnable DSH profile", () => {
  const compatibilityReadmes = new Set([
    path.join("xuanling-tools-replace", "README.md"),
    path.join("xuanling-tools-replace", "README-ZH.md"),
  ]);
  for (const relative of publicReadmes) {
    const readme = readText(relative);
    if (compatibilityReadmes.has(relative)) {
      assert.doesNotMatch(readme, /dsh plugin --profile web add[^\n]*xuanling-dsh-tools-replace/);
      assert.match(readme, /@xuanling-rs\/xuanling-dsh-tools/);
    } else {
      assert.match(
        readme,
        /dsh plugin --profile web add/,
        `${relative}: install command targets the shipped Web profile`,
      );
    }
    assert.doesNotMatch(
      readme,
      /dsh plugin --profile (?:demo|full|replace|xuanling-acceptance)\b/,
      `${relative}: install command must not create a base-only arbitrary profile`,
    );
  }

  for (const relative of ["README.md", "README-ZH.md"]) {
    assert.match(
      readText(relative),
      /--profile headless/,
      `${relative}: shipped Headless profile alternative is documented`,
    );
  }
});

test("the live verifier carries the C-15 isolation flag", () => {
  const verifier = readTestText(path.join("scripts", "verify-deepseek-bridge.mjs"));
  assert.ok(
    verifier.includes('"--memory-db"'),
    "the verifier spawns with an explicit temp --memory-db",
  );
  assert.ok(
    verifier.includes('"--workspace-root"'),
    "the verifier pins a temp workspace root",
  );
  assert.ok(
    verifier.includes('args["tool-profile"]'),
    "the verifier accepts a canonical tool profile",
  );
  assert.ok(
    verifier.includes('"--tool-profile"'),
    "the verifier forwards the selected profile to the binary",
  );
});
