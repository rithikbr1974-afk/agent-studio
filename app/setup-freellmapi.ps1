# Installs FreeLLMAPI (github.com/tashfeenahmed/freellmapi, MIT), Agent Studio's second gateway, into vendor\freellmapi:
# shallow clone, npm install, build, and a .env with a random encryption key, bound to this PC only (127.0.0.1:3001).
# Re-running updates the code (git pull) and rebuilds; the .env and its data (server\data) are kept.
# Usage: powershell -ExecutionPolicy Bypass -File app\setup-freellmapi.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$dir = Join-Path $root "vendor\freellmapi"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git is needed: winget install Git.Git" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 20-24 is needed." }

if (Test-Path (Join-Path $dir ".git")) {
    Write-Host "Updating $dir"; git -C $dir pull --ff-only
} else {
    New-Item -ItemType Directory -Force (Split-Path $dir) | Out-Null
    Write-Host "Cloning into $dir"; git clone --depth 1 https://github.com/tashfeenahmed/freellmapi.git $dir
}
if ($LASTEXITCODE) { throw "git failed." }

Push-Location $dir
try {
    if (-not (Test-Path ".env")) {   # written by Node: PowerShell 5.1 would add a byte-order mark
        node -e "require('fs').writeFileSync('.env','ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('hex')+'\nPORT=3001\nHOST=127.0.0.1\nNODE_ENV=production\n')"
        Write-Host ".env written (random encryption key; keep this file: provider keys can't be read without it)"
    }
    Write-Host "npm install (about 3 minutes)"; npm install --no-audit --no-fund; if ($LASTEXITCODE) { throw "npm install failed." }
    Write-Host "npm run build (about 3 minutes)"; npm run build; if ($LASTEXITCODE) { throw "npm run build failed." }
} finally { Pop-Location }
Write-Host "`nDone. Agent Studio starts FreeLLMAPI from now on. First time: open http://127.0.0.1:3001, create your"
Write-Host "account, add provider keys on its Keys page, then in Agent Studio: Settings > FreeLLMAPI gateway > paste the"
Write-Host "unified key > Sync FreeLLMAPI models."
