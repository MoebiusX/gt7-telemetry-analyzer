@echo off
REM Double-click to restart everything
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0services.ps1" restart
echo.
pause
