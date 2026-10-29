' Starts the Taskosphere Agent without a console window.
' Used by the Start-menu shortcut and by the sign-in (Run) entry.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run """" & dir & "\TaskosphereAgent.exe""", 0, False
