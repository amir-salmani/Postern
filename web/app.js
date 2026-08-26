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
  picked: new Set(),
  identities: [],
  series: null,
};

const el = (id) => document.getElementById(id);
const TITLES = { inbox: "Inbox", quarantine: "Quarantine", sent: "Sent", trash: "Trash", events: "Dashboard" };

/**
 * Two series, fixed order, never cycled. Validated with the palette checker
 * against both surfaces: CVD separation ΔE 20.4 (deutan) and 28.4 (normal),
 * chroma and lightness in band, contrast ≥ 3:1. The same pair works in light
 * and dark, so nothing is flipped per mode.
 */
const SERIES = { received: "#D9622B", sent: "#00A3C4" };

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
  showMail();

  if (!append) {
    state.folder = folder;
    state.cursor = null;
    state.messages = [];
    state.picked.clear();
    renderBulkBar();
    el("messages").replaceChildren();
    document.querySelectorAll(".trash-note").forEach((n) => n.remove());
    clearReader();
  }
  el("view-title").textContent = state.query ? "Search" : TITLES[state.folder];
  const inTrash = state.folder === "trash";
  el("bulk-restore").classList.toggle("hidden", !inTrash);
  el("bulk-inbox").classList.toggle("hidden", state.folder !== "quarantine");
  el("bulk-quarantine").classList.toggle("hidden", state.folder !== "inbox");
  el("bulk-delete").textContent = inTrash ? "Delete forever" : "Delete";
  el("list-status").textContent = "Loading…";

  const query = new URLSearchParams({ folder: state.folder });
  if (state.query) query.set("q", state.query);
  if (append && state.cursor) query.set("before", String(state.cursor));

  try {
    const data = await (await api(`/messages?${query}`)).json();
    state.messages.push(...data.messages);
    state.cursor = data.nextCursor;
    renderList(data.messages);
    if (state.folder === "trash" && !append && data.messages.length) {
      const note = document.createElement("div");
      note.className = "trash-note";
      note.textContent = "Messages here are deleted for good 30 days after you trashed them.";
      el("messages").before(note);
    }
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
    item.append(checkboxFor(message), avatarFor(name));

    // textContent throughout — every value here came from an email, and an
    // email is hostile input.
    item.append(
      span("from", name),
      span("subject", message.subject || "(no subject)"),
      span("preview", message.envelope_to || ""),
    );

    if (message.thread_count > 1) {
      const count = document.createElement("span");
      count.className = "thread-count";
      count.textContent = message.thread_count;
      item.querySelector(".from").append(count);
    }

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

    item.addEventListener("click", (event) => {
      if (event.target.closest(".check")) return;   // selecting is not opening
      openMessage(message);
    });
    list.append(item);
  }
}

function checkboxFor(message) {
  const label = document.createElement("label");
  label.className = "check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = state.picked.has(message.id);
  input.addEventListener("change", () => {
    if (input.checked) state.picked.add(message.id);
    else state.picked.delete(message.id);
    input.closest("li")?.classList.toggle("picked", input.checked);
    renderBulkBar();
  });
  label.append(input, document.createElement("span"));
  return label;
}

function renderBulkBar() {
  const count = state.picked.size;
  document.body.classList.toggle("selecting", count > 0);
  el("bulkbar").classList.toggle("hidden", count === 0);
  el("bulk-count").textContent = `${count} selected`;
  const all = state.messages.length > 0 && count === state.messages.length;
  el("select-all").checked = all;
  el("select-all").indeterminate = count > 0 && !all;
}

function clearSelection() {
  state.picked.clear();
  document.querySelectorAll("#messages li.picked").forEach((li) => li.classList.remove("picked"));
  document.querySelectorAll("#messages .check input").forEach((i) => { i.checked = false; });
  renderBulkBar();
}

