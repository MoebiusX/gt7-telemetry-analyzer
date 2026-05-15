@echo off
REM Double-click to start exporter + prometheus + grafana
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0services.ps1" start
echo.
pause
