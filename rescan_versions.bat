@echo off
setlocal
cd /d "%~dp0"
echo Scanning media folder for new versions...
python rescan_versions.py
if %errorlevel% neq 0 (
    py rescan_versions.py
)
echo.
pause
