// Agent Studio front end. Talks to OpenCode through the local server's /oc/* proxy.
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };

const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
};

// ---------------------------------------------------------------- state
const S = {
  dir: "", state: {}, sessions: [], sid: null,
  msgs: new Map(), // messageID -> { info, parts: Map(partID -> part) }
  status: {}, perms: new Map(), questions: new Map(), todos: [],
  providers: [], model: null, agents: [], agent: "build", commands: [],
  attach: [], es: null, dirty: new Set(), busySince: 0, diffs: [],
};

// ---------------------------------------------------------------- api
async function api(path, { method = "GET", body } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const url = "/oc" + path + (S.dir ? `${sep}directory=${encodeURIComponent(S.dir)}` : "");
  const r = await fetch(url, {
    method, headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (r.status === 401) signedOut();
  if (!r.ok) throw new Error(`${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const studio = (path, opts) => fetch("/studio/" + path, opts).then((r) => { if (r.status === 401) signedOut(); return r.json(); });
function signedOut() { $("#signed-out").hidden = false; }
const saveState = (patch) => { Object.assign(S.state, patch); return studio("state", { method: "PUT", body: JSON.stringify(patch) }); };

function toast(msg, ms = 3200) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
function fail(e) { console.error(e); toast(String(e.message || e)); }

// ---------------------------------------------------------------- boot
async function boot() {
  applyTheme(localStorage.getItem("theme") || "system");
  // The launcher opens the window with a one-time code (and the folder from Run Agent).
  const q = new URLSearchParams(location.search);
  const code = q.get("code"), folder = q.get("folder");
  if (code || folder) history.replaceState(null, "", "/");
  if (code) await fetch("/studio/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }).catch(() => {});
  const r = await fetch("/studio/state");
  if (r.status === 401) return signedOut();
  S.state = await r.json();
  if (S.state.sidebar === false) document.body.classList.add("no-side");
  pcQuestions(); loadSandbox();
  S.dir = S.state.project || S.state.agentRoot;
  const picked = folder ? await pickFolder(folder) : null;
  await openProject(picked || S.dir, !picked);
  pollGateway(); setInterval(pollGateway, 15000);
}

// A folder for the agent: inside the AI agent folder it opens as it is; outside, it is copied in first
// (after asking), so the agent never changes the original.
async function pickFolder(p) {
  const r = await studio("dir?path=" + encodeURIComponent(String(p).trim()));
  if (!r.exists) { toast("That folder doesn't exist"); return null; }
  if (r.inside) return r.path;
  $("#import-root").textContent = r.root;
  $("#import-from").textContent = r.path;
  const dlg = $("#dlg-import");
  const yes = await new Promise((ok) => {
    $("#import-yes").onclick = () => { ok(true); dlg.close(); };
    $("#import-no").onclick = () => dlg.close();
    dlg.onclose = () => ok(false);
    dlg.showModal();
  });
  if (!yes) return null;
  toast("Copying the folder in…", 60000);
  const res = await fetch("/studio/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: r.path }) });
  const j = await res.json();
  if (!res.ok) { toast(j.error || "Copying failed"); return null; }
  toast(`Copied in: ${j.path}`);
  return j.path;
}

async function loadSandbox() {
  const el = $("#sandbox");
  const s = await studio("sandbox").catch(() => null);
  const ok = s && s.label === "low";
  el.className = "sandbox " + (ok ? "ok" : "bad");
  el.querySelector("span").textContent = ok ? `Sandbox: ${baseName(s.root)}` : "Sandbox not set up (run Install.bat)";
  if (s) el.title = ok ? `The agent can change files only in ${s.root}. It can't touch drivers, the registry or system settings.` : el.title;
}

// Risky PC actions wait for a yes here. Every open window gets the question; the first answer counts.
function pcQuestions() {
  let current = null;
  const dlg = $("#dlg-ask");
  const answer = (yes) => {
    if (!current) return;
    const id = current; current = null;
    fetch("/studio/pc/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, yes }) });
    if (dlg.open) dlg.close();
  };
  $("#ask-yes").onclick = () => answer(true);
  $("#ask-no").onclick = () => answer(false);
  dlg.addEventListener("close", () => answer(false));
  const es = new EventSource("/studio/pc/events");
  es.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    if (e.type === "ask") {
      current = e.id;
      $("#ask-text").textContent = e.question;
      if (!dlg.open) dlg.showModal();
      $("#ask-no").focus();   // Enter or Space alone never approves
    } else if (e.type === "done" && current === e.id) { current = null; if (dlg.open) dlg.close(); }
  };
  es.onerror = () => { if (es.readyState === 2) setTimeout(pcQuestions, 3000); };
}

// A deleted project folder: create it again (empty, so its chats carry on) or drop it and open another project.
// Returns the folder to use.
async function ensureFolder(dir) {
  if (!dir) return S.state.agentRoot;
  const exists = async (p) => (await studio("dir?path=" + encodeURIComponent(p)).catch(() => ({ exists: true }))).exists;
  if (await exists(dir)) return dir;
  if (confirm(`The project folder\n${dir}\nwas deleted.\n\nOK: create it again (empty) and keep its chats.\nCancel: remove it from the list and open another project.`)) {
    const j = await studio("mkdir", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: dir }) });
    if (!j.error) { toast(`Created ${dir} again`); return dir; }
    toast(j.error);
  }
  const projects = (S.state.projects || []).filter((p) => p !== dir);
  let next = S.state.agentRoot;
  for (const p of projects) if (await exists(p)) { next = p; break; }
  await saveState({ projects, project: next });
  return next;
}

async function openProject(dir, first) {
  dir = await ensureFolder(dir);
  S.dir = dir;
  const projects = [dir, ...(S.state.projects || []).filter((p) => p !== dir)].slice(0, 12);
  if (!first || !S.state.project) saveState({ project: dir, projects });
  else S.state.projects = projects;
  $("#project-name").textContent = baseName(dir) || "No project";
  $("#project").title = dir;
  $("#welcome-project").textContent = dir ? `in ${dir}` : "";
  connectEvents();
  await Promise.all([loadProviders(), loadAgents(), loadCommands(), loadSessions()]);
  const keep = first && S.state.sid && S.sessions.find((s) => s.id === S.state.sid);
  if (keep) await openSession(S.state.sid); else { showSession(null); loadChanges(); }
  if (paneTab()) refreshPane();
}

function baseName(p) { return String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop(); }

// ---------------------------------------------------------------- events (SSE)
function connectEvents() {
  if (S.es) S.es.close();
  const es = new EventSource(`/oc/event?directory=${encodeURIComponent(S.dir)}`);
  S.es = es;
  es.onmessage = (ev) => { try { const e = JSON.parse(ev.data); onEvent(e.type, e.properties || {}); } catch (err) { console.warn(err); } };
  es.onerror = () => { setTimeout(() => { if (S.es === es && es.readyState === 2) connectEvents(); }, 2000); };
}

function onEvent(type, p) {
  switch (type) {
    case "session.created": case "session.updated": {
      const i = S.sessions.findIndex((s) => s.id === p.info.id);
      if (p.info.parentID) break; // subagent sessions stay out of the list
      if (i >= 0) S.sessions[i] = p.info; else S.sessions.unshift(p.info);
      renderSessions();
      if (p.info.id === S.sid) renderHeader();
      break;
    }
    case "session.deleted":
      S.sessions = S.sessions.filter((s) => s.id !== p.info.id); renderSessions();
      if (p.info.id === S.sid) showSession(null);
      break;
    case "session.status":
      S.status[p.sessionID] = p.status; renderSessions();
      if (p.sessionID === S.sid) renderBusy();
      break;
    case "session.idle":
      S.status[p.sessionID] = { type: "idle" }; renderSessions();
      if (p.sessionID === S.sid) { renderBusy(); loadChanges(); }
      break;
    case "session.error":
      if (p.sessionID === S.sid && p.error) showError(p.error);
      break;
    case "message.updated":
      if (p.info.sessionID !== S.sid) break;
      msg(p.info.id).info = p.info; mark(p.info.id);
      break;
    case "message.removed":
      if (p.sessionID !== S.sid) break;
      S.msgs.delete(p.messageID); $(`.msg[data-id="${p.messageID}"]`)?.remove();
      break;
    case "message.part.updated": {
      const part = p.part; if (part.sessionID !== S.sid) break;
      msg(part.messageID).parts.set(part.id, part); mark(part.messageID);
      break;
    }
    case "message.part.delta": {
      if (p.sessionID !== S.sid) break;
      const m = msg(p.messageID); let part = m.parts.get(p.partID);
      if (!part) { part = { id: p.partID, messageID: p.messageID, type: p.field === "text" ? "text" : "text" }; m.parts.set(p.partID, part); }
      part[p.field] = (part[p.field] || "") + p.delta; mark(p.messageID);
      break;
    }
    case "message.part.removed":
      if (p.sessionID !== S.sid) break;
      S.msgs.get(p.messageID)?.parts.delete(p.partID); mark(p.messageID);
      break;
    case "permission.asked":
      S.perms.set(p.id, p); renderCards(); renderSessions(); notify("Permission needed", p.permission);
      break;
    case "permission.replied":
      S.perms.delete(p.requestID); renderCards(); renderSessions();
      break;
    case "question.asked":
      S.questions.set(p.id, p); renderCards(); renderSessions(); notify("Question", p.questions?.[0]?.question);
      break;
    case "question.replied": case "question.rejected":
      S.questions.delete(p.requestID); renderCards(); renderSessions();
      break;
    case "todo.updated":
      if (p.sessionID === S.sid) { S.todos = p.todos || []; renderTodos(); }
      break;
    case "session.diff": case "file.edited":
      clearTimeout(loadChanges.t); loadChanges.t = setTimeout(loadChanges, 400);
      break;
    case "mcp.tools.changed":
      if ($("#dlg-connectors").open) loadMcp();
      break;
  }
}

