// PC control for the agent: an MCP server (Streamable HTTP, JSON replies) whose tools see and drive the
// desktop through pc/pchelper.exe. The agent itself runs sandboxed at Low integrity and can't touch other
// windows; this runs in Agent Studio's own process, so every rule that keeps it safe lives here:
//   - never acts on terminals, editors with terminals, Explorer / Start / the taskbar, system tools,
//     Device Manager, drivers, the registry, Settings, Claude, Karen, or Agent Studio's own window;
//   - asks you first (a dialog in Agent Studio) before risky clicks and before sending messages;
//   - logs every action to logs/pc_actions.log.
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");

const HELPER = path.join(__dirname, "pc", "pchelper.exe");
const LOG = path.join(__dirname, "..", "logs", "pc_actions.log");

// Windows the agent may never click, type or scroll into (process names, lower case).
const BLOCKED_PROCS = new Set([
  // shells and terminals: typing there would run any command outside the sandbox
  "cmd.exe", "powershell.exe", "pwsh.exe", "powershell_ise.exe", "windowsterminal.exe", "wt.exe", "openconsole.exe",
  "conhost.exe", "bash.exe", "mintty.exe", "wsl.exe", "wslhost.exe", "ubuntu.exe", "alacritty.exe", "wezterm-gui.exe",
  // editors and tools with built-in terminals or that run code
  "code.exe", "code - insiders.exe", "cursor.exe", "windsurf.exe", "devenv.exe", "idea64.exe", "pycharm64.exe",
  "studio64.exe", "webstorm64.exe", "rider64.exe", "zed.exe", "notepad++.exe", "python.exe", "pythonw.exe",
  // Windows shell: Explorer windows, desktop, taskbar, Start, search, Run dialog
  "explorer.exe", "searchhost.exe", "searchapp.exe", "startmenuexperiencehost.exe", "shellexperiencehost.exe",
  "textinputhost.exe", "lockapp.exe", "consent.exe",
  // system tools, drivers and settings
  "regedit.exe", "mmc.exe", "taskmgr.exe", "systemsettings.exe", "control.exe", "msconfig.exe", "devmgmt.exe",
  "pnputil.exe", "msiexec.exe", "secHealthui.exe".toLowerCase(), "securityhealthsystray.exe", "rundll32.exe",
  "dxdiag.exe", "msinfo32.exe", "perfmon.exe", "resmon.exe", "eventvwr.exe", "diskmgmt.exe", "compmgmt.exe",
  "services.exe", "sysdm.cpl", "useraccountcontrolsettings.exe", "optionalfeatures.exe", "winver.exe",
  // other AI agents and assistants (they could be told to do what this agent can't)
  "claude.exe", "chatgpt.exe", "copilot.exe", "ollama app.exe", "lm studio.exe",
]);
// Window titles that are never touched, whatever the process (Agent Studio itself, Karen, installers).
const BLOCKED_TITLES = /agent studio|\bkaren\b|device manager|registry editor|task manager|command prompt|windows powershell|\bterminal\b|setup wizard|installer|installshield|user account control/i;

// Apps the agent may not open.
const BLOCKED_APPS = /terminal|powershell|command prompt|\bcmd\b|bash|wsl|ubuntu|registry|regedit|device manager|driver|services|task manager|control panel|settings|system configuration|msconfig|windows tools|administrative|computer management|disk management|disk cleanup|defragment|recovery|reset|bios|firmware|uninstall|windows security|windows update|event viewer|resource monitor|performance monitor|group policy|hyper-v|sandbox|visual studio|vs code|\bcode\b|cursor|windsurf|jetbrains|pycharm|intellij|android studio|python|node\.js|git bash|claude|chatgpt|copilot|\bkaren\b|agent studio|^run$/i;

