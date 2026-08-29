@echo off
REM Convenience wrapper: double-click this, or run it from cmd.exe.
REM PowerShell refuses unsigned scripts by default, so this bypasses that for this one run
REM only - it changes no policy on the machine.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-desktop.ps1" %*
REM Always pause. Sluice runs until it is closed, so reaching this line at all means either
REM it has been shut down or something went wrong - and in the second case the window used
REM to close over the error before anyone could read it.
echo.
pause
