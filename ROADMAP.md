# Postern — what's left

Status 2026-08-23, after three days of real mail.

Working and verified against live traffic: receive → store → read → reply,
quarantine routing, full-text search over bodies, tombstoned deletes that
survive sync, Trash with a 30-day purge, attachment capture, always-forward
to Gmail, the dashboard, and the unread reminder.

## Done

Threading, inbound attachments, FTS5 search, Trash with a 30-day purge,
sender rules applied retroactively, quarantine moves in both directions,
signatures shown in the composer, out-of-hours auto-reply, daily backups to
R2, versioned migrations, always-forward to an existing mailbox with a
self-healing drain, delivery marks on sent mail, DMARC at p=quarantine, and
click/open tracking turned off.

## Worth doing next



**A restore path.** Backups write nightly to R2 and nothing has ever read one
back. An untested backup is a belief, not a backup — a `restore` script that
rebuilds D1 from an NDJSON snapshot, exercised once against a scratch
database.

**Bounce surfacing.** `email.bounced` and `email.failed` are recorded and
otherwise silent. Delivery marks show it on the message, but nothing tells
you — a message that never arrived should not require opening the dashboard
to discover.

**MTA-STS and TLS-RPT.** Would signal a properly run domain and enforce TLS
on inbound. Deliberately deferred: MTA-STS needs a policy file hosted at a
subdomain, and a broken policy file causes inbound delivery failures. Real
moving parts for marginal benefit — worth doing only when the mailbox is
otherwise boring.

**Attachments on outbound.** Compose is still text-only.

## Should do, less visible

**Forward failures are logged and invisible.** If a forward fails the message
is still stored, but nothing surfaces the failure except the Worker log.

**Bounce handling.** email.bounced and email.failed are recorded and
otherwise ignored — a message that never arrived looks like one that did
unless you open the dashboard.

**Quarantine review.** No way to move a message back to the inbox from the
UI, though the API supports it. A false positive is currently stuck.

**Attachment budget on forwards.** Capped at 1 MB total because base64 is the
one genuinely CPU-bound step and the free plan allows 10ms. Larger files are
named in the trailer instead. Liftable on a paid plan.

**Tombstone growth.** Nothing prunes them. Harmless for years at this volume.

## Nice to have

- Keyboard shortcut overlay (`?`)
- Encryption at rest — the browser already parses, so the server never needs
  to see a decoded body. Honest limit: Resend terminates SMTP, so this is
  encryption at rest, not end-to-end
- Multiple domains on one instance
- Export the whole mailbox as .eml

## Elsewhere, not in this repo

**Write the post.** Draft is at `AmirSalmani/docs/post-what-broke.md` — the
ledger of what broke, which is the part worth reading. Publish on the site,
then link it from the Projects entry.
