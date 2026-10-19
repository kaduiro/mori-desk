@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
if errorlevel 1 goto failed
call scripts\windows-node.bat install
if errorlevel 1 goto failed
set "PATH=%MORI_NODE_DIR%;%PATH:"=%"
set "npm_execpath=%MORI_NODE_DIR%node_modules\npm\bin\npm-cli.js"
where git.exe >nul 2>nul
if errorlevel 1 goto missing_git
"%MORI_NODE_EXE%" scripts\setup.js
if errorlevel 1 goto failed
"%MORI_NODE_EXE%" scripts\run.js start
if errorlevel 1 goto failed
exit /b 0
:missing_git
echo Install Git for Windows first, then reopen this file.
echo Node is already ready. Git is required for the pinned application source.
pause
exit /b 1
:failed
set "MORI_EXIT_CODE=%ERRORLEVEL%"
echo Setup or launch failed. The error is shown above. See docs\windows-ja.md.
pause
exit /b %MORI_EXIT_CODE%
