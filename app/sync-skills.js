// Copies every skill Claude has on this PC into kit/skills, where Agent Studio's OpenCode finds them
// (config `skills.paths`). Run again after adding or updating skills: node app/sync-skills.js
//
// Sources: your own skills (~/.claude/skills), the Anthropic skills synced from your account, the plugins
// installed in Claude Code (gamedev, Lemo-Opuscar) and the plugins synced to the Claude app (social media,
// data, design, openclip, instagram, pdf viewer). Plugin skills get the plugin's name in front
// (social-luma, gamedev-godot-physics) so no two skills share a name.
//
// Paths in the copies are rewritten so the sandboxed agent can follow them: ~/.claude/skills -> kit/skills,
// ~/.claude/instagram -> <AI agent folder>/Studio/instagram (writable), plugin placeholders -> real folders.
const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.userInfo().homedir;
const CLAUDE = path.join(HOME, ".claude");
const KIT = path.join(__dirname, "..", "kit");
const OUT = path.join(KIT, "skills");
const STATE = path.join(__dirname, "..", "data", "studio.json");
let agentRoot = "E:\\AI agent folder";
try { agentRoot = JSON.parse(fs.readFileSync(STATE, "utf8")).agentRoot || agentRoot; } catch {}
const IG_DATA = path.join(agentRoot, "Studio", "instagram");

const fwd = (p) => p.replace(/\\/g, "/");
const TEXT = new Set([".md", ".py", ".js", ".mjs", ".ts", ".tsx", ".json", ".txt", ".yaml", ".yml", ".sh", ".ps1", ".html", ".css"]);

// [source folder, prefix ("" = keep the name)] for each place skills live
function sources() {
  const list = [];
  const own = path.join(CLAUDE, "skills");
  for (const d of safeDirs(own)) if (d !== "synced") list.push({ dir: path.join(own, d), prefix: "", plugin: "" });
  for (const acct of safeDirs(path.join(own, "synced")))
    for (const d of safeDirs(path.join(own, "synced", acct))) list.push({ dir: path.join(own, "synced", acct, d), prefix: "", plugin: "" });

  // Claude Code plugins that are installed (installed_plugins.json), not every cached one
  let installed = {};
  try { installed = JSON.parse(fs.readFileSync(path.join(CLAUDE, "plugins", "installed_plugins.json"), "utf8")).plugins || {}; } catch {}
  for (const [id, versions] of Object.entries(installed)) {
    const v = versions[versions.length - 1]; if (!v) continue;
    pluginSkills(v.installPath, id.split("@")[0], list);
  }
  // Plugins synced to the Claude desktop app from claude.ai
  const rpm = path.join(HOME, "AppData", "Local", "Claude-Data");
  for (const app of safeDirs(rpm)) {
    const base = path.join(rpm, app, "rpm");
    for (const a of safeDirs(base)) for (const b of safeDirs(path.join(base, a))) for (const p of safeDirs(path.join(base, a, b))) {
      const root = path.join(base, a, b, p);
      let name = p;
      try { name = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8")).name || p; } catch {}
      pluginSkills(root, name, list);
    }
  }
  return list;
}

const SHORT = { "social-media-skills": "social" };
function pluginSkills(root, name, list) {
  // skills/<name>/SKILL.md, or grouped deeper (gamedev: skills/engines/godot/<name>), plus a top-level router/
  const found = [];
  const walk = (d, depth) => {
    for (const e of safeDirs(d)) {
      const p = path.join(d, e);
      if (fs.existsSync(path.join(p, "SKILL.md"))) found.push(p);
      else if (depth < 3) walk(p, depth + 1);
    }
  };
  walk(path.join(root, "skills"), 0);
  for (const e of safeDirs(root)) if (e !== "skills" && fs.existsSync(path.join(root, e, "SKILL.md"))) found.push(path.join(root, e));
  for (const p of found) {
    const d = path.basename(p);
    // a plugin whose only skill has the plugin's own name keeps it (lemo-opuscar)
    const prefix = d === name ? "" : (SHORT[name] || name) + "-";
    list.push({ dir: p, prefix, plugin: root });
  }
}

function safeDirs(d) {
  try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
}

const clean = (s) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

function rewrite(text, src, dest, plugin) {
  let t = text
    .replace(/~\/\.claude\/skills\//g, fwd(OUT) + "/")
    .replace(/~\/\.claude\/instagram/g, fwd(IG_DATA))
    .replace(/\$\{?CLAUDE_SKILL_DIR\}?/g, fwd(dest));
  if (plugin) t = t.replace(/\$\{?CLAUDE_PLUGIN_ROOT\}?/g, fwd(plugin));
  return t;
}

function copyDir(src, dest, ctx) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === "__pycache__" || e.name === "node_modules" || e.name === ".git") continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d, ctx);
    else if (e.isFile()) {
      if (TEXT.has(path.extname(e.name).toLowerCase())) fs.writeFileSync(d, rewrite(fs.readFileSync(s, "utf8"), s, ctx.dest, ctx.plugin));
      else fs.copyFileSync(s, d);
    }
  }
}