async function bulkPatch(body) {
  const ids = [...state.picked];
  await Promise.all(ids.map((id) =>
    api(`/messages/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {})));
  for (const message of state.messages) {
    if (state.picked.has(message.id) && typeof body.seen === "boolean") message.seen = body.seen;
  }
  clearSelection();
  await loadFolder(state.folder);
  loadCounts();
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

  const where = message.folder;
  el("restore").classList.toggle("hidden", where !== "trash");
  el("reply").classList.toggle("hidden", where === "trash");
  el("to-inbox").classList.toggle("hidden", where !== "quarantine");
  el("to-quarantine").classList.toggle("hidden", where !== "inbox");
  el("allow-sender").classList.toggle("hidden", where !== "quarantine");
  el("block-sender").classList.toggle("hidden", where === "trash" || where === "sent");
  renderThread(message);

  try {
    const raw = await (await api(`/messages/${message.id}/raw`)).arrayBuffer();
    state.parsed = await PostalMime.parse(raw);
    renderBody();
    await renderAttachments(message);
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

  el("body").srcdoc = bodyDocument(parsed, state);
  el("toggle-source").textContent = !state.showSource && parsed.html ? "Plain text" : "HTML";
  el("toggle-source").classList.toggle("hidden", !parsed.html);
  el("toggle-remote").classList.toggle("hidden", !(!state.showSource && parsed.html) || state.allowRemote);
}

function bodyDocument(parsed, { allowRemote, showSource }) {
  const useHtml = !showSource && parsed.html;
  const imgSrc = allowRemote ? "data: https:" : "data:";
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc};`;
  const content = useHtml ? parsed.html : `<pre>${escapeHtml(parsed.text || "(no text part)")}</pre>`;
  const dark = !document.documentElement.dataset.theme
    ? matchMedia("(prefers-color-scheme: dark)").matches
    : document.documentElement.dataset.theme === "dark";

  return `<!doctype html><html><head>
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
}

/**
 * Two sources. Inline parts come from the parsed MIME in this browser;
 * detached ones were fetched from Resend at ingest and live in R2, so they
 * are served by id rather than rebuilt here.
 */
async function renderAttachments(message) {
  const container = el("attachments");
  container.replaceChildren();

  const items = [];
  for (const attachment of state.parsed?.attachments ?? []) {
    const blob = new Blob([attachment.content], {
      type: attachment.mimeType || "application/octet-stream",
    });
    items.push({
      name: attachment.filename || "attachment",
      size: blob.size,
      href: URL.createObjectURL(blob),
    });
  }

  if (message.has_attach) {
    try {
      const { attachments } = await (await api(`/messages/${message.id}/attachments`)).json();
      for (const a of attachments ?? []) {
        if (items.some((i) => i.name === a.filename)) continue;
        items.push({
          name: a.filename || "attachment",
          size: a.size_bytes,
          href: `/api/messages/${message.id}/attachments/${a.id}`,
        });
      }
    } catch { /* inline parts still render */ }
  }

  container.classList.toggle("hidden", items.length === 0);
  for (const item of items) {
    const link = document.createElement("a");
    link.href = item.href;
    link.download = item.name;
    link.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 5 5.9 9.6a1.6 1.6 0 0 0 2.3 2.3l4.8-4.8a3 3 0 0 0-4.3-4.3L3.6 7.9a4.4 4.4 0 0 0 6.2 6.2l4.2-4.2"/></svg>';
    link.append(document.createTextNode(item.name));
    if (item.size) {
      const size = document.createElement("span");
      size.className = "size";
      size.textContent = formatBytes(item.size);
      link.append(size);
    }
    container.append(link);
  }
}

/**
 * A conversation reads downward. Earlier messages collapse to one line and
 * expand in place, so the thread is scannable without losing the message you
 * actually opened.
 */
async function renderThread(message) {
  const host = el("thread");
  host.replaceChildren();
  host.classList.add("hidden");
  if (!message.thread_id || (message.thread_count ?? 1) < 2) return;

  let messages;
  try {
    ({ messages } = await (await api(`/threads/${encodeURIComponent(message.thread_id)}`)).json());
  } catch { return; }
  if (!messages || messages.length < 2) return;

  host.classList.remove("hidden");
  for (const item of messages) {
    if (item.id === message.id) continue;
    const wrap = document.createElement("div");
    wrap.className = "thread-item";

    const head = document.createElement("button");
    head.type = "button";
    const name = displayFrom(item);
    head.append(avatarFor(name));
    const col = document.createElement("div");
    col.className = "col";
    col.append(span("who", name), span("snippet", item.subject || "(no subject)"));
    const when = document.createElement("time");
    when.textContent = shortDate(item.received_ms);
    head.append(col, when);

    let frame = null;
    head.addEventListener("click", async () => {
      if (frame) {
        frame.remove(); frame = null;
        wrap.classList.remove("open");
        return;
      }
      wrap.classList.add("open");
      frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.style.height = "320px";
      wrap.append(frame);
      try {
        const raw = await (await api(`/messages/${item.id}/raw`)).arrayBuffer();
        const parsed = await PostalMime.parse(raw);
        frame.srcdoc = bodyDocument(parsed, { allowRemote: false, showSource: false });
      } catch (err) {
        frame.srcdoc = `<!doctype html><meta charset="utf-8"><pre>${escapeHtml(err.message)}</pre>`;
      }
    });

    wrap.append(head);
    host.append(wrap);
  }
}

function clearReader() {
  state.selected = null;
  state.parsed = null;
  document.body.classList.remove("reading");
  el("reader").classList.add("hidden");
  el("thread").classList.add("hidden");
  el("compose").classList.add("hidden");
  el("reader-empty").classList.remove("hidden");
}

/* ───────── Activity ───────── */

async function loadEvents() {
  state.folder = "events";
  clearReader();
  el("view-title").textContent = TITLES.events;
  document.querySelector(".list").classList.add("hidden");
  document.querySelector(".reader").classList.add("hidden");
  el("dashboard").classList.remove("hidden");

  const [overview, activity] = await Promise.all([
    api("/overview").then((r) => r.json()),
    api("/events").then((r) => r.json()).catch(() => ({ events: [] })),
  ]);

  renderKpis(overview);
  renderMeters(overview.quota);
  renderChart(overview.series);
  renderEventLog(activity.events);
  loadRules();
}

function showMail() {
  el("dashboard").classList.add("hidden");
  document.querySelector(".list").classList.remove("hidden");
  document.querySelector(".reader").classList.remove("hidden");
}

/* A handful of headline numbers is a KPI row, not a chart. */
function renderKpis({ counts, storage }) {
  const unread = counts.inbox?.unread ?? 0;
  const tiles = [
    { label: "Unread", value: unread, sub: `${counts.inbox?.total ?? 0} in inbox`, alert: unread > 0 },
    { label: "Quarantined", value: counts.quarantine?.total ?? 0, sub: "catch-all, not shown in inbox" },
    { label: "Sent", value: counts.sent?.total ?? 0, sub: "stored copies" },
    {
      label: "Stored",
      value: formatBytes(storage.bytes),
      sub: `${storage.messages} messages · ${((storage.bytes / storage.limitBytes) * 100).toFixed(2)}% of 10 GB`,
    },
  ];

  el("kpis").replaceChildren(...tiles.map((t) => {
    const card = document.createElement("dl");
    card.className = `kpi${t.alert ? " alert" : ""}`;
    const dt = document.createElement("dt"); dt.textContent = t.label;
    const dd = document.createElement("dd"); dd.textContent = t.value;
    const sub = document.createElement("div"); sub.className = "sub"; sub.textContent = t.sub;
    card.append(dt, dd, sub);
    return card;
  }));
}

/* A single ratio against a limit is a meter, never a two-slice pie. */
function renderMeters(quota) {
  const windows = [
    { label: "Today", data: quota.day },
    { label: "This month", data: quota.month },
  ];

  el("meters").replaceChildren(...windows.map(({ label, data }) => {
    const wrap = document.createElement("div");
    const pct = data.limit ? (data.total / data.limit) * 100 : 0;

    const head = document.createElement("div");
    head.className = "meter-head";
    const name = document.createElement("strong"); name.textContent = label;
    const value = document.createElement("span"); value.className = "value";
    value.textContent = `${data.total} / ${data.limit.toLocaleString()}`;
    const percent = document.createElement("span"); percent.className = "pct";
    percent.textContent = `${pct < 1 && pct > 0 ? "<1" : Math.round(pct)}%`;
    head.append(name, value, percent);

    const track = document.createElement("div");
    track.className = "track";
    for (const [key, count] of [["received", data.received], ["sent", data.sent]]) {
      if (!count) continue;
      const fill = document.createElement("i");
      fill.style.width = `${Math.max((count / data.limit) * 100, 0.8)}%`;
      fill.style.background = SERIES[key];
      track.append(fill);
    }

    const sub = document.createElement("div");
    sub.className = "meter-sub";
    for (const [key, count] of [["received", data.received], ["sent", data.sent]]) {
      const item = document.createElement("span");
      const swatch = document.createElement("i"); swatch.style.background = SERIES[key];
      item.append(swatch, document.createTextNode(`${count} ${key}`));
      sub.append(item);
    }

    wrap.append(head, track, sub);
    if (!quota.available) {
      const warn = document.createElement("div");
      warn.className = "meter-sub";
      warn.textContent = "Usage unavailable — Resend key cannot read lists.";
      wrap.append(warn);
    }
    return wrap;
  }));
}

/**
 * Grouped columns: the job is telling two series apart over time, which is
 * categorical, and grouping keeps each day's two values comparable against
 * the same baseline rather than stacked on a moving one.
 */
function renderChart(series) {
  state.series = series;
  const host = el("chart");
  host.replaceChildren();

  // Measured, not scaled. A fixed viewBox stretched to the container makes
  // 10px axis type render at 17px on a wide screen and forces the box taller
  // than it needs to be.
  const W = Math.max(320, host.clientWidth || 720);
  const H = 190, padL = 30, padR = 8, padB = 22, padT = 10;
  const peak = Math.max(1, ...series.map((d) => Math.max(d.received, d.sent)));
  const ticks = niceTicks(peak);
  const top = ticks[ticks.length - 1];
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / series.length;
  const barW = Math.max(3, Math.min(11, slot / 2 - 2));   // 2px gap between the pair

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("height", H);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Mail received and sent per day, last 14 days");

  const grid = document.createElementNS(ns, "g");
  grid.setAttribute("class", "grid");
  for (const tick of ticks) {
    const y = padT + plotH - (tick / top) * plotH;
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", padL); line.setAttribute("x2", W - padR);
    line.setAttribute("y1", y); line.setAttribute("y2", y);
    grid.append(line);
    const label = document.createElementNS(ns, "text");
    label.setAttribute("class", "axis");
    label.setAttribute("x", padL - 6); label.setAttribute("y", y + 3);
    label.setAttribute("text-anchor", "end");
    label.textContent = tick;
    grid.append(label);
  }
  svg.append(grid);

  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  host.append(tooltip);

  series.forEach((day, i) => {
    const group = document.createElementNS(ns, "g");
    group.setAttribute("class", "day");
    const x0 = padL + i * slot + slot / 2;

    [["received", day.received, -1], ["sent", day.sent, 1]].forEach(([key, value, side]) => {
      if (!value) return;
      const h = Math.max(2, (value / top) * plotH);
      const bar = document.createElementNS(ns, "rect");
      bar.setAttribute("class", "bar");
      bar.setAttribute("x", x0 + (side < 0 ? -barW - 1 : 1));
      bar.setAttribute("y", padT + plotH - h);
      bar.setAttribute("width", barW);
      bar.setAttribute("height", h);
      bar.setAttribute("rx", 3);              // rounded data-end, anchored to baseline
      bar.setAttribute("fill", SERIES[key]);
      group.append(bar);
    });

    const hit = document.createElementNS(ns, "rect");
    hit.setAttribute("class", "hit");
    hit.setAttribute("x", padL + i * slot); hit.setAttribute("y", padT);
    hit.setAttribute("width", slot); hit.setAttribute("height", plotH);
    group.append(hit);

    group.addEventListener("mouseenter", () => {
      tooltip.replaceChildren();
      const title = document.createElement("b");
      title.textContent = new Date(`${day.day}T00:00:00Z`)
        .toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
      tooltip.append(title);
      for (const [key, value] of [["received", day.received], ["sent", day.sent]]) {
        const row = document.createElement("div");
        row.className = "k";
        const swatch = document.createElement("i"); swatch.style.background = SERIES[key];
        row.append(swatch, document.createTextNode(`${value} ${key}`));
        tooltip.append(row);
      }
      tooltip.style.left = `${Math.min(Math.max(x0, 70), W - 70)}px`;
      tooltip.style.transform = "translate(-50%, -100%)";
      tooltip.style.top = "18px";
      tooltip.classList.add("on");
    });
    group.addEventListener("mouseleave", () => tooltip.classList.remove("on"));

    // Label the ends and the middle only — never a number on every point.
    if (i === 0 || i === series.length - 1 || i === Math.floor(series.length / 2)) {
      const label = document.createElementNS(ns, "text");
      label.setAttribute("class", "axis");
      label.setAttribute("x", x0); label.setAttribute("y", H - 5);
      label.setAttribute("text-anchor", i === 0 ? "start" : i === series.length - 1 ? "end" : "middle");
      label.textContent = new Date(`${day.day}T00:00:00Z`)
        .toLocaleDateString([], { day: "numeric", month: "short" });
      group.append(label);
    }

    svg.append(group);
  });

  host.append(svg);
}

function niceTicks(peak) {
  const step = peak <= 4 ? 1 : peak <= 10 ? 2 : peak <= 25 ? 5 : Math.ceil(peak / 5 / 10) * 10;
  const out = [];
  for (let v = 0; v <= peak + step - 1; v += step) out.push(v);
  return out;
}

function renderEventLog(events) {
  const colours = {
    "email.received": SERIES.received,
    "email.sent": SERIES.sent,
    "email.delivered": SERIES.sent,
    "email.bounced": "#c0392b",
    "email.failed": "#c0392b",
    "email.complained": "#c0392b",
  };

  el("events-note").textContent = events.length ? `${events.length} recent` : "";
  el("event-log").replaceChildren(...events.slice(0, 40).map((event) => {
    const item = document.createElement("li");
    const type = document.createElement("span");
    type.className = "type";
    const dot = document.createElement("i");
    dot.className = "dot";
    dot.style.background = colours[event.type] || "var(--ink-3)";
    type.append(dot, document.createTextNode(event.type));
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = event.summary || event.email_id || "";
    const when = document.createElement("time");
    when.textContent = shortDate(event.created_ms);
    item.append(type, what, when);
    return item;
  }));

  if (!events.length) {
    const empty = document.createElement("li");
    empty.className = "what";
    empty.textContent = "No events yet.";
    el("event-log").append(empty);
  }
}

/* ───────── Compose ───────── */

async function loadIdentities() {
  try {
    const { identities } = await (await api("/identities")).json();
    state.identities = identities ?? [];
    el("c-from").replaceChildren(...state.identities.map((address) => {
      const option = document.createElement("option");
      option.value = address;
      option.textContent = address;
      return option;
    }));
  } catch { /* the picker just stays empty; the server still defaults */ }
}

function openCompose({ to = "", subject = "", inReplyTo = null, references = null, threadId = null, from = null } = {}) {
  state.compose = { inReplyTo, references, threadId };
  // Reply from the address it was addressed to, when that's one of ours —
  // answering a message sent to jobs@ from hi@ is a small betrayal of the alias.
  if (from && state.identities.includes(from.toLowerCase())) el("c-from").value = from.toLowerCase();
  else if (state.identities.length) el("c-from").value = state.identities[0];
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
    from: (message.envelope_to || "").toLowerCase(),
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
        from: el("c-from").value || null,
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

/**
 * In-page confirm. The native confirm() opens at the top of the browser
 * chrome, away from where you clicked, and its default button varies by
 * platform — Enter here always means the action you asked for.
 */
/**
 * Resolves to false, true, or — when `extra` is given — that option's value,
 * so a caller can offer a wider variant of the same action without a second
 * dialog. Enter takes the primary action; Escape and the backdrop cancel.
 */
function confirmDialog({ title, text, action = "Delete", extra = null }) {
  return new Promise((resolve) => {
    const backdrop = el("dialog");
    el("dialog-title").textContent = title;
    el("dialog-text").textContent = text;
    el("dialog-ok").textContent = action;
    const extraBtn = el("dialog-extra");
    extraBtn.classList.toggle("hidden", !extra);
    if (extra) extraBtn.textContent = extra.label;
    backdrop.classList.remove("hidden");
    el("dialog-ok").focus();

    const finish = (value) => {
      backdrop.classList.add("hidden");
      el("dialog-ok").removeEventListener("click", onOk);
      el("dialog-cancel").removeEventListener("click", onCancel);
      extraBtn.removeEventListener("click", onExtra);
      backdrop.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onOk = () => finish(true);
    const onExtra = () => finish(extra.value);
    const onCancel = () => finish(false);
    const onBackdrop = (e) => { if (e.target === backdrop) finish(false); };
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    };

    el("dialog-ok").addEventListener("click", onOk);
    extraBtn.addEventListener("click", onExtra);
    el("dialog-cancel").addEventListener("click", onCancel);
    backdrop.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey, true);
  });
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

el("more").addEventListener("click", () => loadFolder(state.folder, { append: true }));
el("new").addEventListener("click", () => openCompose());
el("c-cancel").addEventListener("click", closeCompose);
el("compose").addEventListener("submit", submitCompose);
el("reply").addEventListener("click", () => state.selected && replyTo(state.selected));
el("toggle-remote").addEventListener("click", () => { state.allowRemote = true; renderBody(); });
el("toggle-source").addEventListener("click", () => { state.showSource = !state.showSource; renderBody(); });

el("delete").addEventListener("click", async () => {
  const message = state.selected;
  if (!message) return;
  const permanent = message.folder === "trash";
  const ok = await confirmDialog({
    title: permanent ? "Delete forever?" : "Move to Trash?",
    text: permanent
      ? "The message and its attachments are removed from your R2 bucket. This cannot be undone."
      : "It stays recoverable in Trash for 30 days, then is deleted for good.",
    action: permanent ? "Delete forever" : "Move to Trash",
  });
  if (!ok) return;
  try {
    await api(`/messages/${message.id}${permanent ? "?purge=1" : ""}`, { method: "DELETE" });
    document.querySelector(`#messages li[data-id="${message.id}"]`)?.remove();
    state.messages = state.messages.filter((m) => m.id !== message.id);
    clearReader();
    loadCounts();
  } catch (err) {
    el("list-status").textContent = err.message;
  }
});

el("select-all").addEventListener("change", (e) => {
  if (e.target.checked) state.messages.forEach((m) => state.picked.add(m.id));
  else state.picked.clear();
  document.querySelectorAll("#messages li").forEach((li) => {
    const on = state.picked.has(li.dataset.id);
    li.classList.toggle("picked", on);
    const input = li.querySelector(".check input");
    if (input) input.checked = on;
  });
  renderBulkBar();
});

el("restore").addEventListener("click", async () => {
  const message = state.selected;
  if (!message) return;
  await api(`/messages/${message.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder: "inbox" }),
  });
  clearReader();
  await loadFolder(state.folder);
  loadCounts();
});

el("bulk-restore").addEventListener("click", () => bulkPatch({ folder: "inbox" }));
el("bulk-inbox").addEventListener("click", () => bulkPatch({ folder: "inbox" }));
el("bulk-quarantine").addEventListener("click", () => bulkPatch({ folder: "quarantine" }));

async function moveSelected(folder) {
  const message = state.selected;
  if (!message) return;
  await api(`/messages/${message.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder }),
  });
  clearReader();
  await loadFolder(state.folder);
  loadCounts();
}

