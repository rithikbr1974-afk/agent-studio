// Which skills each Agent Studio agent lists, and the "creator" agent for reels, video and Instagram.
// All ~270 skills live in kit/skills (made by sync-skills.js). Listing them all would send ~44k tokens with
// every request, so each agent lists a short set and reaches the rest through the skill-library index.
const path = require("path");

const KIT_SKILLS = path.join(__dirname, "..", "kit", "skills");

// Every agent: the index plus the general skills.
const CORE = [
  "skill-library", "studio-jobs", "reverse-engineer-anything",
  "docx", "xlsx", "pptx", "pdf", "mcp-builder", "skill-creator", "web-artifacts-builder", "deep-research",
];

// The creator agent also lists everything the regular reel / Instagram work uses.
const CREATOR = [
  "reel", "ig-*", "remotion-best-practices", "remotion-render", "remotion-captions", "explainer-*",
  "motion-broll", "sound-effects", "object-separation", "web-images", "lemo-opuscar", "maquina-cortes-gta",
  "openclip-clip-video", "openclip-caption-video", "social-luma", "social-viral-reverse-engineering",
  "social-trend-jacking", "social-hook-writer",
];

const allow = (names) => Object.fromEntries([["*", "deny"], ...names.map((n) => [n, "allow"])]);

// REA has ~250 tools (~90k tokens of schemas): they are off for every agent (config `tools`) except reverse.
// The studio tools are on only for the creator agent, so the coding agents and subagents stay lean.
const OFF = { "rea_*": false, "studio_*": false };

function agents() {
  return {
    build: { permission: { skill: allow(CORE) } },
    plan: { permission: { skill: allow(CORE) } },
    creator: {
      mode: "primary",
      description: "Reels, short films, clips and Instagram (the user's regular jobs, with the studio tools)",
      permission: { skill: allow([...CORE, ...CREATOR]) },
      tools: { "studio_*": true },
    },
    reverse: {
      mode: "primary",
      description: "Reverse engineering with REA (binaries, APKs, web bundles, Electron apps) - big toolset, use a model with a long context",
      permission: { skill: allow([...CORE, "social-viral-reverse-engineering"]) },
      tools: { "rea_*": true },
    },
  };
}

module.exports = { KIT_SKILLS, agents, OFF, CORE, CREATOR };
