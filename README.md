# Postern

Personal email on your own infrastructure. Bring a domain.

Mail for your domain is received by Cloudflare Email Routing, stored in *your*
D1 database and *your* R2 bucket, and read through a web UI you deploy to your
own Cloudflare account. Outbound goes through a pluggable sender. No provider
holds your mail, and nothing here costs money at personal volume.

**Status: Phase 2 — ingest and read.** No sending yet. Run it alongside your
existing mailbox for a few weeks and prove it captures mail reliably before
anything depends on it.

## How it works

```
sender ──► MX (Cloudflare Email Routing, free)
             └─ catch-all rule ──► Worker: email()
                   ├─ raw .eml ─────► R2   (10 GB free)
                   ├─ header row ───► D1   (5 GB free)
                   └─ forward() ────► your existing mailbox   ← the net

browser ──► static assets (free, never touch the Worker)
             └─ /api/* ──► Worker: fetch()  ── Access JWT verified
                              ├─ list ◄── D1
                              └─ raw  ◄── R2 ──► parsed in the browser
```

Three constraints produced this shape, and it's worth knowing them before
changing anything:

**No MIME parsing on the server.** Workers Free allows 10 ms of CPU per
invocation. Parsing a multi-megabyte message with attachments blows through
that and the message is lost. So ingest stores the raw `.eml` untouched and
reads only headers Cloudflare has already parsed. The browser does the
parsing later, where CPU is free and plentiful.

**The forward is permanent, not temporary.** Every message is also delivered
to your existing mailbox. That keeps this project *additive* — a bug here
can't cost you an email, and you keep a mobile client and a spam filter for
free while you decide whether to trust it. Turn it off only when you're sure.

**The catch-all is a quarantine, not an inbox.** Every address that has ever
leaked from your domain is deliverable, so mail to unknown local-parts is
stored out of the way rather than in front of you. Addresses listed in
`INBOX_ADDRESSES` reach the inbox; everything else waits in quarantine.

## Reading mail safely

HTML email is untrusted code that arrived from a stranger, and remote images
are read receipts. So message bodies render inside an iframe with `sandbox`
and no `allow-scripts`, under a CSP of `default-src 'none'` that blocks every
remote resource. Loading remote images is a button you press per message, not
a default. Attachments are rendered from in-memory blobs and never executed.

Cloudflare Access protects a hostname, not a Worker — anyone who learned the
`workers.dev` URL would otherwise read the whole mailbox. So `src/access.ts`
verifies the Access JWT on every API request: RS256 signature against the
team's published certificates, plus `exp`, `nbf` and the application audience
tag. It fails closed. If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` are unset, no
request is authorised.

Also disable the `workers.dev` route once you have a custom hostname, so the
Access policy is the only way in.

## Verify this first

The design assumes `message.forward()` still works after `message.raw` has
been buffered. The raw stream is documented as single-use, and it is not
documented whether forwarding consumes it. **The first real message through
this Worker must confirm the forward arrived.**

If it doesn't, the fix is one of:

- move the `forward()` call above the `arrayBuffer()` read, or
- drop the buffering and forward only, then re-fetch the message another way.

Run `npx wrangler tail` while you send yourself a test message, and check the
destination mailbox before trusting anything else in here.

## Setup

Requires a domain on Cloudflare and a verified Email Routing destination
address.

```bash
npm install

# Storage
npx wrangler d1 create postern           # put the id into wrangler.jsonc
npx wrangler r2 bucket create postern-raw
npm run schema

# Config: set MAIL_DOMAIN, INBOX_ADDRESSES and FORWARD_TO in wrangler.jsonc
npm run deploy
```

Then create a Cloudflare Access application for the hostname you deployed to,
and copy its **Application Audience (AUD) tag** and your team domain into
`ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` in `wrangler.jsonc`. Redeploy.

Then in the dashboard, **Email Routing → Routing Rules**, set the catch-all
action to *Send to a Worker* → `postern-ingest`.

`FORWARD_TO` must be an address you have already verified as an Email Routing
destination, or forwarding fails silently.

## Checking it works

```bash
npx wrangler tail                                    # live logs
npx wrangler d1 execute postern --remote \
  --command "SELECT received_ms, folder, envelope_from, subject FROM messages ORDER BY received_ms DESC LIMIT 10"
```

## Roadmap

- **Phase 1 — ingest.** ✅ Store to D1 + R2, forward to your mailbox.
- **Phase 2 — read-only UI.** ✅ Behind Cloudflare Access, MIME parsed
  client-side with a vendored `postal-mime`. Static assets bypass the Worker,
  so page loads cost no quota. No polling — refresh on focus, throttled.
- **Phase 3 — compose and reply.** Via `src/senders/`, Resend by default.
  Must set `In-Reply-To` and `References`, and write a copy of every sent
  message back to D1, or your own sent mail is invisible.
- **Phase 4 — search.** D1 FTS5 over subject, sender and body text, populated
  lazily on first open.
- **Phase 5 — encryption at rest.** The browser already does the parsing, so
  the server never needs to see a decoded body. Encrypt the `.eml` before it
  reaches R2. Note the honest limit: Cloudflare terminates inbound SMTP, so
  this is encryption at rest, not end-to-end.

## Free tier headroom

| Resource | Free | Personal use |
|---|---|---|
| Worker invocations | 100k/day | inbound mail + UI opens |
| D1 | 5 GB, 5M row reads/day | ~1 row per message |
| R2 | 10 GB | years of `.eml` at personal volume |
| Inbound message size | 25 MiB | Email Routing hard cap |

The one way to blow this is a UI that polls for new mail. Don't build one —
inbound mail and the UI share the same 100k/day, so polling can starve your
own ingest. Push from the `email()` handler instead; that invocation is
already happening.

## Development

```bash
npm install
npm run vendor      # refresh web/vendor/postal-mime from node_modules
npm run typecheck
npm run build       # dry-run bundle, no deploy
npm run dev
```

`web/vendor/` is committed on purpose. A mail client should not fetch a
parser from a CDN at runtime, and there is no build step to add one.

## Licence

MIT.

`web/vendor/postal-mime/` is vendored from [postal-mime](https://github.com/postalsys/postal-mime), MIT-0, licence included alongside it.
