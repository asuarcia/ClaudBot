@echo off
REM ===========================================================================
REM  Claudbot portable — Windows launcher
REM
REM  Double-click this, or run it from a terminal. It finds the Node runtime
REM  bundled on this drive (so the host machine needs nothing installed) and
REM  hands over to portable\boot.mjs, which prompts for the passphrase.
REM
REM  %~dp0 is this script's own directory WITH a trailing backslash, so the
REM  drive letter is never hardcoded.
REM ===========================================================================
setlocal

set "DRIVE=%~dp0"
set "NODE=%DRIVE%runtime\win-x64\node.exe"

if not exist "%NODE%" (
  REM No bundled runtime for this platform — fall back to a host install.
  where node >nul 2>&1
  if errorlevel 1 (
    echo.
    echo   No Node runtime found.
    echo.
    echo   This drive has no runtime\win-x64\node.exe and Node is not installed
    echo   on this machine. Re-run make-portable with the Windows runtime
    echo   included, or install Node 22+ here.
    echo.
    pause
    exit /b 1
  )
  set "NODE=node"
)

"%NODE%" "%DRIVE%portable\boot.mjs" %*
set "CODE=%ERRORLEVEL%"

REM Keep the window open on failure so a double-click user can read the error.
if not "%CODE%"=="0" (
  echo.
  echo   Claudbot exited with code %CODE%.
  pause
)

endlocal & exit /b %CODE%
