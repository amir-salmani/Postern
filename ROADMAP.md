# Postern — what's left

Status 2026-08-23, after three days of real mail.

Working and verified against live traffic: receive → store → read → reply,
quarantine routing, full-text search over bodies, tombstoned deletes that
survive sync, Trash with a 30-day purge, attachment capture, always-forward
to Gmail, the dashboard, and the unread reminder.

## Worth doing next

**Rules / filters.** The strongest signal from real use: six of the first
seven messages were notifications, and all six went straight to the bin.
Sender or subject rules that auto-trash or auto-label would remove most of
the triage. Bigger day-to-day win than anything else on this list.

**Threading in the UI.** Built but still unexercised — no real back-and-forth
has arrived. Note that repeated notifications sharing a subject are correctly
*not* threaded, since they carry no In-Reply-To.

**Attachments on outbound.** Inbound capture works; compose is still
text-only.

**Gmail "Send mail as".** Resend's free tier includes an SMTP relay, so Gmail
can send as hi@amirsalmani.com directly. Combined with always-forward, that
closes the loop: read and reply entirely from Gmail, with Postern as storage
and archive. Removes the last reason Postern has to be a daily destination.

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

**Update amirsalmani.com** to list Postern as a project. The Projects nav item
is still "soon".
