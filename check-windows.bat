@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
if errorlevel 1 goto failed
call scripts\windows-node.bat existing
if errorlevel 1 goto failed
if "%~1"=="" goto default_check
"%MORI_NODE_EXE%" scripts\doctor.js --extension-dir "%~1"
goto finished
:default_check
"%MORI_NODE_EXE%" scripts\doctor.js
:finished
set "MORI_EXIT_CODE=%ERRORLEVEL%"
echo.
echo This checks disk files only. Chrome and live monitoring have not been tested.
pause
exit /b %MORI_EXIT_CODE%
:failed
set "MORI_EXIT_CODE=%ERRORLEVEL%"
echo The version check could not run. No setup or repair was attempted.
pause
exit /b %MORI_EXIT_CODE%