// Clicks on these need your yes (button, link and menu names, and the window title).
const RISKY = /\b(send|buy|pay|purchase|order|checkout|place order|subscribe|unsubscribe|donate|transfer|delete|remove|erase|empty|wipe|format|uninstall|install|download|run|open file|keep|update now|restart|shut ?down|sign ?out|log ?out|post|publish|share|submit|reply|forward|confirm|accept|agree|allow|grant|permit|discard|don'?t save|replace|overwrite|reset|block|report|call|video call|join)\b/i;
// Apps where Enter usually sends a message.
const MESSAGING = /whatsapp|telegram|discord|slack|teams|messenger|instagram|outlook|gmail|mail|signal|skype|zoom|x\.com|twitter|facebook|linkedin/i;

let helper = null, pending = new Map(), nextId = 1, buf = "";
function startHelper() {
  helper = spawn(HELPER, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  helper.stdout.setEncoding("utf8");
  helper.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const r = JSON.parse(line); const p = pending.get(r.id);
        if (p) { pending.delete(r.id); r.ok ? p.ok(r.result) : p.fail(new Error(r.error)); }
      } catch {}
    }
  });
  helper.on("exit", () => {
    helper = null; buf = "";
    for (const p of pending.values()) p.fail(new Error("the PC helper stopped"));
    pending.clear();
  });
}
function hand(op, args = {}, timeout = 15000) {
  if (!helper) startHelper();
  const id = nextId++;
  return new Promise((ok, fail) => {
    const t = setTimeout(() => { pending.delete(id); fail(new Error(op + " timed out")); }, timeout);
    pending.set(id, { ok: (v) => { clearTimeout(t); ok(v); }, fail: (e) => { clearTimeout(t); fail(e); } });
    helper.stdin.write(JSON.stringify({ id, op, ...args }) + "\n");
  });
}

function log(line) {
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch {}
}

