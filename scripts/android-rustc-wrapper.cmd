@echo off
setlocal
chcp 65001 >nul
set "ARGS=%*"
set "ARGS=%ARGS: - = __HAKUS_STDIN__ %"
powerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0android-rustc-wrapper.ps1" %ARGS%
exit /b %errorlevel%