el("to-inbox").addEventListener("click", () => moveSelected("inbox"));
el("to-quarantine").addEventListener("click", () => moveSelected("quarantine"));

/**
 * A rule is about the sender, so it is created from a message rather than
 * from a settings screen — the moment you decide is the moment you are
 * looking at the mail that made you decide.
 */
async function ruleFor(message, action, label) {
  const sender = (addressOf(message.header_from) || message.envelope_from || "").toLowerCase();
  if (!sender) return;
  const domain = sender.split("@")[1] || "";

  const scope = await confirmDialog({
    title: `${label} ${sender}?`,
    text: action === "inbox"
      ? "Mail from this sender will go straight to your inbox, including anything already quarantined."
      : `Mail from this sender will be ${action === "trash" ? "moved to Trash" : "quarantined"} on arrival, and anything already received will be moved now.`,
    action: label,
    extra: domain ? { label: `Whole domain (@${domain})`, value: "domain" } : null,
  });
  if (!scope) return;

  const result = await (await api("/rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: scope === "domain" ? "domain" : "sender",
      pattern: scope === "domain" ? domain : sender,
      action,
    }),
  })).json();

  clearReader();
  await loadFolder(state.folder);
  loadCounts();
  el("list-status").textContent = result.applied
    ? `Rule added · ${result.applied} existing message${result.applied === 1 ? "" : "s"} moved`
    : "Rule added";
}

