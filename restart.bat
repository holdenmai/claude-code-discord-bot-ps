@echo off
REM Restart script for Discord bot
echo Waiting for old process to exit...
timeout /t 2 /nobreak >nul

echo Starting bot...
cd /d "%~dp0"

REM Start bun in a new window that stays open
start "Discord Bot" cmd /k "bun run src/index.ts"

echo Bot restart complete
