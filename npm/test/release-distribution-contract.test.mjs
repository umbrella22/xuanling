import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { classifyIntegrityLookup } from "../scripts/registry-release.mjs";
import { resolveCommandForPlatform } from "../scripts/shared.mjs";
import { describeProjection } from "../scripts/zcode-promotion-lib.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "npm-publish.yml");
const fixtureRoot = path.join(repoRoot, "test", "release", "fixtures");

function workflow() {
  return readFileSync(workflowPath, "utf8");
}

function workflowJob(source, name) {
  const marker = `\n  ${name}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `release workflow is missing job ${name}`);
  const tail = source.slice(start + marker.length);
  const nextJob = /\n  [a-z][a-z0-9-]*:\n/.exec(tail);
  const end = nextJob === null
    ? source.length
    : start + marker.length + nextJob.index;
  return source.slice(start, end);
}

test("shared runner invokes the Windows npm CLI directly without rewriting native executables", () => {
  const npmCliPath = "C:\\node\\node_modules\\npm\\bin\\npm-cli.js";
  assert.deepEqual(
    resolveCommandForPlatform("npm", "win32", {
      execPath: "C:\\node\\node.exe",
      exists: (candidate) => candidate === npmCliPath,
      env: { Path: "C:\\other" },
    }),
    { command: "C:\\node\\node.exe", argsPrefix: [npmCliPath] },
  );
  assert.deepEqual(
    resolveCommandForPlatform("npm", "linux"),
    { command: "npm", argsPrefix: [] },
  );
  assert.deepEqual(
    resolveCommandForPlatform("git", "win32"),
    { command: "git", argsPrefix: [] },
  );
});

test("synthetic release fixture is hash-pinned before distribution tests use it", () => {
  const manifest = JSON.parse(readFileSync(path.join(fixtureRoot, "synthetic-tree.json"), "utf8"));
  const payload = readFileSync(path.join(fixtureRoot, manifest.path));
  assert.equal(createHash("sha256").update(payload).digest("hex"), manifest.sha256);
  assert.equal(manifest.source_commit, "0000000000000000000000000000000000000000");
});

test("registry integrity reconciliation has exact publish, skip, and failure states", () => {
  const expectedIntegrity = "sha512-fixture";
  const specifier = "xuanling-mcp@0.2.1";
  assert.deepEqual(
    classifyIntegrityLookup({ stdout: "", stderr: "npm ERR! E404", exitCode: 1 }, {
      expectedIntegrity,
      specifier,
    }),
    { action: "publish" },
  );
  assert.deepEqual(
    classifyIntegrityLookup({ stdout: `${JSON.stringify(expectedIntegrity)}\n`, stderr: "" }, {
      expectedIntegrity,
      specifier,
    }),
    { action: "skip", integrity: expectedIntegrity },
  );
  assert.throws(
    () => classifyIntegrityLookup({ stdout: '"sha512-other"\n', stderr: "" }, {
      expectedIntegrity,
      specifier,
    }),
    /already exists with integrity/,
  );
  assert.throws(
    () => classifyIntegrityLookup({ stdout: "", stderr: "npm ERR! E503", exitCode: 1 }, {
      expectedIntegrity,
      specifier,
    }),
    /Unable to query/,
  );
});

test("idempotent publisher reconciles delayed visibility and refuses drift", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "xuanling-publisher-contract-"));
  try {
    const fakeBin = path.join(temporary, "bin");
    const statePath = path.join(temporary, "state.json");
    const packageRoot = path.join(temporary, "package");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(packageRoot, { recursive: true });
    const fakeNpm = path.join(fakeBin, "npm");
    await writeFile(fakeNpm, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const state = JSON.parse(readFileSync(process.env.STATE_FILE, "utf8"));
const command = process.argv[2];
if (command === "view") {
  state.views += 1;
  if (!state.published || state.visibility_delays > 0) {
    if (state.published) state.visibility_delays -= 1;
    writeFileSync(process.env.STATE_FILE, JSON.stringify(state));
    console.error("npm ERR! E404 fixture");
    process.exit(1);
  }
  writeFileSync(process.env.STATE_FILE, JSON.stringify(state));
  console.log(JSON.stringify(state.integrity));
  process.exit(0);
}
if (command === "publish") {
  state.publishes += 1;
  state.published = true;
  writeFileSync(process.env.STATE_FILE, JSON.stringify(state));
  process.exit(0);
}
console.error("unexpected fake npm command", command);
process.exit(2);
`);
    await chmod(fakeNpm, 0o755);

    const tarballPath = path.join(packageRoot, "fixture.tgz");
    const tarball = Buffer.from("fixture tarball\n");
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    const manifestPath = path.join(packageRoot, "fixture.pack.json");
    await writeFile(tarballPath, tarball);
    await writeFile(manifestPath, JSON.stringify({
      filename: "fixture.tgz",
      integrity,
      name: "xuanling-fixture",
      version: "0.2.1",
    }));
    const invoke = () => execFileSync(process.execPath, [
      "npm/scripts/publish-idempotent.mjs",
      "--manifest", manifestPath,
      "--tag", "latest",
      "--registry", "https://registry.example.test",
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        STATE_FILE: statePath,
      },
      stdio: "pipe",
    });

    await writeFile(statePath, JSON.stringify({
      integrity,
      published: false,
      publishes: 0,
      views: 0,
      visibility_delays: 1,
    }));
    invoke();
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), {
      integrity,
      published: true,
      publishes: 1,
      views: 3,
      visibility_delays: 0,
    });
    invoke();
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).publishes, 1);

    const mismatch = JSON.parse(await readFile(statePath, "utf8"));
    mismatch.integrity = "sha512-different";
    await writeFile(statePath, JSON.stringify(mismatch));
    assert.throws(invoke, "an immutable registry mismatch must fail");

    await writeFile(tarballPath, "tampered tarball\n");
    assert.throws(invoke, "local tarball drift must fail before registry reconciliation");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("ZCode target bootstrap template contains documentation only", async () => {
  const template = path.join(repoRoot, "test", "release", "target-repo-template");
  assert.deepEqual(
    (await readdir(template)).sort(),
    ["LICENSE", "README-ZH.md", "README.md"],
  );
  assert.equal(existsSync(path.join(template, ".github")), false);
});