function notify(title, body) {
  if (document.hasFocus()) return;
  if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body: body || "" });
}

// ---------------------------------------------------------------- providers / models / agents
async function loadProviders() {
  try {
    const r = await api("/config/providers");
    S.providers = r.providers || [];
    const want = S.state.model;
    const has = (m) => m && S.providers.some((p) => p.id === m.providerID && p.models[m.modelID]);
    if (has(want)) S.model = want;
    else {
      const pick = has({ providerID: "opencode", modelID: "glm-5.3-flash-free" }) ? { providerID: "opencode", modelID: "glm-5.3-flash-free" }
        : Object.entries(r.default || {}).map(([providerID, modelID]) => ({ providerID, modelID })).find(has);
      S.model = pick || null;
    }
  } catch (e) { fail(e); }
  renderModel();
}
function modelInfo(m = S.model) { return m && S.providers.find((p) => p.id === m.providerID)?.models[m.modelID]; }
function renderModel() {
  const mi = modelInfo();
  $("#model-name").textContent = mi ? mi.name || mi.id : "Choose a model";
}
function isFree(m) { return m.cost && m.cost.input === 0 && m.cost.output === 0; }

// Small local models get the lean "local" agent (short prompt, core tools); others go back to build.
function pickModel(m) {
  S.model = m; saveState({ model: m }); renderModel();
  const lean = m.providerID === "local" && S.agents.some((a) => a.name === "local");
  if (lean) S.agent = "local"; else if (S.agent === "local") S.agent = "build";
  renderAgents();
}
function openModelMenu(anchor, onPick = pickModel) {
  const items = [];
  const sorted = [...S.providers].sort((a, b) => (a.id === "opencode" ? -1 : b.id === "opencode" ? 1 : a.name.localeCompare(b.name)));
  for (const p of sorted) {
    const models = Object.values(p.models).sort((a, b) => (isFree(b) - isFree(a)) || String(a.name).localeCompare(String(b.name)));
    items.push({ head: p.name });
    for (const m of models) {
      const cur = S.model && S.model.providerID === p.id && S.model.modelID === m.id;
      const ctx = m.limit?.context ? `${Math.round(m.limit.context / 1000)}k` : "";
      items.push({
        label: m.name || m.id, sub: ctx, badge: isFree(m) ? "free" : "", cur, search: `${p.name} ${m.id} ${m.name}`,
        run: () => onPick({ providerID: p.id, modelID: m.id }),
      });
    }
  }
  menu(anchor, items, { filter: "Search models", up: true });
}

async function loadAgents() {
  try { S.agents = (await api("/agent")).filter((a) => a.mode !== "subagent" && !a.hidden); } catch (e) { fail(e); }
  if (!S.agents.find((a) => a.name === S.agent)) S.agent = S.agents[0]?.name || "build";
  renderAgents();
}
function renderAgents() {
  const seg = $("#agent-seg");
  const main = S.agents.filter((a) => ["build", "plan", "creator", "reverse", "local"].includes(a.name));
  const list = main.length ? main : S.agents.slice(0, 2);
  seg.innerHTML = list.map((a) => `<button data-agent="${esc(a.name)}" class="${a.name === S.agent ? "on" : ""}" title="${esc(a.description || "")}">${esc(a.name)}</button>`).join("");
}
function toggleAgent() {
  const names = $$("#agent-seg button").map((b) => b.dataset.agent);
  S.agent = names[(names.indexOf(S.agent) + 1) % names.length] || S.agent; renderAgents();
}

async function loadCommands() { try { S.commands = await api("/command"); } catch { S.commands = []; } }

// ---------------------------------------------------------------- sessions
async function loadSessions() {
  try { S.sessions = (await api("/session?roots=true")).filter((s) => !s.parentID); } catch (e) { S.sessions = []; fail(e); }
  try { S.status = await api("/session/status"); } catch {}
  try { for (const p of await api("/permission")) S.perms.set(p.id, p); } catch {}
  try { for (const q of await api("/question")) S.questions.set(q.id, q); } catch {}
  renderSessions();
}

function renderSessions() {
  const q = $("#session-search").value.trim().toLowerCase();
  const list = S.sessions.filter((s) => !q || (s.title || "").toLowerCase().includes(q))
    .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
  const now = new Date(); const day = 864e5;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groupOf = (t) => t >= startToday ? "Today" : t >= startToday - day ? "Yesterday" : t >= startToday - 7 * day ? "This week" : "Older";
  const asks = new Set([...S.perms.values(), ...S.questions.values()].map((x) => x.sessionID));
  let html = "", last = "";
  for (const s of list) {
    const g = groupOf(s.time?.updated || 0);
    if (g !== last) { html += `<div class="group">${g}</div>`; last = g; }
    const busy = S.status[s.id] && S.status[s.id].type !== "idle";
    html += `<button class="sess ${s.id === S.sid ? "on" : ""} ${busy ? "busy" : ""} ${asks.has(s.id) ? "ask" : ""}" data-sid="${s.id}">
      <span class="dot"></span><span class="t">${esc(s.title || "Untitled")}</span>
      <span class="del" data-del="${s.id}" title="Delete">${ICON.trash}</span></button>`;
  }
  $("#sessions").innerHTML = html || `<div class="group">No sessions yet</div>`;
}

function showSession(id) {
  S.sid = id; S.msgs.clear(); S.todos = []; S.dirty.clear();
  $("#messages").innerHTML = ""; $("#cards").innerHTML = "";
  document.body.classList.toggle("has-session", !!id);
  renderHeader(); renderTodos(); renderBusy(); renderCards(); renderSessions(); renderChangesCount(); renderMeter();
  saveState({ sid: id });
}

async function openSession(id) {
  showSession(id);
  try {
    const [list, todos] = await Promise.all([api(`/session/${id}/message`), api(`/session/${id}/todo`).catch(() => [])]);
    if (S.sid !== id) return;
    for (const { info, parts } of list) {
      const m = msg(info.id); m.info = info;
      for (const p of parts) m.parts.set(p.id, p);
      mark(info.id);
    }
    S.todos = todos; renderTodos();
    flush(); scrollDown(true);
    loadChanges();
  } catch (e) { fail(e); }
  if (paneTab()) refreshPane();
}

async function newSession(silent) {
  const s = await api("/session", { method: "POST", body: {} });
  if (!S.sessions.find((x) => x.id === s.id)) S.sessions.unshift(s);
  showSession(s.id);
  if (!silent) $("#input").focus();
  return s;
}

function current() { return S.sessions.find((s) => s.id === S.sid); }
function renderHeader() {
  const s = current();
  $("#title").textContent = s ? s.title || "Untitled" : "New session";
  document.title = s ? `${s.title || "Untitled"} · Agent Studio` : "Agent Studio";
}

function renderBusy() {
  const st = S.sid && S.status[S.sid];
  const busy = !!st && st.type !== "idle";
  document.body.classList.toggle("busy", busy);
  const pill = $("#status");
  pill.className = "pill " + (st?.type || "");
  pill.textContent = !st || st.type === "idle" ? "" : st.type === "retry" ? `Retrying (${st.attempt})` : "Working";
  $("#working").hidden = !busy;
  if (busy && !S.busySince) S.busySince = Date.now();
  if (!busy) S.busySince = 0;
  $("#working-text").textContent = st?.type === "retry" ? (st.message || "Provider busy, retrying") : "Working";
  if (busy) scrollDown();
}
setInterval(() => {
  if (!S.busySince) return;
  const s = Math.round((Date.now() - S.busySince) / 1000);
  const st = S.status[S.sid];
  if (st?.type !== "retry") $("#working-text").textContent = `Working · ${s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s"}`;
}, 1000);

