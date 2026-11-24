// Agent Studio server: serves the page, starts the sandboxed `opencode serve`, proxies /oc/* (HTTP, SSE
// and the terminal WebSocket) to it, and serves the agent's PC-control tools on /mcp. Listens on 127.0.0.1.
//
// The sandbox: OpenCode (and every shell, test or tool it starts) runs at Windows' Low integrity level
// through sandbox/lowrun.exe. It can change files only in the AI agent folder (labelled Low by install.ps1)
// and its own data folders; Windows refuses every other write, and it can't touch drivers or system
// settings. Agent Studio's own data (settings, login code, browser profile) is also unreadable from there.
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile, execFileSync } = require("child_process");
const pc = require("./pc");
const studio = require("./studio");   // the regular jobs: reels, Instagram, Telegram (studio_* tools)
const kit = require("./kit");         // skills (kit/skills) and the creator agent

// A launch without the user folder variables broke every path below (OpenCode, keys, the window profile, the
// sandbox's temp folders). Fill in the missing ones from the Windows account itself.
{
  let home = ""; try { home = require("os").userInfo().homedir; } catch {}
  if (home) {
    process.env.USERPROFILE ||= home;
    process.env.APPDATA ||= path.join(home, "AppData", "Roaming");
    process.env.LOCALAPPDATA ||= path.join(home, "AppData", "Local");
  }
}

const PORT = Number(process.env.STUDIO_PORT || 4321);
const OC_PORT = Number(process.env.OPENCODE_PORT || 4097);   // not OpenCode's default 4096: only our sandboxed one lives here
const OMNI = process.env.OMNIROUTE_URL || "http://127.0.0.1:20128";
const FREE = process.env.FREELLMAPI_URL || "http://127.0.0.1:3001";   // FreeLLMAPI, the second gateway (vendor/freellmapi)
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "..", "data");
const LOGS = path.join(ROOT, "..", "logs");
const STATE = path.join(DATA, "studio.json");
const CODE_FILE = path.join(DATA, "launch-code");
const LOWRUN = path.join(ROOT, "sandbox", "lowrun.exe");
const RULES = path.join(ROOT, "agent-rules.md");
const LOW_HOME = path.join(process.env.USERPROFILE || "", "AppData", "LocalLow", "AgentStudio");
const POWERSHELL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
// The window's own Edge profile (outside data/: Edge's sandboxed helpers must be able to read it).
// pc.js recognises Agent Studio's windows by it; launch.ps1 uses the same folder.
process.env.STUDIO_EDGE_PROFILE = path.join(process.env.LOCALAPPDATA || "", "AgentStudio", "edge");

const VENDOR = {
  "marked.js": "node_modules/marked/lib/marked.umd.js",
  "purify.js": "node_modules/dompurify/dist/purify.min.js",
  "xterm.js": "node_modules/@xterm/xterm/lib/xterm.js",
  "xterm.css": "node_modules/@xterm/xterm/css/xterm.css",
  "fit.js": "node_modules/@xterm/addon-fit/lib/addon-fit.js",
};

// Coding agents the terminal can launch. `check` is the command looked up on PATH.
const AGENTS = [
  { id: "opencode", name: "OpenCode", check: "opencode", run: "opencode" },
  { id: "aider", name: "Aider", check: "aider", run: "aider" },
  { id: "gemini", name: "Gemini CLI", check: "gemini", run: "gemini" },
  { id: "qwen", name: "Qwen Code", check: "qwen", run: "qwen" },
  { id: "codex", name: "Codex CLI", check: "codex", run: "codex" },
  { id: "goose", name: "Goose", check: "goose", run: "goose session" },
  { id: "crush", name: "Crush", check: "crush", run: "crush" },
  { id: "openclaw", name: "OpenClaw", check: "openclaw", run: "openclaw tui" },
];

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".ico": "image/x-icon",
};

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

// ---------- state ----------
function readState() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
  if (!s.agentRoot) s.agentRoot = "E:\\AI agent folder";
  if (!s.project || !inRoot(s.project, s.agentRoot)) s.project = s.agentRoot;
  s.projects = (s.projects || []).filter((p) => inRoot(p, s.agentRoot));
  return s;
}
function writeState(s) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}
const agentRoot = () => readState().agentRoot;

