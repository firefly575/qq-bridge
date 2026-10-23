@echo off
rem 打开 QQ 桥接控制台（令牌从 state\console-token 现读，不把令牌写死在文件里）
setlocal enabledelayedexpansion
set "T="
if exist "%~dp0state\console-token" (
  for /f "usebackq delims=" %%i in ("%~dp0state\console-token") do set "T=%%i"
)
if "%T%"=="" (
  echo [错误] 找不到 state\console-token，无法自动带令牌打开。
  echo         可以先打开 http://127.0.0.1:3100/ ，在弹窗里手动输入令牌。
  pause
  exit /b 1
)
echo 正在打开控制台：http://127.0.0.1:3100/
start "" "http://127.0.0.1:3100/?token=%T%"
endlocal
