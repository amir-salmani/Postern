import PostalMime from "./vendor/postal-mime/postal-mime.js";

/**
 * Postern — client.
 *
 * Two rules shape this file:
 *
 *   1. No polling. A background timer asking "anything new?" would burn
 *      Worker invocations for nothing. The list refreshes when you return to
 *      the tab and when you ask it to.
 *
 *   2. Parsing happens here, not on the server. Workers Free allows 10ms of
 *      CPU per request, which a large MIME message would exhaust. The browser
 *      has no such limit — and it means the server never handles a decoded
 *      message body.
 */

const state = {
  folder: "inbox",
  query: "",
  cursor: null,
  messages: [],
  selected: null,
  parsed: null,
  allowRemote: false,
  showSource: false,
  compose: null,
};

const el = (id) => document.getElementById(id);
const TITLES = { inbox: "Inbox", quarantine: "Quarantine", sent: "Sent", events: "Activity" };

async function api(path, options) {
  const response = await fetch(`/api${path}`, options);
  if (response.status === 401 || response.status === 302) {
    throw new Error("Session expired — reload the page to sign in again.");
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Request failed (${response.status})`);
  }
  return response;
}

/* ───────── Folders ───────── */

async function loadCounts() {
  try {
    const { counts } = await (await api("/counts")).json();
    for (const node of document.querySelectorAll("[data-count]")) {
      const entry = counts[node.dataset.count];
      // Unread is the number you act on; total is noise once it's read.
      node.textContent = entry?.unread ? entry.unread : "";
    }
  } catch {
    /* counts are decoration — never block the mailbox on them */
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
  el("view-title").textContent = state.query ? "Search" : TITLES[state.folder];
  el("list-status").textContent = "Loading…";

  const query = new URLSearchParams({ folder: state.folder });
  if (state.query) query.set("q", state.query);
  if (append && state.cursor) query.set("before", String(state.cursor));

  try {
    const data = await (await api(`/messages?${query}`)).json();
    state.messages.push(...data.messages);
    state.cursor = data.nextCursor;
    renderList(data.messages);
    el("more").classList.toggle("hidden", !data.nextCursor);
    el("list-status").textContent = state.messages.length
      ? ""
      : state.query ? "No matches." : "Nothing here.";
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

    const name = displayFrom(message);
    item.append(avatarFor(name));

    // textContent throughout — every value here came from an email, and an
    // email is hostile input.
    item.append(
      span("from", name),
      span("subject", message.subject || "(no subject)"),
      span("preview", message.envelope_to || ""),
    );

    const when = document.createElement("time");
    when.className = "when";
    when.textContent = shortDate(message.received_ms);
    item.append(when);

    if (message.has_attach || message.dmarc === "fail") {
      const tags = document.createElement("div");
      tags.className = "tags";
      if (message.has_attach) tags.append(tag("attachment"));
      if (message.dmarc === "fail") tags.append(tag("dmarc fail", "warn"));
      item.append(tags);
    }

    item.addEventListener("click", () => openMessage(message));
    list.append(item);
  }
}

function span(className, text) {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

function tag(text, kind = "") {
  const node = document.createElement("span");
  node.className = `tag ${kind}`.trim();
  node.textContent = text;
  return node;
}

/** Deterministic colour per sender, so the same person looks the same daily. */
function avatarFor(name) {
  const node = document.createElement("div");
  node.className = "avatar";
  const clean = (name || "?").replace(/[^\p{L}\p{N} ]/gu, " ").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  node.textContent = (parts.length > 1
    ? parts[0][0] + parts[parts.length - 1][0]
    : (clean[0] || "?") + (clean[1] || "")
  ).toUpperCase();

  let hash = 0;
  for (const char of name || "") hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  node.style.background = `hsl(${hash % 360} 45% 42%)`;
  return node;
}

/* ───────── Reader ───────── */

async function openMessage(message) {
  state.selected = message;
  state.allowRemote = false;
  state.showSource = false;
  document.body.classList.add("reading");

  el("reader-empty").classList.add("hidden");
  el("compose").classList.add("hidden");
  el("reader").classList.remove("hidden");
  el("subject").textContent = message.subject || "(no subject)";

  const name = displayFrom(message);
  const avatar = el("avatar");
  avatar.textContent = avatarFor(name).textContent;
  avatar.style.background = avatarFor(name).style.background;

  el("from").textContent = message.header_from || message.envelope_from;
  el("to").textContent = message.envelope_to ? `to ${message.envelope_to}` : "";
  el("date").textContent = new Date(message.received_ms).toLocaleString();
  el("auth").textContent = message.spf || message.dkim || message.dmarc
    ? `spf ${message.spf ?? "–"} · dkim ${message.dkim ?? "–"} · dmarc ${message.dmarc ?? "–"}`
    : "";
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
    el("body").srcdoc = `<!doctype html><meta charset="utf-8"><pre>${escapeHtml(err.message)}</pre>`;
    return;
  }

  if (!message.seen) {
    message.seen = true;
    document.querySelector(`#messages li[data-id="${message.id}"]`)?.classList.remove("unseen");
    api(`/messages/${message.id}/seen`, { method: "POST" }).then(loadCounts).catch(() => {});
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
  const content = useHtml ? parsed.html : `<pre>${escapeHtml(parsed.text || "(no text part)")}</pre>`;
  const dark = !document.documentElement.dataset.theme
    ? matchMedia("(prefers-color-scheme: dark)").matches
    : document.documentElement.dataset.theme === "dark";

  el("body").srcdoc = `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
  :root { color-scheme: ${dark ? "dark" : "light"}; }
  body {
    margin: 0; padding: 20px 22px;
    font: 14.5px/1.65 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
    color: ${dark ? "#eee8dc" : "#1b2137"};
    background: transparent;
    word-wrap: break-word;
  }
  a { color: #d9622b; }
  img, table { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; font: 13px/1.7 ui-monospace, monospace; margin: 0; }
  blockquote { margin: 0 0 0 12px; padding-left: 12px; border-left: 2px solid currentColor; opacity: .6; }
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
    link.className = "quiet";
    link.href = URL.createObjectURL(blob);
    link.download = attachment.filename || "attachment";
    link.textContent = `${attachment.filename || "attachment"} · ${formatBytes(blob.size)}`;
    container.append(link);
  }
}

function clearReader() {
  state.selected = null;
  state.parsed = null;
  document.body.classList.remove("reading");
  el("reader").classList.add("hidden");
  el("compose").classList.add("hidden");
  el("reader-empty").classList.remove("hidden");
}

/* ───────── Activity ───────── */

async function loadEvents() {
  state.folder = "events";
  el("messages").replaceChildren();
  el("more").classList.add("hidden");
  clearReader();
  el("view-title").textContent = TITLES.events;
  el("list-status").textContent = "Loading…";

  try {
    const { events } = await (await api("/events")).json();
    const list = el("messages");
    for (const event of events) {
      const item = document.createElement("li");
      item.classList.add("event");
      item.append(span("from", event.type), span("subject", event.summary || event.email_id || ""));
      const when = document.createElement("time");
      when.className = "when";
      when.textContent = shortDate(event.created_ms);
      item.append(when);
      list.append(item);
    }
    el("list-status").textContent = events.length ? "" : "No events yet.";
  } catch (err) {
    el("list-status").textContent = err.message;
  }
}

/* ───────── Compose ───────── */

function openCompose({ to = "", subject = "", inReplyTo = null, references = null, threadId = null } = {}) {
  state.compose = { inReplyTo, references, threadId };
  el("c-to").value = to;
  el("c-subject").value = subject;
  el("c-body").value = "";
  el("c-status").textContent = "";
  document.body.classList.add("reading");
  el("reader").classList.add("hidden");
  el("reader-empty").classList.add("hidden");
  el("compose").classList.remove("hidden");
  el(to ? "c-body" : "c-to").focus();
}

function closeCompose() {
  el("compose").classList.add("hidden");
  if (state.selected) el("reader").classList.remove("hidden");
  else { el("reader-empty").classList.remove("hidden"); document.body.classList.remove("reading"); }
}

/**
 * Replies carry In-Reply-To and References so the recipient's client threads
 * them with the original — without those, every reply opens a new orphan
 * conversation on their side, which you'd never see.
 */
function replyTo(message) {
  openCompose({
    to: addressOf(message.header_from) || message.envelope_from,
    subject: /^re:/i.test(message.subject || "") ? message.subject : `Re: ${message.subject || ""}`,
    inReplyTo: message.message_id || null,
    references: message.refs || null,
    threadId: message.thread_id || null,
  });
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
    setTimeout(closeCompose, 700);
    loadCounts();
  } catch (err) {
    el("c-status").textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

/* ───────── Helpers ───────── */

function displayFrom(message) {
  const header = message.header_from || message.envelope_from || "";
  const named = header.match(/^\s*"?([^"<]+?)"?\s*</);
  return (named ? named[1] : header).trim() || message.envelope_from || "";
}

function addressOf(header) {
  if (!header) return "";
  const angled = header.match(/<([^>]+)>/);
  return (angled ? angled[1] : header).trim();
}

function shortDate(ms) {
  const date = new Date(ms);
  const now = new Date();
  if (now.toDateString() === date.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (now.getFullYear() === date.getFullYear()) {
    return date.toLocaleDateString([], { day: "numeric", month: "short" });
  }
  return date.toLocaleDateString([], { year: "numeric", month: "short" });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

/* ───────── Events ───────── */

document.querySelectorAll(".folders button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".folders button").forEach((b) => b.classList.remove("active"));
    button.classList.add("active");
    state.query = "";
    el("q").value = "";
    loadFolder(button.dataset.folder);
  });
});

el("refresh").addEventListener("click", () => { loadFolder(state.folder); loadCounts(); });
el("more").addEventListener("click", () => loadFolder(state.folder, { append: true }));
el("new").addEventListener("click", () => openCompose());
el("c-cancel").addEventListener("click", closeCompose);
el("compose").addEventListener("submit", submitCompose);
el("reply").addEventListener("click", () => state.selected && replyTo(state.selected));
el("toggle-remote").addEventListener("click", () => { state.allowRemote = true; renderBody(); });
el("toggle-source").addEventListener("click", () => { state.showSource = !state.showSource; renderBody(); });

el("delete").addEventListener("click", async () => {
  const message = state.selected;
  if (!message || !confirm("Delete this message? The stored copy is removed too.")) return;
  try {
    await api(`/messages/${message.id}`, { method: "DELETE" });
    document.querySelector(`#messages li[data-id="${message.id}"]`)?.remove();
    clearReader();
    loadCounts();
  } catch (err) {
    el("list-status").textContent = err.message;
  }
});

