# Smoke test for a built TaskosphereAgent.exe (used by the installer workflow).
#   pwsh installer/smoke-test.ps1 -Exe dist\TaskosphereAgent.exe
# Checks that the agent answers /health and that the tray icon process
# (TaskosphereTray.exe next to it) starts. The backend is pointed at an
# unreachable address and the browser is not opened, so nothing is sent
# anywhere.
param([Parameter(Mandatory = $true)][string]$Exe)

$ErrorActionPreference = 'Stop'
$exePath = (Resolve-Path $Exe).Path
$dir = Split-Path $exePath
$data = Join-Path $env:RUNNER_TEMP ("tsa-smoke-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $data | Out-Null

$env:TASKOSPHERE_BACKEND_URL = 'http://127.0.0.1:9'
$env:TASKOSPHERE_AGENT_NO_BROWSER = '1'
$env:TASKOSPHERE_AGENT_DATA_DIR = $data

Get-Process TaskosphereAgent, TaskosphereTray -ErrorAction SilentlyContinue | Stop-Process -Force
$p = Start-Process -FilePath $exePath -PassThru -WindowStyle Hidden
try {
  $ok = $false
  for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
    Start-Sleep -Seconds 1
    try { $r = Invoke-RestMethod http://127.0.0.1:7432/health; $ok = ($r.status -eq 'ok') } catch {}
  }
  if (-not $ok) { throw "agent did not answer /health" }
  Write-Host "agent /health ok, version $($r.version)"

  if (Test-Path (Join-Path $dir 'TaskosphereTray.exe')) {
    $tray = $null
    for ($i = 0; $i -lt 20 -and -not $tray; $i++) {
      Start-Sleep -Seconds 1
      $tray = Get-Process TaskosphereTray -ErrorAction SilentlyContinue
    }
    if (-not $tray) {
      Get-Content (Join-Path $data 'agent.log') -ErrorAction SilentlyContinue | Select-Object -Last 40
      throw "tray icon process did not start"
    }
    Start-Sleep -Seconds 5
    if ($tray.HasExited -or -not (Get-Process -Id $tray.Id -ErrorAction SilentlyContinue)) { throw "tray icon process exited" }
    Write-Host "tray icon process running (pid $($tray.Id))"
  }
  Get-Content (Join-Path $data 'agent.log') -ErrorAction SilentlyContinue | Select-Object -Last 15
}
finally {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  Get-Process TaskosphereTray -ErrorAction SilentlyContinue | Stop-Process -Force
}
