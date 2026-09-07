@echo off
setlocal EnableExtensions

rem One-time/update restart: only stop the Node server currently bound to Kami's port.
set "WORK_DIR=%~dp0"
pushd "%WORK_DIR%" || goto :workdir_failed

powershell.exe -NoProfile -Command "$listener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($listener) { $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $listener.OwningProcess); if ($process.Name -ne 'node.exe' -or $process.CommandLine -notmatch 'server\.mjs') { Write-Error '4173 is not owned by a Kami Node server.'; exit 2 }; Stop-Process -Id $listener.OwningProcess -Force }"
if errorlevel 1 goto :failed

timeout /t 1 /nobreak >nul
call ".\启动Kami工作台.cmd"
exit /b %errorlevel%

:workdir_failed
echo Cannot enter the workbench directory: %WORK_DIR%

:failed
echo.
pause
exit /b 1
