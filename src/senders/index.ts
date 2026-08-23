/**
 * The sender boundary. Phase 3 — nothing here is wired up yet.
 *
 * This interface exists now, before it's needed, because it's the seam that
 * keeps every outbound decision reversible: Resend on the free tier today,
 * an SMTP smarthost or Cloudflare Email Sending later, without a rewrite.
 * Hard-coding one provider is the most likely way this project rots.
 */
import { resendSender } from "./resend";

export interface OutboundMessage {
  from: string;
  to: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  /** RFC 5322 threading. Omit these and replies orphan in the recipient's client. */
  inReplyTo?: string;
  references?: string;
  /** Where a reply should actually go — used by forwards to reach the original sender. */
  replyTo?: string;
  attachments?: Array<{ filename: string; content: string }>;
  headers?: Record<string, string>;
}

export interface SendResult {
  messageId: string;
}

export interface Sender {
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}

/**
 * Pick the sender from config. Swapping Resend for an SMTP smarthost or
 * Cloudflare Email Sending is a change here and nowhere else.
 */
export function getSender(env: { RESEND_API_KEY?: string }): Sender {
  if (env.RESEND_API_KEY) return resendSender(env.RESEND_API_KEY);
  throw new Error("No sender configured — set the RESEND_API_KEY secret.");
}