el("block-sender").addEventListener("click", () =>
  state.selected && ruleFor(state.selected, "trash", "Block"));
el("allow-sender").addEventListener("click", () =>
  state.selected && ruleFor(state.selected, "inbox", "Always allow"));

async function loadRules() {
  try {
    const { rules } = await (await api("/rules")).json();
    const host = el("rules");
    host.replaceChildren(...rules.map((rule) => {
      const item = document.createElement("li");
      const type = document.createElement("span");
      type.className = "type";
      const dot = document.createElement("i");
      dot.className = "dot";
      dot.style.background = rule.action === "inbox" ? SERIES.sent : "#c0392b";
      type.append(dot, document.createTextNode(rule.action));

      const what = document.createElement("span");
      what.className = "what";
      what.textContent = `${rule.kind === "domain" ? "@" : ""}${rule.pattern}`;

      const remove = document.createElement("button");
      remove.className = "quiet";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        await api(`/rules/${rule.id}`, { method: "DELETE" });
        loadRules();
      });

      item.append(type, what, remove);
      return item;
    }));
    if (!rules.length) {
      const empty = document.createElement("li");
      empty.className = "what";
      empty.textContent = "No rules yet. Use Block or Allow sender on a message.";
      host.append(empty);
    }
  } catch { /* rules are additive; never block the dashboard on them */ }
}
el("bulk-read").addEventListener("click", () => bulkPatch({ seen: true }));
el("bulk-unread").addEventListener("click", () => bulkPatch({ seen: false }));

