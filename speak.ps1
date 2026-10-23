param(
  [Parameter(Mandatory = $true)][string]$Text,
  [string]$Target = 'group:<群号>',
  [string]$Voice = 'zh-CN-XiaoyiNeural',
  [string]$Rate = '+0%',
  [string]$Volume = '+0%',
  [ValidateSet('auto', 'edge', 'sapi')][string]$Engine = 'auto',
  [string]$Prefix = 'say',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$audioDir = Join-Path $root 'audio'
$tokenFile = Join-Path $root 'state\console-token'

if (-not (Test-Path $audioDir)) { New-Item -ItemType Directory -Force -Path $audioDir | Out-Null }
if (-not (Test-Path $tokenFile)) { throw "console token not found: $tokenFile (is the bridge running?)" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $audioDir "$Prefix-$stamp.mp3"

function Invoke-EdgeTts {
  & python -m edge_tts -t $Text -v $Voice "--rate=$Rate" "--volume=$Volume" --write-media $out 2>&1 | Out-Null
  return (Test-Path $out) -and ((Get-Item $out).Length -gt 0)
}

function Invoke-SapiTts {
  $wav = [System.IO.Path]::ChangeExtension($out, '.wav')
  Add-Type -AssemblyName System.Speech
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try { $s.SelectVoice($Voice) } catch {
    $zh = ($s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } | Where-Object { $_.Culture.Name -eq 'zh-CN' } | Select-Object -First 1)
    if ($zh) { $s.SelectVoice($zh.Name) }
  }
  $s.SetOutputToWaveFile($wav)
  $s.Speak($Text)
  $s.Dispose()
  if (-not (Test-Path $wav)) { return $false }
  $ff = if ($env:FFMPEG_PATH) { $env:FFMPEG_PATH } else { "ffmpeg" }
  if (Test-Path $ff) {
    & $ff -y -loglevel error -i $wav -ac 1 -ar 24000 -b:a 48k $out 2>&1 | Out-Null
    Remove-Item $wav -Force
  } else {
    Move-Item $wav $out -Force
  }
  return (Test-Path $out) -and ((Get-Item $out).Length -gt 0)
}

$ok = $false
if ($Engine -eq 'edge' -or $Engine -eq 'auto') { $ok = Invoke-EdgeTts }
if (-not $ok -and ($Engine -eq 'sapi' -or $Engine -eq 'auto')) {
  Write-Output 'edge-tts failed, falling back to SAPI'
  $ok = Invoke-SapiTts
}
if (-not $ok) { throw 'TTS failed for both engines' }

Write-Output ("audio: {0} ({1} KB)" -f $out, [math]::Round((Get-Item $out).Length / 1KB, 1))

if ($DryRun) { Write-Output 'dry run, not sending'; exit 0 }

$token = (Get-Content $tokenFile -Raw).Trim()
$leaf = Split-Path -Leaf $out
$body = @{ target = $Target; file = $leaf } | ConvertTo-Json -Compress
$tmp = Join-Path $env:TEMP "qqbridge-voice-$stamp.json"
[System.IO.File]::WriteAllText($tmp, $body, (New-Object System.Text.UTF8Encoding($false)))
try {
  $resp = & curl.exe -sS --max-time 60 -X POST 'http://127.0.0.1:3100/api/send/voice' `
    -H "x-console-token: $token" -H 'Content-Type: application/json' `
    --data-binary "@$tmp" 2>&1
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
Write-Output ("bridge: " + ($resp -join ''))
