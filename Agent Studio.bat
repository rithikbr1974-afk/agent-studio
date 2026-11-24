@echo off
rem Opens Agent Studio (same as its Start menu shortcut). Run Install.bat once first.
start "" wscript.exe "%~dp0app\AgentStudio.vbs" %1
