import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TARGETS, expectedOptionalDependencies } from "../packages/harness-bridge/lib/targets.js";
import { readWorkspaceVersion, run } from "../scripts/shared.mjs";

test("Bridge release tarballs preserve binaries, source identity and exact platform dependencies", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bridge-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceCommit = "1".repeat(40);
  const version = await readWorkspaceVersion();
  const binary = path.join(directory, "fixture-binary");
  const bytes = Buffer.from("native-fixture\0binary\xff", "latin1");
  const notices = path.join(directory, "notices.txt");
  await writeFile(binary, bytes);
  await writeFile(notices, "Fixture license\n");

  for (const target of [undefined, ...Object.values(TARGETS)]) {
    const output = path.join(directory, target?.id ?? "main");
    await run("node", [
      "npm/scripts/pack-harness-bridge.mjs", "--out", output, "--commit", sourceCommit,
      ...(target ? ["--target", target.id, "--binary", binary, "--notices", notices] : []),
    ]);
    const pack = JSON.parse(await readFile(path.join(output, "pack", `${target?.id ?? "main"}.pack.json`), "utf8"));
    const tarball = path.join(output, "pack", pack.filename);
    const archive = await readFile(tarball);
    assert.equal(pack.integrity, `sha512-${createHash("sha512").update(archive).digest("base64")}`);
    const { stdout } = await run("tar", ["-xOf", tarball, "package/package.json"]);
    const manifest = JSON.parse(stdout);
    assert.equal(manifest.name, target?.packageName ?? "@xuanling-rs/harness-bridge");
    assert.equal(manifest.version, target ? `${version}-${target.id}` : version);
    if (target) {
      assert.deepEqual(manifest.os, [target.os]);
      assert.deepEqual(manifest.cpu, [target.cpu]);
      assert.deepEqual(manifest.libc, target.libc ? [target.libc] : undefined);
      assert.equal(manifest.harnessBridgeBinary.sourceCommit, sourceCommit);
      assert.equal(manifest.harnessBridgeBinary.target, target.rustTarget);
      assert.equal(manifest.harnessBridgeBinary.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.deepEqual(await readFile(path.join(output, "package", target.binary)), bytes);
    } else {
      assert.equal(manifest.xuanlingRelease.sourceCommit, sourceCommit);
      assert.deepEqual(manifest.optionalDependencies, expectedOptionalDependencies(version));
    }
  }
});
