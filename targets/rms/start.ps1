<#
.SYNOPSIS
  Starts the local RMS API or Web UI in its own console window, the same way the desktop shortcuts do, and returns.
  AutoFeatureTour only calls this when nothing answers on the service's port, so running services are never touched.
  It never passes -Force (which would kill running services). Close the window, or press Ctrl+C in it, to stop.
#>
param(
  [Parameter(Mandatory)][ValidateSet('api', 'web')][string]$Service,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$scripts = if ($env:AFT_RMS_DEV_SCRIPTS) { $env:AFT_RMS_DEV_SCRIPTS } else { 'C:\TylerDev\nwps-rms-dev-scripts' }
$script = Join-Path $scripts $(if ($Service -eq 'api') { 'StartRmsApi.local.ps1' } else { 'StartWebUi.local.ps1' })
if (-not (Test-Path $script)) { throw "Not found: $script (set AFT_RMS_DEV_SCRIPTS to the nwps-rms-dev-scripts folder)" }
$args = @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', $script)
if ($SkipBuild -or $env:AFT_RMS_SKIP_BUILD -eq '1') { $args += '-SkipBuild' }
Start-Process powershell.exe -ArgumentList $args -WorkingDirectory $scripts
Write-Host "Started $Service in a new window: $script"