test("release workflow requires provenance and attestation without publisher certificates", () => {
  const source = workflow();
  const build = source.indexOf("Build locked release binary");
  const stage = source.indexOf("Stage native package with explicit release trust");
  const attest = source.indexOf("Attest immutable ZCode marketplace archive");
  for (const [name, position] of Object.entries({ build, stage, attest })) {
    assert.notEqual(position, -1, `release workflow is missing ${name}`);
  }
  assert.ok(build < stage, "native bytes are hashed and staged after the locked build");
  assert.match(source, /actions\/attest-build-provenance@v2/);
  assert.match(source, /attestations: write/);
  assert.match(source, /id-token: write/);
  assert.doesNotMatch(source, /environment: release-signing/);
  assert.doesNotMatch(source, /MACOS_CERTIFICATE|WINDOWS_CERTIFICATE|WINDOWS_TIMESTAMP_URL/);
  assert.doesNotMatch(source, /codesign\s+(?:--sign\s+-|-s\s+-)/, "ad-hoc signing is not a release substitute");

  const publisher = readFileSync(
    path.join(repoRoot, "npm", "scripts", "publish-idempotent.mjs"),
    "utf8",
  );
  assert.match(publisher, /"--provenance"/);
});

test("release workflow has a no-tag preflight for npm and ZCode credentials", () => {
  const source = workflow();
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /environment: npmjs/);
  assert.match(source, /npm whoami/);
  assert.match(source, /NPM_CONFIG_USERCONFIG/);
  for (const job of [
    "build-main",
    "build-native",
    "build-dsh",
    "assemble-release",
    "publish",
    "promote",
  ]) {
    assert.match(
      workflowJob(source, job),
      /if: github\.event_name == 'push'/,
      `${job} must stay disabled during a manual preflight`,
    );
  }
});

