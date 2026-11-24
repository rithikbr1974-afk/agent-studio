@echo off
rem Builds lowrun.exe with the C# compiler that comes with Windows (.NET Framework 4).
cd /d "%~dp0"
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /optimize /platform:x64 /out:lowrun.exe lowrun.cs
