import type { Env, Folder } from "./types";
import {
  chooseFolder,
  parseAuthResults,
  parseDateHeader,
  parseInboxAddresses,
  r2KeyFor,
} from "./headers";

/**
 * Postern — inbound ingest.
 *
 * Two constraints shape everything here:
 *
 *   1. Workers Free gives 10ms of CPU per invocation. Async I/O doesn't count
 *      against it, but JS execution does — so this handler does no MIME
 *      parsing at all. The raw .eml goes to R2 verbatim and the browser
 *      parses it later. Every field we store comes from headers Cloudflare
 *      already parsed.
 *
 *   2. If this handler returns without forwarding, consuming raw, or
 *      rejecting, the message is silently dropped. Silent mail loss is the
 *      worst possible failure, so the control flow below always ends in one
 *      of those three.
 *
 * The safety net fires before storage deliberately: a bug in our code must
 * never be able to cost you an email.
 */
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  // Single-use stream — read it exactly once, before anything else touches
  // the message.
  let raw: ArrayBuffer | null = null;
  try {
    raw = await new Response(message.raw).arrayBuffer();
  } catch (err) {
    console.error("postern: failed to buffer raw message", err);
  }

  // The net. Runs before storage so that storage bugs are survivable.
  let forwarded = false;
  if (env.FORWARD_TO) {
    try {
      await message.forward(env.FORWARD_TO);
      forwarded = true;
    } catch (err) {
      console.error("postern: forward failed", err);
    }
  }

  let stored = false;
  if (raw) {
    try {
      await store(message, raw, env);
      stored = true;
    } catch (err) {
      console.error("postern: store failed", err);
    }
  }

  // Both paths failed, so nothing anywhere holds this message. Reject, which
  // bounces it back to the sender. A bounce is unpleasant; a message that
  // vanishes without anyone knowing is worse.
  if (!forwarded && !stored) {
    message.setReject("Temporary failure storing message. Please retry.");
  }
}

async function store(
  message: ForwardableEmailMessage,
  raw: ArrayBuffer,
  env: Env,
): Promise<void> {
  const receivedMs = Date.now();
  const id = crypto.randomUUID();
  const r2Key = r2KeyFor(id, receivedMs);

  const h = message.headers;
  const messageId = h.get("message-id");
  const inReplyTo = h.get("in-reply-to");
  const refs = h.get("references");
  const contentType = h.get("content-type") ?? "";
  const authRaw = h.get("authentication-results");
  const auth = parseAuthResults(authRaw);

  const folder: Folder = chooseFolder(
    message.to,
    parseInboxAddresses(env.INBOX_ADDRESSES),
    auth,
  );

  // R2 before D1. If D1 then fails we're left with an orphaned object, which
  // is cheap and reconcilable. The reverse — a row pointing at an object that
  // was never written — is a broken message in the UI with no way back.
  await env.RAW.put(r2Key, raw, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: { envelopeFrom: message.from, envelopeTo: message.to },
  });

  const threadId = await resolveThread(env, messageId, inReplyTo, id);

  await env.DB.prepare(
    `INSERT INTO messages (
       id, r2_key, message_id, in_reply_to, refs, thread_id,
       envelope_from, envelope_to, header_from, subject,
       date_ms, received_ms, size_bytes,
       auth_results, spf, dkim, dmarc,
       folder, seen, has_attach
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      id,
      r2Key,
      messageId,
      inReplyTo,
      refs,
      threadId,
      message.from,
      message.to,
      h.get("from"),
      h.get("subject"),
      parseDateHeader(h.get("date")),
      receivedMs,
      message.rawSize,
      authRaw,
      auth.spf,
      auth.dkim,
      auth.dmarc,
      folder,
      contentType.toLowerCase().includes("multipart/mixed") ? 1 : 0,
    )
    .run();
}

/**
 * Group replies with the message they answer. One indexed D1 read — cheap,
 * and it's I/O so it costs no CPU budget. Without this, threading can't be
 * reconstructed later without re-parsing the whole mailbox.
 */
async function resolveThread(
  env: Env,
  messageId: string | null,
  inReplyTo: string | null,
  fallbackId: string,
): Promise<string> {
  if (inReplyTo) {
    const parent = await env.DB.prepare(
      `SELECT thread_id FROM messages WHERE message_id = ? LIMIT 1`,
    )
      .bind(inReplyTo.trim())
      .first<{ thread_id: string }>();
    if (parent?.thread_id) return parent.thread_id;
  }
  return messageId ?? fallbackId;
}
