# Agent Studio

A desktop-style coding agent for Windows, built from free and open-source parts:

| Part | Role |
|---|---|
| **OpenCode** 1.19.5 (`opencode serve`, port 4097, sandboxed) | The agent: reads, edits, runs commands, tracks tasks, asks before risky steps |
| **OmniRoute** 3.8.52 (port 20128, this PC only) | Gateway: one endpoint for all your free provider keys, auto-fallback when one runs out |
| **FreeLLMAPI** (`vendor/freellmapi`, port 3001, this PC only) | Second gateway ([tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi), MIT): 87 free providers, smart routing, `fusion` |
| **Agent Studio** (`app/`, port 4321) | The window: sessions, conversation, changes / files / terminal panes, connectors, settings |

## Install (once, no admin needed)

Double-click **`Install.bat`**. It:

- creates **`E:\AI agent folder`**, the only place the agent can change anything (another place:
  `Install.bat -AgentRoot "D:\Some folder"`);
- builds two small helpers with the C# compiler built into Windows (`app/sandbox/lowrun.exe`, `app/pc/pchelper.exe`);
- adds **Agent Studio** to the Start menu and Desktop, an **AI agent folder** shortcut on the Desktop, and
  **Run Agent** when you right-click a folder in Explorer (Windows 11: right-click → *Show more options*).

Uninstall the menu and shortcuts: `Install.bat -Remove` (your files stay).

## Opening it

- **Start menu / Desktop → Agent Studio**: opens its own window (Edge app mode, its own profile) on your last
  project.
- **Right-click a folder → Run Agent**: a folder inside the AI agent folder opens directly. A folder anywhere
  else is **copied in** (after you say so) and the copy opens; your original is never changed.
- The server stops by itself 15 minutes after the last window closes. Logs go to `logs/`.
- **Start menu / Desktop → OpenCode**: plain OpenCode on its own (its terminal app, in the AI agent folder).
  This one is **not sandboxed**: it works like typing `opencode` yourself. It gets the same skills.

## Skills, agents and regular jobs

- **Skills:** every skill Claude has on this PC (~270: your own, the Anthropic ones, gamedev, Lemo-Opuscar,
  social media, data, design, openclip, instagram) is copied into `kit/skills` by `node app/sync-skills.js`
  (also run automatically the first time). Run it again after adding or updating a skill. Plugin skills get the
  plugin's name in front (`social-luma`, `gamedev-godot-physics`). The copies are git-ignored.
- **Low token use:** each agent lists only a short set of skills; the `skill-library` skill is a one-line index
  of all of them that the agent reads when it needs another one. Measured: build ~12k tokens a request,
  creator ~19k (listing everything would be ~118k).
- **Agents** (the switcher under the message box):
  - **Build / Plan**: coding, documents, research.
  - **Creator**: reels, films, clips, Instagram. Has the `studio_*` tools and the reel / ig-* / remotion /
    Lemo-Opuscar / sound skills.
  - **Reverse**: reverse engineering with REA (~250 tools, so only this agent has them; use a long-context model).
- **Regular jobs** (sidebar): today's reel, a reel about a topic, guided reel, doodle explainer, post a reel,
  check analytics, check comments, plan the week, Lemo-Opuscar film, GTA clips, reverse engineer, find a skill.
