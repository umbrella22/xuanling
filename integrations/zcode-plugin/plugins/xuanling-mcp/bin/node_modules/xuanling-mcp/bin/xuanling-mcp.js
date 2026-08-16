#!/usr/bin/env node

import { launch } from "../lib/launcher.js";

launch().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`xuanling-mcp: ${message}`);
  process.exit(1);
});
