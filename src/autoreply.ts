import { getSender } from "./senders";
import { maySend, readQuota } from "./quota";
import { readSettings, withinWorkingHours } from "./settings";
import type { Env } from "./types";

/**
 * Out-of-hours auto-reply.
 *
 * The hard part is not sending it — it is knowing when *not* to. RFC 3834
 * exists because naive auto-responders create mail loops: two of them
 * answering each other forever. Everything below is about refusing to reply.
 */

/** Local parts that are machines. Replying to them is pointless at best. */
const ROBOT_PATTERNS = [
  "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon",
  "postmaster", "bounce", "notification", "notifications", "automated",
  "no_reply", "invitations", "updates",
];

export async function maybeAutoReply(
  env: Env,
  ctx: {
    envelopeFrom: string;
    envelopeTo: string;
    subject: string;
    messageId: string | null;
    references: string | null;
    headers: Record<string, string>;
  },
): Promise<void> {
  const settings = await readSettings(env);
  if (settings["autoreply.enabled"] !== "true") return;

  // Only outside working hours — inside them, you are the auto-reply.
  if (withinWorkingHours(settings, new Date())) return;

  const sender = extractAddress(ctx.envelopeFrom).toLowerCase();
  if (!sender || !sender.includes("@")) return;

  // Never answer our own domain, or ourselves. This is the loop that bites.
  if (sender.endsWith(`@${env.MAIL_DOMAIN}`) || sender === env.SEND_FROM?.toLowerCase()) return;
  if (env.FORWARD_TO && sender === env.FORWARD_TO.toLowerCase()) return;

  // RFC 3834: never auto-reply to anything already machine-generated.
  const autoSubmitted = (ctx.headers["auto-submitted"] ?? "").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return;
  const precedence = (ctx.headers["precedence"] ?? "").toLowerCase();
  if (["bulk", "list", "junk", "auto_reply"].includes(precedence)) return;
  if (ctx.headers["list-unsubscribe"] || ctx.headers["list-id"]) return;
  if (ctx.headers["x-auto-response-suppress"]) return;

  const localPart = sender.split("@")[0];
  if (ROBOT_PATTERNS.some((p) => localPart.includes(p))) return;

  // One reply per sender per cooldown.
  // An out-of-hours courtesy is not worth the allowance your real mail needs.
  if (!maySend(await readQuota(env), "autoreply")) {
    console.warn("postern: skipping auto-reply, daily allowance nearly spent");
    return;
  }

  const cooldownMs = Number(settings["autoreply.cooldown_hours"] ?? 24) * 3_600_000;
  const previous = await env.DB.prepare(
    `SELECT last_ms FROM autoreplies WHERE sender = ? LIMIT 1`,
  ).bind(sender).first<{ last_ms: number }>();
  if (previous && Date.now() - previous.last_ms < cooldownMs) return;

  const replyTo = ctx.envelopeTo && ctx.envelopeTo.endsWith(`@${env.MAIL_DOMAIN}`)
    ? ctx.envelopeTo
    : env.SEND_FROM;
  const subject = /^re:/i.test(ctx.subject) ? ctx.subject : `Re: ${ctx.subject}`;

  await getSender(env).send({
    from: env.SEND_NAME ? `${env.SEND_NAME} <${replyTo}>` : replyTo,
    to: [sender],
    subject,
    text: settings["autoreply.message"],
    inReplyTo: ctx.messageId ?? undefined,
    references: [ctx.references, ctx.messageId].filter(Boolean).join(" ") || undefined,
    headers: {
      // Tells the other side's responder not to answer this one back.
      "Auto-Submitted": "auto-replied",
      "X-Auto-Response-Suppress": "All",
      "Precedence": "auto_reply",
    },
  });

  await env.DB.prepare(
    `INSERT INTO autoreplies (sender, last_ms, reply_count) VALUES (?, ?, 1)
     ON CONFLICT (sender) DO UPDATE SET last_ms = excluded.last_ms, reply_count = reply_count + 1`,
  ).bind(sender, Date.now()).run();
}

function extractAddress(header: string): string {
  return (header.match(/<([^>]+)>/)?.[1] ?? header).trim();
}
