@echo off
setlocal EnableExtensions

rem Double-click entry kept for habit; the real launcher lives in scripts\launch-kami.cmd
rem so this file stays ASCII-only (cmd reads .cmd files in the console code page,
rem so a UTF-8 body containing Chinese file names is decoded wrong and the call fails).
call "%~dp0scripts\launch-kami.cmd" %*
exit /b %errorlevel%