// Agent Studio's own windows (its Edge app profile), found by command line and cached briefly.
let ownPids = { at: 0, set: new Set() };
function ownWindowsPids() {
  if (Date.now() - ownPids.at < 10000) return Promise.resolve(ownPids.set);
  const marker = (process.env.STUDIO_EDGE_PROFILE || "").replace(/'/g, "''");
  return new Promise((ok) => execFile("powershell.exe", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }`],
    { windowsHide: true }, (err, out) => {
      ownPids = { at: Date.now(), set: new Set(String(out || "").split(/\s+/).filter(Boolean).map(Number)) };
      ok(ownPids.set);
    }));
}

// Why a window is off limits, or "" when the agent may act on it.
async function offLimits(w) {
  if (!w || !w.hwnd) return "no window there";
  if (BLOCKED_PROCS.has(w.proc)) return `${w.proc} is off limits (terminals, editors, Explorer, system tools and other agents are)`;
  if (BLOCKED_TITLES.test(w.title)) return `the window "${w.title}" is off limits`;
  if ((await ownWindowsPids()).has(w.pid)) return "that is Agent Studio's own window";
  return "";
}

// ---------------------------------------------------------------- confirmations
let asker = async () => false;   // replaced by server.js: shows a dialog in Agent Studio
function setAsker(fn) { asker = fn; }
async function confirm(question) {
  log("ASK  " + question);
  const yes = await asker(question).catch(() => false);
  log((yes ? "YES  " : "NO   ") + question);
  if (!yes) throw new Error("The user said no (or didn't answer). Don't try again unless they ask you to.");
}

// ---------------------------------------------------------------- tool helpers
let shot = { scale: 1, originX: 0, originY: 0 };   // last screenshot, to map its pixels back to the screen
let elements = [], elementsWindow = null;           // last screen_read (numbered from 1) and its window
const toScreen = (x, y) => ({ x: Math.round(shot.originX + x / shot.scale), y: Math.round(shot.originY + y / shot.scale) });

async function point(a) {
  if (a.element != null) {
    const e = elements[a.element - 1];
    if (!e) throw new Error(`There is no element ${a.element}. Call screen_read again to get fresh numbers.`);
    // The element's window comes to the front first, so the click lands on it and not on what covers it.
    if (elementsWindow && (await hand("fg")).hwnd !== elementsWindow) await hand("focus", { hwnd: elementsWindow });
    return { x: e.x, y: e.y, label: `${e.role} "${e.name}"` };
  }
  if (a.x == null || a.y == null) throw new Error("Give an element number from screen_read, or x and y from the last screenshot.");
  const p = toScreen(Number(a.x), Number(a.y));
  return { ...p, label: `point ${a.x},${a.y}` };
}

// Emergency stop: with the mouse pushed into the top-left corner of the screen, every action is refused.
async function notStopped() {
  const c = await hand("cursor");
  if (c.x <= 2 && c.y <= 2) throw new Error("Stopped: the user moved the mouse into the top-left corner to stop PC control. Don't continue until they ask.");
}

async function checkPoint(p) {
  await notStopped();
  const w = await hand("at", { x: p.x, y: p.y });
  const why = await offLimits(w);
  if (why) throw new Error(`Refused: ${why}. Ask the user to do this step themselves.`);
  return w;
}

async function checkForeground() {
  await notStopped();
  const w = await hand("fg");
  const why = await offLimits(w);
  if (why) throw new Error(`Refused: the active window is off limits (${why}). Use focus_window to switch to another app first.`);
  return w;
}

function findWindow(list, title) {
  const words = String(title || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error("Say which window (words from its title or app name).");
  return list.find((w) => words.every((x) => (w.title + " " + w.proc).toLowerCase().includes(x)));
}

function describeWindows(list) {
  return list.map((w) => `- ${w.title} [${w.proc}]${w.minimized ? " (minimized)" : ""}`).join("\n");
}

async function usableWindows() {
  const list = await hand("windows");
  const out = [];
  for (const w of list) if (!(await offLimits(w))) out.push(w);
  return out;
}

let startApps = { at: 0, list: [] };
function getStartApps() {
  if (Date.now() - startApps.at < 600000) return Promise.resolve(startApps.list);
  return new Promise((ok) => execFile("powershell.exe", ["-NoProfile", "-Command",
    "Get-StartApps | ForEach-Object { $_.Name + \"`t\" + $_.AppID }"], { windowsHide: true, maxBuffer: 4e6 }, (err, out) => {
      const list = String(out || "").split(/\r?\n/).map((l) => l.split("\t")).filter((p) => p.length === 2 && p[0]).map(([name, id]) => ({ name, id }));
      startApps = { at: Date.now(), list }; ok(list);
    }));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t) => ({ content: [{ type: "text", text: t }] });

