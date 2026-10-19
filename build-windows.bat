@echo off
setlocal
cd /d "%~dp0"
node scripts\run.js build:win:x64
if errorlevel 1 goto failed
echo Build complete. The installer is in .runtime\dist.
pause
exit /b 0
:failed
echo Build failed. Run setup-windows.bat first and read the error above.
pause
exit /b 1
