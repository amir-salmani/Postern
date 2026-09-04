import { runBackfill } from "./backfill";
import { maybeBackup } from "./backup";
import { maySend, readQuota } from "./quota";
import { getSender } from "./senders";
import type { Env } from "./types";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * Minimum gap between digests. Without it, a batch arriving over ten minutes
 * crosses the six-hour line across several cron ticks and produces a separate
 * email for each — which is what happened on 22 Aug at 05:30 and 06:00.
 */
const REMINDER_COOLDOWN_MS = 4 * 60 * 60 * 1000;

/**
 * The scheduled run: fetch, then consider a nudge.
 *
 * One cron does both so the whole thing costs 48 invocations a day rather
 * than two crons' worth. Fetching every 30 minutes means the mailbox is
 * current without the browser polling for it.
 */
export async function handleScheduled(env: Env): Promise<void> {
  try {
    const result = await runBackfill(env);
    if (result.imported) console.log(`postern: scheduled fetch imported ${result.imported}`);
  } catch (err) {
    console.error("postern: scheduled fetch failed", err);
  }
  await maybeBackup(env);
  await purgeExpiredTrash(env);
  await drainUnforwarded(env);
  await remindUnread(env);
}

/** Paced so a burst can't trip Resend's per-second limit. */
const FORWARD_BATCH = 12;

/**
 * Deliver anything that was stored but never forwarded.
 *
 * A forward can fail for reasons that have nothing to do with the message —
 * a bad deploy, a spent allowance, an API blip. Without a sweep, that mail is
 * simply never seen again, because nothing else ever revisits it. This makes
 * the safety net self-healing rather than best-effort at ingest time.
 */
async function drainUnforwarded(env: Env): Promise<void> {
  if (!env.FORWARD_TO || (env.FORWARD_MODE ?? "all").toLowerCase() === "off") return;

  const { results } = await env.DB.prepare(
    `SELECT id FROM messages
      WHERE forwarded_ms IS NULL AND folder IN ('inbox', 'quarantine')
      ORDER BY received_ms ASC
      LIMIT ?`,
  )
    .bind(FORWARD_BATCH)
    .all();

  const pending = (results ?? []) as Array<{ id: string }>;
  if (!pending.length) return;

  // Forwarding keeps its own reserve: it is the safety net, so it is the last
  // thing cut, but it is still cut before the allowance reaches zero and
  // starts refusing mail you actually wrote.
  const quota = await readQuota(env);
  if (!maySend(quota, "forward")) {
    console.warn(`postern: deferring ${pending.length} forward(s), ${quota.remaining} sends left today`);
    return;
  }

  let sent = 0;
  for (const message of pending) {
    try {
      await forwardStored(env, message.id);
      await env.DB.prepare(`UPDATE messages SET forwarded_ms = ? WHERE id = ?`)
        .bind(Date.now(), message.id).run();
      sent += 1;
      await new Promise((resolve) => setTimeout(resolve, 600));
    } catch (err) {
      // Leave the flag unset so the next run retries rather than losing it.
      console.error("postern: drain forward failed", message.id, err);
      break;
    }
  }
  console.log(`postern: forwarded ${sent} previously unforwarded message(s)`);
}

/**
 * Re-sends a stored message from R2 rather than re-fetching it from Resend,
 * so this keeps working for anything past Resend's 30-day retention.
 */
async function forwardStored(env: Env, id: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT r2_key, subject, header_from, envelope_from, envelope_to, folder
       FROM messages WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<{
      r2_key: string; subject: string | null; header_from: string | null;
      envelope_from: string; envelope_to: string; folder: string;
    }>();
  if (!row) return;

  const object = await env.RAW.get(row.r2_key);
  const raw = object ? await object.text() : "";
  const body = raw.split(/\r?\n\r?\n/).slice(1).join("\n\n");

  const originalFrom = row.header_from || row.envelope_from;
  const replyTo = (originalFrom.match(/<([^>]+)>/)?.[1] ?? originalFrom).trim();
  const prefix = row.folder === "quarantine" ? "[quarantine] " : "";

  await getSender(env).send({
    from: env.SEND_NAME ? `${env.SEND_NAME} <${env.SEND_FROM}>` : env.SEND_FROM,
    to: [env.FORWARD_TO],
    replyTo,
    subject: `${prefix}${row.subject ?? "(no subject)"}`,
    text: `${body}\n\n—\nForwarded by Postern · from ${originalFrom} · to ${row.envelope_to}\nhttps://mail.amirsalmani.com`,
    headers: { "X-Mailbox-Copy": "forward" },
  });
}

const TRASH_RETENTION_MS = 30 * 86_400_000;

