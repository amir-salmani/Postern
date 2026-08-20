import { chooseFolder, parseInboxAddresses, r2KeyFor } from "./headers";
import type { Env, Folder } from "./types";

/**
 * Resend inbound webhook.
 *
 * This endpoint is deliberately outside Cloudflare Access — Resend can't log
 * in — so it authenticates the request itself by verifying Resend's Svix
 * signature over the raw body. An unsigned or stale request gets nothing.
 *
 * Resend's webhook carries metadata only: no body, no headers, no
 * attachments. The content comes from a second call to the Receiving API,
 * which is why this needs a full-access key rather than the send-only one.
 */

const REPLAY_TOLERANCE_SECONDS = 300;

export async function handleInbound(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

  if (!env.RESEND_WEBHOOK_SECRET) {
    console.error("postern: RESEND_WEBHOOK_SECRET is unset — refusing webhook");
    return json({ error: "webhook not configured" }, 503);
  }

  // Must be the raw body: any reserialisation changes the bytes and the
  // signature no longer matches.
  const body = await request.text();
  if (!(await verifySignature(env.RESEND_WEBHOOK_SECRET, request.headers, body))) {
    return json({ error: "invalid signature" }, 401);
  }

  let event: { type?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(body);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  // The webhook is subscribed to every event type. Anything that isn't an
  // inbound message is acknowledged and dropped — returning an error would
  // make Resend retry it forever.
  if (event.type !== "email.received") {
    return json({ ok: true, ignored: event.type ?? "unknown" });
  }

  const emailId = typeof event.data?.email_id === "string" ? event.data.email_id : null;
  if (!emailId) return json({ error: "missing email_id" }, 400);

  try {
    await ingest(env, emailId, event.data ?? {});
  } catch (err) {
    // A 5xx tells Resend to retry. Resend also stores the message regardless,
    // so a failure here delays ingestion rather than losing mail.
    console.error("postern: inbound ingest failed", err);
    return json({ error: (err as Error).message }, 500);
  }

  return json({ ok: true });
}

interface ReceivedEmail {
  from?: string;
  to?: string[] | string;
  subject?: string;
  html?: string;
  text?: string;
  headers?: Record<string, string> | Array<{ name: string; value: string }>;
  created_at?: string;
}

async function ingest(env: Env, emailId: string, meta: Record<string, unknown>): Promise<void> {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is unset");

  const response = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
  });
  if (!response.ok) {
    throw new Error(`Receiving API returned ${response.status}: ${await response.text()}`);
  }
  const email = (await response.json()) as ReceivedEmail;

  const receivedMs = Date.now();
  const r2Key = r2KeyFor(emailId, receivedMs);
  const headers = normaliseHeaders(email.headers);

  const to = Array.isArray(email.to) ? email.to : email.to ? [email.to] : [];
  const envelopeTo = to[0] ?? String(meta.to ?? "");
  const envelopeFrom = email.from ?? String(meta.from ?? "");
  const messageId = headers["message-id"] ?? (typeof meta.message_id === "string" ? meta.message_id : null);

  const folder: Folder = chooseFolder(
    envelopeTo,
    parseInboxAddresses(env.INBOX_ADDRESSES),
    { spf: null, dkim: null, dmarc: null },
  );

  const eml = buildEml(email, headers);

  // R2 before D1, so a failure leaves an orphaned object rather than a row
  // pointing at nothing.
  await env.RAW.put(r2Key, eml, { httpMetadata: { contentType: "message/rfc822" } });

  const inReplyTo = headers["in-reply-to"] ?? null;
  const refs = headers["references"] ?? null;
  const threadId = await resolveThread(env, messageId, inReplyTo, emailId);

  // The Resend email id is our primary key, so a webhook retry collides and
  // is ignored rather than storing the same message twice.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (
       id, r2_key, message_id, in_reply_to, refs, thread_id,
       envelope_from, envelope_to, header_from, subject,
       date_ms, received_ms, size_bytes,
       auth_results, spf, dkim, dmarc, folder, seen, has_attach
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 0, ?)`,
  )
    .bind(
      emailId, r2Key, messageId, inReplyTo, refs, threadId,
      envelopeFrom, envelopeTo, headers["from"] ?? envelopeFrom,
      email.subject ?? headers["subject"] ?? "(no subject)",
      Date.parse(headers["date"] ?? email.created_at ?? "") || receivedMs,
      receivedMs, eml.length,
      headers["authentication-results"] ?? null,
      folder,
      (headers["content-type"] ?? "").toLowerCase().includes("multipart/mixed") ? 1 : 0,
    )
    .run();
}

function normaliseHeaders(
  raw: ReceivedEmail["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const h of raw) if (h?.name) out[h.name.toLowerCase()] = h.value;
  } else {
    for (const [name, value] of Object.entries(raw)) out[name.toLowerCase()] = String(value);
  }
  return out;
}

/**
 * Rebuild an .eml from the parsed parts so received mail renders through the
 * same client-side path as everything else, rather than needing a second
 * renderer for Resend-shaped messages.
 */
function buildEml(email: ReceivedEmail, headers: Record<string, string>): string {
  const skip = new Set(["content-type", "content-transfer-encoding", "mime-version"]);
  const lines: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!skip.has(name)) lines.push(`${titleCaseHeader(name)}: ${value}`);
  }

  const boundary = "postern-part-boundary";
  lines.push("MIME-Version: 1.0");

  if (email.html && email.text) {
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, "");
    lines.push(`--${boundary}`, 'Content-Type: text/plain; charset="utf-8"', "", email.text);
    lines.push(`--${boundary}`, 'Content-Type: text/html; charset="utf-8"', "", email.html);
    lines.push(`--${boundary}--`);
  } else if (email.html) {
    lines.push('Content-Type: text/html; charset="utf-8"', "", email.html);
  } else {
    lines.push('Content-Type: text/plain; charset="utf-8"', "", email.text ?? "");
  }

  return lines.join("\r\n");
}

function titleCaseHeader(name: string): string {
  return name.split("-").map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p)).join("-");
}

async function resolveThread(
  env: Env, messageId: string | null, inReplyTo: string | null, fallback: string,
): Promise<string> {
  if (inReplyTo) {
    const parent = await env.DB.prepare(
      `SELECT thread_id FROM messages WHERE message_id = ? LIMIT 1`,
    ).bind(inReplyTo.trim()).first<{ thread_id: string }>();
    if (parent?.thread_id) return parent.thread_id;
  }
  return messageId ?? fallback;
}

/** Svix signature verification — HMAC-SHA256 over `id.timestamp.body`. */
async function verifySignature(
  secret: string, headers: Headers, body: string,
): Promise<boolean> {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return false;

  // Reject stale requests so a captured webhook can't be replayed later.
  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return false;
  if (Math.abs(Date.now() / 1000 - sent) > REPLAY_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(secret.replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  const expected = bytesToBase64(new Uint8Array(mac));

  // The header may carry several space-separated `v1,<sig>` pairs during a
  // secret rotation; any match is valid.
  for (const entry of signatures.split(" ")) {
    const [version, signature] = entry.split(",");
    if (version === "v1" && signature && constantTimeEquals(signature, expected)) return true;
  }
  return false;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
