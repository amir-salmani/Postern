# Postern

**Personal email on Cloudflare's free tier. Bring a domain.**

Mail for your domain is received, stored in your own D1 database and R2
bucket, and read through a web client you deploy to your own Cloudflare
account. No provider holds your mail. At personal volume it costs nothing.

I run my own mail on this. Everything below was shaped by that, and the
constraints are more interesting than the feature list.

## Three constraints that decided the design

**Workers Free allows 10 ms of CPU per invocation.** Parsing a multi-megabyte
MIME message does not fit in that, and a handler that runs out of CPU loses
the message. So the server parses nothing: it stores the raw `.eml` and the
browser parses it. A useful side effect is that the server never handles a
decoded message body.

**A handler that returns without forwarding, storing or rejecting drops the
mail silently.** Silent loss is the worst possible failure for a mailbox, so
every path ends in one of those three, and the forward to an existing mailbox
fires *before* storage — a bug in this code cannot cost you an email.

**Free tiers meter what you least expect.** The mail provider bills inbound
and outbound against a single daily allowance, so on a catch-all domain a
spam burst can consume the quota your outgoing mail needs. The dashboard
shows that number because it is the one worth watching.

## What it does

Mail for your domain is received by Resend, stored in *your* D1 database and
*your* R2 bucket, and read through a web UI you deploy to your own Cloudflare
account. Outbound goes through a pluggable sender. No provider holds your
mail, and nothing here costs money at personal volume.

**Status: in daily use.** Receives, stores, reads, replies, searches, and
forwards every message on to your existing mailbox. See `ROADMAP.md` for
what's still missing.

## How it works

```
sender ──► MX (Resend inbound, catch-all)
             └─ email.received webhook ──► /api/inbound  ── Svix signature verified
                   ├─ fetch body ◄── Resend Receiving API
                   ├─ .eml ─────────► R2   (10 GB free)
                   ├─ header row ───► D1   (5 GB free)
                   └─ every other event ──► D1 events table

browser ──► static assets (free, never touch the Worker)
             └─ /api/* ──► Worker: fetch()  ── Access JWT verified
                              ├─ list   ◄── D1
                              ├─ raw    ◄── R2 ──► parsed in the browser
                              └─ send   ──► Resend
```

Three constraints produced this shape, and it's worth knowing them before
changing anything:

**No MIME parsing on the server.** Workers Free allows 10 ms of CPU per
invocation, which a multi-megabyte message would exhaust. Resend delivers
already-parsed content, and the raw `.eml` is reassembled and stored for the
browser to render. Server CPU stays near zero regardless of message size.

**The webhook is not behind Access.** Resend cannot log in, so `/api/inbound`
is routed before the Access check and authenticates itself by verifying the
Svix HMAC over the raw body, rejecting anything unsigned or older than five
minutes. It needs a **Bypass** policy scoped to that path — see Setup.

**Nothing is lost if the webhook fails.** Resend stores received mail whether
or not your endpoint answered, and retries. `POST /api/backfill` (the *Sync*
button) pulls anything that was missed.

**The catch-all is a quarantine, not an inbox.** Every address that has ever
leaked from your domain is deliverable, so mail to unknown local-parts is
stored out of the way rather than in front of you. Addresses listed in
`INBOX_ADDRESSES` reach the inbox; everything else waits in quarantine.

## Delivery marks

Sent mail carries a tick showing how far it got: one for accepted by the
provider, two for accepted by the recipient's mail server, an alert for a
bounce. Hovering says what each means.

They stop at handoff on purpose. **No sender can see whether a message was
opened or whether it landed in the inbox or in spam** — the delivery event
ends at the receiving server's front door. A tick that implied otherwise
would be a lie dressed as a feature, so the tooltip says so explicitly.

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

Requires a domain on Cloudflare and a Resend account.

```bash
npm install

# Storage
npx wrangler d1 create postern           # put the id into wrangler.jsonc
npx wrangler r2 bucket create postern-raw
npm run schema

# Config: set MAIL_DOMAIN, INBOX_ADDRESSES and SEND_FROM in wrangler.jsonc
npm run deploy

npx wrangler secret put RESEND_API_KEY       # needs full access, not send-only
npx wrangler secret put RESEND_WEBHOOK_SECRET
npx wrangler secret put FORWARD_TO           # optional: BCC of sent mail
```

In Resend: verify your domain, enable **Receiving**, and add a webhook for
`email.received` pointing at `https://mail.yourdomain.com/api/inbound`.

In Cloudflare Zero Trust, protect the app with Access — then add a **second**
self-hosted application scoped to the path `api/inbound` with a single
**Bypass / Everyone** policy. Access matches the most specific path first, so
the webhook gets through while the rest of the UI stays gated.

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
- **Phase 3 — compose and reply.** ✅ Via `src/senders/`, Resend by default.
  Sets `In-Reply-To` and `References`, and writes a copy of every sent message
  back to D1 — Resend has no notion of your mailbox, so without that your own
  sent mail exists nowhere you can read it.
- **Phase 4 — search.** ✅ D1 FTS5 over subject, sender and body, indexed at
  ingest where the body is already a decoded string.
- **Phase 5 — signatures.** Planned. Per-identity, appended client-side so
  it stays editable, `-- ` delimited so clients can collapse it.
- **Phase 6 — auto-reply / working hours.** Planned. Harder than it looks —
  see ROADMAP.md for the rules that stop a vacation responder becoming a
  spam cannon.
- **Phase 7 — encryption at rest.** The browser already does the parsing, so
  the server never needs to see a decoded body. Encrypt the `.eml` before it
  reaches R2. Honest limit: Resend terminates inbound SMTP, so this is
  encryption at rest, not end-to-end.


## Free tier headroom

| Resource | Free | Personal use |
|---|---|---|
| Worker invocations | 100k/day | inbound mail + UI opens |
| D1 | 5 GB, 5M row reads/day | ~1 row per message |
| R2 | 10 GB | years of `.eml` at personal volume |
| Resend free tier | 3,000/mo, 100/day | **shared between inbound and outbound** |

Two things to watch. A UI that polls for new mail would burn Worker
invocations for nothing, which is why the client refreshes on focus and never
on a timer. And Resend's free tier counts inbound *and* outbound against one
100/day allowance — on a catch-all domain, a spam wave can consume the
allowance your outgoing mail needs.

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
