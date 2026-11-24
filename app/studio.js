// Studio tools for the agent: the jobs Claude does regularly (reels, Instagram, Telegram) as an MCP server.
// The reel pipeline and igcli live in the Karen folder (KAREN_DIR), outside the sandbox, so these tools run them from Agent
// Studio's own process with fixed commands only (no free-form shell), and mirror each reel into
// <AI agent folder>\Studio\Reels\<name> where the agent can read and edit it.
//   - anything that posts, replies or messages someone asks you first (Allow / Don't allow in the window);
//   - only one heavy job (render) at a time; every job is logged to logs/studio_jobs.log.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const KAREN = process.env.KAREN_DIR || path.resolve(__dirname, "..", "..", "karen-voice-assistant");
const REELS = path.join(KAREN, "ig-reels");
const PY = path.join(KAREN, ".venv", "Scripts", "python.exe");
const PY_IG = path.join(REELS, ".venv-ig", "Scripts", "python.exe");
const INSIGHTS = path.join(KAREN, "data", "reel_insights");
const LOG = path.join(__dirname, "..", "logs", "studio_jobs.log");
const OUT_DIRS = { auto: path.join(REELS, "reels"), doodle: path.join(REELS, "reels"), launch: path.join(REELS, "launch"), turbo: path.join(REELS, "turbo") };
const VOICES = ["ava", "brian", "emma", "ryan"];

let workspace = () => "E:\\AI agent folder\\Studio";
function setWorkspace(fn) { workspace = fn; }
const reelsWs = () => path.join(workspace(), "Reels");
const igWs = () => path.join(workspace(), "Instagram");

function log(m) {
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {}
}
const text = (t) => ({ content: [{ type: "text", text: t }] });

let asker = async () => false;
function setAsker(fn) { asker = fn; }
async function confirm(question) {
  log("ASK  " + question.split("\n")[0]);
  const yes = await asker(question).catch(() => false);
  log((yes ? "YES  " : "NO   ") + question.split("\n")[0]);
  if (!yes) throw new Error("The user said no (or didn't answer). Don't try again unless they ask you to.");
}

// A reel folder name: letters, digits, dots, dashes, underscores only (no paths).
function folderName(n) {
  const s = String(n || "").trim();
  if (!/^[\w.-]{1,120}$/.test(s) || s === "." || s === "..") throw new Error("Give the reel folder's name (as listed by studio_reels), not a path.");
  return s;
}
const account = (a) => { const s = String(a || "").toLowerCase(); if (s && !/^[a-z0-9_]{1,30}$/.test(s)) throw new Error("account: a short name like gta, or empty for the main account"); return s; };

// ---------------------------------------------------------------- jobs
const jobs = new Map();
let heavy = null;   // id of the running render-type job

function run(cmd, args, opts = {}) {
  const id = crypto.randomBytes(4).toString("hex");
  const job = { id, title: opts.title || path.basename(cmd), status: "running", out: "", started: Date.now(), code: null, result: null };
  jobs.set(id, job);
  log(`START ${id} ${job.title}: ${cmd} ${args.join(" ")}`);
  const p = spawn(cmd, args, {
    cwd: opts.cwd || KAREN, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...(opts.env || {}) },
  });
  const add = (b) => { job.out = (job.out + b.toString()).slice(-60000); };
  p.stdout.on("data", add); p.stderr.on("data", add);
  job.done = new Promise((ok) => p.on("close", async (code) => {
    job.code = code;
    try { if (opts.after) job.result = await opts.after(job); } catch (e) { job.out += `\n[after: ${e.message}]`; }
    job.status = code === 0 ? "done" : "failed";
    if (heavy === id) heavy = null;
    log(`END   ${id} ${job.status} (${code}) ${Math.round((Date.now() - job.started) / 1000)} s`);
    ok(job);
  }));
  p.on("error", (e) => { add(`\n${e.message}`); });
  if (opts.heavy) heavy = id;
  return job;
}