// Is p the AI agent folder or inside it (after resolving "..", case-insensitive like Windows)?
function inRoot(p, root = agentRoot()) {
  if (!p) return false;
  const a = path.resolve(String(p)).toLowerCase().replace(/[\\/]+$/, "");
  const r = path.resolve(root).toLowerCase().replace(/[\\/]+$/, "");
  return a === r || a.startsWith(r + "\\");
}

// Windows' integrity label of a folder ("low" when the sandbox can write there).
function labelOf(dir) {
  try { return /Low Mandatory Level/.test(execFileSync("icacls", [dir], { windowsHide: true, encoding: "utf8" })) ? "low" : "other"; }
  catch { return "missing"; }
}

// ---------- sign-in ----------
// The launcher reads a one-time code from data/launch-code (unreadable from the sandbox) and opens the
// window with it; the page trades it for a session cookie. So only windows opened by the launcher can
// approve PC actions or import folders, never the agent itself.
let launchCode = "";
const sessions = new Set();
function newLaunchCode() {
  launchCode = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CODE_FILE, launchCode);
}
function signedIn(req) {
  const m = /(?:^|;\s*)studio=([a-f0-9]{48})/.exec(req.headers.cookie || "");
  return !!m && sessions.has(m[1]);
}
const PC_TOKEN = crypto.randomBytes(24).toString("hex");   // the sandboxed agent's key for /mcp only

// ---------- opencode (sandboxed) ----------
function ocHealthy() {
  return new Promise((ok) => {
    const r = http.get({ host: "127.0.0.1", port: OC_PORT, path: "/global/health", timeout: 1500 }, (res) => {
      res.resume(); ok(res.statusCode === 200);
    });
    r.on("error", () => ok(false));
    r.on("timeout", () => { r.destroy(); ok(false); });
  });
}

function ocBinary() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  // lowrun needs a real file path (it can't run npm's opencode.cmd), so look in every place npm may have put it:
  // a launch from some other program can come with APPDATA missing or pointing elsewhere.
  // os.userInfo() asks Windows for the account's profile folder, so it works even without USERPROFILE/APPDATA.
  const os = require("os");
  let account = ""; try { account = os.userInfo().homedir; } catch {}
  const roots = [process.env.APPDATA, account && path.join(account, "AppData", "Roaming"), path.join(os.homedir(), "AppData", "Roaming")];
  try {   // npm's global prefix, wherever it is
    roots.push(execFileSync("cmd.exe", ["/c", "npm", "prefix", "-g"], { encoding: "utf8", windowsHide: true, timeout: 15000 }).trim());
  } catch {}
  const tried = [];
  for (const r of [...new Set(roots.filter((x) => x && path.isAbsolute(x)))]) {
    for (const base of [path.join(r, "npm"), r]) {
      const exe = path.join(base, "node_modules", "opencode-ai", "bin", "opencode.exe");
      try { fs.statSync(exe); return exe; } catch (e) {
        if (e.code !== "ENOENT" && e.code !== "ENOTDIR") { log("opencode.exe is there but busy:", e.code); return exe; }   // e.g. a virus scan holding it
        tried.push(`${exe} (${e.code})`);
      }
    }
  }
  log("opencode.exe not found. APPDATA=" + (process.env.APPDATA || "(missing)") + " USERPROFILE=" + (process.env.USERPROFILE || "(missing)") + " tried: " + tried.join("; "));
  throw new Error("OpenCode isn't installed (opencode.exe not found). Run: npm i -g opencode-ai@1.19.5");
}

// Whatever listens on our OpenCode port and wasn't started by this server is stopped: an OpenCode left
// from an older run might not be sandboxed.
function freePort(port) {
  try {
    const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { windowsHide: true, encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
      if (m && Number(m[1]) === port) { execFileSync("taskkill", ["/PID", m[2], "/T", "/F"], { windowsHide: true }); log("stopped old process on", port); }
    }
  } catch {}
}

// The agent's rules, given to OpenCode through its environment so the user's own OpenCode setup is untouched.
// Folders outside the project the agent may read (never write: Windows keeps them at Medium):
// the skills, and the Lemo-Opuscar film library the lemo-opuscar skill uses.
const LEMO = path.join(require("os").userInfo().homedir, "lemo-opuscar");
function readable() {
  const rules = { "*": "deny" };
  for (const d of [kit.KIT_SKILLS, LEMO]) {
    rules[path.join(d, "*")] = "allow"; rules[path.join(d, "**")] = "allow";
    const f = d.split(path.sep).join("/");
    rules[f + "/*"] = "allow"; rules[f + "/**"] = "allow";
  }
  return rules;
}

