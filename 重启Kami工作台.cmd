@echo off
setlocal EnableExtensions

rem Restart Kami: stop every workbench Node server, wait until port 4173 is really
rem free, then run the normal launcher (Docker Desktop -> Directus -> Kami).
rem ASCII-only on purpose (see comments in scripts\launch-kami.cmd).
pushd "%~dp0" || goto :workdir_failed

echo Stopping any running Kami server...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\stop-kami-server.ps1"
if errorlevel 1 goto :failed

echo Starting Kami workbench again...
call ".\scripts\launch-kami.cmd"
exit /b %errorlevel%

:workdir_failed
echo Cannot enter the workbench directory: %~dp0

:failed
echo.
pause
exit /b 1
