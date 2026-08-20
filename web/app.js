import PostalMime from "./vendor/postal-mime/postal-mime.js";

/**
 * Postern — client.
 *
 * Two rules shape this file:
 *
 *   1. No polling. Inbound mail and this UI share one 100k/day pool of Worker
 *      invocations, so a background timer asking "anything new?" can starve
 *      the handler that actually receives your mail. The list refreshes when
 *      you return to the tab and when you ask it to. Nothing else.
 *
 *   2. Parsing happens here, not on the server. Workers Free allows 10ms of
 *      CPU per request, which a large MIME message would exhaust. The browser
 *      has no such limit.
 */

const state = {
  folder: "inbox",
  cursor: null,
  messages: [],
  selected: null,
  parsed: null,
  allowRemote: false,
  showSource: false,
  compose: null,
};

const el = (id) => document.getElementById(id);

async function api(path, options) {
  const response = await fetch(`/api${path}`, options);
  if (response.status === 401) {
    throw new Error("Not authorised. Your Access session may have expired — reload the page.");
  }
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response;
}

/**
 * Every webhook Resend has sent us. Delivery, bounce, open and complaint
 * events are the only feedback there is on outbound mail, so they get their
 * own view rather than being invisible in the database.
 */
async function loadEvents() {
  state.folder = "events";
  el("messages").replaceChildren();
  el("more").classList.add("hidden");
  clearReader();
  el("list-status").textContent = "Loading…";

  try {
    const data = await (await api("/events")).json();
    const list = el("messages");
    for (const event of data.events) {
      const item = document.createElement("li");
      item.classList.add("event");

      const type = document.createElement("span");
      type.className = "from";
      type.textContent = event.type;

      const summary = document.createElement("span");
      summary.className = "subject";
      summary.textContent = event.summary || event.email_id || "";

      const when = document.createElement("time");
      when.className = "when mono";
      when.textContent = shortDate(event.created_ms);

      item.append(type, summary, when);
      list.append(item);
    }
    el("list-status").textContent = data.events.length ? "" : "No events yet.";
  } catch (err) {
    el("list-status").textContent = err.message;
  }
}

async function loadFolder(folder, { append = false } = {}) {
  if (folder === "events") return loadEvents();
  if (!append) {
    state.folder = folder;
    state.cursor = null;
    state.messages = [];
    el("messages").replaceChildren();
    clearReader();
  }
  el("list-status").textContent = "Loading…";

  const query = new URLSearchParams({ folder: state.folder });
  if (append && state.cursor) query.set("before", String(state.cursor));

  try {
    const data = await (await api(`/messages?${query}`)).json();
    state.messages.push(...data.messages);
    state.cursor = data.nextCursor;
    renderList(data.messages);
    el("more").classList.toggle("hidden", !data.nextCursor);
    el("list-status").textContent = state.messages.length ? "" : "Nothing here.";
  } catch (err) {
    el("list-status").textContent = err.message;
  }
}

function renderList(messages) {
  const list = el("messages");
  for (const message of messages) {
    const item = document.createElement("li");
    item.dataset.id = message.id;
    if (!message.seen) item.classList.add("unseen");

    // textContent throughout — every value here came from an email, and an
    // email is hostile input.
    const from = document.createElement("span");
    from.className = "from";
    from.textContent = displayFrom(message);

    const subject = document.createElement("span");
    subject.className = "subject";
    subject.textContent = message.subject || "(no subject)";

    const when = document.createElement("time");
    when.className = "when mono";
    when.textContent = shortDate(message.received_ms);

    item.append(from, subject, when);
    if (message.has_attach) item.append(badge("attachment"));
    if (message.dmarc === "fail") item.append(badge("dmarc fail", "warn"));

    item.addEventListener("click", () => openMessage(message));
    list.append(item);
  }
}

function badge(text, kind = "") {
  const span = document.createElement("span");
  span.className = `badge ${kind}`.trim();
  span.textContent = text;
  return span;
}

async function openMessage(message) {
  state.selected = message;
  state.allowRemote = false;
  state.showSource = false;

  el("reader-empty").classList.add("hidden");
  el("compose").classList.add("hidden");
  el("reader").classList.remove("hidden");
  el("subject").textContent = message.subject || "(no subject)";
  el("from").textContent = message.header_from || message.envelope_from;
  el("to").textContent = message.envelope_to;
  el("date").textContent = new Date(message.received_ms).toLocaleString();
  el("auth").textContent = `spf=${message.spf ?? "-"} dkim=${message.dkim ?? "-"} dmarc=${message.dmarc ?? "-"}`;
  el("download").href = `/api/messages/${message.id}/raw`;
  el("download").setAttribute("download", `${message.id}.eml`);
  el("body").srcdoc = "";

  document.querySelectorAll("#messages li").forEach((li) => {
    li.classList.toggle("selected", li.dataset.id === message.id);
  });

  try {
    const raw = await (await api(`/messages/${message.id}/raw`)).arrayBuffer();
    state.parsed = await PostalMime.parse(raw);
    renderBody();
    renderAttachments();
  } catch (err) {
    el("body").srcdoc = escapeToDocument(err.message);
    return;
  }

  if (!message.seen) {
    message.seen = true;
    document.querySelector(`#messages li[data-id="${message.id}"]`)?.classList.remove("unseen");
    api(`/messages/${message.id}/seen`, { method: "POST" }).catch(() => {});
  }
}

/**
 * Message bodies render inside a sandboxed iframe with no allow-scripts, and
 * a CSP that blocks every remote resource. HTML email is untrusted code, and
 * remote images are read receipts — both are opt-in, neither is default.
 */