el("bulk-delete").addEventListener("click", async () => {
  const count = state.picked.size;
  if (!count) return;
  const permanent = state.folder === "trash";
  const ok = await confirmDialog({
    title: permanent
      ? `Delete ${count} message${count === 1 ? "" : "s"} forever?`
      : `Move ${count} message${count === 1 ? "" : "s"} to Trash?`,
    text: permanent
      ? "They and their attachments are removed from your R2 bucket. This cannot be undone."
      : "They stay recoverable in Trash for 30 days, then are deleted for good.",
    action: permanent ? "Delete forever" : "Move to Trash",
  });
  if (!ok) return;
  const ids = [...state.picked];
  await Promise.all(ids.map((id) =>
    api(`/messages/${id}${permanent ? "?purge=1" : ""}`, { method: "DELETE" }).catch(() => {})));
  clearSelection();
  clearReader();
  await loadFolder(state.folder);
  loadCounts();
});

// Search spans every folder — looking for a message you can't place is
// exactly when you don't know which folder it's in.
el("q").addEventListener("input", debounce((e) => {
  state.query = e.target.value.trim();
  loadFolder(state.folder);
}, 220));

/**
 * One action, not three. Fetch pulls anything Resend is holding, then reloads
 * the view — there is no reason to ever want half of that, and three buttons
 * doing overlapping jobs is worse than one that does the whole job.
 */
