Set WshShell = CreateObject("WScript.Shell")
WScript.Sleep 2000
WshShell.CurrentDirectory = "C:\\Users\\micha\\Documents\\GitHub\\claude-code-discord-bot-ps"
WshShell.Run "cmd /k echo RESTART TEST SUCCESS && pause", 1, False
