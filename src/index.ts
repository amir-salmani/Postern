import { handleApi } from "./api";
import { handleInbound } from "./inbound";
import type { Env } from "./types";

/**
 * Mail arrives at /api/inbound as a Resend webhook and is read through
 * /api/*. Static assets in web/ are served by Cloudflare before the Worker
 * runs, so page loads cost nothing against the free plan's 100k daily
 * invocations — only /api/* requests are billed.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    // Checked before handleApi, which requires an Access session. Resend
    // cannot log in, so this route authenticates by signature instead.
    if (url.pathname === "/api/inbound") {
      return handleInbound(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
