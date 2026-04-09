@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-edge.ps1" %*
exit /b %ERRORLEVEL%