// ---------------------------------------------------------------- messages
function msg(id) {
  let m = S.msgs.get(id);
  if (!m) { m = { info: null, parts: new Map() }; S.msgs.set(id, m); }
  return m;
}
function mark(id) { S.dirty.add(id); if (!mark.raf) mark.raf = requestAnimationFrame(flush); }
function flush() {
  mark.raf = 0;
  const box = $("#messages");
  const nearBottom = isNearBottom();
  for (const id of S.dirty) {
    const m = S.msgs.get(id); if (!m || !m.info) continue;
    const el = renderMessage(id, m);
    const old = box.querySelector(`.msg[data-id="${id}"]`);
    if (old) { keepOpen(old, el); old.replaceWith(el); }
    else {
      const after = [...box.children].find((c) => c.dataset.id > id);
      box.insertBefore(el, after || null);
    }
  }
  S.dirty.clear();
  markReverted(); renderMeter();
  if (nearBottom) scrollDown(true);
}
function keepOpen(oldEl, newEl) { // keep expanded tool rows expanded across re-renders
  for (const d of $$("details[data-k]", oldEl)) {
    const n = newEl.querySelector(`details[data-k="${d.dataset.k}"]`);
    if (n) n.open = d.open;
  }
}
function isNearBottom() { const t = $("#thread"); return t.scrollHeight - t.scrollTop - t.clientHeight < 120; }
function scrollDown(force) { const t = $("#thread"); if (force || isNearBottom()) t.scrollTop = t.scrollHeight; }

function md(text) {
  const html = DOMPurify.sanitize(marked.parse(text || "", { gfm: true, breaks: false }));
  const div = document.createElement("div"); div.className = "md"; div.innerHTML = html;
  for (const a of $$("a", div)) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  for (const pre of $$("pre", div)) pre.insertAdjacentHTML("beforeend", '<button class="copy">Copy</button>');
  return div;
}

