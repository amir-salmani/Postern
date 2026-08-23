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

## Planned features

### Default signature

Per identity, not one global string — the From picker already offers `hi@`,
`jobs@` and `contact@`, and a signature that says the wrong role on the wrong
alias is worse than none.

- Store as `SIGNATURE_<localpart>` vars, falling back to a default.
- Insert **client-side**, into the compose textarea, so it is visible and
  editable before sending. A server-side append is invisible until it has
  already gone out.
- Delimit with `-- ` on its own line (RFC 3676). Clients collapse it and
  quoting strips it; without the delimiter every reply accumulates copies.
- On reply, the signature goes **above** the quoted text, not at the bottom.
- Never on forwards, reminders or auto-replies — those are machine mail, and
  a signature on them reads as a person who isn't there.

### Auto-reply and working hours

The stated goal is an 8am–8pm window with an out-of-hours reply, and the same
mechanism covers vacation mode: a condition, a message, and a decision to send.

Fire it **on receipt**, in the inbound webhook — a cron would reply up to
thirty minutes late, which defeats the point of saying "I'm not here."

The condition is easy. The rules that stop it becoming a spam cannon are the
actual work, and every one of them has burned someone:

- **Never reply to bulk mail.** Skip anything with `Precedence: bulk|list|junk`,
  `List-Unsubscribe`, or `Auto-Submitted` other than `no`. Without this you
  auto-reply to every newsletter and, worse, to mailing lists — which is how
  a responder ends up mailing a few hundred strangers.
- **Never reply to `noreply@`, `no-reply@`, `donotreply@`** or anything that
  matches that shape. Nobody reads it and some bounce back.
- **Never reply to quarantine.** Replying to spam confirms the address is
  live and reaches a human. Quarantine is exactly the mail you must stay
  silent about.
- **Never reply to your own domain**, or two responders ping-pong forever.
- **Once per sender per window**, not once per message — otherwise a chatty
  correspondent gets ten identical replies in an afternoon. Needs a table:
  `autoreply_log(address TEXT PRIMARY KEY, last_sent_ms INTEGER)`.
- **Set `Auto-Submitted: auto-replied`** on the outgoing reply, so other
  people's responders know not to answer it.

Two more that are specific to this setup:

- **Time zone, not offset.** "8am" means Europe/Helsinki, which is UTC+2 or
  UTC+3 depending on the date. Store the zone and resolve it at send time; a
  hardcoded offset silently drifts by an hour twice a year.
- **Quota.** Every auto-reply is a send against the same free-tier allowance
  as your real mail and your forwards. Worth a cap — a daily ceiling on
  auto-replies, after which it stays quiet rather than eating the allowance.

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