function renderBody() {
  const parsed = state.parsed;
  if (!parsed) return;

  const useHtml = !state.showSource && parsed.html;
  const imgSrc = state.allowRemote ? "data: https:" : "data:";
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc};`;

  const content = useHtml
    ? parsed.html
    : `<pre>${escapeHtml(parsed.text || "(no text part)")}</pre>`;

  el("body").srcdoc = `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 1rem; font: 15px/1.6 system-ui, sans-serif; word-wrap: break-word; }
  img, table { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; font: 13px/1.6 ui-monospace, monospace; }
</style></head><body>${content}</body></html>`;

  el("toggle-source").textContent = useHtml ? "Plain text" : "HTML";
  el("toggle-source").classList.toggle("hidden", !parsed.html);
  el("toggle-remote").classList.toggle("hidden", !useHtml || state.allowRemote);
}

function renderAttachments() {
  const container = el("attachments");
  container.replaceChildren();
  const attachments = state.parsed?.attachments ?? [];
  container.classList.toggle("hidden", attachments.length === 0);

  for (const attachment of attachments) {
    const blob = new Blob([attachment.content], {
      type: attachment.mimeType || "application/octet-stream",
    });
    const link = document.createElement("a");
    link.className = "ghost";
    link.href = URL.createObjectURL(blob);
    link.download = attachment.filename || "attachment";
    link.textContent = `${attachment.filename || "attachment"} · ${formatBytes(blob.size)}`;
    container.append(link);
  }
}

/**
 * Compose. Replies carry In-Reply-To and References so the recipient's client
 * threads them with the original — without those, every reply you send opens
 * a new orphan conversation on their side.
 */
function openCompose({ to = "", subject = "", inReplyTo = null, references = null, threadId = null } = {}) {
  state.compose = { inReplyTo, references, threadId };
  el("c-to").value = to;
  el("c-subject").value = subject;
  el("c-body").value = "";
  el("c-status").textContent = "";
  el("reader").classList.add("hidden");
  el("reader-empty").classList.add("hidden");
  el("compose").classList.remove("hidden");
  el("c-body").focus();
}

function closeCompose() {
  el("compose").classList.add("hidden");
  if (state.selected) el("reader").classList.remove("hidden");
  else el("reader-empty").classList.remove("hidden");
}

function replyTo(message) {
  const address = addressOf(message.header_from) || message.envelope_from;
  const subject = /^re:/i.test(message.subject || "") ? message.subject : `Re: ${message.subject || ""}`;
  openCompose({
    to: address,
    subject,
    inReplyTo: message.message_id || null,
    references: message.refs || null,
    threadId: message.thread_id || null,
  });
}

function addressOf(header) {
  if (!header) return "";
  const angled = header.match(/<([^>]+)>/);
  return (angled ? angled[1] : header).trim();
}

async function submitCompose(event) {
  event.preventDefault();
  const button = el("c-send");
  button.disabled = true;
  el("c-status").textContent = "Sending…";

  try {
    const response = await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: el("c-to").value.split(",").map((s) => s.trim()).filter(Boolean),
        subject: el("c-subject").value,
        text: el("c-body").value,
        inReplyTo: state.compose?.inReplyTo ?? null,
        references: state.compose?.references ?? null,
        threadId: state.compose?.threadId ?? null,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Send failed (${response.status})`);

    el("c-status").textContent = result.stored ? "Sent." : "Sent (copy not stored).";
    setTimeout(closeCompose, 800);
  } catch (err) {
    el("c-status").textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

function clearReader() {
  state.selected = null;
  state.parsed = null;
  el("reader").classList.add("hidden");
  el("reader-empty").classList.remove("hidden");
}

function displayFrom(message) {
  const header = message.header_from || message.envelope_from || "";
  const named = header.match(/^\s*"?([^"<]+?)"?\s*</);
  return (named ? named[1] : header).trim() || message.envelope_from;
}

function shortDate(ms) {
  const date = new Date(ms);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { day: "2-digit", month: "short" });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function escapeToDocument(message) {
  return `<!doctype html><meta charset="utf-8"><pre>${escapeHtml(message)}</pre>`;
}

// Events

document.querySelectorAll(".folders button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".folders button").forEach((b) => b.classList.remove("active"));
    button.classList.add("active");
    loadFolder(button.dataset.folder);
  });
});

el("refresh").addEventListener("click", () => loadFolder(state.folder));
el("new").addEventListener("click", () => openCompose());

// Resend holds received mail whether or not the webhook succeeded, so this
// recovers anything that arrived while the endpoint was unreachable.
el("sync").addEventListener("click", async () => {
  const button = el("sync");
  button.disabled = true;
  el("list-status").textContent = "Syncing from Resend…";
  try {
    const result = await (await api("/backfill", { method: "POST" })).json();
    el("list-status").textContent =
      `Imported ${result.imported}, already had ${result.skipped}` +
      (result.failed?.length ? `, ${result.failed.length} failed` : "");
    if (result.imported) await loadFolder(state.folder);
  } catch (err) {
    el("list-status").textContent = err.message;
  } finally {
    button.disabled = false;
  }
});
el("reply").addEventListener("click", () => state.selected && replyTo(state.selected));
el("c-cancel").addEventListener("click", closeCompose);
el("compose").addEventListener("submit", submitCompose);
el("more").addEventListener("click", () => loadFolder(state.folder, { append: true }));

el("toggle-remote").addEventListener("click", () => {
  state.allowRemote = true;
  renderBody();
});

el("toggle-source").addEventListener("click", () => {
  state.showSource = !state.showSource;
  renderBody();
});

// Refresh when you come back to the tab, at most once a minute. This replaces
// polling entirely — see the note at the top of this file.
let lastRefresh = Date.now();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (Date.now() - lastRefresh < 60_000) return;
  lastRefresh = Date.now();
  loadFolder(state.folder);
});

loadFolder("inbox");