function renderMessage(id, { info, parts }) {
  const list = [...parts.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  if (info.role === "user") {
    const el = h(`<div class="msg user" data-id="${id}"></div>`);
    const files = list.filter((p) => p.type === "file");
    if (files.length) el.append(h(`<div class="files">${files.map(fileChip).join("")}</div>`));
    const text = list.filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join("\n");
    if (text) el.append(h(`<div class="bubble">${esc(text)}</div>`));
    el.append(h(`<div class="tools">
      <button data-act="copy">Copy</button><button data-act="revert" title="Undo this message and every change after it">Undo from here</button>
      <button data-act="fork" title="Start a new session from this point">Fork</button></div>`));
    return el;
  }
  const el = h(`<div class="msg assistant" data-id="${id}"></div>`);
  for (const p of list) {
    const node = renderPart(p, info);
    if (node) el.append(node);
  }
  if (info.error && info.error.name !== "MessageAbortedError") el.append(errorBox(info.error));
  if (info.error && info.error.name === "MessageAbortedError") el.append(h(`<div class="note">Stopped.</div>`));
  if (info.time?.completed) el.append(turnFooter(info));
  return el;
}

// Footer for the whole agent turn: time since the user's message, and tokens of the last step.
function turnFooter(info) {
  const user = S.msgs.get(info.parentID)?.info;
  const start = user?.time?.created || info.time.created;
  const secs = Math.round((info.time.completed - start) / 1000);
  const t = info.tokens || {};
  const tok = (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cache?.read || 0);
  const cost = [...S.msgs.values()].filter((m) => m.info?.parentID === info.parentID).reduce((a, m) => a + (m.info.cost || 0), 0);
  return h(`<div class="foot"><span>${esc(info.modelID || "")}</span><span>${secs < 60 ? secs + "s" : Math.floor(secs / 60) + "m " + (secs % 60) + "s"}</span><span>${tok.toLocaleString()} tokens in context</span>${cost ? `<span>$${cost.toFixed(4)}</span>` : ""}</div>`);
}

function fileChip(p) {
  const img = p.mime?.startsWith("image/") && p.url?.startsWith("data:") ? `<img src="${esc(p.url)}" alt="">` : ICON.file;
  return `<span class="file-chip">${img}<span>${esc(p.filename || p.url)}</span></span>`;
}
function errorBox(err) {
  const m = err.data?.message || err.message || err.name || "Something went wrong";
  return h(`<div class="error-box"><b>${esc(err.name || "Error")}</b>: ${esc(m)}</div>`);
}
function showError(err) {
  $("#cards").append(errorBox(err)); scrollDown();
}

function renderPart(p, info) {
  switch (p.type) {
    case "text": return p.synthetic || !p.text ? null : md(p.text);
    case "reasoning": {
      if (!p.text?.trim()) return null;
      const live = !p.time?.end && !info.time?.completed;
      const d = h(`<details class="think" data-k="${p.id}"><summary>${live ? "Thinking…" : "Thought process"}</summary></details>`);
      d.append(md(p.text)); return d;
    }
    case "tool": return renderTool(p);
    case "file": return h(`<div class="files" style="justify-content:flex-start">${fileChip(p)}</div>`);
    case "patch": return h(`<div class="note">Changed ${p.files.length} file${p.files.length === 1 ? "" : "s"} · <button class="link" data-act="changes">view changes</button></div>`);
    case "retry": return h(`<div class="note warn">Retrying (attempt ${p.attempt}): ${esc(p.error?.data?.message || p.error?.message || "")}</div>`);
    case "agent": return h(`<div class="note">Using agent <b>${esc(p.name)}</b></div>`);
    case "subtask": return h(`<div class="note">Subtask for <b>${esc(p.agent)}</b>: ${esc(p.description || "")}</div>`);
    case "compaction": return h(`<div class="divider">Conversation summarised to save context</div>`);
    default: return null; // step-start, step-finish, snapshot
  }
}

const TOOL_NAMES = {
  read: "Read", edit: "Edit", write: "Write", bash: "Run", grep: "Search", glob: "Find", list: "List",
  webfetch: "Fetch", websearch: "Web search", task: "Agent", todowrite: "Update tasks", todoread: "Read tasks",
  patch: "Patch", apply_patch: "Patch", multiedit: "Edit", question: "Ask", skill: "Skill", lsp: "Code intel",
};
function toolArg(tool, input = {}) {
  const rel = (f) => String(f || "").replace(S.dir, "").replace(/^[\\/]/, "");
  switch (tool) {
    case "read": case "edit": case "write": case "multiedit": return rel(input.filePath);
    case "bash": return input.command;
    case "grep": return input.pattern + (input.path ? ` in ${rel(input.path)}` : "");
    case "glob": return input.pattern;
    case "list": return rel(input.path) || ".";
    case "webfetch": return input.url;
    case "websearch": return input.query;
    case "task": return input.description;
    case "todowrite": return `${(input.todos || []).length} tasks`;
    default: { const v = Object.values(input).find((x) => typeof x === "string"); return v || ""; }
  }
}
function renderTool(p) {
  const st = p.state || {}; const input = st.input || {};
  if (p.tool === "todowrite" || p.tool === "todoread") {
    return st.status === "error" ? h(`<div class="note warn">Task list update failed: ${esc(st.error)}</div>`) : null;
  }
  const name = TOOL_NAMES[p.tool] || p.tool.replace(/_/g, " ");
  const arg = toolArg(p.tool, input);
  const status = st.status || "pending";
  const icon = status === "completed" ? ICON.check : status === "error" ? ICON.x : "";
  let meta = "";
  const diffText = st.metadata?.diff;
  if (diffText) { const c = countDiff(diffText); meta = `<span class="plus">+${c.a}</span> <span class="minus">−${c.d}</span>`; }
  else if (p.tool === "bash" && st.metadata?.exit !== undefined && st.metadata.exit !== 0) meta = `<span class="minus">exit ${st.metadata.exit}</span>`;
  else if (p.tool === "read" && st.metadata?.preview === undefined && st.output) meta = "";
  const sub = p.tool === "task" && st.metadata?.sessionId ? `<button class="link sub-link" data-sub="${esc(st.metadata.sessionId)}">open</button>` : "";
  const d = h(`<details class="tool ${status}" data-k="${p.id}">
    <summary><span class="st">${icon}</span><span class="name">${esc(name)}</span><span class="arg">${esc(arg)}</span>${sub}<span class="meta">${meta}</span></summary></details>`);
  const detail = document.createElement("div"); detail.className = "detail";
  if (diffText) detail.append(diffView(diffText));
  else if (p.tool === "write" && input.content) detail.append(preBlock(input.content));
  else if (p.tool === "bash") {
    detail.append(h(`<div class="label">Command</div>`), preBlock(input.command || ""));
    if (st.output || st.metadata?.output) detail.append(h(`<div class="label">Output</div>`), preBlock(trim(st.output || st.metadata?.output)));
  } else if (st.output) detail.append(preBlock(trim(st.output)));
  else if (Object.keys(input).length) detail.append(preBlock(JSON.stringify(input, null, 2)));
  if (status === "error") detail.append(h(`<pre class="err">${esc(st.error)}</pre>`));
  if (detail.childNodes.length) d.append(detail);
  if (status === "running" || status === "pending") d.classList.add("running");
  return d;
}
function trim(s, n = 6000) { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s; }
function preBlock(text) { const pre = document.createElement("pre"); pre.textContent = text; return pre; }
function countDiff(t) { let a = 0, d = 0; for (const l of String(t).split("\n")) { if (l.startsWith("+") && !l.startsWith("+++")) a++; else if (l.startsWith("-") && !l.startsWith("---")) d++; } return { a, d }; }
function diffView(text) {
  const box = document.createElement("div"); box.className = "diff";
  for (const l of String(text).split("\n")) {
    if (/^(Index:|index [0-9a-f]|={3,}|diff --git|\+\+\+|---|new file mode|deleted file mode|\\ No newline)/.test(l)) continue;
    const div = document.createElement("div");
    div.className = l.startsWith("@@") ? "h" : l.startsWith("+") ? "a" : l.startsWith("-") ? "d" : "";
    div.textContent = l || " "; box.append(div);
  }
  return box;
}

function markReverted() {
  const rev = current()?.revert?.messageID;
  for (const el of $$("#messages .msg")) el.classList.toggle("reverted", !!rev && el.dataset.id >= rev);
  const bar = $("#revert-bar");
  if (rev && !bar) $("#cards").prepend(h(`<div class="note" id="revert-bar">Messages below were undone. <button class="link" data-act="unrevert">Restore them</button> · sending a new message makes the undo permanent.</div>`));
  if (!rev && bar) bar.remove();
}

// ---------------------------------------------------------------- permission + question cards
function renderCards() {
  const box = $("#cards");
  $$(".card", box).forEach((c) => c.remove());
  for (const p of S.perms.values()) {
    if (p.sessionID !== S.sid) continue;
    const pats = (p.patterns || []).join("\n");
    const diff = p.metadata?.diff;
    const c = h(`<div class="card perm" data-perm="${p.id}">
      <h5>Allow <b>${esc(p.permission)}</b>?</h5>
      <div class="muted">${esc(p.metadata?.description || "The agent wants to do this:")}</div>
      ${pats ? `<div class="what">${esc(pats)}</div>` : ""}
      <div class="acts"><button class="btn primary" data-reply="once">Allow once</button>
      <button class="btn" data-reply="always" title="${esc((p.always || []).join(", "))}">Always allow</button>
      <button class="btn danger" data-reply="reject">Deny</button></div></div>`);
    if (diff) c.querySelector(".acts").before(diffView(diff));
    box.append(c);
  }
  for (const q of S.questions.values()) {
    if (q.sessionID !== S.sid) continue;
    const c = h(`<div class="card" data-q="${q.id}"></div>`);
    q.questions.forEach((qi, i) => {
      c.append(h(`<h5>${esc(qi.header || "Question")}</h5>`), h(`<div>${esc(qi.question)}</div>`));
      for (const o of qi.options || []) {
        const b = h(`<button class="opt" data-i="${i}" data-label="${esc(o.label)}">${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ""}</button>`);
        c.append(b);
      }
      if (qi.custom !== false) c.append(h(`<input type="text" data-i="${i}" placeholder="Or type your own answer">`));
      c.dataset["multi" + i] = qi.multiple ? "1" : "";
    });
    c.append(h(`<div class="acts"><button class="btn primary" data-qsend>Answer</button><button class="btn" data-qreject>Dismiss</button></div>`));
    box.append(c);
  }
  scrollDown();
}

async function replyPerm(id, reply) {
  try { await api(`/permission/${id}/reply`, { method: "POST", body: { reply } }); S.perms.delete(id); renderCards(); renderSessions(); }
  catch (e) { fail(e); }
}
async function answerQuestion(card, reject) {
  const id = card.dataset.q;
  try {
    if (reject) await api(`/question/${id}/reject`, { method: "POST" });
    else {
      const q = S.questions.get(id);
      const answers = q.questions.map((_, i) => {
        const picked = $$(`.opt.sel[data-i="${i}"]`, card).map((b) => b.dataset.label);
        const typed = $(`input[data-i="${i}"]`, card)?.value.trim();
        return typed ? [...picked, typed] : picked;
      });
      await api(`/question/${id}/reply`, { method: "POST", body: { answers } });
    }
    S.questions.delete(id); renderCards(); renderSessions();
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- todos + meter
function renderTodos() {
  const box = $("#todos"); const t = S.todos || [];
  box.hidden = !t.length;
  const done = t.filter((x) => x.status === "completed").length;
  $("#todos-title").textContent = `Tasks ${done}/${t.length}`;
  $("#todos-list").innerHTML = t.map((x) => `<li class="${esc(x.status)}">${esc(x.content)}</li>`).join("");
}
function renderMeter() {
  const last = [...S.msgs.values()].filter((m) => m.info?.role === "assistant" && m.info.tokens?.input).pop();
  const mi = modelInfo();
  if (!last || !mi?.limit?.context) { $("#meter").textContent = ""; return; }
  const t = last.info.tokens;
  const used = (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
  $("#meter").textContent = `${Math.min(100, Math.round((used / mi.limit.context) * 100))}% context`;
}

// ---------------------------------------------------------------- composer
const input = $("#input");
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + "px"; }

async function sendMessage(textArg) {
  const text = (textArg ?? input.value).trim();
  if (!text && !S.attach.length) return;
  if (!S.model) { toast("Choose a model first"); return; }
  if (text.startsWith("/") && !S.attach.length && (await slash(text))) { input.value = ""; autosize(); return; }
  // The project folder may have been deleted while the window was open: OpenCode can't run there.
  const ok = await ensureFolder(S.dir);
  if (ok !== S.dir) { await openProject(ok); toast("Your message is still in the box: send it again here."); return; }
  try {
    if (!S.sid) await newSession(true);
    const parts = [...S.attach.map(({ preview, ...p }) => p)];
    if (text) parts.unshift({ type: "text", text });
    input.value = ""; autosize(); S.attach = []; renderAttach();
    S.status[S.sid] = { type: "busy" }; renderBusy(); scrollDown(true);
    await api(`/session/${S.sid}/prompt_async`, { method: "POST", body: { parts, model: S.model, agent: S.agent } });
  } catch (e) { S.status[S.sid] = { type: "idle" }; renderBusy(); fail(e); }
}

// Built-in slash commands; anything else is passed to OpenCode's own commands (/init, custom ones…).
async function slash(text) {
  const [cmd, ...rest] = text.slice(1).split(" ");
  const args = rest.join(" ");
  switch (cmd) {
    case "new": case "clear": await newSession(); return true;
    case "undo": await undoLast(); return true;
    case "redo": if (S.sid) await api(`/session/${S.sid}/unrevert`, { method: "POST" }).catch(fail); return true;
    case "compact": case "summarize":
      if (S.sid) api(`/session/${S.sid}/summarize`, { method: "POST", body: { providerID: S.model.providerID, modelID: S.model.modelID } }).catch(fail);
      return true;
    case "models": openModelMenu($("#model")); return true;
    case "plan": case "build": case "local": case "creator": case "reverse": S.agent = cmd; renderAgents(); return true;
  }
  if (!S.commands.find((c) => c.name === cmd)) return false;
  if (!S.sid) await newSession(true);
  S.status[S.sid] = { type: "busy" }; renderBusy();
  api(`/session/${S.sid}/command`, { method: "POST", body: { command: cmd, arguments: args, agent: S.agent, model: `${S.model.providerID}/${S.model.modelID}` } }).catch(fail);
  return true;
}

async function undoLast() {
  if (!S.sid) return;
  const rev = current()?.revert?.messageID;
  const users = [...S.msgs.values()].filter((m) => m.info?.role === "user" && (!rev || m.info.id < rev)).map((m) => m.info.id).sort();
  const last = users.pop(); if (!last) return toast("Nothing to undo");
  await api(`/session/${S.sid}/revert`, { method: "POST", body: { messageID: last } }).catch(fail);
}

async function stop() { if (S.sid) await api(`/session/${S.sid}/abort`, { method: "POST" }).catch(fail); }

// slash and @ suggestions while typing
function suggest() {
  const v = input.value; const pos = input.selectionStart;
  const before = v.slice(0, pos);
  if (/^\/\S*$/.test(before)) {
    const q = before.slice(1).toLowerCase();
    const builtin = [["new", "Start a new session"], ["undo", "Undo the last message and its file changes"], ["redo", "Restore undone messages"],
      ["compact", "Summarise the conversation to free context"], ["plan", "Switch to Plan (read-only)"], ["build", "Switch to Build"], ["models", "Pick a model"]];
    const items = [...builtin.map(([n, d]) => ({ name: n, d })), ...S.commands.map((c) => ({ name: c.name, d: c.description || c.template?.slice(0, 60) }))]
      .filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 12)
      .map((c) => ({ label: "/" + c.name, sub: c.d || "", run: () => { input.value = "/" + c.name + " "; input.focus(); autosize(); } }));
    return items.length ? menu($("#composer"), items, { up: true, keys: true, keepFocus: true }) : closeMenu();
  }
  const at = before.match(/@([^\s@]*)$/);
  if (at) {
    clearTimeout(suggest.t);
    suggest.t = setTimeout(async () => {
      const files = await api(`/find/file?query=${encodeURIComponent(at[1])}&limit=12`).catch(() => []);
      if (!files.length) return closeMenu();
      menu($("#composer"), files.map((f) => ({
        label: f, run: () => {
          input.value = before.slice(0, -at[0].length) + "@" + f + " " + v.slice(pos);
          addFile(f); input.focus(); autosize();
        },
      })), { up: true, keys: true, keepFocus: true });
    }, 120);
    return;
  }
  if (menu.keys) closeMenu();
}

function addFile(rel) {
  const abs = (S.dir.replace(/[\\/]+$/, "") + "/" + rel).replace(/\\/g, "/");
  if (S.attach.some((a) => a.filename === rel)) return;
  S.attach.push({ type: "file", mime: "text/plain", filename: rel, url: "file:///" + abs.replace(/^\/+/, "") });
  renderAttach();
}
function renderAttach() {
  $("#attachments").innerHTML = S.attach.map((a, i) => `<span class="file-chip">${a.preview ? `<img src="${a.preview}" alt="">` : ICON.file}<span>${esc(a.filename)}</span><button class="x" data-unattach="${i}">✕</button></span>`).join("");
}
function readAsData(file) {
  return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); });
}
async function attachBlobs(files) {
  for (const f of files) {
    if (f.size > 8e6) { toast(`${f.name} is over 8 MB`); continue; }
    const url = await readAsData(f);
    S.attach.push({ type: "file", mime: f.type || "application/octet-stream", filename: f.name || "pasted.png", url, preview: f.type.startsWith("image/") ? url : "" });
  }
  renderAttach();
}

