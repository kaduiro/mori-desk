@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
if errorlevel 1 goto failed
call scripts\windows-node.bat existing
if errorlevel 1 goto failed
set "PATH=%MORI_NODE_DIR%;%PATH:"=%"
set "npm_execpath=%MORI_NODE_DIR%node_modules\npm\bin\npm-cli.js"
echo Close the original Clawd on Desk before using this CLI preview.
echo Existing Clawd settings are not automatically migrated.
"%MORI_NODE_EXE%" scripts\run.js start --enable-cli
if errorlevel 1 goto failed
exit /b 0
:failed
set "MORI_EXIT_CODE=%ERRORLEVEL%"
echo Mori Desk CLI preview could not start. See docs\windows-ja.md.
pause
exit /b %MORI_EXIT_CODE%
