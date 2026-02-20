# Restart script for Discord bot
# Wait for old process to exit, then start new one

param(
    [int]$OldPid
)

# Wait a moment for the old process to finish cleanup
Start-Sleep -Seconds 2

# Check if old process is still running
$oldProcess = Get-Process -Id $OldPid -ErrorAction SilentlyContinue
if ($oldProcess) {
    Write-Host "Waiting for old process $OldPid to exit..."
    Wait-Process -Id $OldPid -Timeout 10 -ErrorAction SilentlyContinue
}

# Change to bot directory
Set-Location $PSScriptRoot

# Start the bot
Write-Host "Starting bot..."
Start-Process -FilePath "bun" -ArgumentList "run", "src/index.ts" -NoNewWindow