// ---------------------------------------------------------------- menu
function menu(anchor, items, { filter, up, keys, keepFocus } = {}) {
  const m = $("#menu"); m.innerHTML = ""; m.hidden = false; menu.keys = !!keys; menu.items = items;
  let box = m;
  if (filter) {
    const f = h(`<input class="filter" placeholder="${esc(filter)}">`); m.append(f);
    box = document.createElement("div"); m.append(box);
    f.oninput = () => draw(f.value.toLowerCase());
    setTimeout(() => f.focus());
  }
  function draw(q = "") {
    box.innerHTML = ""; let lastHead = null; let pendingHead = null;
    for (const it of items) {
      if (it.head) { pendingHead = it.head; continue; }
      if (q && !(it.search || it.label).toLowerCase().includes(q)) continue;
      if (pendingHead && pendingHead !== lastHead) { box.append(h(`<div class="mh">${esc(pendingHead)}</div>`)); lastHead = pendingHead; }
      const b = h(`<button class="mi ${it.cur ? "cur" : ""}"><span class="main">${esc(it.label)}</span>${it.badge ? `<span class="badge">${esc(it.badge)}</span>` : ""}<span class="sub">${esc(it.sub || "")}</span></button>`);
      b.onmousedown = (e) => { if (keepFocus) e.preventDefault(); };
      b.onclick = () => { closeMenu(); it.run(); };
      box.append(b);
    }
    $$(".mi", box)[0]?.classList.add("act");
  }
  draw();
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - 430)) + "px";
  m.style.minWidth = Math.min(r.width, 420) + "px";
  if (up) { m.style.top = ""; m.style.bottom = innerHeight - r.top + 6 + "px"; }
  else { m.style.bottom = ""; m.style.top = r.bottom + 6 + "px"; }
}
function closeMenu() { $("#menu").hidden = true; menu.keys = false; }
function menuKey(e) {
  const m = $("#menu"); if (m.hidden) return false;
  const items = $$(".mi", m); let i = items.findIndex((x) => x.classList.contains("act"));
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); items[i]?.classList.remove("act");
    i = (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[i]?.classList.add("act"); items[i]?.scrollIntoView({ block: "nearest" }); return true;
  }
  if ((e.key === "Enter" || e.key === "Tab") && items[i]) { e.preventDefault(); items[i].click(); return true; }
  if (e.key === "Escape") { closeMenu(); return true; }
  return false;
}