- **Studio tools** (`app/studio.js`): Karen's reel pipeline and igcli live in the Karen folder (`KAREN_DIR`), outside the sandbox,
  so Agent Studio runs them for the agent with fixed commands only. Reels are mirrored into
  `<AI agent folder>\Studio\Reels\<name>`, Instagram stats and playbooks into `Studio\Instagram\insights`.
  Posting, replying and DMs ask you first in the window (Allow / Don't allow). Log: `logs/studio_jobs.log`.
- The agent may *read* `kit\skills` and the Lemo-Opuscar library (`%USERPROFILE%\lemo-opuscar`) but can't change
  them (Windows keeps them out of the sandbox).

## What the agent can and can't do

- **Write** only inside the AI agent folder. OpenCode runs at Windows' *Low* integrity level (like a browser
  sandbox), so Windows itself refuses writes anywhere else: your other folders, `C:\Windows`, Program Files,
  drivers, the registry and system settings. Tested: writes to the Desktop, `C:\` and this app's folder were
  all denied.
- **Read** outside the folder is blocked by OpenCode's rules (its file tools and its shell check). Windows
  doesn't block reads at Low level, so this part relies on OpenCode, not the OS. Agent Studio's own settings
  (`data/`) are unreadable from the sandbox.
- **Shell:** Windows PowerShell (Git Bash can't run sandboxed). git, node, npm and Python work. Temp files and
  package caches go to `%USERPROFILE%\AppData\LocalLow\AgentStudio`.
- **PC control** (like Claude's computer use): the `pc_*` tools read windows by name (UI Automation), take
  screenshots, click, type, scroll, press keys, open Start-menu apps and web pages. They run in Agent Studio's
  server, not the sandbox, and every action is logged to `logs/pc_actions.log`.
  - **Never allowed:** terminals and shells, code editors, Explorer, Task Manager, Device Manager, Registry
    Editor, Settings, Control Panel, installers, other AI agents, Agent Studio itself, the Windows key and
    system shortcuts, `file://` and local addresses.
  - **Asks you first** (Allow once / Don't allow in the window; no answer in 2 minutes = no): clicks on
    send / buy / pay / delete / install / download / sign out / submit…, closing a window, Alt+F4, and Enter
    in messaging apps (WhatsApp, Telegram, Teams, Outlook, Gmail…).
  - **Emergency stop:** move the mouse into the top-left corner of the screen; every PC action refuses until
    you move it away.
  - Only the sandboxed agent has the key to these tools, and only a window opened by the launcher can answer
    its questions, so the agent can't approve itself.
- **Local models** (the SD card's llama.cpp on port 8080) only answer while the card is plugged in and
  START-CHAT is running; otherwise pick a free model (GLM-5.3-Flash Free, DeepSeek V4.1 Flash Free).

## First-time setup

1. **OmniRoute dashboard:** http://127.0.0.1:20128/dashboard. Sign in with the default password `CHANGEME`
   and **change it straight away** (Settings).
2. **Add provider keys** in the dashboard (Providers). Free ones:

   | Provider | Where to get the key |
   |---|---|
   | Google Gemini | aistudio.google.com/apikey |
   | Groq | console.groq.com/keys |
   | OpenRouter (`:free` models) | openrouter.ai/keys |
   | Cerebras | cloud.cerebras.ai → API Keys |
   | Mistral (Codestral) | console.mistral.ai → Experiment plan → API Keys |
   | GitHub Models | github.com/settings/tokens → fine-grained, `models: read` |
   | NVIDIA NIM | build.nvidia.com → Get API Key |
   | Hugging Face | huggingface.co/settings/tokens |
   | SambaNova | cloud.sambanova.ai → API Keys |
   | Z.ai (GLM) | z.ai → API Keys |
   | Cloudflare Workers AI | dash.cloudflare.com → AI → Workers AI (account ID + token) |

   Free tiers change often, and some (Gemini free, Mistral Experiment) may use your prompts. Never let the
   agent read `.env` files or secrets.
3. **Create an OmniRoute key** (dashboard → **API Manager**, http://127.0.0.1:20128/dashboard/api-manager),
   paste it in Agent Studio → Settings → Gateway, and
   press **Sync gateway models**. Every model behind your keys then shows up in the model menu, plus the
   `auto/coding`, `auto/fast`… routes that switch provider automatically.

OpenCode's own free models (GLM-5.3-Flash Free, DeepSeek V4.1 Flash Free, Big Pickle…) work with no key at
all. GLM-5.3-Flash Free and DeepSeek V4.1 Flash Free don't keep your data.

### FreeLLMAPI (second gateway, optional)

Runs next to OmniRoute; the launcher starts it (hidden, ~25 s) when `vendor\freellmapi` is built. Install or
update it with `powershell -ExecutionPolicy Bypass -File app\setup-freellmapi.ps1` (git clone, npm install,
build, a `.env` with a random encryption key and `HOST=127.0.0.1`). `vendor/` is not in this repo.

1. Open http://127.0.0.1:3001 and **create your account** (first run only).
2. **Keys** page: add provider keys (same free providers as above; it knows 87). Order the **Fallback Chain**.
3. Copy the **unified key** (top of the Keys page, `freellmapi-…`), paste it in Agent Studio → Settings →
   *FreeLLMAPI gateway* and press **Sync FreeLLMAPI models**. The menu gets `auto` (its router picks),
   `fusion` (several models answer, one merges; slow), your `auto:<chain>` profiles and every model your keys
   unlock. Sync again after adding keys.

Notes: it checks `api.freellmapi.co` twice a day for model catalog updates (free installs get the monthly
snapshot). Provider keys are encrypted in `vendor\freellmapi\server\data`; keep its `.env`, or they can't be
read. Its log is `logs\freellmapi.log`. The top bar shows "Gateways on" when both run (hover for which).

## Paid models later

Settings → *Add any OpenAI-compatible provider*: ID, base URL, model names and key. Or add the provider in
OmniRoute's (or FreeLLMAPI's) dashboard and sync. Nothing else changes.

## Using it

- **Build / Plan** (Shift+Tab): Plan only reads and proposes; Build makes the changes.
- **@file** attaches a file, **/** lists commands (`/init` writes AGENTS.md, `/undo`, `/redo`, `/compact`, `/new`).
- Hover a message of yours: **Undo from here** (reverts its file changes too) or **Fork** into a new session.
- **Changes** pane: every uncommitted change in the project. **Files**: browse and add a file to the chat.
  **Terminal**: a real shell in the project; **+ Agent** opens another coding agent there.
- **Connectors**: MCP servers (docs lookup, browser, GitHub…), with one-click presets.
- Shortcuts: Ctrl+N new session, Ctrl+B sidebar, Ctrl+J terminal, Ctrl+K search sessions, Esc stop.

- The **Terminal** pane and **+ Agent** run inside the same sandbox as the agent.
