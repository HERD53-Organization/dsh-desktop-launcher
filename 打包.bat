@echo off
REM ============================================================================
REM  DSH Launcher - rebuild the launcher and refresh the deliverable folder
REM
REM  Double-click this file. It runs, in order:
REM    1. npm run dist    rebuild the app from src\ into build\
REM    2. npm run share   assemble DSH-Launcher\ and DSH-Launcher.zip
REM
REM  When it finishes, share EITHER of these:
REM    - the folder  DSH-Launcher\      (right-click, send to, compressed folder)
REM    - the archive DSH-Launcher.zip
REM
REM  ASCII-only on purpose, and CRLF line endings are required: cmd.exe
REM  mis-parses a .bat that uses bare LF, executing the REM lines as commands.
REM ============================================================================

setlocal
cd /d "%~dp0"

echo.
echo  ================================================================
echo   DSH Launcher - rebuild and package
echo  ================================================================
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo   ERROR: npm was not found on PATH.
  echo   Install Node.js LTS from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo   node_modules is missing. Running "npm install" first ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   ERROR: npm install failed.
    echo.
    pause
    exit /b 1
  )
)

echo  [1/2] Building (npm run dist) ...
echo.
call npm run dist
if errorlevel 1 (
  echo.
  echo   ERROR: the build failed. Nothing was packaged.
  echo   The most common cause is that the launcher is still running and
  echo   holding files in build\win-unpacked. Quit it from its tray menu
  echo   ^(Quit^) and run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo  [2/2] Assembling the share folder (npm run share) ...
echo.
call npm run share
if errorlevel 1 (
  echo.
  echo   ERROR: packaging failed.
  echo.
  pause
  exit /b 1
)

echo.
echo  ================================================================
echo   Ready to share
echo  ================================================================
echo.
echo   Folder : "%~dp0DSH-Launcher"
echo   Archive: "%~dp0DSH-Launcher.zip"
echo.
echo   Send either one. The recipient runs setup.bat once, then launches
echo   win-unpacked\DSH Launcher.exe from the tray.
echo.
echo   Never send your own ~/.dsh/.credentials.yaml.
echo.
pause
exit /b 0