// REA (reverse engineering) runs inside the sandbox like the agent, so it can only open what the agent can.
function reaServer() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(require("os").userInfo().homedir, ".claude.json"), "utf8")).mcpServers?.rea;
    if (c && c.command && fs.existsSync(c.command)) return { type: "local", command: [c.command, ...(c.args || [])], enabled: true, timeout: 300000 };
  } catch {}
  return null;
}

function ocConfig() {
  const mcp = {
    pc: { type: "remote", url: `http://127.0.0.1:${PORT}/mcp`, headers: { "x-pc-token": PC_TOKEN }, oauth: false, enabled: true, timeout: 300000 },
    studio: { type: "remote", url: `http://127.0.0.1:${PORT}/studio-mcp`, headers: { "x-pc-token": PC_TOKEN }, oauth: false, enabled: true, timeout: 600000 },
  };
  const rea = reaServer(); if (rea) mcp.rea = rea;
  return {
    permission: { external_directory: readable() },
    instructions: [RULES],
    skills: { paths: [kit.KIT_SKILLS] },
    agent: kit.agents(),
    tools: kit.OFF,
    mcp,
  };
}

function sandboxEnv() {
  const low = (d) => { const p = path.join(LOW_HOME, d); fs.mkdirSync(p, { recursive: true }); return p; };
  const env = { ...process.env };
  // Git Bash's runtime can't start at Low integrity, so the agent's shell is Windows PowerShell, and Git's
  // Unix tools are kept off PATH (they would fail the same way). git.exe itself works.
  env.Path = env.PATH = (env.Path || env.PATH || "").split(";").filter((p) => !/\\Git\\usr\\bin\\?$/i.test(p)).join(";");
  delete env.PATH; // Windows env names are case-insensitive; keep a single Path
  Object.assign(env, {
    SHELL: POWERSHELL, OPENCODE_GIT_BASH_PATH: POWERSHELL, OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",   // the same skills come from kit/skills (renamed, paths fixed)
    OPENCODE_CONFIG_CONTENT: JSON.stringify(ocConfig()),
    TEMP: low("temp"), TMP: low("temp"), npm_config_cache: low("npm-cache"), PIP_CACHE_DIR: low("pip-cache"),
    UV_CACHE_DIR: low("uv-cache"), PYTHONPYCACHEPREFIX: low("pycache"), LOWRUN_PARENT: String(process.pid),
  });
  return env;
}

let ocChild = null, ocFails = 0;
async function ensureOpencode() {
  if (ocChild && (await ocHealthy())) return;
  freePort(OC_PORT);
  const bin = ocBinary();
  log("starting sandboxed", bin, "serve");
  fs.mkdirSync(LOGS, { recursive: true });
  const out = fs.openSync(path.join(LOGS, "opencode.log"), "a");
  ocChild = spawn(LOWRUN, [bin, "serve", "--port", String(OC_PORT), "--hostname", "127.0.0.1"], {
    cwd: agentRoot(), env: sandboxEnv(), stdio: ["ignore", out, out], windowsHide: true,
  });
  const started = Date.now();
  ocChild.on("exit", (code) => {
    log("opencode exited", code); ocChild = null;
    ocFails = Date.now() - started < 10000 ? ocFails + 1 : 0;   // quick crashes in a row: wait longer each time
    if (!stopping) setTimeout(() => ensureOpencode().catch((e) => log("restart failed", e.message)),
                              Math.min(2000 * 2 ** ocFails, 60000));
  });
  for (let i = 0; i < 60 && !(await ocHealthy()); i++) await new Promise((r) => setTimeout(r, 500));
}
let stopping = false;
process.on("exit", () => { stopping = true; if (ocChild) ocChild.kill(); });
process.on("SIGINT", () => process.exit(0));

// ---------- PC-control confirmations ----------
// A risky PC action waits here for a yes in one of the open windows (2 minutes, else no).
const pageStreams = new Set();
const questions = new Map();
let lastPage = Date.now();
function broadcast(ev) { for (const res of pageStreams) res.write(`data: ${JSON.stringify(ev)}\n\n`); }

