#!/usr/bin/env bash
# Real-Linux platform evidence (plan §7 R07 / W7.2): run the platform suite
# inside an actual Linux container against the mounted checkout. No
# cross-platform inference: this produces its own uname/os-release evidence.
set -euo pipefail
echo "=== linux identity ==="
uname -a
cat /etc/os-release | head -3
node --version
echo "=== platform suite ==="
cd /workspace/integrations/deepseek-harness/xuanling-blueprint
node scripts/verify.mjs --suite platform
echo "=== plain-node platform probe (no dsh install needed) ==="
node -e "
const { execFileSync } = require('node:child_process')
console.log('platform:', process.platform, process.arch)
console.log('no symlink creation check:')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-linux-'))
const target = path.join(dir, 'target'); fs.mkdirSync(target)
fs.writeFileSync(path.join(target, 'SKILL.md'), 'x')
// resolution must not create links even where symlink() is permitted
const { symlinkSync } = fs
let links = 0
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isSymbolicLink()) links++ ; else if (e.isDirectory()) walk(path.join(d, e.name)) } }
walk(dir)
console.log('links created:', links)
process.exit(links === 0 ? 0 : 1)
"
