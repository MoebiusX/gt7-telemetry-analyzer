@echo off
REM Double-click to see what's running
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0services.ps1" status
echo.
pause