/**
 * Empty the bin on our own clock. Thirty days from when you deleted it, not
 * thirty days from when it arrived — which is what Resend's retention would
 * have given, and it would have surprised you.
 */
async function purgeExpiredTrash(env: Env): Promise<void> {
  const cutoff = Date.now() - TRASH_RETENTION_MS;
  const { results } = await env.DB.prepare(
    `SELECT id, r2_key FROM messages
      WHERE folder = 'trash' AND trashed_ms IS NOT NULL AND trashed_ms < ?
      LIMIT 100`,
  )
    .bind(cutoff)
    .all();

  const expired = (results ?? []) as Array<{ id: string; r2_key: string }>;
  if (!expired.length) return;

  for (const message of expired) {
    const { results: files } = await env.DB.prepare(
      `SELECT r2_key FROM attachments WHERE message_id = ?`,
    ).bind(message.id).all();

    await Promise.all([
      env.RAW.delete(message.r2_key),
      ...((files ?? []) as Array<{ r2_key: string }>).map((f) => env.RAW.delete(f.r2_key)),
    ]);

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(message.id),
      env.DB.prepare(`DELETE FROM attachments WHERE message_id = ?`).bind(message.id),
      env.DB.prepare(`DELETE FROM messages_fts WHERE id = ?`).bind(message.id),
      env.DB.prepare(`INSERT OR REPLACE INTO tombstones (id, deleted_ms) VALUES (?, ?)`)
        .bind(message.id, Date.now()),
    ]);
  }
  console.log(`postern: purged ${expired.length} expired from trash`);
}

/**
 * Nudge about inbox mail that has sat unread for six hours.
 *
 * Each message is marked once it has been included in a reminder, so this
 * nags per message rather than per hour — an unread newsletter you're
 * ignoring on purpose stops mattering after the first nudge.
 *
 * One digest per run, never one email per message: on Resend's free tier the
 * reminder shares its allowance with your real mail, so a chatty reminder
 * would consume the quota it exists to protect.
 */
async function remindUnread(env: Env): Promise<void> {
  if (!env.FORWARD_TO) return;

  // A reminder already went out recently, so anything newly past the
  // threshold waits for the next window rather than arriving as a second mail.
  const lastReminder = await env.DB.prepare(
    `SELECT MAX(reminded_ms) AS last FROM messages WHERE reminded_ms IS NOT NULL`,
  ).first<{ last: number | null }>();
  if (lastReminder?.last && Date.now() - lastReminder.last < REMINDER_COOLDOWN_MS) return;

  const cutoff = Date.now() - SIX_HOURS_MS;
  const { results } = await env.DB.prepare(
    `SELECT id, subject, header_from, envelope_from, received_ms
       FROM messages
      WHERE folder = 'inbox' AND seen = 0
        AND received_ms < ? AND reminded_ms IS NULL
      ORDER BY received_ms ASC
      LIMIT 20`,
  )
    .bind(cutoff)
    .all();

  const pending = (results ?? []) as Array<{
    id: string; subject: string | null;
    header_from: string | null; envelope_from: string;
    received_ms: number;
  }>;
  if (!pending.length) return;

  const lines = pending.map((m) => {
    const from = (m.header_from || m.envelope_from || "").replace(/\s*<[^>]*>/, "").trim();
    const hours = Math.floor((Date.now() - m.received_ms) / 3_600_000);
    return `• ${from || "unknown"} — ${m.subject || "(no subject)"}  [${hours}h ago]`;
  });

  if (!maySend(await readQuota(env), "reminder")) {
    console.warn("postern: skipping unread reminder, daily allowance nearly spent");
    return;
  }

  const noun = pending.length === 1 ? "message" : "messages";
  const text = [
    `${pending.length} unread ${noun} have been sitting in your Postern inbox for over six hours:`,
    "",
    ...lines,
    "",
    "https://mail.amirsalmani.com",
  ].join("\n");

  try {
    const sender = getSender(env);
    await sender.send({
      from: env.SEND_NAME ? `${env.SEND_NAME} <${env.SEND_FROM}>` : env.SEND_FROM,
      to: [env.FORWARD_TO],
      subject: `Postern: ${pending.length} unread ${noun}`,
      text,
      headers: { "X-Mailbox-Copy": "reminder" },
    });
  } catch (err) {
    // Leave reminded_ms unset so the next run retries rather than silently
    // dropping the nudge.
    console.error("postern: reminder send failed", err);
    return;
  }

  const now = Date.now();
  await env.DB.batch(
    pending.map((m) =>
      env.DB.prepare(`UPDATE messages SET reminded_ms = ? WHERE id = ?`).bind(now, m.id),
    ),
  );
}
