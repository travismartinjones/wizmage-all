@echo off
setlocal
rem Keep Windows argument handling in the PowerShell wrapper; all packaging is shared Node code.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-edge.ps1" %*
exit /b %ERRORLEVEL%
