@echo off
setlocal EnableExtensions

rem Double-click launcher: Docker Desktop -> Directus -> Kami.
set "WORK_DIR=%~dp0"
set "DOCKER_DESKTOP_D=D:\Docker\Desktop\Docker Desktop.exe"
set "DOCKER_DESKTOP_C=C:\Program Files\Docker\Docker\Docker Desktop.exe"
set "KAMI_EDGE_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%KAMI_EDGE_EXE%" set "KAMI_EDGE_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

pushd "%WORK_DIR%" || goto :workdir_failed

rem Do not launch a second Node server when the workbench is already available.
powershell.exe -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:4173/api/health'; exit [int]($response.StatusCode -ne 200) } catch { exit 1 }"
if not errorlevel 1 (
  call :open_workbench 0
  exit /b 0
)

docker version --format "{{.Server.Version}}" >nul 2>&1
if not errorlevel 1 goto :docker_ready

echo [1/4] Starting Docker Desktop...
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
echo [2/4] Starting Directus...
call npm run directus:up
if errorlevel 1 goto :failed

echo [3/4] Waiting for Directus...
set /a directus_attempts=0
:wait_for_directus
set /a directus_attempts+=1
powershell.exe -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:18055/server/health'; exit [int]($response.StatusCode -ne 200) } catch { exit 1 }"
if not errorlevel 1 goto :directus_ready
if %directus_attempts% GEQ 60 goto :directus_failed
timeout /t 2 /nobreak >nul
goto :wait_for_directus

:directus_ready
echo [4/4] Starting Kami workbench...
call :open_workbench 2
set "KAMI_AUTO_SHUTDOWN=1"
echo Your browser will open automatically. Closing the last page stops Kami and Docker Desktop.
echo.
call npm start
exit /b %errorlevel%

:open_workbench
start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "$delay = [int]'%~1'; if ($delay -gt 0) { Start-Sleep -Seconds $delay }; $edge = $env:KAMI_EDGE_EXE; if (Test-Path -LiteralPath $edge) { $profile = Join-Path $env:LOCALAPPDATA 'KamiWorkbench\edge-safe-profile'; Start-Process -FilePath $edge -ArgumentList @('--disable-gpu', ('--user-data-dir=' + $profile), '--no-first-run', '--new-window', 'http://127.0.0.1:4173') } else { Start-Process 'http://127.0.0.1:4173' }"
exit /b 0

:docker_failed
echo Docker Desktop did not become ready within two minutes. Check it and retry.
goto :failed

:directus_failed
echo Directus did not become ready within two minutes. Check Docker Desktop and retry.
goto :failed

:workdir_failed
echo Cannot enter the workbench directory: %WORK_DIR%

:failed
echo.
pause
exit /b 1
