@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
if errorlevel 1 goto failed
call scripts\windows-node.bat existing
if errorlevel 1 goto failed
set "PATH=%MORI_NODE_DIR%;%PATH:"=%"
set "npm_execpath=%MORI_NODE_DIR%node_modules\npm\bin\npm-cli.js"
"%MORI_NODE_EXE%" scripts\run.js start
if errorlevel 1 goto failed
exit /b 0
:failed
set "MORI_EXIT_CODE=%ERRORLEVEL%"
echo Mori Desk could not start. Run setup-windows.bat for the first setup.
pause
exit /b %MORI_EXIT_CODE%