test("release workflow publishes the complete ordered npm set", () => {
  const source = workflow();
  assert.ok(existsSync(path.join(repoRoot, "npm", "scripts", "pack-dsh-bundles.mjs")));
  assert.ok(existsSync(path.join(repoRoot, "npm", "scripts", "verify-dsh-release-set.mjs")));
  const nativePublish = source.indexOf("Publish native variants");
  const launcherPublish = source.indexOf("Publish stable launcher");
  const dshPublish = source.indexOf("Publish DSH bundles");
  assert.ok(nativePublish !== -1 && launcherPublish !== -1 && dshPublish !== -1);
  assert.ok(nativePublish < launcherPublish && launcherPublish < dshPublish);
  for (const name of [
    "xuanling-dsh-memory",
    "xuanling-dsh-tools",
    "xuanling-dsh-tools-replace",
    "xuanling-dsh-skills",
  ]) {
    assert.match(source, new RegExp(name));
  }
});

test("promotion is gated on the complete registry set and zcode-packer permission", () => {
  const source = workflow();
  assert.match(source, /stage-zcode-marketplace\.mjs/);
  assert.match(source, /verify-zcode-marketplace\.mjs/);
  assert.match(source, /environment: zcode-packer/);
  assert.match(source, /secrets\.XL_PUBLISH_TOKEN/);
  assert.match(source, /vars\.ZCODE_REPOSITORY/);
  assert.match(source, /umbrella22\/xuanling-zcode-marketplace/);
  assert.match(source, /\.permissions\.push \/\/ false/);
  assert.match(source, /\.default_branch/);
  assert.match(
    source,
    /zcode-prerequisites:[\s\S]*environment: zcode-packer[\s\S]*XL_PUBLISH_TOKEN:[\s\S]*ZCODE_REPOSITORY/,
  );
  assert.match(
    source,
    /build-main:[\s\S]*needs: \[validate-release, npm-prerequisites, zcode-prerequisites\]/,
  );
  const sourcePreflight = source.indexOf("Verify authenticated target repository access");
  const build = source.indexOf("Build locked release binary");
  const publish = source.indexOf("Publish native variants");
  assert.ok(sourcePreflight !== -1 && sourcePreflight < build && build < publish);
  assert.match(
    source,
    /repository: \$\{\{ vars\.ZCODE_REPOSITORY \}\}[\s\S]*path: target[\s\S]*token: \$\{\{ secrets\.XL_PUBLISH_TOKEN \}\}/,
  );
  assert.match(source, /promote-zcode-marketplace\.mjs/);
  assert.match(source, /git -C target push --atomic origin/);
  assert.doesNotMatch(source, /actions\/create-github-app-token@|repository_dispatch|write-zcode-dispatch-payload/);
});

test("target promotion replay is idempotent and rejects tree drift", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "xuanling-promotion-replay-"));
  const incoming = path.join(temporary, "incoming");
  const target = path.join(temporary, "target");
  const sourceCommit = "d".repeat(40);
  const script = path.join(
    repoRoot,
    "npm",
    "scripts",
    "promote-zcode-marketplace.mjs",
  );
  try {
    await cp(path.join(repoRoot, "test", "release", "target-repo-template"), target, {
      recursive: true,
    });
    await mkdir(path.join(incoming, "plugins", "xuanling-mcp"), { recursive: true });
    await writeFile(path.join(incoming, "marketplace.json"), '{"name":"fixture"}\n');
    await writeFile(path.join(incoming, "plugins", "xuanling-mcp", "runtime.txt"), "runtime\n");
    await writeFile(path.join(incoming, "release-manifest.json"), JSON.stringify({
      source_commit: sourceCommit,
      version: "0.2.1",
    }, null, 2));
    const tree = await describeProjection(incoming, { strictRoot: true });
    const baseArgs = [
      script,
      "--incoming", incoming,
      "--target", target,
      "--version", "0.2.1",
      "--source-commit", sourceCommit,
      "--tree-sha256", tree.sha256,
    ];
    execFileSync(process.execPath, [...baseArgs, "--mode", "promote"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    assert.equal((await describeProjection(target)).sha256, tree.sha256);
    execFileSync(process.execPath, [...baseArgs, "--mode", "compare-only"], {
      cwd: repoRoot,
      stdio: "pipe",
    });

    await writeFile(path.join(target, "plugins", "xuanling-mcp", "runtime.txt"), "drift\n");
    assert.throws(() => execFileSync(process.execPath, [...baseArgs, "--mode", "compare-only"], {
      cwd: repoRoot,
      stdio: "pipe",
    }), "an existing immutable tree with drift must be rejected");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});
