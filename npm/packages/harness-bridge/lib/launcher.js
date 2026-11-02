import { spawn as nodeSpawn } from "node:child_process";
import {
  chmodSync as nodeChmodSync,
  existsSync as nodeExistsSync,
  readFileSync as nodeReadFileSync,
  statSync as nodeStatSync,
} from "node:fs";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectTarget } from "./targets.js";

const require = createRequire(import.meta.url);
// This file lives at <repo>/npm/packages/harness-bridge/lib/launcher.js.
const launcherRoot = path.resolve(fileURLToPath(import.meta.url), "../../../../..");

function findRepoRoot(start, exists) {
  let directory = path.resolve(start);
  for (;;) {
    if (
      exists(path.join(directory, "Cargo.toml")) &&
      exists(path.join(directory, "crates", "xuanling-harness-bridge", "Cargo.toml"))
    ) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * Resolve the harness-bridge executable without invoking a shell.
 *
 * Order: explicit HARNESS_BRIDGE_BIN, an installed platform package, a local
 * Cargo build (target/release before target/debug), then PATH. The resolved
 * path is always an existing file.
 */
export function resolveBinary({
  env = process.env,
  cwd = process.cwd(),
  target = detectTarget(),
  existsSync: exists = nodeExistsSync,
  readFileSync: read = nodeReadFileSync,
  resolvePackageJson = (specifier) => require.resolve(specifier),
  repoRoots = [cwd, launcherRoot],
} = {}) {
  const binaryName = target.os === "win32" ? "harness-bridge.exe" : "harness-bridge";

  const override = env.HARNESS_BRIDGE_BIN;
  if (override) {
    const resolved = path.isAbsolute(override) ? override : path.resolve(cwd, override);
    if (exists(resolved)) return resolved;
    throw new Error(`HARNESS_BRIDGE_BIN does not exist: ${resolved}`);
  }

  // Published platform packages ship the binary with target metadata.
  try {
    const packageJsonPath = resolvePackageJson(`${target.alias}/package.json`);
    const packageJson = JSON.parse(read(packageJsonPath, "utf8"));
    const metadata = packageJson.harnessBridgeBinary ?? packageJson.xuanlingBinary;
    if (metadata?.target === target.rustTarget && typeof metadata?.binary === "string") {
      const binaryPath = path.join(path.dirname(packageJsonPath), metadata.binary);
      if (exists(binaryPath)) return binaryPath;
    }
  } catch {
    // No platform package is installed; continue with local and PATH lookup.
  }

  for (const root of repoRoots.filter(Boolean)) {
    const repoRoot = findRepoRoot(root, exists);
    if (!repoRoot) continue;
    const candidates = [];
    if (env.CARGO_TARGET_DIR) {
      candidates.push(path.join(env.CARGO_TARGET_DIR, "release", binaryName));
      candidates.push(path.join(env.CARGO_TARGET_DIR, "debug", binaryName));
    }
    candidates.push(path.join(repoRoot, "target", "release", binaryName));
    candidates.push(path.join(repoRoot, "target", "debug", binaryName));
    for (const candidate of candidates) {
      if (exists(candidate)) return candidate;
    }
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, binaryName);
    if (exists(candidate)) return candidate;
  }

  throw new Error(
    "Cannot find the harness-bridge binary. Set HARNESS_BRIDGE_BIN to its absolute path, run " +
      "`cargo build -p xuanling-harness-bridge` (target/release or target/debug), install a " +
      "platform package, or add harness-bridge to PATH.",
  );
}

function exitCodeForSignal(signal) {
  const number = osConstants.signals?.[signal];
  return typeof number === "number" ? 128 + number : 1;
}

// Some plugin-cache transports strip the executable bit; spawn would fail with
// EACCES. Restore it when possible.
async function ensureExecutable(binaryPath, { chmod, runtime, stat }) {
  if (runtime.platform === "win32") return;
  let info;
  try {
    info = stat(binaryPath);
  } catch {
    return;
  }
  if ((info.mode & 0o111) !== 0) return;
  const mode = info.mode | 0o111;
  try {
    await chmod(binaryPath, mode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Native binary at ${binaryPath} is not executable and the permission could not be restored: ${message}`,
    );
  }
}

export async function launch({
  argv = process.argv.slice(2),
  env = process.env,
  runtime = process,
  spawn = nodeSpawn,
  stat = nodeStatSync,
  chmod = nodeChmodSync,
  target = detectTarget(),
  binaryPath = resolveBinary({ env, cwd: process.cwd(), target }),
} = {}) {
  await ensureExecutable(binaryPath, { chmod, runtime, stat });

  const child = spawn(binaryPath, argv, {
    env,
    stdio: "inherit",
    windowsHide: true,
  });

  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      if (!child.killed) {
        try {
          child.kill(signal);
        } catch {
          // A concurrent child exit can make signal forwarding fail.
        }
      }
    };
    signalHandlers.set(signal, handler);
    runtime.on(signal, handler);
  }

  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        resolve(signal ? { signal } : { code: code ?? 1 });
      });
    });
  } catch (error) {
    for (const [signal, handler] of signalHandlers) {
      runtime.removeListener(signal, handler);
    }
    throw error;
  }

  for (const [signal, handler] of signalHandlers) {
    runtime.removeListener(signal, handler);
  }

  if (result.signal) {
    if (runtime.platform === "win32") {
      runtime.exit(exitCodeForSignal(result.signal));
      return;
    }
    runtime.kill(runtime.pid, result.signal);
    return;
  }
  runtime.exit(result.code);
}