// ---------------------------------------------------------------- side pane
function paneTab() { return $("#pane").hidden ? null : $(".pane-tabs .on")?.dataset.tab; }
function openPane(tab) {
  if (paneTab() === tab) { $("#pane").hidden = true; markPaneButtons(); return; }
  $("#pane").hidden = false;
  $$(".pane-tabs [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $$(".pane-body").forEach((b) => b.classList.toggle("on", b.id === "tab-" + tab));
  markPaneButtons(); refreshPane();
}
function markPaneButtons() { const t = paneTab(); $$(".pane-buttons [data-pane]").forEach((b) => b.classList.toggle("on", b.dataset.pane === t)); }
function refreshPane(only) {
  const t = paneTab(); if (!t || (only && only !== t)) return;
  if (t === "changes") loadChanges();
  if (t === "files" && !$("#tree").childElementCount) loadTree($("#tree"), "", 0);
  if (t === "terminal") { if (!terms.size) newTerminal(); else fitTerms(); }
}
function renderChangesCount() { $("#changes-count").textContent = S.diffs?.length || ""; }

// Uncommitted changes in the project (git working tree vs HEAD), like a diff review pane.
async function loadChanges() {
  try { S.diffs = await api("/vcs/diff?mode=git"); S.gitOk = true; }
  catch { S.gitOk = false; S.diffs = []; }
  renderChangesCount(); if (paneTab() === "changes") renderChanges();
}
function renderChanges() {
  const box = $("#tab-changes");
  if (!S.diffs.length) { box.innerHTML = `<div class="empty">${S.gitOk === false ? "This folder isn't a git repository, so changes can't be tracked here." : "No uncommitted changes."}</div>`; return; }
  box.innerHTML = `<div class="empty" style="padding:10px 14px;text-align:left">${S.diffs.length} changed file${S.diffs.length === 1 ? "" : "s"} not yet committed</div>`;
  for (const d of S.diffs) {
    const det = h(`<details class="cfile" open><summary><span class="tag">${esc(d.status || "modified")}</span><span class="p">${esc(d.file)}</span>
      <span class="plus">+${d.additions}</span><span class="minus">−${d.deletions}</span></summary></details>`);
    if (d.patch) det.append(diffView(d.patch));
    box.append(det);
  }
}

async function loadTree(box, path, depth) {
  try {
    const nodes = await api(`/file?path=${encodeURIComponent(path)}`);
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
    for (const n of nodes) {
      const row = h(`<div class="node ${n.ignored ? "ign" : ""}" style="padding-left:${12 + depth * 14}px">${n.type === "directory" ? ICON.folder : ICON.file}<span>${esc(n.name)}</span></div>`);
      box.append(row);
      if (n.type === "directory") {
        const kids = document.createElement("div"); kids.hidden = true; box.append(kids);
        row.onclick = () => { kids.hidden = !kids.hidden; if (!kids.hidden && !kids.childElementCount) loadTree(kids, n.path, depth + 1); };
      } else row.onclick = () => viewFile(n.path);
    }
  } catch (e) { box.append(h(`<div class="empty">${esc(e.message)}</div>`)); }
}
async function viewFile(path) {
  try {
    const f = await api(`/file/content?path=${encodeURIComponent(path)}`);
    $("#tree").hidden = true; $("#viewer").hidden = false; $("#viewer-path").textContent = path; $("#viewer").dataset.path = path;
    const code = $("#viewer-code"); code.innerHTML = "";
    if (f.type === "binary") { code.textContent = "Binary file"; return; }
    const lines = f.content.split("\n");
    const frag = document.createDocumentFragment();
    for (const l of lines.slice(0, 5000)) { const s = document.createElement("span"); s.textContent = l || " "; frag.append(s); }
    code.append(frag);
  } catch (e) { fail(e); }
}

// ---- terminal (OpenCode PTY over WebSocket)
const terms = new Map(); // ptyID -> { term, fit, ws, el, title }
async function newTerminal(agent) {
  try {
    const body = { cwd: S.dir, title: agent ? agent.name : "Terminal" };
    if (agent) { body.command = "powershell.exe"; body.args = ["-NoLogo", "-NoExit", "-Command", agent.run]; }
    const pty = await api("/pty", { method: "POST", body });
    const el = h(`<div class="term"></div>`); $("#terms").append(el);
    const term = new Terminal({ fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 13, cursorBlink: true, theme: { background: "#141412" }, allowProposedApi: true });
    const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(el);
    const ws = new WebSocket(`ws://${location.host}/oc/pty/${pty.id}/connect?directory=${encodeURIComponent(S.dir)}`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    ws.onclose = () => term.write("\r\n\x1b[2m[terminal closed]\x1b[0m\r\n");
    term.onData((d) => ws.readyState === 1 && ws.send(d));
    term.onResize(({ cols, rows }) => api(`/pty/${pty.id}`, { method: "PUT", body: { size: { cols, rows } } }).catch(() => {}));
    terms.set(pty.id, { term, fit, ws, el, title: body.title });
    showTerm(pty.id);
    if (agent) setTimeout(() => toast(`${agent.name} started in the terminal`), 300);
  } catch (e) { fail(e); }
}
function showTerm(id) {
  for (const [k, t] of terms) t.el.hidden = k !== id;
  showTerm.cur = id; renderTermTabs(); fitTerms(); terms.get(id)?.term.focus();
}
function renderTermTabs() {
  const box = $("#term-tabs");
  box.innerHTML = [...terms].map(([id, t]) => `<button data-term="${id}" class="${id === showTerm.cur ? "on" : ""}">${esc(t.title)}<span class="x" data-kill="${id}">✕</span></button>`).join("")
    + `<button data-term-new title="New terminal">＋ Shell</button><button data-term-agent title="Open another coding agent">＋ Agent</button>`;
}
function fitTerms() { requestAnimationFrame(() => { const t = terms.get(showTerm.cur); try { t?.fit.fit(); } catch {} }); }
async function killTerm(id) {
  const t = terms.get(id); if (!t) return;
  t.ws.close(); t.term.dispose(); t.el.remove(); terms.delete(id);
  api(`/pty/${id}`, { method: "DELETE" }).catch(() => {});
  showTerm([...terms.keys()].pop());
}
addEventListener("resize", fitTerms);

// ---------------------------------------------------------------- dialogs: agents / connectors / settings
let agentList = [];
async function loadAgentList() { agentList = await studio("agents"); return agentList; }
async function openAgentsDialog() {
  $("#dlg-agents").showModal();
  const box = $("#agent-list"); box.innerHTML = `<p class="muted">Checking what is installed…</p>`;
  await loadAgentList();
  box.innerHTML = agentList.map((a) => `<div class="row-item"><span class="n">${esc(a.name)}</span>
    <span class="s">${a.path ? esc(a.path) : "not installed yet"}</span>
    <span class="state ${a.path ? "ok" : ""}">${a.path ? "ready" : "missing"}</span>
    <button class="btn" data-run-agent="${a.id}" ${a.path ? "" : "disabled"}>Open</button></div>`).join("");
}
async function agentMenu(anchor) {
  if (!agentList.length) await loadAgentList();
  menu(anchor, agentList.filter((a) => a.path).map((a) => ({ label: a.name, sub: a.run, run: () => newTerminal(a) })), {});
}

const MCP_PRESETS = [
  { name: "context7", type: "remote", target: "https://mcp.context7.com/mcp", note: "Up-to-date library docs" },
  { name: "playwright", type: "local", target: "npx -y @playwright/mcp@latest", note: "Drive a real browser" },
  { name: "fetch", type: "local", target: "uvx mcp-server-fetch", note: "Read web pages" },
  { name: "sequential-thinking", type: "local", target: "npx -y @modelcontextprotocol/server-sequential-thinking", note: "Step-by-step reasoning tool" },
  { name: "memory", type: "local", target: "npx -y @modelcontextprotocol/server-memory", note: "Long-term memory graph" },
  { name: "github", type: "remote", target: "https://api.githubcopilot.com/mcp/", note: "GitHub (signs in with OAuth)" },
];
async function loadMcp() {
  const box = $("#mcp-list");
  try {
    const st = await api("/mcp");
    const names = Object.keys(st);
    box.innerHTML = names.length ? names.map((n) => {
      const s = st[n]; const cls = s.status === "connected" ? "ok" : s.status === "failed" ? "bad" : s.status.startsWith("needs") ? "warn" : "";
      const act = s.status === "connected" ? `<button class="btn" data-mcp-off="${esc(n)}">Disconnect</button>`
        : s.status === "needs_auth" ? `<button class="btn primary" data-mcp-auth="${esc(n)}">Sign in</button>`
        : `<button class="btn" data-mcp-on="${esc(n)}">Connect</button>`;
      return `<div class="row-item"><span class="n">${esc(n)}</span><span class="s">${esc(s.error || "")}</span><span class="state ${cls}">${esc(s.status.replace(/_/g, " "))}</span>${act}</div>`;
    }).join("") : `<p class="muted">No connectors yet. Pick one below.</p>`;
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  $("#mcp-presets").innerHTML = MCP_PRESETS.map((p, i) => `<button data-preset="${i}" title="${esc(p.target)}">${esc(p.name)} · ${esc(p.note)}</button>`).join("");
}
async function addMcp(form) {
  const f = Object.fromEntries(new FormData(form));
  const config = f.type === "remote" ? { type: "remote", url: f.target.trim(), enabled: true }
    : { type: "local", command: f.target.trim().split(/\s+/), enabled: true };
  try {
    await api("/global/config", { method: "PATCH", body: { mcp: { [f.name]: config } } }); // keep it after restarts
    await api("/mcp", { method: "POST", body: { name: f.name, config } });
    form.reset(); toast(`Added ${f.name}`); loadMcp(); loadCommands();
  } catch (e) { fail(e); }
}

async function openSettings() {
  $("#dlg-settings").showModal();
  $$("#theme-seg button").forEach((b) => b.classList.toggle("on", b.dataset.theme === (localStorage.getItem("theme") || "system")));
  $("#providers").innerHTML = `<p class="muted">Loading…</p>`;
  const g = await studio("omniroute");
  $("#gw-text").textContent = g.running ? `OmniRoute is running at ${g.url}.` : `OmniRoute is not running (${g.url}). Start it with start-gateway.bat.`;
  const fl = await studio("freellmapi").catch(() => ({ running: false, installed: false }));
  $("#fl-text").textContent = fl.running ? `FreeLLMAPI is running at ${fl.url}.`
    : fl.installed ? `FreeLLMAPI is starting or stopped (${fl.url}). It starts with Agent Studio and takes about 25 seconds.`
    : "FreeLLMAPI isn't installed (vendor\\freellmapi). See the README.";
  try {
    const p = await api("/provider");
    const connected = new Set(p.connected || []);
    $("#providers").innerHTML = (p.all || []).filter((x) => connected.has(x.id)).map((x) => {
      const n = Object.keys(x.models || {}).length;
      return `<div class="row-item"><span class="n">${esc(x.name)}</span><span class="s">${n} models</span><span class="state ok">connected</span></div>`;
    }).join("") || `<p class="muted">Only OpenCode's free models so far.</p>`;
  } catch (e) { $("#providers").textContent = e.message; }
}
async function addProvider(form) {
  const f = Object.fromEntries(new FormData(form));
  const models = Object.fromEntries(f.models.split(",").map((s) => s.trim()).filter(Boolean).map((m) => [m, { name: m }]));
  try {
    await api("/global/config", { method: "PATCH", body: { provider: { [f.id]: { npm: "@ai-sdk/openai-compatible", name: f.name || f.id, options: { baseURL: f.baseURL.trim() }, models } } } });
    if (f.key) await api(`/auth/${f.id}`, { method: "PUT", body: { type: "api", key: f.key } });
    form.reset(); toast("Provider added. Its models are in the model menu."); await loadProviders(); openSettings();
  } catch (e) { fail(e); }
}

// OmniRoute's "auto" combos route across every provider connected in its dashboard.
const GATEWAY_AUTO = {
  "auto/coding": "Gateway · best for coding", "auto": "Gateway · balanced", "auto/fast": "Gateway · fastest",
  "auto/smart": "Gateway · quality first", "auto/offline": "Gateway · most quota left",
};
async function syncGateway(e) {
  e?.preventDefault();
  const out = $("#gw-sync-text"); out.textContent = "Syncing…";
  const form = $("#gw-form");
  try {
    const key = form.key.value.trim();
    if (key) { await api("/auth/omniroute", { method: "PUT", body: { type: "api", key } }); form.reset(); }
    const r = await studio("omniroute/models");
    if (r.error) throw new Error(r.error.code === "invalid_api_key" ? "OmniRoute needs its API key: create one in its dashboard (API Manager) and paste it above." : r.error.message || r.error);
    const models = {};
    for (const [id, name] of Object.entries(GATEWAY_AUTO)) models[id] = { name, limit: { context: 128000, output: 16000 } };
    for (const m of r.data || []) {
      if (models[m.id] || /embed|image|tts|whisper|audio|rerank|moderation/i.test(m.id)) continue;
      models[m.id] = { name: m.id, ...(m.context_length ? { limit: { context: m.context_length, output: Math.min(32000, Math.floor(m.context_length / 4)) } } : {}) };
    }
    await api("/global/config", { method: "PATCH", body: { provider: { omniroute: {
      npm: "@ai-sdk/openai-compatible", name: "OmniRoute gateway",
      options: { baseURL: "http://127.0.0.1:20128/v1" }, models,
    } } } });
    await api("/instance/dispose", { method: "POST" }).catch(() => {}); // reload config
    await loadProviders();
    out.textContent = `${Object.keys(models).length} models ready under "OmniRoute gateway".`;
  } catch (e) { out.textContent = ""; fail(e); }
}

// FreeLLMAPI: "auto" lets its router pick, "fusion" asks several models and merges, "auto:<chain>" pins a chain.
async function syncFreeLLM(e) {
  e?.preventDefault();
  const out = $("#fl-sync-text"); out.textContent = "Syncing…";
  const form = $("#fl-form");
  try {
    const key = form.key.value.trim();
    if (key) { await api("/auth/freellmapi", { method: "PUT", body: { type: "api", key } }); form.reset(); }
    const r = await studio("freellmapi/models");
    if (r.error) throw new Error(/auth|key|unauthori/i.test(JSON.stringify(r.error)) ? "FreeLLMAPI needs its unified key: copy it from the top of its Keys page and paste it above." : r.error.message || r.error);
    const models = {};
    for (const m of r.data || []) {
      if (m.available === false || /^claude-/i.test(m.id) || /embed|image|video|tts|whisper|audio|speech|rerank|moderation/i.test(m.id)) continue;
      const name = m.id === "auto" ? "FreeLLMAPI · auto (router picks)" : m.id === "fusion" ? "FreeLLMAPI · fusion (slow, several models)"
        : m.id.startsWith("auto:") ? `FreeLLMAPI · chain ${m.id.slice(5)}` : (m.name || m.id);
      const ctx = m.context_length || m.context_window;
      models[m.id] = { name, ...(ctx ? { limit: { context: ctx, output: Math.min(32000, Math.floor(ctx / 4)) } } : {}) };
    }
    const real = Object.keys(models).filter((id) => id !== "auto" && id !== "fusion" && !id.startsWith("auto:")).length;
    await api("/global/config", { method: "PATCH", body: { provider: { freellmapi: {
      npm: "@ai-sdk/openai-compatible", name: "FreeLLMAPI gateway",
      options: { baseURL: "http://127.0.0.1:3001/v1" }, models,
    } } } });
    await api("/instance/dispose", { method: "POST" }).catch(() => {}); // reload config
    await loadProviders();
    out.textContent = real ? `${Object.keys(models).length} models ready under "FreeLLMAPI gateway".`
      : `Synced, but FreeLLMAPI has no provider keys yet: add some on its Keys page, then sync again.`;
  } catch (e) { out.textContent = ""; fail(e); }
}

function applyTheme(t) {
  if (t === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.dataset.theme = t;
  try { localStorage.setItem("theme", t); } catch {}
  for (const x of terms.values()) x.term.options.theme = { background: "#141412" };
}

async function pollGateway() {
  const [g, fl] = await Promise.all([studio("omniroute").catch(() => ({ running: false })), studio("freellmapi").catch(() => ({ running: false }))]);
  const on = [g.running && "OmniRoute", fl.running && "FreeLLMAPI"].filter(Boolean);
  const el = $("#gateway"); el.className = "gateway " + (on.length ? "up" : "down");
  el.querySelector("span").textContent = on.length === 2 ? "Gateways on" : on.length ? "Gateway on" : "Gateway off";
  el.title = `OmniRoute: ${g.running ? "on" : "off"} · FreeLLMAPI: ${fl.running ? "on" : fl.installed === false ? "not installed" : "off"}`;
}

function projectMenu() {
  const items = (S.state.projects || []).map((p) => ({ label: baseName(p), sub: p, cur: p === S.dir, run: () => openProject(p) }));
  items.push({ label: "Open another folder…", sub: "Folders outside the AI agent folder are copied in", run: async () => {
    const p = prompt("Folder path (outside folders are copied into the AI agent folder)", S.state.agentRoot + "\\");
    if (!p) return;
    const d = await pickFolder(p);
    if (d) openProject(d);
  } });
  menu($("#project"), items, {});
}

// ---------------------------------------------------------------- wiring
$("#new-session").onclick = () => newSession().catch(fail);
$("#project").onclick = projectMenu;
$("#session-search").oninput = renderSessions;
$("#sessions").onclick = async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    if (!confirm("Delete this session? Its messages are removed for good.")) return;
    await api(`/session/${del.dataset.del}`, { method: "DELETE" }).catch(fail); return;
  }
  const b = e.target.closest("[data-sid]"); if (b && b.dataset.sid !== S.sid) openSession(b.dataset.sid);
};
const narrow = () => matchMedia("(max-width: 900px)").matches;
$("#collapse").onclick = $("#expand").onclick = () => {
  if (narrow()) return document.body.classList.toggle("side-open");
  const off = document.body.classList.toggle("no-side"); saveState({ sidebar: !off }); fitTerms();
};
$("#sessions").addEventListener("click", () => narrow() && document.body.classList.remove("side-open"));
$("#title").ondblclick = () => {
  if (!S.sid) return;
  const t = $("#title"); t.contentEditable = "true"; t.focus(); document.getSelection().selectAllChildren(t);
  const done = async (save) => {
    t.contentEditable = "false"; t.onblur = t.onkeydown = null;
    const title = t.textContent.trim();
    if (save && title) await api(`/session/${S.sid}`, { method: "PATCH", body: { title } }).catch(fail); else renderHeader();
  };
  t.onblur = () => done(true);
  t.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); t.blur(); } if (e.key === "Escape") done(false); };
};
$$("[data-pane]").forEach((b) => (b.onclick = () => openPane(b.dataset.pane)));
$$(".pane-tabs [data-tab]").forEach((b) => (b.onclick = () => { $("#pane").hidden = true; openPane(b.dataset.tab); }));
$("#pane-close").onclick = () => { $("#pane").hidden = true; markPaneButtons(); };
$("#viewer-back").onclick = () => { $("#viewer").hidden = true; $("#tree").hidden = false; };
$("#viewer-mention").onclick = () => { addFile($("#viewer").dataset.path); input.focus(); };
$("#term-tabs").onclick = (e) => {
  const k = e.target.closest("[data-kill]"); if (k) { e.stopPropagation(); return killTerm(k.dataset.kill); }
  const t = e.target.closest("[data-term]"); if (t) return showTerm(t.dataset.term);
  if (e.target.closest("[data-term-new]")) return newTerminal();
  if (e.target.closest("[data-term-agent]")) return agentMenu(e.target.closest("[data-term-agent]"));
};

