# Postern

**Personal email on Cloudflare's free tier. Bring a domain.**

Mail for your domain is received, stored in your own D1 database and R2
bucket, and read through a web client you deploy to your own Cloudflare
account. No provider holds your mail. At personal volume it costs nothing.

In daily use on `amirsalmani.com` since August 2026.

![The Postern dashboard: unread and storage counters, free-tier usage against
Resend's shared inbound/outbound allowance, and fourteen days of mail volume](docs/screenshot.png)

*Rendered with placeholder data — a screenshot of a real inbox would publish
other people's names.*

---

## Why it looks like this

Three constraints decided the design. They are more interesting than the
feature list, and worth knowing before changing anything.

**Workers Free allows 10 ms of CPU per invocation.** Parsing a multi-megabyte
MIME message does not fit in that, and a handler that exhausts its CPU loses
the message. So the server parses nothing: it stores the raw `.eml` and the
browser parses it on read. A useful side effect is that the server never
handles a decoded message body.

**A handler that returns without storing, forwarding or rejecting drops the
mail silently.** Silent loss is the worst failure a mailbox has, so every path
ends in one of those three — and mail is forwarded to your existing mailbox
*before* it is stored. A bug in this code cannot cost you an email.

**The free tier meters what you least expect.** Resend bills inbound and
outbound against a single 100/day allowance, so on a catch-all domain a spam
burst can consume the quota your outgoing mail needs. The dashboard shows that
number because it is the one worth watching.

## How it works

```
sender ──► MX (Resend inbound, catch-all)
             └─ email.received webhook ──► /api/inbound   Svix HMAC verified
                   ├─ body ◄── Resend Receiving API
                   ├─ .eml + attachments ──► R2      (10 GB free)
                   ├─ headers + index ─────► D1      (5 GB free)
                   ├─ forward ─────────────► your existing mailbox
                   └─ all other events ────► D1 events table

browser ──► static assets                   served by Cloudflare, no Worker
             └─ /api/* ──► Worker            Access JWT verified
                            ├─ list, search ◄── D1
                            ├─ raw          ◄── R2 ──► parsed in the browser
                            └─ send         ──► Resend
```

A scheduled job every 30 minutes backfills anything the webhook missed,
forwards anything not yet forwarded, empties expired trash, snapshots the
database to R2, and sends the unread reminder.

## Design notes

**The catch-all is a quarantine, not an inbox.** Every address that has ever
leaked from your domain is deliverable. Local-parts you list reach the inbox;
everything else waits in quarantine where you can review it.

**Sender rules apply retroactively.** Blocking a sender also moves the mail
you already have from them — a rule that only affected future mail would leave
you hand-deleting the backlog that made you write the rule.

**Deleting is two-stage.** Trash keeps your copy for 30 days on *your* clock.
Only permanent deletion removes the object, and it leaves a tombstone — the
provider still has its copy for 30 days and would otherwise restore yours on
the next sync.

**Delivery marks stop at handoff.** One tick means the provider accepted it,
two means the recipient's mail server did. No sender can see whether a message
was opened or whether it landed in spam, and the tooltips say so. Click and
open tracking are off: rewriting a link through a redirect domain is the shape
of a phishing link, and it breaks for anyone running a content blocker.

## Security model

**Message bodies are untrusted code from strangers.** They render in an iframe
with `sandbox` and no `allow-scripts`, under `default-src 'none'`. Remote
images — which are read receipts — are blocked until you press a button, per
message. Attachments are served from your bucket and never executed.

**Cloudflare Access protects a hostname, not a Worker.** Anyone who learned
the `workers.dev` URL would otherwise read the whole mailbox, so `src/access.ts`
verifies the Access JWT on every API request: RS256 against the team's
published certificates, plus `exp`, `nbf` and the audience tag. It fails
closed — unset variables authorise nothing. Disable the `workers.dev` route
once a custom hostname exists.

**`/api/inbound` is deliberately outside Access**, because Resend cannot log
in. It authenticates itself by verifying the Svix HMAC over the raw body and
rejects anything unsigned or older than five minutes.

## Setup

Requires a domain on Cloudflare and a Resend account.

```bash
npm install

npx wrangler d1 create postern            # copy the id into wrangler.jsonc
npx wrangler r2 bucket create postern-raw
npx wrangler d1 migrations apply postern --remote

# Set MAIL_DOMAIN, INBOX_ADDRESSES, SEND_FROM and SEND_ADDRESSES
# in wrangler.jsonc, then:
npm run deploy

npx wrangler secret put RESEND_API_KEY        # full access, not send-only
npx wrangler secret put RESEND_WEBHOOK_SECRET
npx wrangler secret put FORWARD_TO            # your existing mailbox
```

**In Resend:** verify the domain, enable Receiving, and add a webhook for
`email.received` pointing at `https://mail.yourdomain.com/api/inbound`. Turn
click and open tracking **off**.

**In Cloudflare Zero Trust:** create a self-hosted Access application for
`mail.yourdomain.com` with a policy allowing your own email. Then create a
**second** application scoped to the path `api/inbound` with a single
**Bypass / Everyone** policy — Access matches the most specific path first, so
the webhook gets through while the UI stays gated. Copy the first
application's **AUD tag** and your team domain into `ACCESS_AUD` and
`ACCESS_TEAM_DOMAIN`, then redeploy.

**DNS:** publish DMARC. With every sender routed through one verified
provider, `p=quarantine` is safe immediately.

```
_dmarc   TXT   v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com
```

## Verifying a deploy

Schema changes are the thing to check properly — confirm with a query, never
by reading a command's output.

```bash
npx wrangler d1 execute postern --remote \
  --command "SELECT COUNT(*) FROM messages"

npx wrangler tail          # live logs while you send yourself a test message
```

The first real message should appear in the UI *and* in the mailbox you set
as `FORWARD_TO`.

## Free tier headroom

| Resource | Free allowance | What uses it |
|---|---|---|
| Worker invocations | 100k/day | inbound mail and API calls; static assets are free |
| D1 | 5 GB, 5M row reads/day | roughly one row per message |
| R2 | 10 GB | years of `.eml` at personal volume |
| Resend | 3,000/mo, 100/day | **shared between inbound and outbound** |

The client never polls. Inbound mail and the UI draw on the same invocation
budget, so a background timer asking "anything new?" would spend the quota
that receiving mail needs.

## Development

```bash
npm install
npm run vendor      # refresh web/vendor/postal-mime from node_modules
npm run typecheck
npm run build       # dry-run bundle, no deploy
npm run dev
```

`web/vendor/` is committed on purpose: a mail client should not fetch its
parser from a CDN at runtime, and there is no build step to add one.

Roadmap and known gaps: [ROADMAP.md](ROADMAP.md).

## Licence

**Personal, non-commercial use** — [PolyForm Noncommercial 1.0.0](LICENSE).

You may run it, modify it and share it for any non-commercial purpose. You may
not sell it, host it as a paid service, or use it in a commercial product.

`web/vendor/postal-mime/` is vendored from
[postal-mime](https://github.com/postalsys/postal-mime) under MIT-0; its
licence travels with it.
