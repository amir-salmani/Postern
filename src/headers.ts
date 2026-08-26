import type { AuthVerdict, Folder } from "./types";

/**
 * Cloudflare stamps an Authentication-Results header on inbound mail. Reading
 * its verdict is free; re-verifying SPF/DKIM ourselves would cost more CPU
 * than the free plan gives us for the entire invocation.
 */
export function parseAuthResults(raw: string | null): AuthVerdict {
  const out: AuthVerdict = { spf: null, dkim: null, dmarc: null };
  if (!raw) return out;
  for (const key of ["spf", "dkim", "dmarc"] as const) {
    const match = raw.match(new RegExp(`\\b${key}=(\\w+)`, "i"));
    if (match) out[key] = match[1].toLowerCase();
  }
  return out;
}

/** "hi+github@example.com" -> "hi" */
export function localPart(address: string): string {
  return (address.split("@")[0] ?? "").toLowerCase().split("+")[0];
}

export function parseInboxAddresses(csv: string): string[] {
  return csv
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * A catch-all on a public domain is a spam magnet — every address that has
 * ever leaked becomes deliverable. So the catch-all is a quarantine, not an
 * inbox: mail to unknown local-parts is still kept, just not in your face.
 */
export function chooseFolder(
  envelopeTo: string,
  inboxAddresses: string[],
  auth: AuthVerdict,
): Folder {
  if (!inboxAddresses.includes(localPart(envelopeTo))) return "quarantine";
  // Only an explicit fail is a signal. Most legitimate senders publish no
  // DMARC policy at all, which reports as "none".
  if (auth.dmarc === "fail") return "quarantine";
  return "inbox";
}

export function r2KeyFor(id: string, receivedMs: number): string {
  const d = new Date(receivedMs);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}/${month}/${id}.eml`;
}

export function parseDateHeader(raw: string | null): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * A sender rule overrides the address-based default.
 *
 * An exact address beats its domain, so "quarantine everything from
 * example.com except sales@" is expressible — the common case for a vendor
 * that sends both notifications and real correspondence.
 */
export function applyRule(
  rules: Array<{ kind: string; pattern: string; action: string }>,
  sender: string,
  fallback: Folder,
): Folder {
  const address = sender.toLowerCase().trim();
  const domain = address.split("@")[1] ?? "";
  const exact = rules.find((r) => r.kind === "sender" && r.pattern === address);
  const byDomain = rules.find((r) => r.kind === "domain" && r.pattern === domain);
  const match = exact ?? byDomain;
  return (match?.action as Folder) ?? fallback;
}
