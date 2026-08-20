export interface Env {
  DB: D1Database;
  RAW: R2Bucket;

  /** Domain this instance owns. */
  MAIL_DOMAIN: string;
  /** Comma-separated local-parts that reach the inbox. Everything else quarantines. */
  INBOX_ADDRESSES: string;
  /** Verified Email Routing destination. Empty disables the safety net. */
  FORWARD_TO: string;

  /** Cloudflare Access team domain, e.g. "yourteam.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN: string;
  /** Application Audience tag from the Access application. */
  ACCESS_AUD: string;
}

export type Folder = "inbox" | "quarantine" | "sent";

export interface AuthVerdict {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}