$("#welcome").onclick = (e) => { const b = e.target.closest("[data-prompt]"); if (b) sendMessage(b.dataset.prompt); };
$("#messages").onclick = async (e) => {
  const copy = e.target.closest(".copy");
  if (copy) { navigator.clipboard.writeText(copy.parentElement.querySelector("code")?.textContent || ""); copy.textContent = "Copied"; return; }
  const sub = e.target.closest("[data-sub]"); if (sub) { e.preventDefault(); return openSession(sub.dataset.sub); }
  if (e.target.closest('[data-act="changes"]')) return openPane("changes");
  const act = e.target.closest(".msg.user [data-act]"); if (!act) return;
  const id = act.closest(".msg").dataset.id;
  if (act.dataset.act === "copy") navigator.clipboard.writeText(act.closest(".msg").querySelector(".bubble")?.textContent || "");
  if (act.dataset.act === "revert") await api(`/session/${S.sid}/revert`, { method: "POST", body: { messageID: id } }).catch(fail);
  if (act.dataset.act === "fork") {
    const s = await api(`/session/${S.sid}/fork`, { method: "POST", body: { messageID: id } }).catch(fail);
    if (s) { S.sessions.unshift(s); openSession(s.id); toast("Forked into a new session"); }
  }
};
$("#cards").onclick = (e) => {
  const r = e.target.closest("[data-reply]"); if (r) return replyPerm(r.closest("[data-perm]").dataset.perm, r.dataset.reply);
  if (e.target.closest('[data-act="unrevert"]')) return api(`/session/${S.sid}/unrevert`, { method: "POST" }).catch(fail);
  const card = e.target.closest("[data-q]"); if (!card) return;
  const opt = e.target.closest(".opt");
  if (opt) {
    if (!card.dataset["multi" + opt.dataset.i]) $$(`.opt[data-i="${opt.dataset.i}"]`, card).forEach((o) => o !== opt && o.classList.remove("sel"));
    opt.classList.toggle("sel");
  }
  if (e.target.closest("[data-qsend]")) answerQuestion(card, false);
  if (e.target.closest("[data-qreject]")) answerQuestion(card, true);
};
$("#todos-head").onclick = () => $("#todos").classList.toggle("closed");
$("#agent-seg").onclick = (e) => { const b = e.target.closest("[data-agent]"); if (b) { S.agent = b.dataset.agent; renderAgents(); } };
$("#model").onclick = () => openModelMenu($("#model"));
$("#attach").onclick = () => $("#file-input").click();
$("#file-input").onchange = (e) => { attachBlobs([...e.target.files]); e.target.value = ""; };
$("#attachments").onclick = (e) => { const x = e.target.closest("[data-unattach]"); if (x) { S.attach.splice(+x.dataset.unattach, 1); renderAttach(); } };
$("#send").onclick = () => (document.body.classList.contains("busy") ? stop() : sendMessage());

