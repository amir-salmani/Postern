export interface Env {
  DB: D1Database;
  RAW: R2Bucket;

  /** Domain this instance owns. */
  MAIL_DOMAIN: string;
  /** Comma-separated local-parts that reach the inbox. Everything else quarantines. */
  INBOX_ADDRESSES: string;
  /** Mailbox every inbound message is forwarded to. Empty disables the net. */
  FORWARD_TO: string;
  /** "all" (default) | "inbox" — skip quarantine | "off". */
  FORWARD_MODE?: string;

  /** Cloudflare Access team domain, e.g. "yourteam.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN: string;
  /** Application Audience tag from the Access application. */
  ACCESS_AUD: string;

  /** Address outbound mail is sent from, e.g. "hi@yourdomain.com". */
  SEND_FROM: string;
  /** Display name on outbound mail. */
  SEND_NAME: string;
  /**
   * Addresses you may send as, comma-separated local-parts. The domain is
   * always MAIL_DOMAIN — an arbitrary From would let anyone who reached this
   * API send mail as anybody.
   */
  SEND_ADDRESSES: string;
  /** Resend API key. Needs full access: sending, and reading received mail. */
  RESEND_API_KEY?: string;
  /** Svix signing secret for the Resend inbound webhook. */
  RESEND_WEBHOOK_SECRET?: string;
}

export type Folder = "inbox" | "quarantine" | "sent" | "trash";

export interface AuthVerdict {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}
