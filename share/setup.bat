@echo off
REM ============================================================================
REM  DSH Launcher - one-time environment setup
REM
REM  Installs what the launcher needs, then tells you how to start it:
REM    1. Node.js          (the launcher runs dsh under the system Node)
REM    2. @deepseek-ai/dsh (the CLI it supervises)
REM
REM  Deliberately ASCII-only: a .bat with Chinese text turns to mojibake under
REM  the default console code page. The Chinese install guide sits next to this
REM  file as a .md whose name is not written here for that same reason.
REM
REM  Usage:  setup.bat                       install with the default registry
REM          setup.bat https://registry.npmjs.org   force a specific registry
REM ============================================================================

setlocal enabledelayedexpansion
set "REGISTRY_ARG=%~1"
if not "%REGISTRY_ARG%"=="" set "NPM_CONFIG_REGISTRY=%REGISTRY_ARG%"

echo.
echo  ================================================================
echo   DSH Launcher - environment setup
echo  ================================================================
echo.

REM ---------------------------------------------------------------- Node.js ---
echo  [1/4] Checking Node.js ...
where node >nul 2>nul
if errorlevel 1 goto :install_node
for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NODE_VERSION=%%v"
echo        found Node.js !NODE_VERSION!
goto :check_dsh

:install_node
echo        Node.js was not found.
where winget >nul 2>nul
if errorlevel 1 goto :node_manual

echo        Installing Node.js LTS through winget ...
echo        (winget may show its own progress and licence prompt)
winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto :node_winget_failed

REM winget updates the machine PATH, but this console still holds the old copy.
set "PATH=%PATH%;%ProgramFiles%\nodejs"
where node >nul 2>nul
if errorlevel 1 goto :node_manual
for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NODE_VERSION=%%v"
echo        installed Node.js !NODE_VERSION!
goto :check_dsh

:node_winget_failed
echo.
echo        ERROR: winget could not install Node.js.
echo        Install it manually from https://nodejs.org (LTS), then re-run this file.
goto :fail

:node_manual
echo.
echo        ERROR: Node.js is still not available on PATH.
echo        Install the LTS build from https://nodejs.org, then re-run this file.
echo        If you installed it just now, close this window and open a new one.
goto :fail

REM --------------------------------------------------------------- npm check ---
:check_dsh
echo  [2/4] Checking npm ...
where npm >nul 2>nul
if errorlevel 1 goto :npm_missing
echo        found npm
goto :install_dsh

:npm_missing
echo.
echo        ERROR: npm was not found. It ships with Node.js, so the Node
echo        installation is probably incomplete. Reinstall Node.js LTS.
goto :fail

REM ------------------------------------------------------------------- dsh -----
:install_dsh
echo  [3/4] Checking @deepseek-ai/dsh ...
where dsh >nul 2>nul
if not errorlevel 1 goto :dsh_present

echo        dsh was not found. Installing it globally ...
call npm install -g @deepseek-ai/dsh --no-audit --no-fund
if errorlevel 1 goto :dsh_failed
echo        installed dsh
goto :verify

:dsh_present
for /f "tokens=*" %%v in ('npm ls -g --depth=0 2^>nul ^| findstr /c:"@deepseek-ai/dsh"') do echo        found %%v
echo        Skipping install. To upgrade, use the tray menu's "Check dsh updates".
goto :verify

:dsh_failed
echo.
echo        ERROR: "npm install -g @deepseek-ai/dsh" failed.
echo.
echo        If the message mentions permissions or EPERM, run this file from a
echo        Command Prompt opened as Administrator.
echo        If it mentions the network or ETIMEDOUT, retry behind a mirror:
echo            setup.bat https://registry.npmmirror.com
goto :fail

REM ----------------------------------------------------------------- verify ----
:verify
echo  [4/4] Verifying ...
set "DSH_VERSION=unknown"
for /f "tokens=*" %%v in ('dsh --version 2^>nul') do set "DSH_VERSION=%%v"
if "!DSH_VERSION!"=="unknown" goto :verify_failed
echo        dsh version: !DSH_VERSION!
goto :done

:verify_failed
echo.
echo        ERROR: dsh is installed but "dsh --version" did not answer.
echo        Close this window, open a new Command Prompt, and run:
echo            dsh --version
echo        If that also fails, reinstall dsh:
echo            npm install -g @deepseek-ai/dsh
goto :fail

REM ------------------------------------------------------------------ done -----
:done
echo.
echo  ================================================================
echo   Setup complete
echo  ================================================================
echo.
if exist "%~dp0win-unpacked\DSH Launcher.exe" (
  echo   Double-click:  "%~dp0win-unpacked\DSH Launcher.exe"
) else if exist "%~dp0..\build\win-unpacked\DSH Launcher.exe" (
  echo   Double-click:  "%~dp0..\build\win-unpacked\DSH Launcher.exe"
) else (
  echo   Could not find "DSH Launcher.exe" next to this file.
  echo   Run this setup.bat from inside the folder that contains win-unpacked.
)
echo.
echo   The launcher runs in the system tray with NO window: after starting it,
echo   left-click its tray icon to open DeepSeek Harness. If you do not see the
echo   icon, expand the hidden-icons chevron ^^ in the taskbar corner.
echo.
echo   To quit the launcher, use its tray menu -^> Quit.
echo.
pause
exit /b 0

:fail
echo.
echo   Setup did not complete. Fix the error above and run setup.bat again.
echo   Re-running is safe: already-installed parts are detected and skipped.
echo.
pause
exit /b 1
