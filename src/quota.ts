import type { Env } from "./types";

/**
 * Remaining send allowance, and whether a given kind of send may proceed.
 *
 * Resend's free tier bills inbound and outbound against one 100/day figure,
 * so a spam burst on a catch-all domain can consume the budget your real mail
 * needs. Nothing here checked that before sending: the reminder, the forward
 * drain and the auto-reply would all happily spend the last of it.
 *
 * Reserves are ordered by how much you would regret losing the send. A reply
 * you typed is worth more than a nightly digest about unread mail.
 */

const DAILY_LIMIT = 100;

/** Below this many sends remaining, only human-initiated mail goes out. */
const RESERVE_FOR_HUMANS = 15;
/** Below this, forwarding still runs — it is the safety net — but little else. */
const RESERVE_FOR_FORWARD = 5;

export type SendKind = "human" | "forward" | "autoreply" | "reminder";

export interface QuotaState {
  usedToday: number;
  remaining: number;
  limit: number;
  known: boolean;
}

/**
 * Counted from Resend's own lists, since Resend is what enforces the limit.
 * If it can't be read, the state is reported as unknown and callers proceed —
 * failing to send real mail because a counter was unavailable would be worse
 * than briefly exceeding a soft limit.
 */
export async function readQuota(env: Env): Promise<QuotaState> {
  const unknown: QuotaState = { usedToday: 0, remaining: DAILY_LIMIT, limit: DAILY_LIMIT, known: false };
  if (!env.RESEND_API_KEY) return unknown;

  const headers = { Authorization: `Bearer ${env.RESEND_API_KEY}` };
  try {
    const [sent, received] = await Promise.all([
      fetch("https://api.resend.com/emails", { headers }),
      fetch("https://api.resend.com/emails/receiving", { headers }),
    ]);
    if (!sent.ok || !received.ok) return unknown;

    const startOfDay = new Date().setUTCHours(0, 0, 0, 0);
    const since = (list: Array<{ created_at?: string }>) =>
      list.filter((x) => Date.parse(x.created_at ?? "") >= startOfDay).length;

    const usedToday =
      since(((await sent.json()) as { data?: Array<{ created_at?: string }> }).data ?? []) +
      since(((await received.json()) as { data?: Array<{ created_at?: string }> }).data ?? []);

    return { usedToday, remaining: Math.max(0, DAILY_LIMIT - usedToday), limit: DAILY_LIMIT, known: true };
  } catch {
    return unknown;
  }
}

export function maySend(quota: QuotaState, kind: SendKind): boolean {
  if (!quota.known) return true;
  switch (kind) {
    case "human":
      return quota.remaining > 0;
    case "forward":
      return quota.remaining > RESERVE_FOR_FORWARD;
    case "autoreply":
    case "reminder":
      return quota.remaining > RESERVE_FOR_HUMANS;
  }
}
