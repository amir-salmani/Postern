/**
 * The sender boundary. Phase 3 — nothing here is wired up yet.
 *
 * This interface exists now, before it's needed, because it's the seam that
 * keeps every outbound decision reversible: Resend on the free tier today,
 * an SMTP smarthost or Cloudflare Email Sending later, without a rewrite.
 * Hard-coding one provider is the most likely way this project rots.
 */
export interface OutboundMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /** RFC 5322 threading. Omit these and replies orphan in the recipient's client. */
  inReplyTo?: string;
  references?: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  messageId: string;
}

export interface Sender {
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}
