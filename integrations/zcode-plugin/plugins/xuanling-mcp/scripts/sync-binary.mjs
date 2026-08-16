#!/usr/bin/env node
// Copy the built native binary + Node launcher from the repo's npm/dist into
// this plugin's bin/node_modules so the plugin directory is self-contained
// (plan W8.6).
//
// The repo root is derived from THIS script's own path — never a hardcoded
// checkout path, and this script never writes the ZCode plugin cache
// (~/.zcode/cli/plugins/cache). Staging happens inside the repo plugin
// directory; the marketplace install sync is a separate, explicitly
// authorized step (plan W8.11).
//
// Usage:
//   node scripts/sync-binary.mjs                        # auto-detect platform
//   node scripts/sync-binary.mjs --source <node_modules-path>
//   node scripts/sync-binary.mjs --binary <native-binary-path>

import { existsSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> plugins/xuanling-mcp -> plugins -> zcode-plugin -> integrations -> repo
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(PLUGIN_ROOT, "..", "..", "..", "..");
const TARGET = path.join(PLUGIN_ROOT, "bin", "node_modules");

// Map host platform -> npm platform suffix used by npm/dist/<suffix>/.
function platformSuffix() {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64-gnu";
  if (platform === "win32" && arch === "x64") return "win32-x64-msvc";
  throw new Error(
    `Unsupported platform ${platform}-${arch}. Build the binary for this host first.`,
  );
}

function resolveSource() {
  const explicit = arg("source");
  if (explicit) return path.resolve(explicit);
  const suffix = platformSuffix();
  const candidate = path.join(
    REPO_ROOT,
    "npm",
    "dist",
    suffix,
    "install-final",
    "node_modules",
  );
  if (!existsSync(candidate)) {
    throw new Error(
      `staged npm package not found at ${candidate}; run the release staging ` +
        `(cargo build --release + npm release scripts) first`,
    );
  }
  return candidate;
}

const source = resolveSource();
if (!existsSync(source)) {
  throw new Error(`source does not exist: ${source}`);
}
rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });
cpSync(source, TARGET, { recursive: true });
for (const relative of [
  ".package-lock.json",
  "xuanling-mcp/README.md",
  "xuanling-mcp/README-ZH.md",
]) {
  rmSync(path.join(TARGET, relative), { force: true });
}
console.log(`synced ${source} -> ${TARGET}`);
