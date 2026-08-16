#!/usr/bin/env node
// Zero-dependency documentation gate for this repository.
//
// Checks, over tracked and untracked non-ignored markdown files, plus
// everything under docs/:
//   1. every relative markdown link resolves to an existing repo file;
//   2. code fences are balanced in every checked markdown file;
//   3. docs/**.md contains no TODO/TBD/FIXME/XXX placeholders;
//   4. every docs/<...>.md path mentioned anywhere points at an existing file
//      (catches links to legacy documents removed with the docs rebuild).
//
// Exits nonzero on the first category with violations, printing one line per
// finding.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const docsDir = path.join(repoRoot, "docs");

function fail(message) {
  console.error(`check-docs: ${message}`);
  process.exitCode = 1;
}

function trackedMarkdownFiles() {
  const output = execFileSync("git", ["ls-files", "*.md"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => path.join(repoRoot, line))
    .filter((file) => existsSync(file));
}

function untrackedMarkdownFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", ":(glob)**/*.md"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => path.join(repoRoot, line));
}

function docsMarkdownFiles() {
  // docs/ may contain files that are not tracked yet (fresh rebuild), so walk it
  // directly instead of relying on git.
  const found = [];
  const walk = (dir) => {
    for (const entry of execFileSync("ls", [dir], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)) {
      const full = path.join(dir, entry);
      if (/\.md$/.test(full)) {
        found.push(full);
      }
    }
  };
  if (existsSync(docsDir)) {
    for (const entry of execFileSync("find", [docsDir, "-type", "d"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)) {
      walk(entry);
    }
  }
  return found;
}

const checkedFiles = [
  ...new Set([
    ...trackedMarkdownFiles(),
    ...untrackedMarkdownFiles(),
    ...docsMarkdownFiles(),
  ]),
];

const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const docPathPattern = /docs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md/g;
const placeholderPattern = /\b(?:TODO|TBD|FIXME|XXX)\b/;
const externalPrefix = /^(?:[a-z][a-z0-9+.-]*:|#)/i;

for (const file of checkedFiles) {
  const relative = path.relative(repoRoot, file);
  const isFixtureInput = relative.split(path.sep).includes("fixtures");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    fail(`${relative}: unreadable`);
    continue;
  }

  // 1. Relative markdown links must resolve.
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1];
    if (externalPrefix.test(target)) {
      continue;
    }
    const withoutAnchor = target.split("#")[0];
    if (withoutAnchor.length === 0) {
      continue;
    }
    const resolved = path.resolve(path.dirname(file), withoutAnchor);
    if (!existsSync(resolved)) {
      fail(`${relative}: broken link -> ${target}`);
    }
  }

  // 2. Balanced code fences.
  const fenceCount = (text.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 !== 0) {
    fail(`${relative}: unbalanced code fences (${fenceCount})`);
  }

  // 5. Table structure (plan W7.5, C-12): outside code fences, every table
  // delimiter row must sit directly under a header row and carry the same
  // number of unescaped-pipe columns, and every body row in the block must
  // match too. An unescaped `|` inside a cell (e.g. a code span) inflates the
  // row's column count; a cell pipe must be escaped as `\|`.
  const lines = text.split("\n");
  let inFence = false;
  const columnCount = (line) => {
    const pipes = (line.match(/(?<!\\)\|/g) ?? []).length;
    return pipes === 0 ? 0 : pipes + 1;
  };
  const isDelimiterRow = (line) => {
    // Only rows that contain a pipe can delimit a table here — a bare `---`
    // line is a setext underline or horizontal rule, not a table delimiter.
    if (!line.includes("|") || !line.includes("-")) {
      return false;
    }
    let cells = line.trim();
    if (cells.startsWith("|")) cells = cells.slice(1);
    if (cells.endsWith("|")) cells = cells.slice(0, -1);
    return cells
      .split("|")
      .map((cell) => cell.trim())
      .every((cell) => /^:?-{1,}:?$/.test(cell));
  };
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*```/.test(lines[index])) {
      inFence = !inFence;
      continue;
    }
    if (inFence || columnCount(lines[index]) === 0) {
      continue;
    }
    if (index + 1 >= lines.length || !isDelimiterRow(lines[index + 1])) {
      continue;
    }
    const headerColumns = columnCount(lines[index]);
    const delimiterColumns = columnCount(lines[index + 1]);
    if (delimiterColumns !== headerColumns) {
      fail(
        `${relative}:${index + 1}: table delimiter has ${delimiterColumns} columns, ` +
          `header has ${headerColumns}`,
      );
    }
    let row = index + 2;
    while (row < lines.length && columnCount(lines[row]) > 0) {
      const columns = columnCount(lines[row]);
      if (columns !== headerColumns) {
        fail(
          `${relative}:${row + 1}: table row has ${columns} columns, ` +
            `header has ${headerColumns}`,
        );
      }
      row += 1;
    }
    index = row - 1;
  }

  // 3. No placeholders inside docs/.
  if (file.startsWith(docsDir) && placeholderPattern.test(text)) {
    fail(`${relative}: contains a TODO/TBD/FIXME/XXX placeholder`);
  }

  // 4. Any docs/<...>.md path referenced outside test fixtures must exist in
  // the repo. Fixture markdown describes a copied workspace, where docs/ is
  // relative to the fixture root rather than this repository root.
  if (!isFixtureInput) {
    for (const match of text.matchAll(docPathPattern)) {
      const referenced = path.join(repoRoot, match[0]);
      if (!existsSync(referenced)) {
        fail(`${relative}: references missing doc path ${match[0]}`);
      }
    }
  }
}

if (process.exitCode) {
  console.error("check-docs: FAILED");
} else {
  console.log(
    `check-docs: OK (${checkedFiles.length} markdown files checked)`,
  );
}
