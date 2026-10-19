@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
if errorlevel 1 goto failed
call scripts\windows-node.bat install
if errorlevel 1 goto failed
echo Node version:
"%MORI_NODE_EXE%" --version
if errorlevel 1 goto failed
echo npm version:
"%MORI_NODE_EXE%" "%MORI_NODE_DIR%node_modules\npm\bin\npm-cli.js" --version
if errorlevel 1 goto failed
echo Node.js and npm are ready for this copy of Mori Desk.
echo This does not add Node to the Windows PATH or install Git.
echo Next: run setup-windows.bat to prepare and launch Mori Desk.
pause
exit /b 0
:failed
set "MORI_EXIT_CODE=%ERRORLEVEL%"
echo Node preparation failed. Read the error above and see docs\windows-ja.md.
pause
exit /b %MORI_EXIT_CODE%
