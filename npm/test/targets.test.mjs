import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { launch, resolveNativeBinary } from "../packages/xuanling-mcp/lib/launcher.js";
import {
  TARGETS,
  detectTarget,
  expectedOptionalDependencies,
  platformVersion,
} from "../packages/xuanling-mcp/lib/targets.js";

const glibcReport = { getReport: () => ({ header: { glibcVersionRuntime: "2.39" } }) };
const oldGlibcReport = { getReport: () => ({ header: { glibcVersionRuntime: "2.34" } }) };
const muslReport = { getReport: () => ({ header: {} }) };

test("target selection distinguishes OS, CPU, and libc", () => {
  assert.equal(
    detectTarget({ platform: "darwin", arch: "arm64" }).id,
    "darwin-arm64",
  );
  assert.equal(
    detectTarget({ platform: "win32", arch: "x64" }).id,
    "win32-x64-msvc",
  );
  assert.equal(
    detectTarget({ platform: "linux", arch: "x64", report: glibcReport }).id,
    "linux-x64-gnu",
  );
  assert.throws(
    () => detectTarget({ platform: "linux", arch: "x64", report: muslReport }),
    /not musl/,
  );
  assert.throws(
    () => detectTarget({ platform: "linux", arch: "x64", report: oldGlibcReport }),
    /requires glibc 2\.35 or newer/,
  );
  assert.throws(
    () => detectTarget({ platform: "darwin", arch: "x64" }),
    /Unsupported platform/,
  );
});

test("platform versions and aliases are deterministic", () => {
  assert.equal(platformVersion("0.1.0", "darwin-arm64"), "0.1.0-darwin-arm64");
  assert.deepEqual(expectedOptionalDependencies("0.1.0"), {
    "xuanling-mcp-darwin-arm64": "npm:@xuanling-rs/xuanling-mcp-darwin-arm64@0.1.0-darwin-arm64",
    "xuanling-mcp-linux-x64-gnu": "npm:@xuanling-rs/xuanling-mcp-linux-x64-gnu@0.1.0-linux-x64-gnu",
    "xuanling-mcp-win32-x64-msvc": "npm:@xuanling-rs/xuanling-mcp-win32-x64-msvc@0.1.0-win32-x64-msvc",
  });
  assert.throws(() => platformVersion("0.1.0-beta.1", "darwin-arm64"), /stable semver/);
});

