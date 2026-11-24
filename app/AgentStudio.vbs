' Starts launch.ps1 without a console window. Shortcuts and the "Run Agent" menu call this.
' Usage: wscript AgentStudio.vbs ["folder"]
Set shell = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
folder = ""
If WScript.Arguments.Count > 0 Then folder = WScript.Arguments(0)
' A trailing backslash ("E:\") would escape the closing quote, so it goes.
Do While Len(folder) > 0 And Right(folder, 1) = "\"
  folder = Left(folder, Len(folder) - 1)
Loop
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\launch.ps1"" -Folder """ & folder & """", 0, False