input.addEventListener("input", () => { autosize(); suggest(); });
input.addEventListener("keydown", (e) => {
  if (menu.keys && menuKey(e)) return;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
  if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); toggleAgent(); }
  if (e.key === "Escape" && document.body.classList.contains("busy")) { e.preventDefault(); stop(); }
});
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); attachBlobs(files); }
});
$("#composer").addEventListener("dragover", (e) => e.preventDefault());
$("#composer").addEventListener("drop", (e) => { e.preventDefault(); attachBlobs([...e.dataTransfer.files]); });

// ---------------------------------------------------------------- regular jobs
// One click starts the job in a new session with the right agent (creator: studio tools; reverse: REA).
// "fill" jobs put the start of the request in the box for you to finish.
const JOBS = [
  { head: "Reels" },
  { label: "Today's reel", sub: "trending topic, Launch style, sent to your Telegram", agent: "creator",
    prompt: "Make today's reel, following the studio-jobs skill: studio_reel_make (style launch, no topic), wait for it with studio_job, check the facts, fix caption.txt until studio_caption_check says READY, then send it to my Telegram. Don't post it." },
  { label: "Reel about a topic…", sub: "you type the topic", agent: "creator", fill: "Make a reel (Launch style) about: " },
  { label: "Guided reel (best quality)…", sub: "hooks, script and scenes written step by step", agent: "creator",
    fill: "Make a guided reel following the reel skill (Mode B) and the studio-jobs skill, about: " },
  { label: "Doodle explainer…", sub: "stick-figure style", agent: "creator", fill: "Make a doodle explainer reel (60 s, 9:16) about: " },
  { label: "Post a reel…", sub: "asks you before it posts", agent: "creator", fill: "Post this reel from Studio\\Reels to Instagram (main account): " },
  { head: "Instagram" },
  { label: "Check analytics", sub: "both accounts, what worked and why", agent: "creator",
    prompt: "Check my Instagram analytics for the main account and the gta account, following the ig-analytics and studio-jobs skills. Compare with the last saved numbers, look at the best and worst reels, update the playbooks in Studio\\Instagram\\insights, and tell me what to make next." },
  { label: "Check new comments", sub: "drafts replies, posts only after your yes", agent: "creator",
    prompt: "Check the unreplied comments on my main and gta Instagram accounts, following the ig-comments and studio-jobs skills. Draft replies and show them to me; don't reply until I say yes." },
  { label: "Plan my week", sub: "ig-plan", agent: "creator", prompt: "Plan my Instagram week following the ig-plan skill, using the playbooks in Studio\\Instagram\\insights." },
  { head: "Films and clips" },
  { label: "Lemo-Opuscar film…", sub: "short film made in code, in a named style", agent: "creator", fill: "Make a Lemo-Opuscar film (follow the lemo-opuscar and studio-jobs skills) about: " },
  { label: "GTA 6 clips…", sub: "maquina-cortes-gta, from a video in this project", agent: "creator", fill: "Cut GTA 6 Shorts with the maquina-cortes-gta skill from this video: " },
  { head: "Other" },
  { label: "Reverse engineer…", sub: "REA tools (reverse agent)", agent: "reverse", fill: "Reverse engineer this (follow the reverse-engineer-anything skill): " },
  { label: "Find a skill…", sub: "search all ~270 skills", agent: "creator", fill: "Load the skill-library skill and tell me which skills fit: " },
];

async function runJob(j) {
  if (!S.agents.find((a) => a.name === j.agent)) { toast(`The ${j.agent} agent isn't loaded yet: restart Agent Studio`); return; }
  if (S.model?.providerID === "local") toast("Local models are too small for this job; pick a free cloud model if it struggles");
  S.agent = j.agent; renderAgents();
  if (j.fill) { input.value = j.fill; autosize(); input.focus(); input.setSelectionRange(input.value.length, input.value.length); return; }
  try { await newSession(true); await sendMessage(j.prompt); } catch (e) { fail(e); }
}
$("#jobs").onclick = (e) => menu(e.currentTarget, JOBS.map((j) => (j.head ? j : { ...j, run: () => runJob(j) })), { filter: "Find a job", up: true });

$$("[data-open]").forEach((b) => (b.onclick = () => {
  const w = b.dataset.open;
  if (w === "settings") openSettings();
  if (w === "connectors") { $("#dlg-connectors").showModal(); loadMcp(); }
  if (w === "agents") openAgentsDialog();
}));
$$("dialog [data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));
$$("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));
$("#theme-seg").onclick = (e) => { const b = e.target.closest("[data-theme]"); if (b) { applyTheme(b.dataset.theme); $$("#theme-seg button").forEach((x) => x.classList.toggle("on", x === b)); } };
$("#gw-form").onsubmit = syncGateway;
$("#fl-form").onsubmit = syncFreeLLM;
$("#add-provider").onsubmit =(e) => { e.preventDefault(); addProvider(e.target); };
$("#add-mcp").onsubmit = (e) => { e.preventDefault(); addMcp(e.target); };
$("#mcp-presets").onclick = (e) => {
  const b = e.target.closest("[data-preset]"); if (!b) return;
  const p = MCP_PRESETS[+b.dataset.preset]; const f = $("#add-mcp");
  f.name.value = p.name; f.type.value = p.type; f.target.value = p.target;
};
$("#mcp-list").onclick = async (e) => {
  const on = e.target.closest("[data-mcp-on]"), off = e.target.closest("[data-mcp-off]"), auth = e.target.closest("[data-mcp-auth]");
  try {
    if (on) await api(`/mcp/${on.dataset.mcpOn}/connect`, { method: "POST" });
    if (off) await api(`/mcp/${off.dataset.mcpOff}/disconnect`, { method: "POST" });
    if (auth) { const r = await api(`/mcp/${auth.dataset.mcpAuth}/auth`, { method: "POST" }); if (r?.authorizationUrl) open(r.authorizationUrl, "_blank", "noopener"); }
  } catch (err) { fail(err); }
  loadMcp();
};
$("#agent-list").onclick = (e) => {
  const b = e.target.closest("[data-run-agent]"); if (!b) return;
  const a = agentList.find((x) => x.id === b.dataset.runAgent);
  $("#dlg-agents").close(); if (paneTab() !== "terminal") openPane("terminal"); newTerminal(a);
};

document.addEventListener("mousedown", (e) => { if (!e.target.closest("#menu") && !e.target.closest("#model") && !e.target.closest("#project")) closeMenu(); });
document.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === "n") { e.preventDefault(); newSession().catch(fail); }
  if (e.ctrlKey && k === "b") { e.preventDefault(); $("#collapse").click(); }
  if (e.ctrlKey && k === "j") { e.preventDefault(); openPane("terminal"); }
  if (e.ctrlKey && k === "k") { e.preventDefault(); $("#session-search").focus(); }
  if (e.key === "Escape" && !$("#menu").hidden) closeMenu();
});
addEventListener("focus", () => { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); }, { once: true });

boot().catch(fail);