// A skill's name is its folder name; OpenCode wants the frontmatter `name:` to match it.
function fixName(file, name) {
  let t = fs.readFileSync(file, "utf8");
  if (!t.startsWith("---")) t = `---\nname: ${name}\ndescription: ${name}\n---\n\n` + t;
  else if (/^name:.*$/m.test(t.split(/^---\s*$/m)[1] || "")) t = t.replace(/^name:.*$/m, `name: ${name}`);
  else t = t.replace(/^---\s*\n/, `---\nname: ${name}\n`);
  fs.writeFileSync(file, t);
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(IG_DATA, { recursive: true });
  // the ig-* skills keep your voice notes and swipe files here: copy what's there once, never overwrite
  for (const f of safeFiles(path.join(CLAUDE, "instagram")))
    if (!fs.existsSync(path.join(IG_DATA, f))) fs.copyFileSync(path.join(CLAUDE, "instagram", f), path.join(IG_DATA, f));

  const seen = new Map(), index = [];
  for (const s of sources()) {
    if (!fs.existsSync(path.join(s.dir, "SKILL.md"))) continue;
    let name = clean(s.prefix + path.basename(s.dir));
    if (seen.has(name)) { log(`skipped duplicate ${name} (${s.dir}; kept ${seen.get(name)})`); continue; }
    seen.set(name, s.dir);
    const dest = path.join(OUT, name);
    copyDir(s.dir, dest, { dest, plugin: s.plugin });
    fixName(path.join(dest, "SKILL.md"), name);
    const fm = (fs.readFileSync(path.join(dest, "SKILL.md"), "utf8").split(/^---\s*$/m)[1] || "");
    index.push({ name, from: s.dir, chars: fm.length });
  }
  fs.writeFileSync(path.join(KIT, "skills-index.json"), JSON.stringify(index, null, 1));
  writeLibrary(index);
  const chars = index.reduce((a, b) => a + b.chars, 0);
  log(`${index.length} skills in ${OUT} (~${Math.round(chars / 4)} tokens of names + descriptions)`);
}

// Listing all ~270 skills to the model costs ~44k tokens a request, so each agent lists only its own few
// (app/kit.js) and this one skill holds a one-line index of all of them, read only when needed (~5k tokens).
const GROUPS = [
  ["Reels, video and Instagram", /^(reel|ig-|remotion-|explainer-|motion-broll|sound-effects|object-separation|web-images|lemo-opuscar|maquina-cortes|openclip-|instagram-)/],
  ["Social media (all platforms)", /^social-/],
  ["Game development", /^(gamedev-|unity-)/],
  ["Data", /^data-/],
  ["Design", /^design-/],
  ["Documents, research and building", /./],
];
const CLAUDE_ONLY = /^(built-in-browser|chrome-browser|computer-use|docs|google-workspace|morning|import-memory|consolidate-memory|setup-claude|explain-usage|learn|instagram-access|instagram-configure|pdf-viewer-)/;

function short(desc) {
  let d = desc.replace(/\s+/g, " ").replace(/^['">|-]+\s*/, "").trim();
  const cut = d.search(/(?<=[a-z0-9)])\.\s/i);
  if (cut > 20) d = d.slice(0, cut);
  return d.length > 110 ? d.slice(0, 107).replace(/\s\S*$/, "") + "…" : d;
}

function writeLibrary(index) {
  const lines = [
    "---",
    "name: skill-library",
    "description: Index of every skill on this PC (reels, Instagram, video, social media, game dev, data, design, documents, reverse engineering). Load it when a task might have a skill you don't see in your list.",
    "---",
    "",
    "# Skill library",
    "",
    `Every skill is a folder in \`${fwd(OUT)}/<name>/\`. To use one, read its \`SKILL.md\` with the read tool and`,
    "follow it; read the other files it points to the same way. Skills were written for Claude Code, so translate:",
    "- \"Bash\" / shell commands: your PowerShell shell (Windows PowerShell 5.1).",
    "- \"Skill tool\" / \"/name\": load the skill here or read its SKILL.md.",
    "- Claude's built-in browser / computer use: the pc_* tools (screen_read, click, type_text, open_url…).",
    "- Paths under the Karen folder (KAREN_DIR) (the reel pipeline, igcli): don't run them yourself; use the studio_* tools,",
    "  which run them outside the sandbox (see the studio-jobs skill).",
    "- Artifacts, Claude Docs, connectors (Gmail, Drive, Canva…): not available here; write a file instead.",
    "",
    "Skills marked (Claude app only) need Claude's own tools; use them only as reading material.",
    "",
  ];
  const done = new Set();
  for (const [title, re] of GROUPS) {
    const rows = index.filter((s) => !done.has(s.name) && re.test(s.name));
    if (!rows.length) continue;
    lines.push(`## ${title}`, "");
    for (const s of rows) {
      done.add(s.name);
      const fm = fs.readFileSync(path.join(OUT, s.name, "SKILL.md"), "utf8").split(/^---\s*$/m)[1] || "";
      const m = /^description:\s*([\s\S]*?)(?=^\w[\w-]*:|$(?![\s\S]))/m.exec(fm);
      const desc = m ? m[1].split(/\r?\n/).map((l) => l.trim()).join(" ") : s.name;
      lines.push(`- \`${s.name}\`${CLAUDE_ONLY.test(s.name) ? " (Claude app only)" : ""}: ${short(desc)}`);
    }
    lines.push("");
  }
  const dir = path.join(OUT, "skill-library");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), lines.join("\n"));
  const studio = path.join(__dirname, "kit-skills");   // Agent Studio's own skills (studio-jobs), kept in git
  for (const d of safeDirs(studio)) copyDir(path.join(studio, d), path.join(OUT, d), { dest: path.join(OUT, d), plugin: "" });
}

function safeFiles(d) { try { return fs.readdirSync(d).filter((f) => fs.statSync(path.join(d, f)).isFile()); } catch { return []; } }
function log(m) { console.log(m); }

if (require.main === module) main();
module.exports = { main, OUT, KIT };
