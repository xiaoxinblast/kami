# Stop every Kami workbench Node server and wait until the port is really released.
#
# Why this exists: the restart launcher used to kill only the process that owned
# port 4173 and then wait 1 second. If the port was still held, the launcher's
# health check believed the workbench was already running, opened the browser and
# exited -- so "restart" looked like it did nothing.
#
# Keep this file ASCII-only: cmd.exe runs it through Windows PowerShell 5.1, which
# decodes BOM-less files as ANSI and would choke on non-ASCII characters.
param(
  [int]$Port = 4173,
  [int]$TimeoutSeconds = 20
)

$targets = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'server\.mjs' -and $_.CommandLine -notmatch 'artifact-template-picker' })

if ($targets.Count -eq 0) {
  Write-Host "  no Kami server process found"
} else {
  foreach ($process in $targets) {
    Write-Host ("  stopping Kami server pid " + $process.ProcessId)
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
  Start-Sleep -Milliseconds 300
}

if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  Write-Error ("Port " + $Port + " is still held; stop the process that owns it and retry.")
  exit 2
}

Write-Host ("  port " + $Port + " is free")
exit 0
