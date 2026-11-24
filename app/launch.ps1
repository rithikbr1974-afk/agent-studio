# Opens Agent Studio: starts the OmniRoute and FreeLLMAPI gateways and the Agent Studio server if they aren't running,
# then opens a window (Edge in app mode, its own profile) signed in with a one-time code.
# Usage: launch.ps1 [-Folder <path>]   (Run Agent passes the folder you right-clicked)
param([string]$Folder = "")
$ErrorActionPreference = "Stop"
$app = $PSScriptRoot
$root = Split-Path $app -Parent
$logs = Join-Path $root "logs"
New-Item -ItemType Directory -Force $logs | Out-Null

# Some launches arrived without the user folder variables, so nothing could find OpenCode. Fill them in from
# Windows itself (the account's known folders), never from what this process happened to inherit.
foreach ($v in @(@("APPDATA", "ApplicationData"), @("LOCALAPPDATA", "LocalApplicationData"), @("USERPROFILE", "UserProfile"))) {
    if (-not [Environment]::GetEnvironmentVariable($v[0])) {
        [Environment]::SetEnvironmentVariable($v[0], [Environment]::GetFolderPath($v[1]))
    }
}
$env:Path = "$env:APPDATA\npm;$env:Path"

# One launch at a time: a double click used to start two servers that fought over OpenCode's port.
$lock = New-Object System.Threading.Mutex($false, "Local\AgentStudioLaunch")
try { $null = $lock.WaitOne(120000) } catch [System.Threading.AbandonedMutexException] {}

function Up($url) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $url | Out-Null; $true } catch { $_.Exception.Response -ne $null } }

if (-not (Up "http://127.0.0.1:20128/api/monitoring/health")) {
    Start-Process cmd.exe -ArgumentList "/c omniroute serve > `"$logs\omniroute.log`" 2>&1" -WindowStyle Hidden
}

# FreeLLMAPI, the second gateway (vendor\freellmapi, port 3001, this PC only via its .env). Not waited for:
# it takes ~25 s to start, and the window shows when it's up.
$free = Join-Path $root "vendor\freellmapi"
if ((Test-Path (Join-Path $free "server\dist\index.js")) -and -not (Up "http://127.0.0.1:3001/livez")) {
    Start-Process cmd.exe -ArgumentList "/c node server\dist\index.js > `"$logs\freellmapi.log`" 2>&1" -WindowStyle Hidden -WorkingDirectory $free
}

$codeFile = Join-Path $root "data\launch-code"
if (-not (Up "http://127.0.0.1:4321/")) {
    Remove-Item (Join-Path $logs "startup-error.txt") -ErrorAction SilentlyContinue
    Start-Process cmd.exe -ArgumentList "/c node `"$app\server.js`" > `"$logs\studio.log`" 2>&1" -WindowStyle Hidden -WorkingDirectory $root
    for ($i = 0; $i -lt 120 -and -not (Up "http://127.0.0.1:4321/"); $i++) {
        if (Test-Path (Join-Path $logs "startup-error.txt")) { break }
        Start-Sleep -Milliseconds 500
    }
}
if (-not (Up "http://127.0.0.1:4321/")) {
    $why = Get-Content (Join-Path $logs "startup-error.txt") -ErrorAction SilentlyContinue
    if (-not $why) { $why = "The server didn't start. See $logs\studio.log" }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("Agent Studio couldn't start.`n`n$why", "Agent Studio") | Out-Null
    exit 1
}

$code = (Get-Content $codeFile -Raw).Trim()
$url = "http://127.0.0.1:4321/?code=$code"
if ($Folder) { $url += "&folder=" + [uri]::EscapeDataString($Folder.TrimEnd('\') + $(if ($Folder -match '^[A-Za-z]:\\?$') { '\' } else { '' })) }
$profile = Join-Path $env:LOCALAPPDATA "AgentStudio\edge"
Start-Process msedge -ArgumentList "--app=$url", "--user-data-dir=`"$profile`"", "--no-first-run", "--no-default-browser-check", "--window-size=1440,900"
