@echo off
REM Convenience wrapper: double-click this, or run it from cmd.exe.
REM PowerShell refuses unsigned scripts by default, so this bypasses that for this one run
REM only - it changes no policy on the machine.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-desktop.ps1" %*
if errorlevel 1 pause
