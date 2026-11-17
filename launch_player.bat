@echo off
setlocal
title ShotSwap Timeline Review
echo ========================================================
echo   ShotSwap Timeline Review ^& Version Player
echo ========================================================
echo.

pushd "%~dp0"
if not exist "%~dp0shotswap_config.json" (
    echo First time running ShotSwap in this directory!
    echo Launching Production Setup Wizard...
    echo.
    py "%~dp0setup_production.py"
    if %errorlevel% neq 0 (
        python "%~dp0setup_production.py"
    )
    echo.
)

echo Starting local lightweight video server...
echo (If port 8080 is used by another service on this machine, it will automatically use 8081+)
echo.

py "%~dp0server.py" 8080
if %errorlevel% neq 0 (
    python "%~dp0server.py" 8080
)
popd
pause
