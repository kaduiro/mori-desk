@echo off
setlocal DisableDelayedExpansion
rem PATH entries do not need surrounding quotes. Normalize them for where.exe
rem inside this helper only; the caller's environment is restored by endlocal.
set "PATH=%PATH:"=%"
rem Called from the repository root with "install" or "existing".
rem Export a selected Node only. Do not modify the machine/user PATH.
set "MORI_NODE_MODE=%~1"
set "MORI_NODE_EXE="
set "MORI_NODE_DIR="
set "MORI_NODE_ROOT=%CD%"
set "MORI_NODE_ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "MORI_NODE_ARCH=%PROCESSOR_ARCHITEW6432%"
if /i "%MORI_NODE_ARCH%"=="AMD64" goto arch_x64
if /i "%MORI_NODE_ARCH%"=="ARM64" goto arch_arm64
echo Mori Desk requires 64-bit Windows on x64 or ARM64.
exit /b 1

:arch_x64
set "MORI_NODE_ARCH=x64"
set "MORI_NODE_SHA256=f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3"
goto select_node

:arch_arm64
set "MORI_NODE_ARCH=arm64"
set "MORI_NODE_SHA256=3a5c209a5bc59e65b3bc0fa13ed5e166a26bd3d55332847f498b76b037408d61"

:select_node
if "%MORI_NODE_MODE%"=="install" goto find_node
if "%MORI_NODE_MODE%"=="existing" goto find_node
echo Internal error: an unknown Node preparation mode was requested.
exit /b 1

:find_node
set "MORI_NODE_DEST=%MORI_NODE_ROOT%\.tools\node-v24.22.0-win-%MORI_NODE_ARCH%"
set "MORI_NODE_EXE=%MORI_NODE_DEST%\node.exe"
call :check_candidate
if not errorlevel 1 goto ready
for /f "delims=" %%N in ('where node.exe 2^>nul') do (
    set "MORI_NODE_EXE=%%N"
    call :check_candidate
    if not errorlevel 1 goto ready
)
if "%MORI_NODE_MODE%"=="existing" goto missing_node
if exist "%MORI_NODE_DEST%" goto destination_exists
if not exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" goto missing_powershell

echo Preparing a private copy of Node.js 24.22.0 with npm for Mori Desk.
echo Download source: https://nodejs.org/dist/v24.22.0/
echo Destination: "%MORI_NODE_DEST%"
echo The download will be checked against a pinned SHA-256 before extraction.
rem All filesystem paths reach PowerShell through environment variables. Never
rem expand a user path into PowerShell code, use encoded commands, or bypass an
rem execution policy. The ZIP is the official portable Node distribution.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command ^
 "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';" ^
 "$stage = $null; $stageOwned = $false; $moriExit = 0;" ^
 "try {" ^
 "  $tools = Join-Path $env:MORI_NODE_ROOT '.tools';" ^
 "  $name = 'node-v24.22.0-win-' + $env:MORI_NODE_ARCH;" ^
 "  $destination = Join-Path $tools $name;" ^
 "  if (Test-Path -LiteralPath $destination) { throw 'The private Node destination already exists. It was not overwritten.' };" ^
 "  [IO.Directory]::CreateDirectory($tools) | Out-Null;" ^
 "  $stage = Join-Path $tools ('.mori-node-stage-' + [Guid]::NewGuid().ToString('N'));" ^
 "  if (Test-Path -LiteralPath $stage) { throw 'The temporary Node directory already exists.' };" ^
 "  [IO.Directory]::CreateDirectory($stage) | Out-Null; $stageOwned = $true;" ^
 "  $archive = Join-Path $stage 'node.zip';" ^
 "  $url = 'https://nodejs.org/dist/v24.22.0/' + $name + '.zip';" ^
 "  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
 "  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive -TimeoutSec 180;" ^
 "  $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash;" ^
 "  if (-not [string]::Equals($actual, $env:MORI_NODE_SHA256, [StringComparison]::OrdinalIgnoreCase)) { throw 'Node ZIP SHA-256 mismatch. Nothing was installed.' };" ^
 "  Expand-Archive -LiteralPath $archive -DestinationPath $stage;" ^
 "  $extracted = Join-Path $stage $name;" ^
 "  $newNode = Join-Path $extracted 'node.exe';" ^
 "  $check = Join-Path $env:MORI_NODE_ROOT 'scripts/check-windows-node.js';" ^
 "  & $newNode $check; if ($LASTEXITCODE -ne 0) { throw 'The downloaded Node or its bundled npm did not pass validation.' };" ^
 "  [IO.Directory]::Move($extracted, $destination);" ^
 "  Write-Host 'The private Node installation is ready.';" ^
 "} catch { [Console]::Error.WriteLine(('Node preparation failed: ' + $_.Exception.Message)); $moriExit = 1; }" ^
 "finally {" ^
 "  if ($stageOwned -and (Test-Path -LiteralPath $stage)) {" ^
 "    try { Remove-Item -LiteralPath $stage -Recurse -Force; }" ^
 "    catch { Write-Warning ('Temporary Node files were preserved at: ' + $stage); }" ^
 "  }" ^
 "}; exit $moriExit"
if errorlevel 1 exit /b 1
set "MORI_NODE_EXE=%MORI_NODE_DEST%\node.exe"
call :check_candidate
if errorlevel 1 goto invalid_install

:ready
for %%N in ("%MORI_NODE_EXE%") do set "MORI_NODE_DIR=%%~dpN"
echo Using Node: "%MORI_NODE_EXE%"
endlocal & set "MORI_NODE_EXE=%MORI_NODE_EXE%" & set "MORI_NODE_DIR=%MORI_NODE_DIR%" & exit /b 0

:check_candidate
if not exist "%MORI_NODE_EXE%" exit /b 1
"%MORI_NODE_EXE%" scripts\check-windows-node.js >nul 2>nul
exit /b %ERRORLEVEL%

:missing_node
echo Node.js 24.18.0 or newer within 24.x, with bundled npm, was not found.
echo Run setup-windows.bat to prepare Node and Mori Desk.
echo To prepare Node only, run install-node-windows.bat.
exit /b 1

:destination_exists
echo The private Node directory exists but did not pass validation:
echo "%MORI_NODE_DEST%"
echo It was not overwritten. Move this directory aside, then run setup again.
echo Do not move or delete any other files in .tools.
exit /b 1

:missing_powershell
echo Windows PowerShell was not found. Install Node.js 24.x with npm manually.
echo See docs\windows-ja.md. No application files were changed.
exit /b 1

:invalid_install
echo The prepared Node did not pass validation. Its files were preserved at:
echo "%MORI_NODE_DEST%"
exit /b 1
