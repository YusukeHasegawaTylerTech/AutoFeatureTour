<#
.SYNOPSIS
  One-time setup for AutoFeatureTour on a clean Windows machine.

.DESCRIPTION
  Installs (via winget, if missing): Node.js LTS (22+), ffmpeg/ffprobe.
  Then runs npm install, installs Playwright's Chromium, optionally links the `aft` command,
  and verifies everything (including a Windows SAPI voice for narration).

  Safe to re-run: anything already present is skipped.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Link      # also make `aft` available globally
#>
param(
  [switch]$Link,        # run `npm link` so `aft` works from any folder
  [switch]$SkipWinget   # don't install system tools, only check them
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    !!  $msg" -ForegroundColor Yellow }

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Winget-Install($id, $name) {
  if ($SkipWinget) { throw "$name is missing. Install it manually (winget install $id) or re-run without -SkipWinget." }
  if (-not (Has 'winget')) { throw "winget not found. Install 'App Installer' from the Microsoft Store, or install $name manually." }
  Write-Host "    installing $name ($id)..."
  winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {  # -1978335189 = already installed
    throw "winget failed to install $name (exit $LASTEXITCODE)."
  }
  Refresh-Path
}

# --- Node.js 22+ -------------------------------------------------------------
Step 'Node.js 22+'
$needNode = $true
if (Has 'node') {
  $major = [int]((node --version).TrimStart('v').Split('.')[0])
  if ($major -ge 22) { $needNode = $false; Ok "node $(node --version)" }
  else { Warn "node $(node --version) is too old (need 22+); upgrading" }
}
if ($needNode) {
  Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js LTS'
  if (-not (Has 'node')) { throw 'Node installed but not on PATH yet. Open a new terminal and re-run this script.' }
  Ok "node $(node --version)"
}

# --- ffmpeg / ffprobe --------------------------------------------------------
Step 'ffmpeg / ffprobe'
if ((Has 'ffmpeg') -and (Has 'ffprobe')) { Ok 'ffmpeg found' }
else {
  Winget-Install 'Gyan.FFmpeg' 'ffmpeg'
  if (-not ((Has 'ffmpeg') -and (Has 'ffprobe'))) {
    throw 'ffmpeg installed but not on PATH yet. Open a new terminal and re-run this script.'
  }
  Ok 'ffmpeg installed'
}

# --- npm packages ------------------------------------------------------------
# Skip when node_modules already matches package-lock.json (npm writes node_modules/.package-lock.json).
Step 'npm packages'
$lock      = Join-Path $PSScriptRoot 'package-lock.json'
$installed = Join-Path $PSScriptRoot 'node_modules\.package-lock.json'
$upToDate  = (Test-Path $installed) -and (Test-Path $lock) -and
             ((Get-Item $installed).LastWriteTimeUtc -ge (Get-Item $lock).LastWriteTimeUtc)
if ($upToDate) { Ok 'node_modules up to date' }
else {
  if (Test-Path $lock) { npm ci } else { npm install }
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
  Ok 'packages installed'
}

# --- Playwright browser ------------------------------------------------------
# `playwright install` is itself a no-op when the matching Chromium build is already present.
Step 'Playwright Chromium'
npx --no-install playwright install chromium
if ($LASTEXITCODE -ne 0) { throw 'Playwright browser install failed.' }
Ok 'chromium ready'

# --- Optional: global `aft` command -----------------------------------------
if ($Link) {
  Step 'Global aft command'
  $globalRoot = (npm root -g).Trim()
  $linked = Join-Path $globalRoot 'autofeaturetour'
  $item = Get-Item $linked -ErrorAction SilentlyContinue
  if ($item -and $item.Target -and ((Resolve-Path $item.Target).Path -eq $PSScriptRoot)) { Ok '`aft` already linked to this repo' }
  else {
    npm link
    if ($LASTEXITCODE -ne 0) { throw 'npm link failed.' }
    Ok '`aft` is available in new terminals'
  }
}

# --- Verify (engine + each target's targets/<app>/requirements.mjs, advisory) -------------
# aft doctor covers voices, Chromium, ffmpeg and per-target extras; the tool itself knows nothing about any app.
Step 'Checking with aft doctor'
node (Join-Path $PSScriptRoot 'src\cli.mjs') doctor
$doctorExit = $LASTEXITCODE

if ($doctorExit -ne 0) { Write-Host "`nSetup finished, but required items are missing (see above)." -ForegroundColor Yellow; exit $doctorExit }
Write-Host "`nSetup complete." -ForegroundColor Green
Write-Host 'Try:  node src/cli.mjs --help'
if ($Link) { Write-Host '      aft --help   (in a new terminal)' }
