# Postern — status and what's left

Last updated 2026-09-04. Running as the only mailbox for `amirsalmani.com`
since 2026-08-20.

---

## Built and running

Verified against real traffic, not just deployed.

**Receiving.** Resend inbound (catch-all) → `email.received` webhook →
`/api/inbound`, Svix HMAC verified with a five-minute replay window. The
endpoint sits outside Cloudflare Access because Resend cannot log in, so it
authenticates itself. Message body and attachments are fetched from Resend's
Receiving API — the webhook carries metadata only.

**Storage.** Raw `.eml` and attachments in R2; headers, threading and index in
D1. R2 is written before D1, so a failure leaves an orphaned object rather
than a row pointing at nothing.

**Reading.** `mail.amirsalmani.com` behind Cloudflare Access, JWT verified in
the Worker on every request and failing closed. MIME parsed in the browser.
Bodies render in a sandboxed iframe under `default-src 'none'` with remote
images opt-in per message.

**Sending.** Resend, four identities, From picker validated server-side
against an allow-list. Signature shown in the composer rather than appended
invisibly. Replies carry `In-Reply-To` and `References`. Every sent message is
written back as a stored copy.

**Forwarding.** Every message forwarded to an existing mailbox, tracked per
message via `forwarded_ms` so a re-sync cannot duplicate and a recovery cannot
be silently skipped. The scheduled job drains anything unforwarded.

**Organising.** Inbox / quarantine / sent / trash. Catch-all lands in
quarantine, not the inbox. Sender and domain rules applied on arrival *and*
retroactively to mail already held. Trash purges after 30 days on our own
clock, leaving a tombstone so a sync cannot resurrect it.

**Finding.** D1 FTS5 over subject, sender and body, indexed at ingest where
the body is already a decoded string.

**Automation.** Out-of-hours auto-reply (RFC 3834 compliant — declines
anything auto-submitted, bulk, list-shaped or noreply-addressed, and rate
limited per sender). Unread reminder after six hours. Nightly D1 → R2 backup
with 30-day retention. All on one 30-minute cron.

**Operating.** Versioned migrations applied through D1's own tracking.
`scripts/restore.mjs`, exercised once against a scratch database — 63/63 rows.
Quota guard reserving the daily send allowance by priority. Dashboard with
usage meters, volume chart and event log. Delivery marks that stop at handoff
and say so.

**Deliverability.** DKIM, SPF and DMARC at `p=quarantine`. Click and open
tracking off — link rewriting is the shape of a phishing link and breaks for
anyone running a content blocker.

**Cost: €0/month.** Cloudflare free tier plus Resend free tier.

---

## What's left

### Worth doing next

**Bounce surfacing.** `email.bounced` and `email.failed` are recorded and the
delivery mark shows a failure on the message, but nothing tells you. A message
that never arrived should not require opening the dashboard to discover.
Cheapest fix: fold recent failures into the existing reminder digest — one
send, no new machinery.

**Attachments on outbound.** Compose is text-only. Inbound capture works, so
the storage half already exists.

**Forward failures are invisible.** A failed forward leaves `forwarded_ms`
unset and the drain retries, which is correct — but a forward failing
repeatedly produces nothing except Worker logs.

### Deferred on purpose

**MTA-STS and TLS-RPT.** Would signal a well-run domain and enforce TLS on
inbound. Not done because MTA-STS needs a policy file hosted at a subdomain,
and a broken policy file causes *inbound delivery failures*. Real moving parts
for marginal gain — worth doing only when everything else is boring.

**Attachment budget on forwards.** Capped at 1 MB total. Base64 encoding is
the one genuinely CPU-bound step in the Worker and the free plan allows 10 ms.
Larger files are named in the trailer instead. Liftable on a paid plan.

**Tombstone pruning.** Nothing removes them. Harmless for years at this
volume, but unbounded is unbounded.

### Nice to have

- Per-alias signatures (the storage supports it; only the default is used)
- Snooze
- Keyboard shortcut overlay (`?`)
- Multiple domains on one instance
- Export the whole mailbox as `.eml`
- Encryption at rest — the browser already parses, so the server never needs a
  decoded body. Honest limit: Resend terminates SMTP, so this would be
  encryption at rest, not end-to-end

---

## Decisions worth not relitigating

**Why not Cloudflare Email Routing for inbound?** It is free to receive *and*
free to forward, where Resend bills both against one 100/day allowance. That
is a genuine advantage and the reason to switch back if quota ever binds. It
was given up for single-vendor simplicity, knowingly.

**Why not self-host the MTA?** Deliverability is IP reputation; IP reputation
is not portable and is unbuildable at personal volume. If a real mail server
ever happens, the split is: self-host receiving and storage, smarthost
outbound. All the difficulty lives in the sending half and you can decline it.

**Why no polling in the client?** Inbound mail and the UI draw on the same
100k/day invocation budget. A background timer asking "anything new?" would
spend the quota that receiving mail needs.

**Why is the tick not a read receipt?** Because no sender can see opens or
inbox placement. The delivery event ends at the receiving server's front door,
and a mark implying otherwise would be a lie dressed as a feature.