const askUser = async (question) => {
  if (!pageStreams.size) return false;
  const id = crypto.randomBytes(8).toString("hex");
  // Bring Agent Studio to the front so the question is seen, then give the agent its window back.
  const before = await pc.hand("fg").catch(() => null);
  const own = (await pc.hand("windows").catch(() => [])).find((w) => /Agent Studio/.test(w.title) && w.proc === "msedge.exe");
  if (own) await pc.hand("focus", { hwnd: own.hwnd }).catch(() => {});
  const yes = await new Promise((ok) => {
    const t = setTimeout(() => { questions.delete(id); broadcast({ type: "done", id }); ok(false); }, 120000);
    questions.set(id, (v) => { clearTimeout(t); questions.delete(id); broadcast({ type: "done", id }); ok(v); });
    broadcast({ type: "ask", id, question });
  });
  if (before && before.hwnd && (!own || before.hwnd !== own.hwnd)) await pc.hand("focus", { hwnd: before.hwnd }).catch(() => {});
  return yes;
};
pc.setAsker(askUser);
studio.setAsker(askUser);
studio.setWorkspace(() => path.join(agentRoot(), "Studio"));

// With no window open for 15 minutes, the server stops (and with it the sandboxed agent).
setInterval(() => {
  if (pageStreams.size) lastPage = Date.now();
  else if (Date.now() - lastPage > 15 * 60000) { log("no window open for 15 min, stopping"); process.exit(0); }
}, 30000);

// ---------- copying a folder in ----------
const FORBIDDEN = [process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData]
  .filter(Boolean).map((p) => p.toLowerCase());

function folderSize(dir, limit) {
  let total = 0, files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; files++; } catch {} }
      if (total > limit || files > 200000) return { total, files, over: true };
    }
  }
  return { total, files, over: false };
}

async function importFolder(src) {
  const from = path.resolve(String(src || ""));
  let st; try { st = fs.statSync(from); } catch {}
  if (!st || !st.isDirectory()) throw new Error("That folder doesn't exist.");
  if (inRoot(from)) return { path: from };
  const low = from.toLowerCase();
  if (/^[a-z]:\\?$/.test(low)) throw new Error("A whole drive can't be copied in. Pick a project folder.");
  if (inRoot(agentRoot(), from)) throw new Error("That folder contains the AI agent folder itself.");
  if (FORBIDDEN.some((f) => low === f || low.startsWith(f + "\\"))) throw new Error("System folders can't be copied in.");
  const size = folderSize(from, 5 * 1024 ** 3);
  if (size.over) throw new Error("That folder is over 5 GB (or 200,000 files). Copy only the project you need.");
  const name = path.basename(from) || "project";
  let to = path.join(agentRoot(), name);
  for (let i = 2; fs.existsSync(to); i++) to = path.join(agentRoot(), `${name} (${i})`);
  await fs.promises.cp(from, to, { recursive: true, errorOnExist: false, force: false, verbatimSymlinks: true });
  log(`copied ${from} -> ${to} (${(size.total / 1048576).toFixed(1)} MB, ${size.files} files)`);
  return { path: to, bytes: size.total, files: size.files };
}

