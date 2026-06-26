@echo off
echo ========================================
echo   LinkedIn AI Agent — Admin Dashboard
echo ========================================
echo.

cd /d "%~dp0"

echo [1/2] Installing / updating dependencies...
call npm install --silent
if errorlevel 1 (
    echo ERROR: npm install failed. Make sure Node.js is installed.
    pause
    exit /b 1
)

echo [2/2] Starting admin dashboard on http://localhost:3000
echo.
echo Admin login credentials:
echo   Email:    admin@linkedin.ai
echo   Password: admin123
echo.
echo Make sure start_backend.bat is also running (port 8010).
echo.
echo Press Ctrl+C to stop the server.
echo ========================================
echo.

call npm run dev

pause