function needFree() {
  if (heavy && jobs.get(heavy)?.status === "running") throw new Error(`Another reel job (${heavy}, ${jobs.get(heavy).title}) is still running. Check it with studio_job and start this one after it finishes.`);
}

function describe(job, tail = 2500) {
  const secs = Math.round((Date.now() - job.started) / 1000);
  let s = `Job ${job.id} (${job.title}): ${job.status}${job.code != null ? `, exit ${job.code}` : ""}, ${secs} s.`;
  if (job.result) s += `\n${job.result}`;
  const out = job.out.trim();
  if (out) s += `\n--- output (last part) ---\n${out.slice(-tail)}`;
  return s;
}

// Wait up to `secs` for a job, then report.
async function waitFor(job, secs) {
  await Promise.race([job.done, new Promise((r) => setTimeout(r, secs * 1000))]);
  return describe(job, job.status === "running" ? 800 : 2500);
}

// ---------------------------------------------------------------- mirroring reel folders
const INPUTS = ["script.txt", "reel.json", "caption.txt", "doodle.json", "plan.json"];

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) {
      const st = fs.statSync(s);
      if (st.size > 400 * 1048576) continue;
      try { if (fs.statSync(d).mtimeMs >= st.mtimeMs && fs.statSync(d).size === st.size) continue; } catch {}
      fs.copyFileSync(s, d);
    }
  }
}

// Folders created or changed by a job (since `since`) in the pipeline's output folders.
function changedFolders(dirs, since) {
  const out = [];
  for (const d of new Set(dirs)) {
    let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch {}
    for (const e of list) if (e.isDirectory()) {
      const p = path.join(d, e.name);
      try { if (fs.statSync(p).mtimeMs >= since - 2000) out.push(p); } catch {}
    }
  }
  return out;
}

function mirrorOut(src) {
  const dest = path.join(reelsWs(), path.basename(src));
  copyTree(src, dest);
  fs.writeFileSync(path.join(dest, ".source"), src);
  return dest;
}

// Where a workspace reel folder came from in the pipeline (or where it goes for a new guided reel).
function sourceOf(name) {
  const ws = path.join(reelsWs(), name);
  try { const s = fs.readFileSync(path.join(ws, ".source"), "utf8").trim(); if (s.toLowerCase().startsWith(REELS.toLowerCase() + "\\")) return s; } catch {}
  return path.join(REELS, "reels", name);
}

function mirrorIn(name) {
  const ws = path.join(reelsWs(), name), src = sourceOf(name);
  if (!fs.existsSync(ws)) throw new Error(`There is no folder ${name} in ${reelsWs()}. Create it there first (script.txt, reel.json, caption.txt).`);
  fs.mkdirSync(src, { recursive: true });
  for (const f of INPUTS) if (fs.existsSync(path.join(ws, f))) fs.copyFileSync(path.join(ws, f), path.join(src, f));
  fs.writeFileSync(path.join(ws, ".source"), src);
  return src;
}

// ---------------------------------------------------------------- caption check
// The ig-caption skill's linter, run by the server itself (not left to the model): after every reel is made or
// finished, before it goes to Telegram, and before every post. Result also saved as caption-check.txt.
const HOME = require("os").userInfo().homedir;
const LINTER = [path.join(HOME, ".claude", "skills", "ig-caption", "caption.py"), path.join(__dirname, "..", "kit", "skills", "ig-caption", "caption.py")].find((f) => fs.existsSync(f));

