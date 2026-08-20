# Postern — what's left

Status as of 2026-08-21. Working end to end: receive → store → read → reply,
plus quarantine routing, event log, dashboard, 30-minute fetch, and a
six-hour unread reminder.

## Worth doing next

**Threading in the UI.** `thread_id` is captured on every message and nothing
reads it. A conversation currently shows as unrelated rows. This is the
largest gap between Postern and a mail client people expect, and the data is
already there.

**Attachment handling on inbound.** Resend exposes attachments through a
separate API that ingest doesn't call yet, so an attached file is currently
visible only if it was inline. `has_attach` is guessed from Content-Type.

**Attachments on outbound.** Compose is text-only.

**Real search.** `LIKE` over subject and sender only — bodies aren't indexed,
because they live in R2 and are never parsed server-side. An FTS5 table
populated on first open would fix it without adding server CPU.

## Should do, less visible

**Rate-limit the reminder against quota.** It sends unconditionally. If the
daily allowance is nearly spent, sending a reminder can consume the headroom
your actual mail needs.

**Bounce handling.** `email.bounced` and `email.failed` are logged and
otherwise ignored. A message you sent that never arrived looks identical to
one that did, unless you open the dashboard.

**Quarantine review.** No way to move a message from quarantine to inbox in
the UI, though the API supports it. Right now a false positive is stuck.

**Tombstone growth.** Nothing prunes them. Harmless for years at this volume,
but unbounded is unbounded.

## Nice to have

- Per-alias identity — reply from the address it was sent to, not always SEND_FROM
- Keyboard shortcut overlay (`?`)
- Encryption at rest (Phase 5) — the browser already parses, so the server
  never needs to see a decoded body. Note the honest limit: Resend terminates
  SMTP, so this is encryption at rest, not end-to-end
- Multiple domains on one instance
- Export — download the whole mailbox as .eml files

## Elsewhere, not in this repo

**Update amirsalmani.com** to list Postern as a project. The site's Projects
nav item is still "soon". Postern is the strongest thing to put behind it:
self-hosted email, own infrastructure, and it matches the site's own brand.
