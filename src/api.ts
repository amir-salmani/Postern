import { verifyAccess } from "./access";
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
    `SELECT id, thread_id, envelope_from, header_from, subject,
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
