Set WshShell = CreateObject("WScript.Shell")
WScript.Sleep 2000
WshShell.CurrentDirectory = "E:\repos\claude-code-discord-bot"
WshShell.Run "cmd /k bun run start", 1, False