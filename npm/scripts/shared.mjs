import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const here = path.dirname(fileURLToPath(import.meta.url));

export const NPM_ROOT = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(NPM_ROOT, "..");
export const MAIN_PACKAGE_DIR = path.join(NPM_ROOT, "packages", "xuanling-mcp");

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function readWorkspaceVersion() {
  const cargoToml = await readFile(path.join(REPO_ROOT, "Cargo.toml"), "utf8");
  const workspacePackage = cargoToml.match(
    /\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/,
  )?.[1];
  const version = workspacePackage?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) {
    throw new Error("Cargo.toml is missing [workspace.package].version");
  }
  return version;
}

export async function readWorkspaceLicense() {
  const cargoToml = await readFile(path.join(REPO_ROOT, "Cargo.toml"), "utf8");
  const workspacePackage = cargoToml.match(
    /\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/,
  )?.[1];
  const license = workspacePackage?.match(/^license\s*=\s*"([^"]+)"/m)?.[1];
  if (!license) {
    throw new Error("Cargo.toml is missing [workspace.package].license");
  }
  return license;
}

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${argument}`);
    }
    const separator = argument.indexOf("=");
    if (separator !== -1) {
      result[argument.slice(2, separator)] = argument.slice(separator + 1);
      continue;
    }
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      result[name] = true;
      continue;
    }
    result[name] = value;
    index += 1;
  }
  return result;
}

export function requiredArg(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required --${name} value`);
  }
  return value;
}

export async function sha256File(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

export function resolveCommandForPlatform(command, platform = process.platform, options = {}) {
  if (platform !== "win32" || command !== "npm") {
    return { command, argsPrefix: [] };
  }

  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const exists = options.exists ?? existsSync;
  const candidates = [];
  if (typeof env.npm_execpath === "string" && env.npm_execpath.length > 0) {
    candidates.push(env.npm_execpath);
  }
  candidates.push(
    path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  );
  const searchPath = env.Path ?? env.PATH ?? env.path ?? "";
  for (const entry of searchPath.split(path.win32.delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (directory.length > 0) {
      candidates.push(path.win32.join(directory, "node_modules", "npm", "bin", "npm-cli.js"));
    }
  }
  const npmCliPath = options.npmCliPath ?? candidates.find((candidate) => exists(candidate));
  if (typeof npmCliPath !== "string" || npmCliPath.length === 0 || !exists(npmCliPath)) {
    throw new Error("Unable to locate npm-cli.js for direct execution on Windows");
  }
  return { command: execPath, argsPrefix: [npmCliPath] };
}

export async function run(command, args, options = {}) {
  try {
    const resolved = resolveCommandForPlatform(command);
    return await execFile(resolved.command, [...resolved.argsPrefix, ...args], {
      cwd: options.cwd ?? REPO_ROOT,
      encoding: "utf8",
      env: options.env ?? process.env,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    });
  } catch (error) {
    if (options.allowFailure) {
      return {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        exitCode: error.code ?? 1,
      };
    }
    throw error;
  }
}

export async function currentCommit() {
  const { stdout } = await run("git", ["rev-parse", "HEAD"]);
  return stdout.trim();
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
