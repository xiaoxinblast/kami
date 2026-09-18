# Close the dedicated Kami workbench browser window.
#
# The launcher always opens Edge with its own profile:
#   %LOCALAPPDATA%\KamiWorkbench\edge-safe-profile
# Restarting used to leave the previous window open, so stale pages kept talking to
# the new server. This script closes only processes that use that profile, so the
# user's normal Edge windows are never touched.
#
# Keep this file ASCII-only: cmd.exe runs it through Windows PowerShell 5.1, which
# decodes BOM-less files as ANSI.
param(
  [string]$ProfileDir = (Join-Path $env:LOCALAPPDATA 'KamiWorkbench\edge-safe-profile'),
  [int]$TimeoutSeconds = 15
)

$targets = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like ("*" + $ProfileDir + "*") })

if ($targets.Count -eq 0) {
  Write-Host "  no Kami browser window found"
  exit 0
}

foreach ($process in $targets) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host ("  closing Kami browser window(s): " + $targets.Count + " process(es)")

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while (((Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -like ("*" + $ProfileDir + "*") }).Count -gt 0) -and ((Get-Date) -lt $deadline)) {
  Start-Sleep -Milliseconds 300
}
exit 0
