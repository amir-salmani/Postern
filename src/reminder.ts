import { runBackfill } from "./backfill";
import { getSender } from "./senders";
import type { Env } from "./types";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

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
  await remindUnread(env);
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
