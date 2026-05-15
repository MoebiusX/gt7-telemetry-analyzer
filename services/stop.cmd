@echo off
REM Double-click to stop all three services
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0services.ps1" stop
echo.
pause
