@echo off
setlocal
cd /d "%~dp0"
node scripts\run.js start
if errorlevel 1 goto failed
exit /b 0
:failed
echo Mori Desk could not start. Run setup-windows.bat for the first setup.
pause
exit /b 1