async function captionCheck(dir) {
  const capFile = path.join(dir, "caption.txt");
  if (!fs.existsSync(capFile)) return { verdict: "MISSING", summary: "no caption.txt", report: "There is no caption.txt in " + dir };
  if (!LINTER) return { verdict: "UNCHECKED", summary: "caption linter not found", report: "ig-caption/caption.py not found" };
  const job = run(PY, ["-X", "utf8", "-I", LINTER, "--json", capFile], { title: "caption check " + path.basename(dir) });
  await job.done;
  let j = null; try { j = JSON.parse(job.out.slice(job.out.indexOf("{"))); } catch {}
  if (!j) return { verdict: "UNCHECKED", summary: "linter failed", report: job.out.slice(-1500) };
  const bad = (j.checks || []).filter((c) => c.status !== "PASS");
  const summary = bad.length ? bad.map((c) => `${c.status} ${c.check}: ${c.detail}`).join("; ") : "all checks pass";
  const report = `Caption check: ${j.verdict}\n` + (j.checks || []).map((c) => `  ${c.status.padEnd(4)} ${c.check}: ${c.detail}`).join("\n");
  try { fs.writeFileSync(path.join(dir, "caption-check.txt"), report + "\n"); } catch {}
  return { verdict: j.verdict, summary, report };
}
const checkNote = (name, c) => c.verdict === "READY" ? `Caption check for ${name}: READY.`
  : `Caption check for ${name}: ${c.verdict} (${c.summary}). Fix caption.txt in the folder (keep the facts true), then run studio_caption_check until it says READY.`;

// ---------------------------------------------------------------- Instagram
function igArgs(acct, rest) { return [path.join(REELS, "igcli.py"), ...(acct ? ["--account", acct] : []), ...rest]; }

