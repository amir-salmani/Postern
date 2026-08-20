import { handleApi } from "./api";
import { handleEmail } from "./email";
import type { Env } from "./types";

/**
 * One Worker, two doors.
 *
 * `email` receives mail from Email Routing. `fetch` serves the read API.
 * Static assets in web/ are served by Cloudflare before the Worker runs, so
 * page loads cost nothing against the free plan's 100k daily invocations —
 * only /api/* requests are billed.
 */
export default {
  email: handleEmail,

  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
