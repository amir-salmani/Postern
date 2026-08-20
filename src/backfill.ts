import { ingest } from "./inbound";
import type { Env } from "./types";

export interface BackfillResult {
  imported: number;
  skipped: number;
  tombstoned: number;
  failed: string[];
}

/**
 * Pull anything Resend is holding that we don't have.
 *
 * Resend stores received mail whether or not the webhook succeeded and
 * retries on failure, so this is the recovery path for any window where the
 * endpoint was down or unreachable.
 *
 * Messages you deleted are skipped via the tombstone table. Without that,
 * every sync would restore them — Resend keeps its copy for 30 days and has
 * no idea you threw ours away.
 */
export async function runBackfill(env: Env): Promise<BackfillResult> {
  const result: BackfillResult = { imported: 0, skipped: 0, tombstoned: 0, failed: [] };
  if (!env.RESEND_API_KEY) return result;

  const response = await fetch("https://api.resend.com/emails/receiving", {
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
  });
  if (!response.ok) throw new Error(`Resend returned ${response.status}`);

  const list = (await response.json()) as { data?: Array<{ id: string }> };

  for (const item of list.data ?? []) {
    const [existing, tombstone] = await Promise.all([
      env.DB.prepare(`SELECT 1 FROM messages WHERE id = ? LIMIT 1`).bind(item.id).first(),
      env.DB.prepare(`SELECT 1 FROM tombstones WHERE id = ? LIMIT 1`).bind(item.id).first(),
    ]);
    if (tombstone) { result.tombstoned += 1; continue; }
    if (existing) { result.skipped += 1; continue; }

    try {
      await ingest(env, item.id);
      result.imported += 1;
    } catch (err) {
      console.error("postern: backfill failed for", item.id, err);
      result.failed.push(item.id);
    }
  }

  return result;
}
