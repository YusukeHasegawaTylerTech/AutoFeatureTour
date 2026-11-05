@echo off
rem Opens the AutoFeatureTour UI (starts its server if needed; the server stops when the last UI window is closed).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is missing: run install.cmd first. & pause & exit /b 1)
node start.mjs %*
if errorlevel 1 pause
