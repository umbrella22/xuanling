#!/usr/bin/env node

import { launch } from "../lib/launcher.js";

launch().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`harness-bridge: ${message}`);
  process.exit(1);
});
