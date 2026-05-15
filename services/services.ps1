# GT7 Telemetry Analyzer — service controller (PowerShell)
#
# One script, three actions:
#   .\services\services.ps1 start      # start exporter, prometheus, grafana
#   .\services\services.ps1 stop       # stop all three (port-based)
#   .\services\services.ps1 restart    # stop + start
#   .\services\services.ps1 status     # show what's listening
#
# Port-based, no PID files. Each service is identified by its listening port.

param(
  [Parameter(Position=0)]
  [ValidateSet('start','stop','restart','status')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

# Resolve repo root (parent of this script's directory)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir

$Services = @(
  @{
    Name = 'exporter'
    Port = 9477
    Cmd  = 'node'
    Args = @('index.js')
    Cwd  = $RepoRoot
    Log  = (Join-Path $RepoRoot 'exporter.log')
    Url  = 'http://localhost:9477/'
  },
  @{
    Name = 'prometheus'
    Port = 9090
    Cmd  = (Join-Path $RepoRoot 'monitoring\native\prometheus-2.54.1.windows-amd64\prometheus.exe')
    Args = @(
      '--config.file=monitoring/prometheus/prometheus.yml',
      '--storage.tsdb.path=monitoring/native/prom-data',
      '--web.listen-address=:9090'
    )
    Cwd  = $RepoRoot
    Log  = (Join-Path $RepoRoot 'monitoring\native\prometheus.log')
    Url  = 'http://localhost:9090/'
  },
  @{
    Name = 'grafana'
    Port = 3000
    Cmd  = (Join-Path $RepoRoot 'monitoring\native\grafana-v11.2.0\bin\grafana-server.exe')
    Args = @()
    Cwd  = (Join-Path $RepoRoot 'monitoring\native\grafana-v11.2.0')
    Log  = (Join-Path $RepoRoot 'monitoring\native\grafana-startup.log')
    Url  = 'http://localhost:3000/'
    Env  = @{
      GF_PATHS_DATA = (Join-Path $RepoRoot 'monitoring\native\grafana-data')
      GF_PATHS_LOGS = (Join-Path $RepoRoot 'monitoring\native\grafana-logs')
      GF_DASHBOARDS_MIN_REFRESH_INTERVAL = '1s'
    }
  }
)

function Get-OwnerPid([int]$Port) {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($c) { return $c.OwningProcess } else { return $null }
}

function Stop-Service-ByPort([hashtable]$Svc) {
  $svcPid = Get-OwnerPid $Svc.Port
  if (-not $svcPid) {
    Write-Host ("  {0,-12} not running" -f $Svc.Name) -ForegroundColor DarkGray
    return $false
  }
  $p = Get-Process -Id $svcPid -ErrorAction SilentlyContinue
  $procName = if ($p) { $p.ProcessName } else { 'unknown' }
  Stop-Process -Id $svcPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300
  $still = Get-OwnerPid $Svc.Port
  if ($still) {
    Write-Host ("  {0,-12} FAILED to stop pid {1} ({2})" -f $Svc.Name, $svcPid, $procName) -ForegroundColor Red
    return $false
  } else {
    Write-Host ("  {0,-12} stopped (pid {1}, {2})" -f $Svc.Name, $svcPid, $procName) -ForegroundColor Yellow
    return $true
  }
}

function Start-Service([hashtable]$Svc) {
  if (Get-OwnerPid $Svc.Port) {
    Write-Host ("  {0,-12} already running on port {1}" -f $Svc.Name, $Svc.Port) -ForegroundColor DarkGray
    return $false
  }
  if (-not (Test-Path $Svc.Cmd) -and -not (Get-Command $Svc.Cmd -ErrorAction SilentlyContinue)) {
    Write-Host ("  {0,-12} EXECUTABLE NOT FOUND: {1}" -f $Svc.Name, $Svc.Cmd) -ForegroundColor Red
    return $false
  }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Svc.Cmd
  foreach ($a in $Svc.Args) { [void]$startInfo.ArgumentList.Add($a) }
  $startInfo.WorkingDirectory = $Svc.Cwd
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError  = $true
  $startInfo.CreateNoWindow = $true
  if ($Svc.ContainsKey('Env')) {
    foreach ($k in $Svc.Env.Keys) { $startInfo.Environment[$k] = $Svc.Env[$k] }
  }
  $proc = [System.Diagnostics.Process]::Start($startInfo)
  # Tail stdout/stderr into a log file in the background.
  $logPath = $Svc.Log
  Start-Job -ScriptBlock {
    param($p, $log)
    Set-Content -Path $log -Value "--- start $(Get-Date) ---"
    while (-not $p.HasExited) {
      $line = $p.StandardOutput.ReadLine(); if ($null -ne $line) { Add-Content -Path $log -Value $line }
      $err  = $p.StandardError.ReadLine();  if ($null -ne $err)  { Add-Content -Path $log -Value "STDERR: $err" }
      Start-Sleep -Milliseconds 50
    }
  } -ArgumentList $proc, $logPath | Out-Null

  # Wait up to 30s for the port to come alive (Grafana can take 10-20s on cold boot).
  $waited = 0
  while ($waited -lt 30000 -and -not (Get-OwnerPid $Svc.Port)) {
    Start-Sleep -Milliseconds 250
    $waited += 250
  }
  if (Get-OwnerPid $Svc.Port) {
    Write-Host ("  {0,-12} started pid {1}  -> {2}" -f $Svc.Name, $proc.Id, $Svc.Url) -ForegroundColor Green
    return $true
  } else {
    Write-Host ("  {0,-12} STARTED pid {1} but port {2} did not open within 15s — check {3}" -f $Svc.Name, $proc.Id, $Svc.Port, $Svc.Log) -ForegroundColor Red
    return $false
  }
}

function Show-Status([hashtable]$Svc) {
  $svcPid = Get-OwnerPid $Svc.Port
  if ($svcPid) {
    $p = Get-Process -Id $svcPid -ErrorAction SilentlyContinue
    $procName = if ($p) { $p.ProcessName } else { '?' }
    $age = if ($p) { ((Get-Date) - $p.StartTime).ToString('hh\:mm\:ss') } else { '?' }
    Write-Host ("  {0,-12} RUNNING pid {1} ({2}) uptime {3}  {4}" -f $Svc.Name, $svcPid, $procName, $age, $Svc.Url) -ForegroundColor Green
  } else {
    Write-Host ("  {0,-12} stopped" -f $Svc.Name) -ForegroundColor DarkGray
  }
}

switch ($Action) {
  'start' {
    Write-Host "Starting GT7 telemetry services..." -ForegroundColor Cyan
    foreach ($s in $Services) { Start-Service $s | Out-Null }
    Write-Host ""
    Write-Host "Open http://localhost:9477/  (local UI)" -ForegroundColor Cyan
    Write-Host "Open http://localhost:3000/  (Grafana)" -ForegroundColor Cyan
  }
  'stop' {
    Write-Host "Stopping GT7 telemetry services..." -ForegroundColor Cyan
    foreach ($s in $Services) { Stop-Service-ByPort $s | Out-Null }
  }
  'restart' {
    Write-Host "Restarting GT7 telemetry services..." -ForegroundColor Cyan
    foreach ($s in $Services) { Stop-Service-ByPort $s | Out-Null }
    Start-Sleep -Milliseconds 500
    foreach ($s in $Services) { Start-Service $s | Out-Null }
  }
  'status' {
    Write-Host "Service status:" -ForegroundColor Cyan
    foreach ($s in $Services) { Show-Status $s }
  }
}
