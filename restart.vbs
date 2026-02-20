Set WshShell = CreateObject("WScript.Shell")
WScript.Sleep 2000
WshShell.CurrentDirectory = "C:\\Users\\micha\\Documents\\GitHub\\claude-code-discord-bot-ps"
WshShell.Run "cmd /k bun run start", 1, False