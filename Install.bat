@echo off
rem One-time setup: the AI agent folder, the sandbox, shortcuts and "Run Agent" on folders.
rem Uninstall the menu and shortcuts: Install.bat -Remove
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\install.ps1" %*
pause