// Search spans every folder — looking for a message you can't place is
// exactly when you don't know which folder it's in.
el("q").addEventListener("input", debounce((e) => {
  state.query = e.target.value.trim();
  loadFolder(state.folder);
}, 220));

el("sync").addEventListener("click", async () => {
  const button = el("sync");
  button.disabled = true;
  el("list-status").textContent = "Syncing from Resend…";
  try {
    const result = await (await api("/backfill", { method: "POST" })).json();
    el("list-status").textContent =
      `Imported ${result.imported}, already had ${result.skipped}` +
      (result.failed?.length ? `, ${result.failed.length} failed` : "");
    if (result.imported) { await loadFolder(state.folder); loadCounts(); }
  } catch (err) {
    el("list-status").textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

const THEME_KEY = "postern-theme";
const savedTheme = localStorage.getItem(THEME_KEY);
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

el("theme").addEventListener("click", () => {
  const current = document.documentElement.dataset.theme
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  renderBody();
});

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.key === "/") { e.preventDefault(); el("q").focus(); }
  if (e.key === "Escape") clearReader();
  if (e.key === "c") openCompose();
  if (e.key === "r" && state.selected) replyTo(state.selected);
  if (e.key === "j" || e.key === "k") {
    e.preventDefault();
    const index = state.messages.findIndex((m) => m.id === state.selected?.id);
    const next = state.messages[e.key === "j" ? index + 1 : index - 1];
    if (next) {
      openMessage(next);
      document.querySelector(`#messages li[data-id="${next.id}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }
});

// Refresh when you come back to the tab, at most once a minute. This replaces
// polling entirely — see the note at the top of this file.
let lastRefresh = Date.now();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (Date.now() - lastRefresh < 60_000) return;
  lastRefresh = Date.now();
  loadFolder(state.folder);
  loadCounts();
});

loadFolder("inbox");
loadCounts();
