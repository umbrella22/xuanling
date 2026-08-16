#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const CANONICAL_TABLES = [
  ["memory_proposals", "proposal_id"],
  ["memory_reviews", "proposal_id"],
  ["memory_record_heads", "record_id"],
  ["memory_record_versions", "record_id, revision"],
  ["memory_record_tags", "record_id, revision, tag"],
  ["memory_feedback_events", "event_id"],
];

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 || index + 1 >= argv.length ? undefined : argv[index + 1];
}

function assertDatabasePath(database) {
  if (typeof database !== "string" || database.length === 0 || !path.isAbsolute(database)) {
    throw new Error("--database must be an absolute path");
  }
  const stats = lstatSync(database);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("database must be a non-symlink regular file");
  }
}

function tableNames(db) {
  return new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
      .all()
      .map((row) => row.name),
  );
}

export function expectedSeedCounts(fixture) {
  return {
    proposals: fixture.records.length,
    reviews: fixture.records.length,
    heads: fixture.records.length,
    versions: fixture.records.length,
    tags: fixture.records.reduce((sum, record) => sum + record.tags.length, 0),
    feedback: 0,
  };
}

export function assertExpectedSeed(snapshot, fixture) {
  const expected = expectedSeedCounts(fixture);
  if (snapshot.schema_version !== "2") {
    throw new Error(`expected schema version 2, got ${JSON.stringify(snapshot.schema_version)}`);
  }
  if (JSON.stringify(snapshot.counts) !== JSON.stringify(expected)) {
    throw new Error(
      `seed canonical counts mismatch: ${JSON.stringify(snapshot.counts)} != ${JSON.stringify(expected)}`,
    );
  }
  const expectedProjection = { unicode61: fixture.records.length, trigram: fixture.records.length };
  if (JSON.stringify(snapshot.projection_rows) !== JSON.stringify(expectedProjection)) {
    throw new Error(
      `seed projection counts mismatch: ${JSON.stringify(snapshot.projection_rows)} != ${JSON.stringify(expectedProjection)}`,
    );
  }
  // WAL/SHM presence is recorded as operational metadata, but a closed
  // temporary WAL database may legitimately retain both sidecar files.
  // Canonical rows and projection counts are the read-only search contract.
}

export function snapshotDatabase(database) {
  assertDatabasePath(database);
  const db = new DatabaseSync(database, { readOnly: true });
  let snapshot;
  try {
    const names = tableNames(db);
    const required = [
      "memory_schema_meta",
      ...CANONICAL_TABLES.map(([name]) => name),
      "memory_fts_v2_unicode",
      "memory_fts_v2_trigram",
    ];
    const missing = required.filter((name) => !names.has(name));
    if (missing.length > 0) {
      throw new Error(`database lacks required Memory v2 tables: ${missing.join(", ")}`);
    }

    const hash = createHash("sha256");
    const rowCounts = {};
    for (const [table, order] of CANONICAL_TABLES) {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
      rowCounts[table] = rows.length;
      const encoded = JSON.stringify(rows);
      hash.update(`${table}\0${Buffer.byteLength(encoded)}\0${encoded}\0`);
    }
    const schema = db
      .prepare("SELECT value FROM memory_schema_meta WHERE key = 'schema_version'")
      .get();
    const projectionRows = {
      unicode61: Number(db.prepare("SELECT COUNT(*) AS count FROM memory_fts_v2_unicode").get().count),
      trigram: Number(db.prepare("SELECT COUNT(*) AS count FROM memory_fts_v2_trigram").get().count),
    };
    snapshot = {
      oracle_version: 1,
      schema_version: schema?.value ?? null,
      counts: {
        proposals: rowCounts.memory_proposals,
        reviews: rowCounts.memory_reviews,
        heads: rowCounts.memory_record_heads,
        versions: rowCounts.memory_record_versions,
        tags: rowCounts.memory_record_tags,
        feedback: rowCounts.memory_feedback_events,
      },
      projection_rows: projectionRows,
      canonical_sha256: hash.digest("hex"),
    };
  } finally {
    db.close();
  }
  return {
    ...snapshot,
    wal_present: existsSync(`${database}-wal`),
    shm_present: existsSync(`${database}-shm`),
  };
}

const isCli = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  try {
    const database = argValue(process.argv.slice(2), "--database");
    if (database === undefined) throw new Error("--database <absolute path> is required");
    process.stdout.write(`${JSON.stringify(snapshotDatabase(database))}\n`);
  } catch (error) {
    console.error(`sqlite-oracle: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
