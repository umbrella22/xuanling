import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
export function bridgeConfig(root, extra = {}) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const command = join(repo, "target", "debug", `harness-bridge${suffix}`);
  const worker = join(repo, "target", "debug", `harness-bridge-fake-worker${suffix}`);
  assert.ok(
    existsSync(command) && existsSync(worker),
    "build prerequisites: cargo build -p xuanling-harness-bridge --bins",
  );
  const configPath = join(root, "bridge.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaces: { test: root },
      adapters: { codex: { program: worker, version: "0.165.0", sandbox: "read-only" } },
      ...extra,
    }),
  );
  return { command, configPath, adapter: "codex", workspaceId: "test" };
}
