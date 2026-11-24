# Opens plain OpenCode (its own terminal app, not Agent Studio's window) in a folder.
# This is the normal, unsandboxed OpenCode: it can work anywhere you point it, like typing `opencode` yourself.
# It gets the same skills as Agent Studio (kit\skills, short lists per agent + the skill-library index).
# Usage: OpenCode.ps1 [folder]     (default: the AI agent folder)
param([string]$Folder = "")
$app = $PSScriptRoot
$root = Split-Path $app -Parent
$host.UI.RawUI.WindowTitle = "OpenCode"

if (-not $Folder) {
    $Folder = "E:\AI agent folder"
    try { $s = Get-Content (Join-Path $root "data\studio.json") -Raw | ConvertFrom-Json; if ($s.agentRoot) { $Folder = $s.agentRoot } } catch {}
}
if (-not (Test-Path $Folder -PathType Container)) { $Folder = $env:USERPROFILE }

$oc = Join-Path $env:APPDATA "npm\opencode.cmd"
if (-not (Test-Path $oc)) { $oc = (Get-Command opencode -ErrorAction SilentlyContinue).Source }
if (-not $oc) { Write-Host "OpenCode isn't installed. Run: npm i -g opencode-ai@1.19.5"; Read-Host "Press Enter to close"; exit 1 }

# Skills: the same kit as Agent Studio (the copies have their names and paths fixed, so Claude Code's own
# ~/.claude/skills aren't read twice).
try {
    $env:OPENCODE_CONFIG_CONTENT = & node -e "const k=require(process.argv[1]);const a=k.agents();for(const n of Object.keys(a)){delete a[n].tools}delete a.reverse;process.stdout.write(JSON.stringify({skills:{paths:[k.KIT_SKILLS]},agent:a}))" (Join-Path $app "kit.js")
    $env:OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1"
} catch {}

Set-Location -LiteralPath $Folder
& $oc
