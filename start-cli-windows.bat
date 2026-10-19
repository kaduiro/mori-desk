@echo off
setlocal
cd /d "%~dp0"
echo Close the original Clawd on Desk before using this CLI preview.
echo Existing Clawd settings are not automatically migrated.
node scripts\run.js start --enable-cli
if errorlevel 1 goto failed
exit /b 0
:failed
echo Mori Desk CLI preview could not start. See docs\windows-ja.md.
pause
exit /b 1
