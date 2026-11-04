@echo off
rem Double-click to set up AutoFeatureTour. Safe to run again any time.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Link %*
echo.
pause
