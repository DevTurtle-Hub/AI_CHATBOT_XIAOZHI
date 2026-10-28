@echo off
setlocal
chcp 65001 > nul
cd /d "%~dp0"
title XiaoXi AI Server

echo ========================================================
echo   KHOI DONG XIAOXI: PYTHON VOICE ENGINE + NODE GATEWAY
echo ========================================================

if not exist ".env" (
    echo [LOI] Khong tim thay D:\IOT\.env
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo [LOI] Chua tim thay Node.js. Hay cai Node.js 20 tro len.
    exit /b 1
)

set "PY_EXE="
set "PY_ARGS="
py -3.11 --version >nul 2>&1
if not errorlevel 1 (
    set "PY_EXE=py"
    set "PY_ARGS=-3.11"
)
if not defined PY_EXE if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set "PY_EXE=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if not defined PY_EXE (
    where python >nul 2>&1
    if not errorlevel 1 set "PY_EXE=python"
)
if not defined PY_EXE (
    echo [LOI] Khong tim thay Python 3.11.
    echo Da kiem tra py launcher, Python311 trong AppData va PATH.
    exit /b 1
)

"%PY_EXE%" %PY_ARGS% -c "import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)" >nul 2>&1
if errorlevel 1 (
    echo [LOI] Can Python 3.11 tro len. Interpreter: %PY_EXE%
    exit /b 1
)

if not exist "node_modules\ws" (
    echo [LOI] Thieu node_modules. Chay: npm install
    exit /b 1
)

"%PY_EXE%" %PY_ARGS% -c "import numpy, onnxruntime, fastapi, scipy, requests, edge_tts" >nul 2>&1
if errorlevel 1 (
    echo [LOI] Thieu thu vien Python. Dang cai tu requirements.txt...
    "%PY_EXE%" %PY_ARGS% -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [LOI] Cai thu vien that bai. Kiem tra Python, pip va ket noi mang.
        exit /b 1
    )
)

if not exist "engine\silero_vad.onnx" (
    echo [LOI] Thieu mo hinh silero_vad.onnx trong thu muc engine\
    exit /b 1
)

echo [*] Khoi dong Python Voice Engine bang %PY_EXE% %PY_ARGS% (port 5005)...
start "XiaoXi Python Voice Engine" /D "%~dp0" cmd /k ""%PY_EXE%" %PY_ARGS% -u engine\voice_engine.py"

echo [*] Cho Python Engine khoi dong...
powershell -NoProfile -Command "$ready=$false; for($i=0;$i -lt 20;$i++){ try{$r=Invoke-WebRequest -Uri 'http://127.0.0.1:5005/health' -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200){$ready=$true; break}}catch{}; Start-Sleep -Seconds 1 }; if($ready){Write-Host '[OK] Python Engine san sang'}else{Write-Host '[LOI] Engine khong san sang sau 20 giay'; exit 1}"
if errorlevel 1 (
    echo [LOI] Xem cua so Python Voice Engine de biet chi tiet.
    exit /b 1
)

echo [*] Khoi dong Node.js Gateway (port 8765)...
node server\server.js
endlocal

