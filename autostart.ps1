# 开机自启编排：QQ → SnowLuma → qq-bridge
# 由计划任务 "qq-bridge-autostart" 在登录时调用（隐藏窗口）。
# 设计要点：
#   1. 幂等：已经在跑的东西不动（重复执行安全）。
#   2. 脱离进程树：用 WMI Win32_Process.Create 启动，父进程是 WmiPrvSE，
#      不会被其它进程（如 DSH）退出时连带杀死。
#   3. 依赖顺序：先等 QQ 进程起来 → 再拉 SnowLuma（hookAutoLoad 会注入 QQ）→
#      再等 OneBot WS 端口（说明 QQ 已登录）→ 最后拉桥接。
#   4. 全程写日志到 state\autostart.log，出问题能查。
param(
  [int]$SnowLumaWaitSec = 120,
  [int]$OneBotWaitSec = 300
)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$logFile = Join-Path $root 'state\autostart.log'
$qqExe = $env:QQ_EXE  # 例：C:\Program Files\Tencent\QQNT\QQ.exe
$snowDir = $env:SNOWLUMA_DIR  # SnowLuma 安装目录
$ffmpegBin = $env:FFMPEG_BIN  # ffmpeg 所在目录（可选）

if (-not (Test-Path (Split-Path $logFile -Parent))) { New-Item -ItemType Directory -Force -Path (Split-Path $logFile -Parent) | Out-Null }

function Write-Log([string]$msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Test-Port([int]$port) {
  try { return ((Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0) } catch { return $false }
}

function Wait-Port([int]$port, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Port $port) { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}

function Start-Detached {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string]$Arguments = '',
    [string]$WorkingDirectory = '',
    [string]$StdOut = '',
    [string]$StdErr = ''
  )
  # 关键：必须让子进程脱离调用者的 console。
  # WMI/CreateProcess 不带标志会继承 console，调用命令一结束整个 console 组收到 Ctrl+C，
  # 后台服务全灭（日志里就是莫名其妙的 ^C，踩过多次）。
  # node 的 spawn({detached:true}) 用 CREATE_NEW_PROCESS_GROUP 起进程，才能真活过父进程。
  try {
    $nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $nodeExe) { $nodeExe = 'C:\Program Files\nodejs\node.exe' }
    $launch = Join-Path $root 'launch.js'
    $env:LAUNCH_OUT = $StdOut
    $env:LAUNCH_ERR = $StdErr
    $env:LAUNCH_CWD = $WorkingDirectory
    $argList = @($launch, $FilePath)
    if ($Arguments) { $argList += ($Arguments -split '\s+' | Where-Object { $_ }) }
    $out = & $nodeExe @argList
    if ($out) { return [int]$out }
    Write-Log "启动未返回 PID: $FilePath $Arguments"
  } catch {
    Write-Log "启动异常: $($_.Exception.Message)"
  } finally {
    Remove-Item Env:LAUNCH_OUT, Env:LAUNCH_ERR, Env:LAUNCH_CWD -ErrorAction SilentlyContinue
  }
  return $null
}

Write-Log '=== autostart begin ==='

# 1) QQ 客户端
if (Get-Process -Name QQ -ErrorAction SilentlyContinue) {
  Write-Log 'QQ: 已在运行'
} elseif (Test-Path $qqExe) {
  Start-Process -FilePath $qqExe
  Write-Log 'QQ: 已启动（若未设置自动登录，需要手动扫码/登录）'
} else {
  Write-Log "QQ: 找不到 $qqExe"
}

# 等 QQ 进程出现（最多 90s）
$qqDeadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $qqDeadline -and -not (Get-Process -Name QQ -ErrorAction SilentlyContinue)) {
  Start-Sleep -Seconds 3
}

