#!/usr/bin/env node
/**
 * Restore a Postern backup into a D1 database.
 *
 *   node scripts/restore.mjs backups/2026-09-04.ndjson postern-restore-test
 *
 * Backups are NDJSON — one {table, row} per line — so a restore streams
 * rather than parsing the whole snapshot at once.
 *
 * Point this at a scratch database, not your live one. The whole purpose of
 * the exercise is to find out whether the snapshot is real, and you cannot
 * learn that by overwriting the thing you would need if it isn't.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [key, database] = process.argv.slice(2);
if (!key || !database) {
  console.error("usage: restore.mjs <r2-key> <d1-database-name>");
  process.exit(1);
}

const run = (args) =>
  execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

console.log(`Fetching ${key} …`);
run(["r2", "object", "get", `postern-raw/${key}`, "--remote", "--file=/tmp/postern-restore.ndjson"]);

const lines = readFileSync("/tmp/postern-restore.ndjson", "utf8").split("\n").filter(Boolean);
console.log(`${lines.length} rows in snapshot`);

const byTable = new Map();
for (const line of lines) {
  const { table, row } = JSON.parse(line);
  if (!byTable.has(table)) byTable.set(table, []);
  byTable.get(table).push(row);
}

const quote = (v) =>
  v === null || v === undefined ? "NULL"
  : typeof v === "number" ? String(v)
  : `'${String(v).replaceAll("'", "''")}'`;

const statements = [];
for (const [table, rows] of byTable) {
  for (const row of rows) {
    const cols = Object.keys(row);
    statements.push(
      `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => quote(row[c])).join(", ")});`,
    );
  }
  console.log(`  ${table}: ${rows.length}`);
}

writeFileSync("/tmp/postern-restore.sql", statements.join("\n"));
console.log(`Applying ${statements.length} statements to ${database} …`);
run(["d1", "execute", database, "--remote", "--yes", "--file=/tmp/postern-restore.sql"]);

// The full-text index is derived, not backed up — rebuild it from what we
// just loaded, or search would silently return nothing after a restore.
console.log("Rebuilding the search index …");
run(["d1", "execute", database, "--remote", "--yes", "--command",
  "DELETE FROM messages_fts; INSERT INTO messages_fts (id, subject, sender, body) " +
  "SELECT id, COALESCE(subject,''), COALESCE(header_from,'')||' '||envelope_from, '' FROM messages"]);

// Report what landed, rather than trusting that the apply succeeded.
for (const table of byTable.keys()) {
  const out = run(["d1", "execute", database, "--remote", "--yes", "--command", `SELECT COUNT(*) AS n FROM ${table}`]);
  const n = out.match(/"n":\s*(\d+)/)?.[1] ?? "?";
  const expected = byTable.get(table).length;
  console.log(`  ${table}: ${n} restored, ${expected} expected ${n === String(expected) ? "✓" : "✗"}`);
}
