import type { Env } from "./types";

/**
 * Cloudflare Access verification.
 *
 * Access protects a *hostname*. It does not protect the Worker, so anyone who
 * learns the workers.dev URL would otherwise read the whole mailbox. Every API
 * request therefore verifies the Access JWT itself.
 *
 * This fails closed. If the Access variables are missing or the certificates
 * can't be fetched, no request is authorised — a misconfigured deploy must
 * serve nothing rather than serve everything.
 */

export interface Identity {
  email: string;
}

interface Jwk extends JsonWebKey {
  kid: string;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache: { fetchedAt: number; keys: Record<string, CryptoKey> } | null = null;

export async function verifyAccess(request: Request, env: Env): Promise<Identity | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;

  const [rawHeader, rawPayload, rawSignature] = token.split(".");
  if (!rawHeader || !rawPayload || !rawSignature) return null;

  let header: { kid?: string; alg?: string };
  let payload: { aud?: string | string[]; exp?: number; nbf?: number; email?: string };
  try {
    header = JSON.parse(decoder.decode(base64UrlToBytes(rawHeader)));
    payload = JSON.parse(decoder.decode(base64UrlToBytes(rawPayload)));
  } catch {
    return null;
  }

  if (header.alg !== "RS256" || !header.kid) return null;

  let keys: Record<string, CryptoKey>;
  try {
    keys = await loadKeys(env.ACCESS_TEAM_DOMAIN);
  } catch (err) {
    console.error("postern: could not load Access certificates", err);
    return null;
  }

  const key = keys[header.kid];
  if (!key) return null;

  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(rawSignature),
    signed,
  );
  if (!valid) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;
  if (typeof payload.nbf === "number" && payload.nbf > nowSeconds) return null;

  // The audience tag ties this token to *this* Access application. Without
  // it, a valid token for any other app on the same team would be accepted.
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes(env.ACCESS_AUD)) return null;

  return { email: payload.email ?? "unknown" };
}

async function loadKeys(teamDomain: string): Promise<Record<string, CryptoKey>> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }

  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access certs returned ${response.status}`);

  const body = (await response.json()) as { keys?: Jwk[] };
  const keys: Record<string, CryptoKey> = {};
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid) continue;
    keys[jwk.kid] = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }

  jwksCache = { fetchedAt: Date.now(), keys };
  return keys;
}

const decoder = new TextDecoder();

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
