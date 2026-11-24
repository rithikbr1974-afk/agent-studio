# One-time setup for Agent Studio (safe to run again). No admin rights needed.
#  - builds sandbox\lowrun.exe and pc\pchelper.exe with the C# compiler that ships with Windows
#  - creates the AI agent folder and labels it Low, so the sandboxed agent can write there and only there
#  - labels OpenCode's own data folders Low (it keeps its sessions there) and makes Low temp/cache folders
#  - makes the icon, the Start menu and Desktop shortcuts, and "Run Agent" on folders in Explorer
# Usage: install.ps1 [-AgentRoot "E:\AI agent folder"]    uninstall: install.ps1 -Remove
param([string]$AgentRoot = "E:\AI agent folder", [switch]$Remove)
$ErrorActionPreference = "Stop"
$app = $PSScriptRoot
$root = Split-Path $app -Parent
$me = $env:USERNAME
$menuKeys = "HKCU:\Software\Classes\Directory\shell\AgentStudio", "HKCU:\Software\Classes\Directory\Background\shell\AgentStudio"
$startLnk = Join-Path ([Environment]::GetFolderPath("Programs")) "Agent Studio.lnk"
$deskLnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "Agent Studio.lnk"
$folderLnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "AI agent folder.lnk"
$ocStartLnk = Join-Path ([Environment]::GetFolderPath("Programs")) "OpenCode.lnk"
$ocDeskLnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "OpenCode.lnk"

if ($Remove) {
    foreach ($k in $menuKeys) { if (Test-Path $k) { Remove-Item $k -Recurse -Force } }
    foreach ($l in $startLnk, $deskLnk, $folderLnk, $ocStartLnk, $ocDeskLnk) { if (Test-Path $l) { Remove-Item $l -Force } }
    Write-Host "Removed the Run Agent menu and the shortcuts. The AI agent folder and its files are kept."
    exit 0
}

function Step($t) { Write-Host "- $t" }

# 1. Helpers
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "The .NET Framework 4 compiler wasn't found ($csc)." }
foreach ($b in "$app\sandbox\build.cmd", "$app\pc\build.cmd") {
    & cmd.exe /c "`"$b`""
    if ($LASTEXITCODE) { throw "Building $b failed." }
}
Step "built lowrun.exe and pchelper.exe"

# 2. The AI agent folder: your account gets full control (needed to set the label), then the Low label.
New-Item -ItemType Directory -Force $AgentRoot | Out-Null
function LabelLow($dir) {
    New-Item -ItemType Directory -Force $dir | Out-Null
    icacls $dir /grant "${me}:(OI)(CI)F" /Q | Out-Null
    $r = icacls $dir /setintegritylevel "(OI)(CI)low" /T /C /Q 2>&1 | Select-Object -Last 1
    if ($r -notmatch "Failed processing 0 files") { Write-Warning "$dir : $r" }
}
LabelLow $AgentRoot
Step "AI agent folder ready: $AgentRoot"

# 3. OpenCode's own folders and the sandbox's temp/caches
$h = $env:USERPROFILE
foreach ($d in "$h\.config\opencode", "$h\.local\share\opencode", "$h\.local\state\opencode", "$h\.cache\opencode") { LabelLow $d }
foreach ($d in "temp", "npm-cache", "pip-cache", "uv-cache", "pycache") { New-Item -ItemType Directory -Force "$h\AppData\LocalLow\AgentStudio\$d" | Out-Null }
Step "OpenCode's data folders labelled for the sandbox"

# 4. Settings: remember the folder
$data = Join-Path $root "data"
New-Item -ItemType Directory -Force $data | Out-Null
$stateFile = Join-Path $data "studio.json"
$state = if (Test-Path $stateFile) { Get-Content $stateFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$state | Add-Member -Force agentRoot $AgentRoot
[IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json -Depth 5))   # UTF-8 without a BOM (Node's JSON.parse rejects one)
icacls $data /grant "${me}:(OI)(CI)F" /Q | Out-Null   # full control is needed to change the label
& "$app\sandbox\lowrun.exe" --protect $data
if ($LASTEXITCODE) { throw "Protecting $data failed." }
Step "settings saved (data\ is unreadable from the sandbox)"

# 5. Icon: public\logo.png (512 px, rounded) scaled to each size, PNG images inside an .ico
Add-Type -AssemblyName System.Drawing
$ico = Join-Path $app "agent-studio.ico"
$logo = [System.Drawing.Image]::FromFile((Join-Path $app "public\logo.png"))
$pngs = foreach ($s in 16, 20, 24, 32, 40, 48, 64, 256) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = "HighQualityBicubic"; $g.PixelOffsetMode = "HighQuality"; $g.SmoothingMode = "AntiAlias"
    $g.DrawImage($logo, 0, 0, $s, $s)
    $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
    , @($s, $ms.ToArray())
}
$logo.Dispose()
$out = New-Object System.IO.MemoryStream; $w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
foreach ($e in $pngs) {
    $sz = $e[0]; $bytes = $e[1]
    $w.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz }))); $w.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
    $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$bytes.Length); $w.Write([uint32]$offset); $offset += $bytes.Length
}
foreach ($e in $pngs) { $w.Write([byte[]]$e[1]) }
[IO.File]::WriteAllBytes($ico, $out.ToArray())
Step "icon made"

# 6. Shortcuts and the Explorer menu
$vbs = Join-Path $app "AgentStudio.vbs"
$wsh = New-Object -ComObject WScript.Shell
function Lnk($path, $target, $arguments, $icon, $desc) {
    $l = $wsh.CreateShortcut($path); $l.TargetPath = $target; $l.Arguments = $arguments; $l.IconLocation = $icon
    $l.Description = $desc; $l.WorkingDirectory = $root; $l.Save()
}
$wscript = "$env:WINDIR\System32\wscript.exe"
Lnk $startLnk $wscript "`"$vbs`"" "$ico,0" "Agent Studio: a coding and PC agent that works in your AI agent folder"
Lnk $deskLnk $wscript "`"$vbs`"" "$ico,0" "Agent Studio"
Lnk $folderLnk $AgentRoot "" "$env:WINDIR\System32\imageres.dll,3" "The only folder Agent Studio's agent can change"
foreach ($k in $menuKeys) {
    New-Item -Force $k | Out-Null
    Set-ItemProperty $k -Name "(default)" -Value "Run Agent"
    Set-ItemProperty $k -Name "Icon" -Value $ico
    New-Item -Force "$k\command" | Out-Null
    Set-ItemProperty "$k\command" -Name "(default)" -Value "`"$wscript`" `"$vbs`" `"%V`""
}
# OpenCode on its own (its terminal app, unsandboxed, same skills): separate Start menu + Desktop shortcuts
$ps = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$ocExe = Join-Path $env:APPDATA "npm\node_modules\opencode-ai\bin\opencode.exe"
$ocIcon = if (Test-Path $ocExe) { "$ocExe,0" } else { "$ps,0" }
$ocArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$app\OpenCode.ps1`""
Lnk $ocStartLnk $ps $ocArgs $ocIcon "OpenCode on its own, in the AI agent folder (not sandboxed)"
Lnk $ocDeskLnk $ps $ocArgs $ocIcon "OpenCode"
Step "Start menu + Desktop shortcuts (Agent Studio, OpenCode), and Run Agent on folders (Windows 11: right-click > Show more options)"
Write-Host "`nDone. Open Agent Studio from the Start menu, or right-click a folder > Run Agent."