async function igRead(a) {
  const acct = account(a.account);
  const cmd = String(a.command || "");
  let rest;
  if (cmd === "whoami") rest = ["whoami"];
  else if (cmd === "stats") rest = ["stats", "--limit", String(Math.min(100, Number(a.limit) || 30)), "--json", ...(a.insights === false ? [] : ["--insights"])];
  else if (cmd === "comments") rest = ["comments", "--recent", String(Math.min(50, Number(a.recent) || 12)), "--json", ...(a.unreplied ? ["--unreplied"] : []), ...(a.media ? ["--media", String(a.media)] : [])];
  else if (cmd === "guide-requests") rest = ["guide-requests", "--recent", String(Math.min(50, Number(a.recent) || 20)), "--json"];
  else throw new Error("command: whoami, stats, comments or guide-requests");
  const job = run(PY_IG, igArgs(acct, rest), { title: `igcli ${cmd}${acct ? " " + acct : ""}` });
  await job.done;
  if (job.code !== 0) return text(`igcli ${cmd} failed (exit ${job.code}):\n${job.out.slice(-3000)}\nIf it asks for a security code or a login, tell the user to run: ig-reels\\.venv-ig\\Scripts\\python.exe ig-reels\\igcli.py ${acct ? "--account " + acct + " " : ""}login (in the Karen folder, KAREN_DIR).`);
  let note = "";
  if (cmd === "stats" || cmd === "comments") {   // keep a copy the agent can read and compare later
    const dir = path.join(igWs(), "insights"); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${acct || "main"}-${cmd}-${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(f, job.out.slice(job.out.search(/[[{]/) >= 0 ? job.out.search(/[[{]/) : 0));
    note = `\n(saved to ${f})`;
  }
  return text(job.out.slice(-14000) + note);
}

// ---------------------------------------------------------------- tools
const TOOLS = [
  {
    name: "reels",
    description: "List the reel folders in the Studio\\Reels workspace (newest first) with what each has (video, caption, script). Call it first to find folder names.",
    schema: {},
    async run() {
      const ws = reelsWs(); fs.mkdirSync(ws, { recursive: true });
      const rows = fs.readdirSync(ws, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
        const p = path.join(ws, e.name), has = (f) => fs.existsSync(path.join(p, f));
        return { name: e.name, t: fs.statSync(p).mtimeMs, tags: ["reel.mp4", "caption.txt", "script.txt", "reel.json"].filter(has).join(", ") };
      }).sort((a, b) => b.t - a.t).slice(0, 40);
      return text(rows.length ? `Folder: ${ws}\n` + rows.map((r) => `- ${r.name}: ${r.tags || "(empty)"}`).join("\n") : `No reels yet in ${ws}. Make one with studio_reel_make.`);
    },
  },
  {
    name: "reel_make",
    description: "Make a whole Instagram reel with the user's pipeline (runs in the background, ~5-8 min). style: launch (default: his Launch style, white/dark stage, picks a trending topic that fits his interests when topic is empty), auto (money/tech story of the day, flood-transition template), turbo (stock footage with word-pop captions), doodle (stick-figure explainer). The finished folder (reel.mp4, caption.txt, script, sources) is copied into Studio\\Reels. Nothing is posted.",
    schema: {
      style: { type: "string", enum: ["launch", "auto", "turbo", "doodle"] },
      topic: { type: "string", description: "Optional topic; empty = pick from today's trends" },
      voice: { type: "string", enum: VOICES, description: "launch/turbo only; random if empty" },
      seconds: { type: "number", description: "doodle only, default 60" },
      format: { type: "string", enum: ["9:16", "16:9"], description: "doodle only, default 9:16" },
    },
    async run(a) {
      needFree();
      const style = a.style || "launch", topic = String(a.topic || "").trim().slice(0, 200);
      let args;
      if (style === "auto") args = [path.join(REELS, "make.py"), ...(topic ? ["--topic", topic] : [])];
      else if (style === "launch") args = [path.join(REELS, "launch.py"), ...(topic ? [topic] : []), ...(VOICES.includes(a.voice) ? ["--voice", a.voice] : [])];
      else if (style === "turbo") { if (!topic) throw new Error("turbo needs a topic"); args = [path.join(REELS, "turbo.py"), topic, ...(VOICES.includes(a.voice) ? ["--voice", a.voice] : [])]; }
      else if (style === "doodle") { if (!topic) throw new Error("doodle needs a topic"); args = [path.join(REELS, "doodle.py"), topic, "--seconds", String(Math.max(15, Math.min(300, Number(a.seconds) || 60))), "--format", a.format === "16:9" ? "16:9" : "9:16"]; }
      else throw new Error("style: launch, auto, turbo or doodle");
      const since = Date.now();
      const job = run(PY, args, {
        title: `reel ${style}${topic ? ": " + topic : ""}`, heavy: true,
        after: async () => {
          const made = changedFolders([OUT_DIRS[style]], since).filter((p) => fs.existsSync(path.join(p, "reel.mp4")));
          if (!made.length) return "No finished reel folder found.";
          const lines = [];
          for (const p of made) { const ws = mirrorOut(p); lines.push(`Copied to the workspace: ${ws}`, checkNote(path.basename(ws), await captionCheck(ws))); }
          return lines.join("\n");
        },
      });
      return text(await waitFor(job, 20) + "\nIt keeps running in the background: check it with studio_job (it can take 5-8 minutes).");
    },
  },
  {
    name: "reel_step",
    description: "Guided reel (the reel skill's Mode B): after you wrote script.txt, reel.json and caption.txt in Studio\\Reels\\<folder>, run one pipeline step on it. Steps in order: voiceover (Kokoro voice + word timing), prepare (scenes + timings into the Remotion studio), render (1080x1920 MP4, ~3 min), finish (loudness to -16 LUFS, SOUND.md, sheet.png). 'all' runs the four in a row. Results are copied back into the folder.",
    schema: {
      folder: { type: "string" },
      step: { type: "string", enum: ["voiceover", "prepare", "render", "finish", "all"] },
      handle: { type: "string", description: "prepare: the @handle shown in the video" },
      voice: { type: "string", description: "voiceover: a Kokoro voice id, e.g. am_michael (optional)" },
    },
    async run(a) {
      needFree();
      const name = folderName(a.folder), step = a.step || "all";
      const src = mirrorIn(name);
      const handle = /^@?[\w.]{1,30}$/.test(a.handle || "") ? (a.handle.startsWith("@") ? a.handle : "@" + a.handle) : "";
      const steps = step === "all" ? ["voiceover", "prepare", "render", "finish"] : [step];
      const cmds = steps.map((s) => {
        if (s === "voiceover") return [PY, [path.join(REELS, "voiceover.py"), src, ...(/^[a-z]{2}_[a-z]+$/.test(a.voice || "") ? ["--voice", a.voice] : [])], KAREN];
        if (s === "prepare") return [PY, [path.join(REELS, "prepare.py"), src, ...(handle ? ["--handle", handle] : [])], KAREN];
        if (s === "render") return [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npx", "remotion", "render", "src/index.ts", "Reel", path.join(src, "reel.mp4"), "--props=public/reel/props.json", "--codec=h264", "--crf=22", "--concurrency=6"], path.join(REELS, "studio")];
        if (s === "finish") return [PY, [path.join(REELS, "finish.py"), src], KAREN];
        throw new Error("step: voiceover, prepare, render, finish or all");
      });
      // run the steps one after another as one job
      const id = crypto.randomBytes(4).toString("hex");
      const job = { id, title: `reel ${name}: ${steps.join(" > ")}`, status: "running", out: "", started: Date.now(), code: null, result: null };
      jobs.set(id, job); heavy = id;
      job.done = (async () => {
        for (const [cmd, args, cwd] of cmds) {
          const j = run(cmd, args, { cwd, title: `${name} ${path.basename(args[0] === "/d" ? "render" : args[0])}` });
          await j.done; job.out = (job.out + j.out).slice(-60000);
          if (j.code !== 0) { job.code = j.code; break; }
        }
        if (job.code == null) job.code = 0;
        try {
          const ws = mirrorOut(src); job.result = `Folder updated: ${ws}`;
          if (job.code === 0 && steps.includes("finish")) job.result += "\n" + checkNote(name, await captionCheck(ws));
        } catch (e) { job.result = e.message; }
        job.status = job.code === 0 ? "done" : "failed"; heavy = null;
        return job;
      })();
      return text(await waitFor(job, 25) + (job.status === "running" ? "\nStill running: check it with studio_job." : ""));
    },
  },
  {
    name: "caption_check",
    description: "Lint a reel's caption.txt (the ig-caption skill's checks: hook in the first 125 characters, length, one ask, hashtags, links, emoji). Run it after you edit a caption; posting refuses a caption that isn't READY.",
    schema: { folder: { type: "string" } },
    async run(a) {
      const name = folderName(a.folder), c = await captionCheck(path.join(reelsWs(), name));
      return text(c.report + (c.verdict === "READY" ? "" : "\n\nFix caption.txt and run this again."));
    },
  },
  {
    name: "job",
    description: "Check a studio job (reel making, steps): waits up to 45 s for it to finish, then reports its status and the end of its output. Without an id, lists recent jobs.",
    schema: { id: { type: "string" } },
    async run(a) {
      if (!a.id) {
        const list = [...jobs.values()].slice(-10).reverse();
        return text(list.length ? list.map((j) => `- ${j.id} ${j.title}: ${j.status}`).join("\n") : "No jobs yet.");
      }
      const job = jobs.get(String(a.id));
      if (!job) throw new Error("No job with that id (jobs are forgotten when Agent Studio restarts).");
      return text(await waitFor(job, 45));
    },
  },
  {
    name: "instagram",
    description: "Read the user's Instagram with igcli (read-only): whoami, stats (plays, likes, comments, reach/saves/shares of recent reels), comments (on recent reels, with ids for replying), guide-requests. account: empty = main account (Lemo-Opuscar films), 'gta' = the GTA 6 clips page. stats/comments are also saved as JSON in Studio\\Instagram\\insights.",
    schema: {
      command: { type: "string", enum: ["whoami", "stats", "comments", "guide-requests"] },
      account: { type: "string" },
      limit: { type: "number", description: "stats: how many recent posts (default 30)" },
      insights: { type: "boolean", description: "stats: include reach/saves/shares (default true)" },
      recent: { type: "number", description: "comments: how many recent posts to look at" },
      unreplied: { type: "boolean", description: "comments: only ones not answered yet" },
      media: { type: "string", description: "comments: only this reel (code or link)" },
    },
    run: igRead,
  },
  {
    name: "instagram_post",
    description: "Post a finished reel from Studio\\Reels\\<folder> (reel.mp4 + caption.txt) to Instagram. The caption is checked first and must be READY (or anyway=true if he said so). Asks the user first in the window, showing the caption; only call it when he asked to post.",
    schema: { folder: { type: "string" }, account: { type: "string", description: "empty = main, gta = GTA page" }, cover: { type: "string", enum: ["auto", "first"] }, anyway: { type: "boolean", description: "only if he said to post although the caption check isn't READY (he sees the verdict in the question)" } },
    async run(a) {
      const name = folderName(a.folder), acct = account(a.account);
      const dir = path.join(reelsWs(), name);
      const video = path.join(dir, "reel.mp4"), capFile = path.join(dir, "caption.txt");
      if (!fs.existsSync(video) || !fs.existsSync(capFile)) throw new Error(`${dir} needs reel.mp4 and caption.txt.`);
      const cap = fs.readFileSync(capFile, "utf8").trim();
      const mb = (fs.statSync(video).size / 1048576).toFixed(1);
      const c = await captionCheck(dir);
      if (c.verdict !== "READY" && !a.anyway) throw new Error(`Not posted: ${checkNote(name, c)}\n${c.report}`);
      const warn = c.verdict === "READY" ? "" : `\n\nCaption check: ${c.verdict} (${c.summary})`;
      await confirm(`Post this reel publicly to Instagram (${acct ? "@" + acct + " account" : "main account"})?\n${name}/reel.mp4 (${mb} MB)${warn}\n\nCaption:\n${cap.slice(0, 900)}`);
      const job = run(PY_IG, igArgs(acct, ["upload-reel", dir, "--caption-file", capFile, "--cover", a.cover === "first" ? "first" : "auto", "--yes"]), { title: `post ${name}` });
      await job.done;
      return text((job.code === 0 ? "Posted.\n" : `Posting failed (exit ${job.code}).\n`) + job.out.slice(-3000));
    },
  },
  {
    name: "instagram_reply",
    description: "Reply publicly to a comment on one of the user's reels (ids from studio_instagram comments). Asks him first in the window.",
    schema: { media: { type: "string", description: "reel code or link" }, comment_id: { type: "string" }, text: { type: "string" }, account: { type: "string" } },
    async run(a) {
      const acct = account(a.account), t = String(a.text || "").trim();
      if (!t || !a.media || !/^\d+$/.test(String(a.comment_id || ""))) throw new Error("media, a numeric comment_id and text are needed");
      await confirm(`Reply publicly on Instagram${acct ? " (@" + acct + ")" : ""} to comment ${a.comment_id} on ${a.media}?\n\n${t}`);
      const job = run(PY_IG, igArgs(acct, ["reply", String(a.media), String(a.comment_id), t, "--yes"]), { title: "reply" });
      await job.done;
      return text((job.code === 0 ? "Replied.\n" : `Reply failed (exit ${job.code}).\n`) + job.out.slice(-2000));
    },
  },
  {
    name: "instagram_dm",
    description: "Send an Instagram direct message from the user's account. Asks him first in the window.",
    schema: { username: { type: "string" }, text: { type: "string" }, account: { type: "string" }, keyword: { type: "string", description: "the guide keyword this answers (optional)" } },
    async run(a) {
      const acct = account(a.account), u = String(a.username || "").replace(/^@/, ""), t = String(a.text || "").trim();
      if (!/^[\w.]{1,30}$/.test(u) || !t) throw new Error("username and text are needed");
      await confirm(`Send this Instagram DM to @${u}${acct ? " from @" + acct : ""}?\n\n${t}`);
      const job = run(PY_IG, igArgs(acct, ["dm", u, t, ...(a.keyword ? ["--keyword", String(a.keyword)] : []), "--yes"]), { title: `dm ${u}` });
      await job.done;
      return text((job.code === 0 ? "Sent.\n" : `DM failed (exit ${job.code}).\n`) + job.out.slice(-2000));
    },
  },
  {
    name: "send_telegram",
    description: "Send a finished reel (Studio\\Reels\\<folder>\\reel.mp4 with its caption) to the user's own Telegram chat, so he can watch it on his phone. Never posts anywhere public.",
    schema: { folder: { type: "string" } },
    async run(a) {
      const name = folderName(a.folder), dir = path.join(reelsWs(), name), video = path.join(dir, "reel.mp4");
      if (!fs.existsSync(video)) throw new Error(`${dir} has no reel.mp4`);
      const cap = path.join(dir, "caption.txt");
      // He sees the caption check's verdict on his phone too, under the caption.
      const c = await captionCheck(dir);
      const tg = path.join(dir, "telegram-caption.txt");
      fs.writeFileSync(tg, (fs.existsSync(cap) ? fs.readFileSync(cap, "utf8").trim() : "(no caption)") + `\n\n— caption check: ${c.verdict}${c.verdict === "READY" ? "" : " (" + c.summary + ")"}`);
      const job = run(PY, [path.join(REELS, "send_telegram.py"), video, tg], { title: `telegram ${name}` });
      await job.done;
      return text((job.code === 0 ? "Sent to his Telegram." : `Sending failed (exit ${job.code}):\n${job.out.slice(-2000)}`) + "\n" + checkNote(name, c));
    },
  },
  {
    name: "frames",
    description: "Make a strip of frames from a reel video so you can look at what is on screen (for analytics or review). Both paths must be inside Studio. Optional times in seconds.",
    schema: { video: { type: "string", description: "e.g. Reels\\<folder>\\reel.mp4 (relative to Studio) or a full path inside Studio" }, out: { type: "string", description: "output .jpg, relative to Studio" }, times: { type: "string", description: "e.g. 1,4,8,15" } },
    async run(a) {
      const inWs = (p) => { const f = path.resolve(workspace(), String(p || "")); if (!f.toLowerCase().startsWith(path.resolve(workspace()).toLowerCase() + "\\")) throw new Error("Paths must be inside " + workspace()); return f; };
      const v = inWs(a.video), o = inWs(a.out || "frames.jpg");
      const times = /^[\d.,]+$/.test(a.times || "") ? [a.times] : [];
      const job = run(PY_IG, [path.join(REELS, "reel_frames.py"), v, o, ...times], { title: "frames" });
      await job.done;
      return text(job.code === 0 ? `Saved ${o}. Look at it with the read tool (if you can see images).\n${job.out.slice(-500)}` : `Failed (exit ${job.code}):\n${job.out.slice(-1500)}`);
    },
  },
];

// Copies kept in the workspace for the agent to read: the analytics playbooks.
function syncWorkspace() {
  try {
    const dir = path.join(igWs(), "insights"); fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(INSIGHTS)) {
      const s = path.join(INSIGHTS, f), d = path.join(dir, f);
      if (!/\.(md|json)$/.test(f)) continue;
      try { if (fs.statSync(d).mtimeMs >= fs.statSync(s).mtimeMs) continue; } catch {}
      fs.copyFileSync(s, d);
    }
    fs.mkdirSync(reelsWs(), { recursive: true });
  } catch (e) { log("sync: " + e.message); }
}

// ---------------------------------------------------------------- MCP (Streamable HTTP, JSON responses)
async function rpc(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  if (method === "initialize")
    return reply({ protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} },
      serverInfo: { name: "agent-studio-studio", version: "1.0.0" },
      instructions: "the user's regular jobs: reels (make, guided steps), Instagram (read, post, reply, DM), Telegram. Posting, replying and DMs ask him first." });
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
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } };
}

async function handleMcp(req, res, raw) {
  if (req.method === "GET") { res.writeHead(405, { allow: "POST" }); return res.end(); }
  if (req.method === "DELETE") { res.writeHead(200); return res.end(); }
  let msg;
  try { msg = JSON.parse(raw); } catch { res.writeHead(400); return res.end(); }
  const out = Array.isArray(msg) ? (await Promise.all(msg.map(rpc))).filter(Boolean) : await rpc(msg);
  if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(out));
}

module.exports = { handleMcp, setAsker, setWorkspace, syncWorkspace, TOOLS, jobs };
