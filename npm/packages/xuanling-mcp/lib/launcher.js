import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import path from "node:path";

import { detectTarget } from "./targets.js";

const require = createRequire(import.meta.url);

export function resolveNativeBinary(
  target,
  {
    existsSync = nodeExistsSync,
    readFileSync = nodeReadFileSync,
    resolvePackageJson = (specifier) => require.resolve(specifier),
  } = {},
) {
  let packageJsonPath;
  try {
    packageJsonPath = resolvePackageJson(`${target.alias}/package.json`);
  } catch {
    throw new Error(
      `Missing optional dependency ${target.alias}. Reinstall the current xuanling-mcp package before retrying`,
    );
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const metadata = packageJson.xuanlingBinary;
  if (
    metadata?.target !== target.rustTarget ||
    metadata?.binary !== target.binary ||
    !/^[0-9a-f]{64}$/.test(metadata?.sha256 ?? "")
  ) {
    throw new Error(
      `Installed package ${target.alias} does not match target ${target.rustTarget}`,
    );
  }

  const binaryPath = path.join(path.dirname(packageJsonPath), metadata.binary);
  if (!existsSync(binaryPath)) {
    throw new Error(
      `Native binary is missing from ${target.alias}. Reinstall the current xuanling-mcp package before retrying`,
    );
  }
  const actualSha256 = createHash("sha256")
    .update(readFileSync(binaryPath))
    .digest("hex");
  if (actualSha256 !== metadata.sha256) {
    throw new Error(
      `Native binary checksum mismatch in ${target.alias}. Reinstall the current xuanling-mcp package before retrying`,
    );
  }
  return binaryPath;
}

function exitCodeForSignal(signal) {
  const number = osConstants.signals?.[signal];
  return typeof number === "number" ? 128 + number : 1;
}

export async function launch({
  argv = process.argv.slice(2),
  env = process.env,
  runtime = process,
  spawn = nodeSpawn,
  target = detectTarget(),
  binaryPath = resolveNativeBinary(target),
} = {}) {
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