el("sync").addEventListener("click", async () => {
  const button = el("sync");
  if (button.dataset.busy) return;
  button.dataset.busy = "1";
  button.setAttribute("aria-busy", "true");
  el("sync-label").textContent = "Fetching…";

  try {
    const result = await (await api("/backfill", { method: "POST" })).json();
    await loadFolder(state.folder);
    loadCounts();

    const parts = [];
    if (result.imported) parts.push(`${result.imported} new`);
    if (result.tombstoned) parts.push(`${result.tombstoned} previously deleted, left alone`);
    if (result.failed?.length) parts.push(`${result.failed.length} failed`);
    el("list-status").textContent = parts.length
      ? parts.join(" · ")
      : (state.messages.length ? "" : "Nothing here.");
  } catch (err) {
    el("list-status").textContent = err.message;
  } finally {
    delete button.dataset.busy;
    button.removeAttribute("aria-busy");
    el("sync-label").textContent = "Fetch";
  }
});

/**
 * Theme switch. The knob is spring-driven rather than transitioned, so it
 * animates from wherever it currently is and can be re-targeted mid-flight
 * without jumping — the same behaviour as the switch on amirsalmani.com.
 */
const THEME_KEY = "postern-theme";
const toggle = el("theme");

let knobValue = 0;      // 0 = dark, 1 = light
let knobTarget = 0;
let knobVelocity = 0;
let knobFrame = null;

