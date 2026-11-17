@echo off
setlocal
title ShotSwap Timeline Review — Setup Wizard
echo ========================================================
echo   ShotSwap Timeline Review — Production Setup Wizard
echo ========================================================
echo.
pushd "%~dp0"
py setup_production.py
if %errorlevel% neq 0 (
    python setup_production.py
)
popd
pause