test("native resolver validates target metadata and binary checksum", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xuanling-launcher-test-"));
  try {
    const fixture = "native fixture";
    const binaryPath = path.join(directory, "xuanling-mcp");
    const packageJsonPath = path.join(directory, "package.json");
    await writeFile(binaryPath, fixture);
    await writeFile(
      packageJsonPath,
      JSON.stringify({
        xuanlingBinary: {
          binary: "xuanling-mcp",
          sha256: createHash("sha256").update(fixture).digest("hex"),
          target: "fixture-target",
        },
      }),
    );
    const target = { alias: "fixture-package", binary: "xuanling-mcp", rustTarget: "fixture-target" };
    assert.equal(
      resolveNativeBinary(target, { resolvePackageJson: () => packageJsonPath }),
      binaryPath,
    );

    await writeFile(binaryPath, "corrupted fixture");
    assert.throws(
      () => resolveNativeBinary(target, { resolvePackageJson: () => packageJsonPath }),
      /checksum mismatch/,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("launcher forwards argv and child exit status", async () => {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  const runtime = new EventEmitter();
  runtime.platform = "darwin";
  runtime.pid = 123;
  runtime.exit = (code) => {
    runtime.exitCode = code;
  };
  runtime.kill = () => assert.fail("runtime should not be killed for a numeric exit");
  let invocation;
  const spawn = (command, argv, options) => {
    invocation = { command, argv, options };
    queueMicrotask(() => child.emit("exit", 17, null));
    return child;
  };

  await launch({
    argv: ["--version"],
    binaryPath: "/fixture/xuanling-mcp",
    runtime,
    spawn,
    target: TARGETS["darwin-arm64"],
  });
  assert.equal(invocation.command, "/fixture/xuanling-mcp");
  assert.deepEqual(invocation.argv, ["--version"]);
  assert.equal(invocation.options.stdio, "inherit");
  assert.equal(runtime.exitCode, 17);
  assert.equal(runtime.listenerCount("SIGINT"), 0);
});

test("launcher removes signal handlers when spawning fails", async () => {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    throw new Error("child already exited");
  };
  const runtime = new EventEmitter();
  runtime.platform = "darwin";
  runtime.pid = 123;
  runtime.exit = () => assert.fail("runtime should not exit for a spawn error");
  runtime.kill = () => assert.fail("runtime should not be killed for a spawn error");
  const spawnError = new Error("spawn failed");
  const spawn = () => {
    queueMicrotask(() => child.emit("error", spawnError));
    return child;
  };

  await assert.rejects(
    launch({
      binaryPath: "/fixture/xuanling-mcp",
      runtime,
      spawn,
      target: TARGETS["darwin-arm64"],
    }),
    spawnError,
  );
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(runtime.listenerCount(signal), 0);
  }
});

function chmodRuntime(platform = "darwin") {
  const runtime = new EventEmitter();
  runtime.platform = platform;
  runtime.pid = 123;
  runtime.exit = (code) => {
    runtime.exitCode = code;
  };
  return runtime;
}

test("launcher restores a missing executable bit before spawning", async () => {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => {};
  const runtime = chmodRuntime();
  let spawnCount = 0;
  const spawn = (command) => {
    spawnCount += 1;
    assert.equal(command, "/fixture/xuanling-mcp");
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const chmodCalls = [];
  const stat = () => ({ mode: 0o100644 });

  await launch({
    binaryPath: "/fixture/xuanling-mcp",
    chmod: (binaryPath, mode) => chmodCalls.push({ binaryPath, mode }),
    runtime,
    spawn,
    stat,
    target: TARGETS["darwin-arm64"],
  });

  assert.deepEqual(chmodCalls, [
    { binaryPath: "/fixture/xuanling-mcp", mode: 0o100755 },
  ]);
  assert.equal(spawnCount, 1);
});

test("launcher leaves an executable binary and win32 payloads untouched", async () => {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => {};
  const spawn = () => {
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const chmod = () => assert.fail("chmod must not run when the bit is present or the platform is win32");

  for (const { platform, mode } of [
    { platform: "darwin", mode: 0o100755 },
    { platform: "linux", mode: 0o100711 },
    { platform: "win32", mode: 0o100644 },
  ]) {
    await launch({
      binaryPath: "/fixture/xuanling-mcp",
      chmod,
      runtime: chmodRuntime(platform),
      spawn,
      stat: () => ({ mode }),
      target: TARGETS["darwin-arm64"],
    });
  }
});

test("launcher surfaces a clear error when the executable bit cannot be restored", async () => {
  const runtime = chmodRuntime();
  const spawn = () => assert.fail("spawn must not run when chmod fails");
  const chmod = () => Promise.reject(Object.assign(new Error("EACCES: permission denied"), {
    code: "EACCES",
  }));

  await assert.rejects(
    launch({
      binaryPath: "/fixture/xuanling-mcp",
      chmod,
      runtime,
      spawn,
      stat: () => ({ mode: 0o100644 }),
      target: TARGETS["darwin-arm64"],
    }),
    /is not executable and the permission could not be restored: EACCES/,
  );
});

test("launcher falls through to spawn when the binary cannot be stat'ed", async () => {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => {};
  const runtime = chmodRuntime();
  let spawnCount = 0;
  const spawn = () => {
    spawnCount += 1;
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const stat = () => {
    throw new Error("ENOENT: no such file or directory");
  };

  await launch({
    binaryPath: "/fixture/xuanling-mcp",
    chmod: () => assert.fail("chmod must not run when stat fails"),
    runtime,
    spawn,
    stat,
    target: TARGETS["darwin-arm64"],
  });

  assert.equal(spawnCount, 1);
});
