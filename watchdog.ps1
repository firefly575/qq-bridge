# 看门狗：每 30 秒检查 SnowLuma / qq-bridge 是否活着，死了就拉起来。
# 设计：
#   - 只检查端口（5099 WebUI、3001 OneBot WS、3100 桥接控制台），不猜测进程名。
#   - 拉起统一交给 autostart.ps1（它本身幂等，已存在的不会动）。
#   - 自己有单实例锁，避免重复跑。
#   - 全程写 state\watchdog.log。
param(
  [int]$IntervalSec = 30
)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$logFile = Join-Path $root 'state\watchdog.log'
$lockFile = Join-Path $root 'state\watchdog.lock'
$autostart = Join-Path $root 'autostart.ps1'

function Write-Log([string]$m) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Test-Port([int]$port) {
  try {
    return ((Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)
  } catch { return $false }
}

# 单实例
if (Test-Path $lockFile) {
  $old = (Get-Content $lockFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
    exit 0
  }
}
Set-Content -LiteralPath $lockFile -Value $PID -Encoding ascii

Write-Log "watchdog started (pid=$PID, interval=${IntervalSec}s)"

try {
  while ($true) {
    $snow = Test-Port 5099
    $onebot = Test-Port 3001
    $bridge = Test-Port 3100

    if (-not ($snow -and $onebot -and $bridge)) {
      Write-Log ("down: snowluma={0} onebot={1} bridge={2} -> running autostart" -f $snow, $onebot, $bridge)
      try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $autostart 2>&1 | Out-Null
      } catch {
        Write-Log ("autostart failed: " + $_.Exception.Message)
      }
      Start-Sleep -Seconds 8
      $snow2 = Test-Port 5099; $onebot2 = Test-Port 3001; $bridge2 = Test-Port 3100
      Write-Log ("after autostart: snowluma={0} onebot={1} bridge={2}" -f $snow2, $onebot2, $bridge2)
    }

    Start-Sleep -Seconds $IntervalSec
  }
} finally {
  Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
}