# 1.5) Ollama（本地模型模式要用；它自己没有开机自启项）
if (Test-Port 11434) {
  Write-Log 'Ollama: 已在运行（11434 在听）'
} else {
  $ollamaApp = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe'
  if (Test-Path $ollamaApp) {
    Start-Process -FilePath $ollamaApp -WindowStyle Hidden -ErrorAction SilentlyContinue
    Write-Log 'Ollama: 已启动 ollama app.exe'
  } else {
    $ollamaExe = (Get-Command ollama -ErrorAction SilentlyContinue).Source
    if ($ollamaExe) {
      Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -WindowStyle Hidden -ErrorAction SilentlyContinue
      Write-Log 'Ollama: 已启动 ollama serve'
    } else {
      Write-Log 'Ollama: 未安装，跳过'
    }
  }
  if (-not (Wait-Port 11434 30)) { Write-Log 'Ollama: 等待 11434 超时（本地模型模式下会回退提示）' }
}

# 2) SnowLuma（hookAutoLoad=true，启动后自动注入 QQ 进程）
if (Test-Port 5099) {
  Write-Log 'SnowLuma: 已在运行（5099 在听）'
} else {
  $procId = Start-Detached -FilePath (Join-Path $snowDir 'node.exe') -Arguments 'index.mjs' `
    -WorkingDirectory $snowDir `
    -StdOut (Join-Path $snowDir 'run-boot.out.log') -StdErr (Join-Path $snowDir 'run-boot.err.log')
  Write-Log "SnowLuma: 已启动 PID=$procId"
  if (-not (Wait-Port 5099 $SnowLumaWaitSec)) { Write-Log 'SnowLuma: 等待 5099 超时' }
}

# 3) 等 OneBot（3001 = QQ 已登录且 hook 生效）
if (Wait-Port 3001 $OneBotWaitSec) {
  Write-Log 'OneBot: 3001 已就绪（QQ 已登录）'
} else {
  Write-Log 'OneBot: 3001 仍未就绪（QQ 可能还没登录）；仍会启动桥接，登录后自动连上'
}

# 4) 桥接
if (Test-Port 3100) {
  Write-Log 'bridge: 已在运行（3100 在听）'
} else {
  $env:FFMPEG_PATH = Join-Path $ffmpegBin 'ffmpeg.exe'
  $env:PATH = "$ffmpegBin;$env:PATH"
  $nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $nodeExe) { $nodeExe = 'C:\Program Files\nodejs\node.exe' }
  $procId = Start-Detached -FilePath $nodeExe -Arguments 'src\bridge.js' `
    -WorkingDirectory $root `
    -StdOut (Join-Path $root 'state\bridge.log') -StdErr (Join-Path $root 'state\bridge.err.log')
  Write-Log "bridge: 已启动 PID=$procId"
  if (-not (Wait-Port 3100 90)) { Write-Log 'bridge: 等待 3100 超时' }
  # 桥接优先级调高：本地模型吃满 CPU 时，仍要让 /model api 这类指令能立刻被处理
  if ($procId) {
    try { (Get-Process -Id $procId -ErrorAction Stop).PriorityClass = 'High'; Write-Log 'bridge: 优先级已设为 High' } catch { }
  }
}

# 5) 看门狗（每 30s 检查端口，缺啥拉啥；自己也要被保住）
#    用 node 而不是 powershell：这台机器上从 WMI/cmd 拉起的 powershell 会被安全软件拦成"拒绝访问"。
$wdRunning = $false
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'watchdog\.js' -and $_.CommandLine -notmatch 'Get-CimInstance' } | ForEach-Object { $wdRunning = $true }
if ($wdRunning) {
  Write-Log 'watchdog: 已在运行'
} else {
  Remove-Item (Join-Path $root 'state\watchdog.lock') -Force -ErrorAction SilentlyContinue
  $nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $nodeExe) { $nodeExe = 'C:\Program Files\nodejs\node.exe' }
  $procId = Start-Detached -FilePath $nodeExe -Arguments 'watchdog.js' `
    -WorkingDirectory $root `
    -StdOut (Join-Path $root 'state\watchdog.out.log') -StdErr (Join-Path $root 'state\watchdog.err.log')
  Write-Log "watchdog: 已启动 PID=$procId"
}

Write-Log '=== autostart end ==='
