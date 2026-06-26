@echo off
echo ========================================
echo   LinkedIn AI Agent -- Backend Startup
echo ========================================
echo.

cd /d "%~dp0"

set PYTHONIOENCODING=utf-8

echo [1/2] Installing / updating dependencies...
pip install -r requirements.txt --quiet
if errorlevel 1 (
    echo ERROR: pip install failed. Make sure Python is installed.
    pause
    exit /b 1
)

echo [2/2] Starting server on port 8010...

:: Try to kill whatever is on 8010 first
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8010 " ^| findstr "LISTENING"') do (
    echo Releasing port 8010 from PID %%a ...
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 >nul

echo.
echo ========================================
echo   API running on http://127.0.0.1:8010
echo   Set this URL in the extension options
echo   Press Ctrl+C to stop
echo ========================================
echo.

python -m uvicorn main:app --app-dir "%~dp0" --host 127.0.0.1 --port 8010 --reload

pause