function springTo(target) {
  knobTarget = target;
  if (knobFrame) return;
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    // Critically damped: response 0.35s, damping ratio 1.
    const stiffness = (2 * Math.PI / 0.35) ** 2;
    const damping = 2 * (2 * Math.PI / 0.35);
    const accel = stiffness * (knobTarget - knobValue) - damping * knobVelocity;
    knobVelocity += accel * dt;
    knobValue += knobVelocity * dt;

    if (Math.abs(knobTarget - knobValue) < 0.001 && Math.abs(knobVelocity) < 0.001) {
      knobValue = knobTarget;
      knobVelocity = 0;
      knobFrame = null;
    } else {
      knobFrame = requestAnimationFrame(step);
    }
    toggle.style.setProperty("--t", knobValue.toFixed(4));
  };
  knobFrame = requestAnimationFrame(step);
}

function applyTheme(theme, { animate = true } = {}) {
  document.documentElement.dataset.theme = theme;
  toggle.setAttribute("aria-pressed", String(theme === "dark"));
  toggle.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} theme`);
  const target = theme === "light" ? 1 : 0;
  if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) springTo(target);
  else { knobValue = knobTarget = target; toggle.style.setProperty("--t", String(target)); }
}

applyTheme(
  localStorage.getItem(THEME_KEY)
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  { animate: false },
);

toggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  renderBody();
});

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.key === "/") { e.preventDefault(); el("q").focus(); }
  if (e.key === "Escape") { clearSelection(); clearReader(); }
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

// Nothing refreshes on its own — not on a timer, not on tab focus. A cron
// fetches from Resend every 30 minutes server-side; the browser only asks
// when you press Fetch or Refresh. Every request here is one you chose.

loadFolder("inbox");
loadCounts();
loadIdentities();