// ---------------------------------------------------------------- tools
const TOOLS = [
  {
    name: "screen_read",
    description: "Read the screen without a picture: the open windows, and the buttons, links, menus, text boxes and text of the active window (or the window you name), numbered. Use the numbers with click, type_text and scroll. Call it again after the screen changes.",
    schema: { window: { type: "string", description: "Optional: words from the title of the window to read (it is brought to the front first)" } },
    async run(a) {
      let w;
      if (a.window) {
        w = findWindow(await usableWindows(), a.window);
        if (!w) throw new Error(`No usable window matches "${a.window}".`);
        await hand("focus", { hwnd: w.hwnd });
      } else w = await checkForeground();
      let els = await hand("elements", { hwnd: w.hwnd, max: 150 }, 20000);
      for (let i = 0; i < 6 && els.length < 3; i++) {   // a window that is still starting has almost nothing yet
        await new Promise((r) => setTimeout(r, 800));
        els = await hand("elements", { hwnd: w.hwnd, max: 150 }, 20000);
      }
      elements = els; elementsWindow = w.hwnd;
      const lines = els.map((e, i) => `${i + 1}. ${e.role} "${e.name}"${e.enabled ? "" : " (disabled)"}`);
      return text(`Active window: ${w.title} [${w.proc}]\n\n${lines.join("\n") || "(no readable elements; try screenshot)"}\n\nOther windows:\n${describeWindows(await usableWindows())}`);
    },
  },
  {
    name: "screenshot",
    description: "Take a screenshot of the whole screen (a picture, for models that can see images). x/y for click, scroll and drag are pixels in this picture.",
    schema: {},
    async run() {
      const s = await hand("shot", { maxw: 1280 }, 20000);
      shot = s;
      const fg = await hand("fg");
      return { content: [
        { type: "image", data: s.data, mimeType: "image/jpeg" },
        { type: "text", text: `Screenshot ${s.w}x${s.h}. Active window: ${fg.title} [${fg.proc}].` },
      ] };
    },
  },
  {
    name: "click",
    description: "Click a numbered element from screen_read, or a point (x, y) in the last screenshot. Risky buttons (send, buy, delete, install, download, sign out...) ask the user first.",
    schema: {
      element: { type: "number", description: "Element number from screen_read" },
      x: { type: "number" }, y: { type: "number" },
      button: { type: "string", enum: ["left", "right", "middle"], description: "Default left" },
      double: { type: "boolean", description: "Double-click" },
    },
    async run(a) {
      const p = await point(a);
      const w = await checkPoint(p);
      const what = `${p.label}${w.element ? ` (${w.element})` : ""} in "${w.title}"`;
      if (RISKY.test(p.label) || RISKY.test(w.element || "")) await confirm(`Click ${what}?`);
      log(`click ${what}`);
      await hand("click", { x: p.x, y: p.y, button: a.button || "left", count: a.double ? 2 : 1 });
      await wait(400);
      const fg = await hand("fg");
      return text(`Clicked ${what}. Active window now: ${fg.title} [${fg.proc}]. Call screen_read or screenshot to see the result.`);
    },
  },
  {
    name: "type_text",
    description: "Type text into the active window (any language). Give an element number to click into a text box first. Text ending in a new line presses Enter.",
    schema: { text: { type: "string" }, element: { type: "number", description: "Optional text box to click first" } },
    async run(a) {
      const t = String(a.text ?? "");
      if (t.length > 5000) throw new Error("Type at most 5000 characters at a time.");
      if (a.element != null) { const p = await point(a); await checkPoint(p); await hand("click", { x: p.x, y: p.y, button: "left", count: 1 }); await wait(200); }
      const w = await checkForeground();
      if (/\n/.test(t) && MESSAGING.test(w.title + " " + w.proc)) await confirm(`Type and send this in "${w.title}"?\n\n${t.slice(0, 600)}`);
      log(`type ${JSON.stringify(t.slice(0, 200))} in "${w.title}"`);
      await hand("type", { text: t }, 30000 + t.length * 40);   // 25 ms a key: faster and apps like Notepad drop letters
      return text(`Typed ${t.length} characters into "${w.title}".`);
    },
  },
  {
    name: "press_keys",
    description: "Press a key or shortcut in the active window, e.g. enter, tab, esc, ctrl+s, ctrl+shift+t, alt+tab, f5, pagedown, volumeup, playpause. The Windows key is not allowed.",
    schema: { keys: { type: "string" } },
    async run(a) {
      const k = String(a.keys || "").toLowerCase().replace(/\s+/g, "");
      if (!k) throw new Error("Which keys?");
      if (/(^|\+)win($|\+)/.test(k) || /ctrl\+alt|ctrl\+shift\+esc|ctrl\+esc/.test(k)) throw new Error("Refused: Windows-key and system shortcuts are off limits.");
      const w = await checkForeground();
      if (/(^|\+)(enter|return)$/.test(k) && MESSAGING.test(w.title + " " + w.proc)) await confirm(`Press ${k} in "${w.title}" (this may send a message)?`);
      if (k === "alt+f4") await confirm(`Close "${w.title}" with Alt+F4?`);
      log(`keys ${k} in "${w.title}"`);
      await hand("keys", { combo: k });
      return text(`Pressed ${k} in "${w.title}".`);
    },
  },
  {
    name: "scroll",
    description: "Scroll at an element, at a screenshot point, or in the middle of the active window.",
    schema: {
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      amount: { type: "number", description: "Wheel steps, 1-20 (default 5)" },
      element: { type: "number" }, x: { type: "number" }, y: { type: "number" },
    },
    async run(a) {
      let p;
      if (a.element != null || a.x != null) p = await point(a);
      else { const w = await checkForeground(); p = { x: w.x + Math.round(w.w / 2), y: w.y + Math.round(w.h / 2) }; }
      const w = await checkPoint(p);
      const n = Math.max(1, Math.min(20, Number(a.amount) || 5));
      const dir = a.direction || "down";
      await hand("scroll", { x: p.x, y: p.y, delta: dir === "up" || dir === "left" ? n : -n, axis: dir === "left" || dir === "right" ? "h" : "v" });
      log(`scroll ${dir} ${n} in "${w.title}"`);
      return text(`Scrolled ${dir} in "${w.title}".`);
    },
  },
  {
    name: "drag",
    description: "Drag with the left mouse button from one screenshot point to another (sliders, moving items).",
    schema: { from_x: { type: "number" }, from_y: { type: "number" }, to_x: { type: "number" }, to_y: { type: "number" } },
    async run(a) {
      const s = toScreen(a.from_x, a.from_y), e = toScreen(a.to_x, a.to_y);
      const w = await checkPoint(s); await checkPoint(e);
      log(`drag ${a.from_x},${a.from_y} -> ${a.to_x},${a.to_y} in "${w.title}"`);
      await hand("drag", { x1: s.x, y1: s.y, x2: e.x, y2: e.y });
      return text(`Dragged in "${w.title}".`);
    },
  },
  {
    name: "windows",
    description: "List the open windows the agent may use.",
    schema: {},
    async run() { return text(describeWindows(await usableWindows()) || "(no usable windows)"); },
  },
  {
    name: "focus_window",
    description: "Bring a window to the front (words from its title or app name).",
    schema: { title: { type: "string" } },
    async run(a) {
      const w = findWindow(await usableWindows(), a.title);
      if (!w) throw new Error(`No usable window matches "${a.title}".`);
      const fg = await hand("focus", { hwnd: w.hwnd });
      log(`focus "${w.title}"`);
      if (fg.hwnd !== w.hwnd) throw new Error(`Windows didn't let "${w.title}" come to the front (the active window is "${fg.title}"). Try again, or ask the user to click it.`);
      return text(`"${w.title}" is in front.`);
    },
  },
  {
    name: "window",
    description: "Minimize, maximize, restore or close a window (words from its title). Closing asks the user first.",
    schema: { title: { type: "string" }, action: { type: "string", enum: ["minimize", "maximize", "restore", "close"] } },
    async run(a) {
      const w = findWindow(await usableWindows(), a.title);
      if (!w) throw new Error(`No usable window matches "${a.title}".`);
      if (a.action === "close") { await confirm(`Close the window "${w.title}"? Unsaved work there may ask to be saved.`); await hand("close", { hwnd: w.hwnd }); }
      else await hand("show", { hwnd: w.hwnd, cmd: { minimize: 6, maximize: 3, restore: 9 }[a.action] ?? 9 });
      log(`window ${a.action} "${w.title}"`);
      return text(`${a.action}: "${w.title}".`);
    },
  },
  {
    name: "open_app",
    description: "Open an app from the Start menu by name (e.g. Notepad, Calculator, Paint, Spotify, Microsoft Edge). Terminals, code editors, system tools, Settings and other AI agents are not allowed.",
    schema: { name: { type: "string" } },
    async run(a) {
      const want = String(a.name || "").trim();
      if (!want) throw new Error("Which app?");
      if (BLOCKED_APPS.test(want)) throw new Error(`Refused: "${want}" is off limits for the agent.`);
      const apps = await getStartApps();
      const lower = want.toLowerCase();
      const app = apps.find((x) => x.name.toLowerCase() === lower) || apps.find((x) => x.name.toLowerCase().startsWith(lower))
        || apps.find((x) => x.name.toLowerCase().includes(lower));
      if (!app) throw new Error(`No Start menu app called "${want}".`);
      if (BLOCKED_APPS.test(app.name) || BLOCKED_APPS.test(app.id)) throw new Error(`Refused: "${app.name}" is off limits for the agent.`);
      log(`open app ${app.name} (${app.id})`);
      const before = new Set((await usableWindows()).map((w) => w.hwnd));
      spawn("explorer.exe", ["shell:AppsFolder\\" + app.id], { detached: true, stdio: "ignore" }).unref();
      // Wait for its window (a new one, or one with the app's name if it was already open) and bring it to the front:
      // Windows often opens a new app behind the window the user is working in.
      let win = null;
      for (let i = 0; i < 16 && !win; i++) {
        await wait(500);
        const ws = await usableWindows();
        win = ws.find((w) => !before.has(w.hwnd) && !w.minimized) || (i >= 4 ? findWindow(ws, app.name) : null);
      }
      if (win && (await hand("fg")).hwnd !== win.hwnd) await hand("focus", { hwnd: win.hwnd });
      const fg = await hand("fg");
      return text(`Opened ${app.name}. Active window: ${fg.title} [${fg.proc}].${win && fg.hwnd !== win.hwnd ? ` Its window "${win.title}" didn't come to the front; use focus_window.` : ""}`);
    },
  },
  {
    name: "open_url",
    description: "Open a web page (http or https) in the default browser, or in edge / chrome / firefox.",
    schema: { url: { type: "string" }, browser: { type: "string", enum: ["default", "edge", "chrome", "firefox"] } },
    async run(a) {
      let u;
      try { u = new URL(String(a.url || "")); } catch { throw new Error("That isn't a full web address."); }
      if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https pages can be opened.");
      if (/^(127\.|localhost$|\[::1\])/.test(u.hostname)) throw new Error("Refused: local addresses (this PC's own servers) are off limits.");
      const exe = { edge: "msedge", chrome: "chrome", firefox: "firefox" }[a.browser];
      log(`open url ${u.href}${exe ? " in " + exe : ""}`);
      if (exe) spawn("cmd.exe", ["/d", "/c", "start", '""', exe, u.href], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      else spawn("explorer.exe", [u.href], { detached: true, stdio: "ignore" }).unref();
      await wait(2000);
      return text(`Opened ${u.href}.`);
    },
  },
  {
    name: "wait",
    description: "Wait a few seconds (1-30) for something on screen to finish loading.",
    schema: { seconds: { type: "number" } },
    async run(a) { const s = Math.max(1, Math.min(30, Number(a.seconds) || 2)); await wait(s * 1000); return text(`Waited ${s} s.`); },
  },
];

// ---------------------------------------------------------------- MCP (Streamable HTTP, JSON responses)
async function rpc(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  if (method === "initialize")
    return reply({ protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} },
      serverInfo: { name: "agent-studio-pc", version: "1.0.0" },
      instructions: "Controls this Windows PC's screen, mouse and keyboard. Prefer screen_read (text) over screenshot. Refused actions are the user's to do." });
  if (method === "ping") return reply({});
  if (method === "tools/list")
    return reply({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description,
      inputSchema: { type: "object", properties: t.schema, additionalProperties: false } })) });
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool " + params?.name } };
    try { return reply(await tool.run(params.arguments || {})); }
    catch (e) { log(`refused/failed ${tool.name}: ${e.message}`); return reply({ content: [{ type: "text", text: e.message }], isError: true }); }
  }
  if (id === undefined) return null;   // notifications need no reply
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } };
}

async function handleMcp(req, res, raw) {
  if (req.method === "GET") { res.writeHead(405, { allow: "POST" }); return res.end(); }   // no server-sent stream
  if (req.method === "DELETE") { res.writeHead(200); return res.end(); }
  let msg;
  try { msg = JSON.parse(raw); } catch { res.writeHead(400); return res.end(); }
  const out = Array.isArray(msg) ? (await Promise.all(msg.map(rpc))).filter(Boolean) : await rpc(msg);
  if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(out));
}

module.exports = { handleMcp, setAsker, TOOLS, offLimits, hand };
