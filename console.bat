@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "state\console-token" (
  echo [ERROR] state\console-token not found. Start the bridge first: start.bat
  pause
  exit /b 1
)

set /p TOKEN=<state\console-token

rem check whether the console port is listening
netstat -ano | findstr /r /c:"127.0.0.1:3100 .*LISTENING" >nul
if errorlevel 1 (
  echo [WARN] console port 3100 is not listening - the bridge is probably not running.
  echo        Start it with start.bat, then run this again.
  echo.
)

echo Opening qq-bridge console: http://127.0.0.1:3100
start "" "http://127.0.0.1:3100/?token=%TOKEN%"
