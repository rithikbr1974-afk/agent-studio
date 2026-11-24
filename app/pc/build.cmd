@echo off
rem Builds pchelper.exe with the C# compiler that comes with Windows (.NET Framework 4 + its UI Automation).
cd /d "%~dp0"
set "FW=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319"
"%FW%\csc.exe" /nologo /optimize /platform:x64 /out:pchelper.exe ^
  /r:System.Drawing.dll /r:System.Web.Extensions.dll ^
  /r:"%FW%\WPF\UIAutomationClient.dll" /r:"%FW%\WPF\UIAutomationTypes.dll" /r:"%FW%\WPF\WindowsBase.dll" ^
  pchelper.cs
