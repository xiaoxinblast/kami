@echo off
setlocal EnableExtensions

rem Double-click launcher: Docker Desktop -> Directus -> Kami.
set "WORK_DIR=%~dp0"
set "DOCKER_DESKTOP_D=D:\Docker\Desktop\Docker Desktop.exe"
set "DOCKER_DESKTOP_C=C:\Program Files\Docker\Docker\Docker Desktop.exe"

pushd "%WORK_DIR%" || goto :workdir_failed

rem Do not launch a second Node server when the workbench is already available.
powershell.exe -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:4173/api/health'; exit [int]($response.StatusCode -ne 200) } catch { exit 1 }"
if not errorlevel 1 (
  start "" "http://127.0.0.1:4173"
  exit /b 0
)

docker version --format "{{.Server.Version}}" >nul 2>&1
if not errorlevel 1 goto :docker_ready

echo [1/3] Starting Docker Desktop...
if exist "%DOCKER_DESKTOP_D%" (
  start "" "%DOCKER_DESKTOP_D%"
) else if exist "%DOCKER_DESKTOP_C%" (
  start "" "%DOCKER_DESKTOP_C%"
) else (
  echo Docker Desktop was not found. Install and start Docker Desktop first.
  goto :failed
)

set /a docker_attempts=0
:wait_for_docker
set /a docker_attempts+=1
timeout /t 2 /nobreak >nul
docker version --format "{{.Server.Version}}" >nul 2>&1
if not errorlevel 1 goto :docker_ready
if %docker_attempts% GEQ 60 goto :docker_failed
goto :wait_for_docker

:docker_ready
echo [2/3] Starting Directus...
call npm run directus:up
if errorlevel 1 goto :failed

echo [3/3] Starting Kami workbench...
start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:4173'"
echo Your browser will open automatically. Close this window to stop Kami.
echo.
call npm start
exit /b %errorlevel%

:docker_failed
echo Docker Desktop did not become ready within two minutes. Check it and retry.
goto :failed

:workdir_failed
echo Cannot enter the workbench directory: %WORK_DIR%

:failed
echo.
pause
exit /b 1
