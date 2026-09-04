import { readSettings, writeSettings } from "./settings";
import type { Env } from "./types";

const DAY_MS = 86_400_000;
const KEEP_DAYS = 30;

/**
 * Daily snapshot of the database into R2.
 *
 * The .eml bodies are already objects in R2, but everything that makes them a
 * mailbox — folders, read state, rules, threading, the tombstones that stop
 * deleted mail returning — lives only in D1. Losing that would leave a bucket
 * of anonymous files.
 *
 * Written as NDJSON so a restore can stream it rather than parse megabytes of
 * JSON in a Worker.
 *
 * messages_fts is deliberately excluded: it is an index derived from
 * messages, and restoring it row by row would be slower and more fragile than
 * rebuilding it. scripts/restore.mjs rebuilds it after loading.
 */
export async function maybeBackup(env: Env): Promise<void> {
  const settings = await readSettings(env);
  const last = Number(settings["backup.last_ms"] ?? 0);
  if (Date.now() - last < DAY_MS) return;

  const stamp = new Date().toISOString().slice(0, 10);
  // events was missing here until a restore into a scratch database showed it
  // absent. It holds every delivery, bounce and complaint, which is what the
  // delivery marks read — losing it would leave sent mail with no history.
  const tables = ["messages", "attachments", "rules", "tombstones", "settings",
                  "autoreplies", "events"];
  const lines: string[] = [];

  for (const table of tables) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
    for (const row of results ?? []) {
      lines.push(JSON.stringify({ table, row }));
    }
  }

  await env.RAW.put(`backups/${stamp}.ndjson`, lines.join("\n"), {
    httpMetadata: { contentType: "application/x-ndjson" },
    customMetadata: { rows: String(lines.length), created: new Date().toISOString() },
  });

  await writeSettings(env, { "backup.last_ms": String(Date.now()) });
  console.log(`postern: backed up ${lines.length} rows to backups/${stamp}.ndjson`);

  await prune(env);
}

/** Keep a month. An unbounded backup directory is a slow storage leak. */
async function prune(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
  const listed = await env.RAW.list({ prefix: "backups/" });
  for (const object of listed.objects) {
    const day = object.key.slice("backups/".length, "backups/".length + 10);
    if (day && day < cutoff) await env.RAW.delete(object.key);
  }
}
