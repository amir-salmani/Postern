import type { Env } from "./types";

/**
 * Key/value settings with typed defaults.
 *
 * Preferences live in a table rather than in wrangler.jsonc because changing
 * a signature or your working hours should not require a deploy.
 */
export const DEFAULTS = {
  "signature.default": "",
  "autoreply.enabled": "false",
  "autoreply.start": "8",
  "autoreply.end": "20",
  "autoreply.timezone": "Europe/Helsinki",
  "autoreply.message":
    "Thanks for your message — it has arrived safely.\n\n" +
    "I read and reply to email between 08:00 and 20:00 Helsinki time, so you'll " +
    "hear back from me during the next working window.\n\n" +
    "If it's urgent, say so in a reply and it'll reach me sooner.",
  "autoreply.cooldown_hours": "24",
  "backup.last_ms": "0",
} as const;

export type SettingKey = keyof typeof DEFAULTS;

export async function readSettings(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all();
  const stored = Object.fromEntries(
    ((results ?? []) as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]),
  );
  return { ...DEFAULTS, ...stored };
}

export async function writeSettings(env: Env, values: Record<string, string>): Promise<void> {
  const now = Date.now();
  const statements = Object.entries(values)
    .filter(([key]) => key in DEFAULTS || key.startsWith("signature."))
    .map(([key, value]) =>
      env.DB.prepare(
        `INSERT INTO settings (key, value, updated_ms) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_ms = excluded.updated_ms`,
      ).bind(key, String(value), now),
    );
  if (statements.length) await env.DB.batch(statements);
}

/** The signature for a given From address, falling back to the default. */
export function signatureFor(settings: Record<string, string>, address: string): string {
  return settings[`signature.${address.toLowerCase()}`] || settings["signature.default"] || "";
}

/**
 * Whether `at` falls inside working hours in the configured zone.
 *
 * Uses Intl rather than a fixed offset, so this stays correct across Finland's
 * daylight-saving change instead of being an hour wrong for half the year.
 */
export function withinWorkingHours(settings: Record<string, string>, at: Date): boolean {
  const zone = settings["autoreply.timezone"] || "Europe/Helsinki";
  const start = Number(settings["autoreply.start"] ?? 8);
  const end = Number(settings["autoreply.end"] ?? 20);
  let hour: number;
  try {
    hour = Number(
      new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "numeric", hour12: false })
        .format(at),
    );
  } catch {
    hour = at.getUTCHours();
  }
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}
