import { verifyAccess } from "./access";
import { getSender } from "./senders";
import type { Env, Folder } from "./types";

const FOLDERS: Folder[] = ["inbox", "quarantine", "sent"];
const PAGE_SIZE = 50;

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

  if (segments[0] === "send" && request.method === "POST") {
    return sendMessage(request, env);
  }

  if (segments[0] === "messages" && segments[1]) {
    const id = segments[1];
    if (segments[2] === "raw" && request.method === "GET") return rawMessage(env, id);
    if (segments[2] === "seen" && request.method === "POST") return markSeen(env, id);
  }

  return json({ error: "not found" }, 404);
}

async function listMessages(env: Env, url: URL): Promise<Response> {
  const requested = url.searchParams.get("folder") as Folder | null;
  const folder: Folder = requested && FOLDERS.includes(requested) ? requested : "inbox";

  // Keyset pagination on the indexed sort column. OFFSET would make D1 scan
  // and discard rows, which gets slower the deeper you scroll.
  const before = Number(url.searchParams.get("before"));
  const cursor = Number.isFinite(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;

  const { results } = await env.DB.prepare(
    `SELECT id, thread_id, envelope_from, envelope_to, header_from, subject,
            message_id, in_reply_to, refs,
            received_ms, size_bytes, folder, seen, has_attach,
            spf, dkim, dmarc
       FROM messages
      WHERE folder = ? AND received_ms < ?
      ORDER BY received_ms DESC
      LIMIT ?`,
  )
    .bind(folder, cursor, PAGE_SIZE)
    .all();

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

interface SendRequest {
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

  const from = env.SEND_NAME ? `${env.SEND_NAME} <${env.SEND_FROM}>` : env.SEND_FROM;

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
    to: string[]; from: string; subject: string; text: string;
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
      env.SEND_FROM, m.to.join(", "), m.from, m.subject,
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