// ---------- helpers ----------
function sameOrigin(req) {
  const host = req.headers.host || "";
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return false; // DNS-rebinding guard
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}`;
}

function body(req) {
  return new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); });
}

function send(res, code, data, type = "application/json", headers = {}) {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(typeof data === "string" ? data : JSON.stringify(data));
}

function onPath(cmd) {
  return new Promise((ok) => execFile("where.exe", [cmd], { windowsHide: true }, (err, out) => ok(err ? null : out.split(/\r?\n/)[0])));
}

// Every OpenCode request names its project folder; only folders in the AI agent folder are passed on.
function allowedDirectory(target) {
  const d = new URL(target, "http://x").searchParams.get("directory");
  return d === null || inRoot(d);
}

function proxy(req, res, target) {
  const headers = { ...req.headers, host: `127.0.0.1:${OC_PORT}` };
  delete headers.origin; delete headers.referer; delete headers.cookie;
  const up = http.request({ host: "127.0.0.1", port: OC_PORT, method: req.method, path: target, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on("error", (e) => send(res, 502, { error: "OpenCode is not reachable: " + e.message }));
  req.pipe(up);
  res.on("close", () => up.destroy());
}

// A provider key the user saved in OpenCode (Settings or /connect). Read on the server only.
function savedKey(id) {
  const base = process.env.XDG_DATA_HOME || path.join(process.env.USERPROFILE || "", ".local", "share");
  try { return JSON.parse(fs.readFileSync(path.join(base, "opencode", "auth.json"), "utf8"))[id]?.key || ""; }
  catch { return ""; }
}

async function omniStatus() {
  try {
    const r = await fetch(OMNI + "/v1/models", { signal: AbortSignal.timeout(2000) });
    return { url: OMNI, running: true, status: r.status };
  } catch { return { url: OMNI, running: false }; }
}

async function freeStatus() {   // /livez is FreeLLMAPI's unauthenticated liveness probe
  const installed = fs.existsSync(path.join(ROOT, "..", "vendor", "freellmapi", "server", "dist", "index.js"));
  try {
    const r = await fetch(FREE + "/livez", { signal: AbortSignal.timeout(2000) });
    return { url: FREE, installed, running: r.ok, status: r.status };
  } catch { return { url: FREE, installed, running: false }; }
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  if (!sameOrigin(req)) return send(res, 403, { error: "forbidden" });
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  // The agent's PC tools: only with the key given to the sandboxed OpenCode.
  if (p === "/mcp") {
    if (req.headers["x-pc-token"] !== PC_TOKEN) return send(res, 403, { error: "forbidden" });
    return pc.handleMcp(req, res, await body(req));
  }
  if (p === "/studio-mcp") {   // the studio_* tools, same key
    if (req.headers["x-pc-token"] !== PC_TOKEN) return send(res, 403, { error: "forbidden" });
    return studio.handleMcp(req, res, await body(req));
  }

  if (p === "/studio/login" && req.method === "POST") {
    let code = ""; try { code = JSON.parse(await body(req)).code; } catch {}
    if (!code || code !== launchCode) return send(res, 401, { error: "This window wasn't opened by Agent Studio's launcher. Open Agent Studio from its shortcut." });
    newLaunchCode();   // each code works once
    const sid = crypto.randomBytes(24).toString("hex");
    sessions.add(sid);
    return send(res, 200, { ok: true }, "application/json", { "set-cookie": `studio=${sid}; Path=/; HttpOnly; SameSite=Strict` });
  }

  // Everything below needs a window opened by the launcher (the page and static files don't).
  const isPage = !p.startsWith("/oc/") && !p.startsWith("/studio/");
  if (!isPage && !signedIn(req)) return send(res, 401, { error: "signed out" });

  if (p.startsWith("/oc/")) {
    if (!allowedDirectory(req.url.slice(3))) return send(res, 403, { error: "Only folders inside the AI agent folder can be opened." });
    return proxy(req, res, req.url.slice(3));
  }

  if (p === "/studio/state") {
    if (req.method === "GET") return send(res, 200, readState());
    if (req.method === "PUT") {
      try {
        const patch = JSON.parse(await body(req));
        delete patch.agentRoot;   // set by install.ps1 only
        if (patch.project && !inRoot(patch.project)) return send(res, 400, { error: "Projects must be inside the AI agent folder." });
        const s = { ...readState(), ...patch }; writeState(s); return send(res, 200, s);
      }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
  }
  if (p === "/studio/sandbox") {
    const root = agentRoot();
    return send(res, 200, { root, label: labelOf(root), running: !!ocChild, port: OC_PORT });
  }
  if (p === "/studio/mkdir" && req.method === "POST") {   // re-create a deleted project folder (AI agent folder only)
    try {
      const d = path.resolve(JSON.parse(await body(req)).path || "");
      if (!inRoot(d) || d.toLowerCase() === path.resolve(agentRoot()).toLowerCase()) return send(res, 400, { error: "Only folders inside the AI agent folder." });
      fs.mkdirSync(d, { recursive: true });   // inherits the folder's Low label, so the agent can write there
      return send(res, 200, { path: d });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === "/studio/import" && req.method === "POST") {
    try { return send(res, 200, await importFolder(JSON.parse(await body(req)).path)); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === "/studio/pc/events") {   // the page's channel for PC-action questions
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": hi\n\n");
    pageStreams.add(res); lastPage = Date.now();
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { clearInterval(ping); pageStreams.delete(res); lastPage = Date.now(); });
    return;
  }
  if (p === "/studio/pc/answer" && req.method === "POST") {
    try { const a = JSON.parse(await body(req)); const f = questions.get(a.id); if (f) f(!!a.yes); return send(res, 200, { ok: !!f }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === "/studio/omniroute") return send(res, 200, await omniStatus());
  if (p === "/studio/omniroute/models") { // the gateway's model list, for syncing into OpenCode
    try {
      const key = savedKey("omniroute");
      const r = await fetch(OMNI + "/v1/models", { headers: key ? { authorization: "Bearer " + key } : {}, signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      return send(res, r.status, j);
    } catch (e) { return send(res, 502, { error: "OmniRoute is not reachable: " + e.message }); }
  }
  if (p === "/studio/freellmapi") return send(res, 200, await freeStatus());
  if (p === "/studio/freellmapi/models") { // only models it has a provider key for, plus auto/fusion/chains
    try {
      const key = savedKey("freellmapi");
      const r = await fetch(FREE + "/v1/models?available=true", { headers: key ? { authorization: "Bearer " + key } : {}, signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      return send(res, r.status, j);
    } catch (e) { return send(res, 502, { error: "FreeLLMAPI is not reachable: " + e.message }); }
  }
  if (p === "/studio/agents") {
    const list = await Promise.all(AGENTS.map(async (a) => ({ ...a, path: await onPath(a.check) })));
    return send(res, 200, list);
  }
  if (p === "/studio/dir") { // does a folder exist, and is it inside the AI agent folder (for the project picker)
    const d = url.searchParams.get("path") || "";
    let ok = false; try { ok = fs.statSync(d).isDirectory(); } catch {}
    return send(res, 200, { path: ok ? path.resolve(d) : d, exists: ok, inside: ok && inRoot(d), root: agentRoot() });
  }

  if (p.startsWith("/vendor/")) {
    const f = VENDOR[p.slice(8)];
    if (!f) return send(res, 404, "not found", "text/plain");
    return fs.createReadStream(path.join(ROOT, f)).on("open", function () {
      res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "text/plain" }); this.pipe(res);
    }).on("error", () => send(res, 404, "not found", "text/plain"));
  }

  const file = path.normalize(path.join(PUBLIC, p === "/" ? "index.html" : p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "not found", "text/plain");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  });
});

// Terminal: pass the WebSocket upgrade for /oc/pty/... straight through to opencode.
server.on("upgrade", (req, socket, head) => {
  if (!sameOrigin(req) || !req.url.startsWith("/oc/") || !signedIn(req) || !allowedDirectory(req.url.slice(3))) return socket.destroy();
  const up = net.connect(OC_PORT, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url.slice(3)} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === "origin" || k === "cookie") continue;
      lines.push(`${k}: ${k === "host" ? `127.0.0.1:${OC_PORT}` : v}`);
    }
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

// Start-up: refuse to run the agent unless the sandbox is in place.
(async () => {
  const root = agentRoot();
  if (!fs.existsSync(LOWRUN)) throw new Error("sandbox/lowrun.exe is missing: run Install.bat");
  if (labelOf(root) !== "low") throw new Error(`${root} isn't set up for the agent: run Install.bat`);
  fs.mkdirSync(DATA, { recursive: true });
  execFileSync(LOWRUN, ["--protect", DATA], { windowsHide: true });   // the sandbox can't read Agent Studio's data
  newLaunchCode();
  studio.syncWorkspace();
  if (!fs.existsSync(path.join(kit.KIT_SKILLS, "skill-library"))) {   // first start after an update: copy the skills in
    try { require("./sync-skills").main(); } catch (e) { log("skills sync failed:", e.message); }
  }
  // Twice (once right after the PC woke) opencode.exe looked missing for a moment although it was there: keep
  // trying for ~30 s before giving up, so a click then still opens the window.
  for (let i = 1; ; i++) {
    try { await ensureOpencode(); break; }
    catch (e) { if (i >= 15) throw e; log(`OpenCode not ready (${e.message}); trying again`); await new Promise((r) => setTimeout(r, 2000)); }
  }
  server.listen(PORT, "127.0.0.1", () => log(`Agent Studio on http://127.0.0.1:${PORT} (agent folder ${root})`));
})().catch((e) => { log("cannot start:", e.message); fs.writeFileSync(path.join(LOGS, "startup-error.txt"), e.message); process.exit(1); });
