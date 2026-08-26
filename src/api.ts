import { verifyAccess } from "./access";
import { runBackfill } from "./backfill";
import { getSender } from "./senders";
import type { Env, Folder } from "./types";

const FOLDERS: Folder[] = ["inbox", "quarantine", "sent", "trash"];
const TRASH_RETENTION_MS = 30 * 86_400_000;
const PAGE_SIZE = 50;

const SELECT_COLUMNS = `SELECT m.id, m.thread_id, m.envelope_from, m.envelope_to, m.header_from,
            m.subject, m.message_id, m.in_reply_to, m.refs,
            m.received_ms, m.size_bytes, m.folder, m.seen, m.has_attach,
            m.spf, m.dkim, m.dmarc, m.trashed_ms,
            (SELECT COUNT(*) FROM messages t
              WHERE t.thread_id = m.thread_id AND t.folder != 'trash') AS thread_count
       FROM messages m`;

/**
 * FTS5 treats punctuation as syntax, so a raw subject line can be a syntax
 * error rather than a search. Quote each term and prefix-match the last one
 * so results narrow as you type.
 */
function ftsQuery(input: string): string {
  const terms = input.replace(/["*]/g, " ").split(/\s+/).filter(Boolean);
  if (!terms.length) return '""';
  return terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(" AND ");
}

/**
 * The read API. Phase 2 is deliberately read-only — sending arrives in
 * Phase 3 through src/senders/.
 *
 * Everything here costs a Worker invocation, so the client is built to ask
 * rarely: no polling, one list request per folder view, one raw fetch per
 * message opened. Static assets bypass the Worker entirely and are free.
 */
export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const identity = await verifyAccess(request, env);
  if (!identity) return json({ error: "unauthorized" }, 401);

  const segments = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"

  if (segments[0] === "messages" && segments.length === 1 && request.method === "GET") {
    return listMessages(env, url);
  }

  if (segments[0] === "threads" && segments[1] && request.method === "GET") {
    return thread(env, segments[1]);
  }

  if (segments[0] === "rules") {
    if (request.method === "GET") return listRules(env);
    if (request.method === "POST") return createRule(request, env);
    if (segments[1] && request.method === "DELETE") return deleteRule(env, segments[1]);
  }

  if (segments[0] === "identities" && request.method === "GET") {
    return json({ identities: identities(env), name: env.SEND_NAME });
  }

  if (segments[0] === "overview" && request.method === "GET") {
    return overview(env);
  }

  if (segments[0] === "counts" && request.method === "GET") {
    return folderCounts(env);
  }

  if (segments[0] === "events" && request.method === "GET") {
    return listEvents(env, url);
  }

  if (segments[0] === "backfill" && request.method === "POST") {
    return backfill(env);
  }

  if (segments[0] === "send" && request.method === "POST") {
    return sendMessage(request, env);
  }

  if (segments[0] === "messages" && segments[1]) {
    const id = segments[1];
    if (segments[2] === "raw" && request.method === "GET") return rawMessage(env, id);
    if (segments[2] === "seen" && request.method === "POST") return markSeen(env, id);
    if (segments[2] === "attachments" && request.method === "GET") {
      return segments[3] ? attachment(env, id, segments[3]) : listAttachments(env, id);
    }
    if (!segments[2] && request.method === "PATCH") return patchMessage(request, env, id);
    // Soft by default; ?purge=1 is the irreversible one.
    if (!segments[2] && request.method === "DELETE") {
      return url.searchParams.get("purge") === "1"
        ? purgeMessage(env, id)
        : trashMessage(env, id);
    }
  }

  return json({ error: "not found" }, 404);
}

const DAY_MS = 86_400_000;

/**
 * Everything the dashboard needs in one request.
 *
 * Quota is counted from Resend's own lists rather than our tables, because
 * Resend is what enforces it — and its free tier bills inbound and outbound
 * against the same allowance, which is the number actually worth watching.
 */
async function overview(env: Env): Promise<Response> {
  const now = Date.now();
  const since = now - 13 * DAY_MS;

  const [folders, storage, series] = await Promise.all([
    env.DB.prepare(
      `SELECT folder, COUNT(*) AS total, SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS unread
         FROM messages GROUP BY folder`,
    ).all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS messages, COALESCE(SUM(size_bytes), 0) AS bytes FROM messages`,
    ).first<{ messages: number; bytes: number }>(),
    env.DB.prepare(
      `SELECT date(received_ms / 1000, 'unixepoch') AS day,
              SUM(CASE WHEN folder = 'sent' THEN 0 ELSE 1 END) AS received,
              SUM(CASE WHEN folder = 'sent' THEN 1 ELSE 0 END) AS sent
         FROM messages
        WHERE received_ms >= ?
        GROUP BY day ORDER BY day`,
    ).bind(since).all(),
  ]);

  const counts: Record<string, { total: number; unread: number }> = {};
  for (const row of (folders.results ?? []) as Array<{ folder: string; total: number; unread: number }>) {
    counts[row.folder] = { total: row.total, unread: row.unread ?? 0 };
  }

  return json({
    counts,
    trashRetentionDays: TRASH_RETENTION_MS / 86_400_000,
    storage: { messages: storage?.messages ?? 0, bytes: storage?.bytes ?? 0, limitBytes: 10 * 1024 ** 3 },
    series: fillDays((series.results ?? []) as Array<{ day: string; received: number; sent: number }>, now),
    quota: await resendQuota(env, now),
  });
}

/** Gaps read as zero, not as missing — a chart with holes in it lies. */
function fillDays(
  rows: Array<{ day: string; received: number; sent: number }>,
  now: number,
): Array<{ day: string; received: number; sent: number }> {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = 13; i >= 0; i -= 1) {
    const day = new Date(now - i * DAY_MS).toISOString().slice(0, 10);
    const row = byDay.get(day);
    out.push({ day, received: row?.received ?? 0, sent: row?.sent ?? 0 });
  }
  return out;
}

interface QuotaWindow { sent: number; received: number; total: number; limit: number }

async function resendQuota(
  env: Env,
  now: number,
): Promise<{ day: QuotaWindow; month: QuotaWindow; available: boolean }> {
  const empty = { sent: 0, received: 0, total: 0, limit: 0 };
  if (!env.RESEND_API_KEY) {
    return { day: { ...empty, limit: 100 }, month: { ...empty, limit: 3000 }, available: false };
  }

  const headers = { Authorization: `Bearer ${env.RESEND_API_KEY}` };
  const [sentRes, receivedRes] = await Promise.all([
    fetch("https://api.resend.com/emails", { headers }),
    fetch("https://api.resend.com/emails/receiving", { headers }),
  ]);
  if (!sentRes.ok || !receivedRes.ok) {
    return { day: { ...empty, limit: 100 }, month: { ...empty, limit: 3000 }, available: false };
  }

  const sent = ((await sentRes.json()) as { data?: Array<{ created_at?: string }> }).data ?? [];
  const received = ((await receivedRes.json()) as { data?: Array<{ created_at?: string }> }).data ?? [];

  const startOfDay = new Date(now).setUTCHours(0, 0, 0, 0);
  const startOfMonth = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const after = (list: Array<{ created_at?: string }>, from: number) =>
    list.filter((x) => Date.parse(x.created_at ?? "") >= from).length;

  const build = (from: number, limit: number): QuotaWindow => {
    const s = after(sent, from);
    const r = after(received, from);
    return { sent: s, received: r, total: s + r, limit };
  };

  return { day: build(startOfDay, 100), month: build(startOfMonth, 3000), available: true };
}

async function folderCounts(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT folder,
            COUNT(*) AS total,
            SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS unread
       FROM messages
      GROUP BY folder`,
  ).all();

  const counts: Record<string, { total: number; unread: number }> = {};
  for (const row of (results ?? []) as Array<{ folder: string; total: number; unread: number }>) {
    counts[row.folder] = { total: row.total, unread: row.unread ?? 0 };
  }
  return json({ counts });
}

/** Every message in a conversation, oldest first — a thread reads downward. */
async function thread(env: Env, threadId: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `${SELECT_COLUMNS}
      WHERE m.thread_id = ? AND m.folder != 'trash'
      ORDER BY m.received_ms ASC`,
  )
    .bind(threadId)
    .all();
  return json({ messages: results ?? [] });
}

async function listAttachments(env: Env, messageId: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, filename, content_type, size_bytes FROM attachments WHERE message_id = ?`,
  )
    .bind(messageId)
    .all();
  return json({ attachments: results ?? [] });
}

async function attachment(env: Env, messageId: string, attachmentId: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT r2_key, filename, content_type FROM attachments WHERE id = ? AND message_id = ? LIMIT 1`,
  )
    .bind(attachmentId, messageId)
    .first<{ r2_key: string; filename: string; content_type: string }>();
  if (!row) return json({ error: "not found" }, 404);

  const object = await env.RAW.get(row.r2_key);
  if (!object) return json({ error: "attachment missing from storage" }, 410);

  return new Response(object.body, {
    headers: {
      "Content-Type": row.content_type || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${(row.filename || "attachment").replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

/**
 * Trash keeps our own copy and our own clock. Resend's 30-day retention runs
 * from receipt, not from deletion, so a message trashed on day 29 would be
 * recoverable for one day — and composed mail never enters Resend's receiving
 * store at all. Keeping the object here makes the window mean what it says.
 */
async function trashMessage(env: Env, id: string): Promise<Response> {
  const result = await env.DB.prepare(
    `UPDATE messages SET folder = 'trash', trashed_ms = ? WHERE id = ? AND folder != 'trash'`,
  )
    .bind(Date.now(), id)
    .run();
  if (!result.meta.changes) return json({ error: "not found" }, 404);
  return json({ ok: true, folder: "trash" });
}

/** Irreversible: object, row, index and attachments all go, tombstone stays. */
async function purgeMessage(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT r2_key FROM messages WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<{ r2_key: string }>();
  if (!row) return json({ error: "not found" }, 404);

  const { results } = await env.DB.prepare(
    `SELECT r2_key FROM attachments WHERE message_id = ?`,
  ).bind(id).all();

  await Promise.all([
    env.RAW.delete(row.r2_key),
    ...((results ?? []) as Array<{ r2_key: string }>).map((a) => env.RAW.delete(a.r2_key)),
  ]);

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM attachments WHERE message_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM messages_fts WHERE id = ?`).bind(id),
    env.DB.prepare(`INSERT OR REPLACE INTO tombstones (id, deleted_ms) VALUES (?, ?)`)
      .bind(id, Date.now()),
  ]);
  return json({ ok: true });
}

/** Mark read/unread, or move between folders. */
async function patchMessage(request: Request, env: Env, id: string): Promise<Response> {
  let body: { seen?: boolean; folder?: Folder };
  try {
    body = (await request.json()) as { seen?: boolean; folder?: Folder };
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const updates: string[] = [];
  const values: unknown[] = [];
  if (typeof body.seen === "boolean") {
    updates.push("seen = ?");
    values.push(body.seen ? 1 : 0);
  }
  if (body.folder && FOLDERS.includes(body.folder)) {
    updates.push("folder = ?");
    values.push(body.folder);
    // Restoring must clear the countdown, or the purge would still take it.
    updates.push("trashed_ms = ?");
    values.push(body.folder === "trash" ? Date.now() : null);
  }
  if (!updates.length) return json({ error: "nothing to update" }, 400);

  values.push(id);
  await env.DB.prepare(`UPDATE messages SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  return json({ ok: true });
}

async function listMessages(env: Env, url: URL): Promise<Response> {
  const requested = url.searchParams.get("folder") as Folder | null;
  const folder: Folder = requested && FOLDERS.includes(requested) ? requested : "inbox";

  // Keyset pagination on the indexed sort column. OFFSET would make D1 scan
  // and discard rows, which gets slower the deeper you scroll.
  const before = Number(url.searchParams.get("before"));
  const cursor = Number.isFinite(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;

  // Search spans every folder — looking for a message you can't place is
  // exactly when you don't know which folder it's in.
  const query = (url.searchParams.get("q") ?? "").trim();
  const like = `%${query}%`;

  // Full text via FTS5 over subject, sender and body. Search spans every
  // folder except trash — looking for something you can't place is exactly
  // when you don't know which folder it's in, but you didn't mean the bin.
  const statement = query
    ? env.DB.prepare(
        `${SELECT_COLUMNS}
          WHERE m.received_ms < ?
            AND m.folder != 'trash'
            AND m.id IN (SELECT id FROM messages_fts WHERE messages_fts MATCH ?)
          ORDER BY m.received_ms DESC
          LIMIT ?`,
      ).bind(cursor, ftsQuery(query), PAGE_SIZE)
    : env.DB.prepare(
        `${SELECT_COLUMNS}
          WHERE m.folder = ? AND m.received_ms < ?
          ORDER BY m.received_ms DESC
          LIMIT ?`,
      ).bind(folder, cursor, PAGE_SIZE);

  const { results } = await statement.all();

  const messages = results ?? [];
  const last = messages[messages.length - 1] as { received_ms?: number } | undefined;

  return json({
    folder,
    messages,
    nextCursor: messages.length === PAGE_SIZE ? (last?.received_ms ?? null) : null,
  });
}

/**
 * Streams the stored .eml straight through. The Worker never parses it —
 * that happens in the browser, which is what keeps this inside the free
 * plan's 10ms CPU budget no matter how large the message is.
 */
async function rawMessage(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT r2_key FROM messages WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<{ r2_key: string }>();
  if (!row) return json({ error: "not found" }, 404);

  const object = await env.RAW.get(row.r2_key);
  if (!object) return json({ error: "raw message missing from storage" }, 410);

  return new Response(object.body, {
    headers: {
      "Content-Type": "message/rfc822",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

async function markSeen(env: Env, id: string): Promise<Response> {
  await env.DB.prepare(`UPDATE messages SET seen = 1 WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

async function listEvents(env: Env, url: URL): Promise<Response> {
  const before = Number(url.searchParams.get("before"));
  const cursor = Number.isFinite(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;

  const { results } = await env.DB.prepare(
    `SELECT id, type, email_id, created_ms, summary
       FROM events
      WHERE created_ms < ?
      ORDER BY created_ms DESC
      LIMIT ?`,
  )
    .bind(cursor, PAGE_SIZE)
    .all();

  return json({ events: results ?? [] });
}

async function backfill(env: Env): Promise<Response> {
  if (!env.RESEND_API_KEY) return json({ error: "RESEND_API_KEY is unset" }, 501);
  try {
    return json({ ok: true, ...(await runBackfill(env)) });
  } catch (err) {
    return json({ error: (err as Error).message }, 502);
  }
}

const RULE_ACTIONS = ["inbox", "quarantine", "trash"];

async function listRules(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, pattern, action, created_ms FROM rules ORDER BY created_ms DESC`,
  ).all();
  return json({ rules: results ?? [] });
}

/**
 * Creating a rule also applies it to mail already received, so blocking a
 * sender clears the backlog you were blocking them for. A rule that only
 * affected future mail would leave you deleting the same twelve messages by
 * hand anyway.
 */
async function createRule(request: Request, env: Env): Promise<Response> {
  let body: { kind?: string; pattern?: string; action?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const kind = body.kind === "domain" ? "domain" : "sender";
  const pattern = (body.pattern ?? "").trim().toLowerCase();
  const action = body.action ?? "";
  if (!pattern) return json({ error: "pattern is required" }, 400);
  if (!RULE_ACTIONS.includes(action)) return json({ error: "unknown action" }, 400);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO rules (id, kind, pattern, action, created_ms) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (kind, pattern) DO UPDATE SET action = excluded.action`,
  )
    .bind(id, kind, pattern, action, Date.now())
    .run();

  const match = kind === "domain" ? `%@${pattern}` : pattern;
  const applied = await env.DB.prepare(
    `UPDATE messages SET folder = ?, trashed_ms = ?
      WHERE folder != 'sent' AND folder != ? AND lower(envelope_from) LIKE ?`,
  )
    .bind(action, action === "trash" ? Date.now() : null, action, match)
    .run();

  return json({ ok: true, id, applied: applied.meta.changes ?? 0 });
}

async function deleteRule(env: Env, id: string): Promise<Response> {
  await env.DB.prepare(`DELETE FROM rules WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

/** Every address you're permitted to send as, default first. */
function identities(env: Env): string[] {
  const domain = env.MAIL_DOMAIN;
  const listed = (env.SEND_ADDRESSES ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => (part.includes("@") ? part : `${part}@${domain}`));
  const all = [env.SEND_FROM, ...listed].filter(Boolean);
  return [...new Set(all)];
}

interface SendRequest {
  from?: string;
  to?: string[];
  subject?: string;
  text?: string;
  inReplyTo?: string | null;
  references?: string | null;
  threadId?: string | null;
}

/**
 * Send, then store a copy. Resend has no concept of your mailbox — without
 * writing the copy back ourselves, your own sent mail would simply not exist
 * anywhere you can read it.
 */
async function sendMessage(request: Request, env: Env): Promise<Response> {
  let body: SendRequest;
  try {
    body = (await request.json()) as SendRequest;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const to = (body.to ?? []).map((address) => address.trim()).filter(Boolean);
  const subject = (body.subject ?? "").trim();
  const text = body.text ?? "";
  if (!to.length) return json({ error: "at least one recipient is required" }, 400);
  if (!text.trim()) return json({ error: "message body is empty" }, 400);

  let sender;
  try {
    sender = getSender(env);
  } catch (err) {
    return json({ error: (err as Error).message }, 501);
  }

  // The From must be one we allow. Trusting the client here would turn this
  // endpoint into a way to send mail as any address on the domain.
  const allowed = identities(env);
  const requested = (body.from ?? "").trim().toLowerCase();
  const address = requested && allowed.includes(requested) ? requested : env.SEND_FROM;
  if (requested && !allowed.includes(requested)) {
    return json({ error: `Not permitted to send as ${requested}` }, 403);
  }
  const from = env.SEND_NAME ? `${env.SEND_NAME} <${address}>` : address;

  // References accumulates the whole chain; In-Reply-To names only the parent.
  const references = [body.references, body.inReplyTo].filter(Boolean).join(" ").trim();

  let result;
  try {
    result = await sender.send({
      from,
      to,
      // A copy to the existing mailbox, so sent mail is readable on your phone
      // too. Tagged so it can be filtered out of the inbox there.
      bcc: env.FORWARD_TO ? [env.FORWARD_TO] : undefined,
      subject: subject || "(no subject)",
      text,
      inReplyTo: body.inReplyTo ?? undefined,
      references: references || undefined,
      headers: { "X-Mailbox-Copy": "sent" },
    });
  } catch (err) {
    return json({ error: (err as Error).message }, 502);
  }

  try {
    await storeSentCopy(env, {
      to,
      from,
      address,
      subject: subject || "(no subject)",
      text,
      messageId: result.messageId ? `<${result.messageId}@resend>` : null,
      inReplyTo: body.inReplyTo ?? null,
      references: references || null,
      threadId: body.threadId ?? null,
    });
  } catch (err) {
    // The mail is already gone; failing the request now would invite a
    // duplicate send. Report success and log the bookkeeping failure.
    console.error("postern: sent but failed to store copy", err);
    return json({ ok: true, stored: false, messageId: result.messageId });
  }

  return json({ ok: true, stored: true, messageId: result.messageId });
}

async function storeSentCopy(
  env: Env,
  m: {
    to: string[]; from: string; address: string; subject: string; text: string;
    messageId: string | null; inReplyTo: string | null;
    references: string | null; threadId: string | null;
  },
): Promise<void> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const date = new Date(now);
  const r2Key = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${id}.eml`;

  // Reconstruct an .eml so sent mail reads through exactly the same path as
  // received mail — one renderer, not two.
  const eml = [
    `From: ${m.from}`,
    `To: ${m.to.join(", ")}`,
    `Subject: ${m.subject}`,
    `Date: ${date.toUTCString()}`,
    m.messageId ? `Message-ID: ${m.messageId}` : null,
    m.inReplyTo ? `In-Reply-To: ${m.inReplyTo}` : null,
    m.references ? `References: ${m.references}` : null,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    m.text,
  ].filter((line) => line !== null).join("\r\n");

  await env.RAW.put(r2Key, eml, {
    httpMetadata: { contentType: "message/rfc822" },
  });

  await env.DB.prepare(
    `INSERT INTO messages (
       id, r2_key, message_id, in_reply_to, refs, thread_id,
       envelope_from, envelope_to, header_from, subject,
       date_ms, received_ms, size_bytes,
       auth_results, spf, dkim, dmarc, folder, seen, has_attach
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'sent', 1, 0)`,
  )
    .bind(
      id, r2Key, m.messageId, m.inReplyTo, m.references,
      m.threadId ?? m.messageId ?? id,
      m.address, m.to.join(", "), m.from, m.subject,
      now, now, eml.length,
    )
    .run();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
