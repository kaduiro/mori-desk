@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 goto missing_node
where git.exe >nul 2>nul
if errorlevel 1 goto missing_git
node scripts\setup.js
if errorlevel 1 goto failed
node scripts\run.js start
if errorlevel 1 goto failed
exit /b 0
:missing_node
echo Install Node.js 24.x LTS with npm first. See docs\windows-ja.md.
pause
exit /b 1
:missing_git
echo Install Git for Windows first, then reopen this file.
pause
exit /b 1
:failed
echo Setup or launch failed. The error is shown above. See docs\windows-ja.md.
pause
exit /b 1
