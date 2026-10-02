# Launch + wait MUST stay in one GHA step. Splitting Start-Process into a later
# step causes Windows runners to tear down the process tree (~silent ~10s exit).
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$TestFile,
  [Parameter(Mandatory = $false)][string]$ExtraArgs = "",
  [Parameter(Mandatory = $false)][string]$LogsDir = "logs",
  [Parameter(Mandatory = $false)][int]$WaitSeconds = 25,
  [Parameter(Mandatory = $false)][switch]$RequireWindow,
  [Parameter(Mandatory = $false)][string]$JobLabel = "app"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

if (-not (Test-Path $ExePath)) {
  throw "Executable not found: $ExePath"
}

Write-Host "=== Launch [$JobLabel] ==="
Write-Host "Exe: $ExePath"
Write-Host "TestFile: $TestFile"
Write-Host "ExtraArgs: $ExtraArgs"
Write-Host "WaitSeconds: $WaitSeconds"

$argList = @()
if ($ExtraArgs -and $ExtraArgs.Trim().Length -gt 0) {
  $argList += ($ExtraArgs -split '\s+' | Where-Object { $_ -ne "" })
}
if ($TestFile -and $TestFile.Trim().Length -gt 0 -and (Test-Path $TestFile)) {
  $argList += $TestFile
}

$stdout = Join-Path $LogsDir "stdout.log"
$stderr = Join-Path $LogsDir "stderr.log"
$diagLog = Join-Path $LogsDir "easyview-diagnostics.log"
$electronLog = Join-Path $LogsDir "electron-debug.log"

$env:EASYVIEW_DIAG = "1"
$env:EASYVIEW_DIAG_LOG = (Resolve-Path $LogsDir).Path + "\easyview-diagnostics.log"
$env:ELECTRON_ENABLE_LOGGING = "1"
$env:ELECTRON_LOG_FILE = (Resolve-Path $LogsDir).Path + "\electron-debug.log"

Write-Host "EASYVIEW_DIAG_LOG=$env:EASYVIEW_DIAG_LOG"
Write-Host "Args: $($argList -join ' ')"

$process = Start-Process -FilePath $ExePath -ArgumentList $argList -PassThru `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr

if (-not $process) {
  throw "Failed to start process"
}

$appPid = $process.Id
Write-Host "Started PID=$appPid"
"APP_PID=$appPid" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8

$aliveAfter2 = $true
Start-Sleep -Seconds 2
if (-not (Get-Process -Id $appPid -ErrorAction SilentlyContinue)) {
  $aliveAfter2 = $false
  Write-Host "Process exited within 2s; ExitCode=$($process.ExitCode)"
}
else {
  Write-Host "Alive after 2s"
}

$checkInterval = 5
$elapsed = 2
$failed = $false
$failReason = ""

while ($elapsed -lt $WaitSeconds) {
  Start-Sleep -Seconds $checkInterval
  $elapsed += $checkInterval
  $proc = Get-Process -Id $appPid -ErrorAction SilentlyContinue
  if (-not $proc) {
    $failed = $true
    $failReason = "Process $appPid exited after ~${elapsed}s (ExitCode=$($process.ExitCode))"
    Write-Host $failReason
    break
  }
  $memMb = [math]::Round($proc.WorkingSet64 / 1MB, 2)
  Write-Host "t=${elapsed}s alive CPU=$($proc.CPU)s MEM=${memMb}MB MainWindow='$($proc.MainWindowTitle)' Handle=$($proc.MainWindowHandle)"
}

$windowOk = $false
$proc = Get-Process -Id $appPid -ErrorAction SilentlyContinue
if ($proc) {
  if ($proc.MainWindowHandle -ne 0) {
    $windowOk = $true
    Write-Host "Window present: '$($proc.MainWindowTitle)'"
  }
  elseif ($RequireWindow) {
    Start-Sleep -Seconds 5
    $proc = Get-Process -Id $appPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne 0) {
      $windowOk = $true
      Write-Host "Window present after extra wait: '$($proc.MainWindowTitle)'"
    }
  }
}

# Screenshot
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
  $shot = Join-Path $LogsDir "screenshot.png"
  $bitmap.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
  Write-Host "Screenshot: $shot ($((Get-Item $shot).Length) bytes)"
}
catch {
  Write-Host "Screenshot failed: $_"
}

# Collect crash dumps / AppData
$appData = [Environment]::GetFolderPath('ApplicationData')
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
$collectDirs = @(
  (Join-Path $appData "EasyView_Md"),
  (Join-Path $localAppData "EasyView_Md"),
  (Join-Path $env:TEMP "EasyView_Md")
)
foreach ($dir in $collectDirs) {
  if (Test-Path $dir) {
    $dest = Join-Path $LogsDir ("appdata-" + (Split-Path $dir -Leaf))
    Write-Host "Copying $dir -> $dest"
    Copy-Item -Path $dir -Destination $dest -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# Event log snippet
try {
  $startTime = (Get-Date).AddMinutes(-15)
  $events = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Level = 2; StartTime = $startTime } -ErrorAction SilentlyContinue |
    Where-Object { $_.Message -match 'EasyView|Electron|node\.exe' } |
    Select-Object -First 20
  if ($events) {
    $events | ForEach-Object {
      "--- Event $($_.Id) $($_.TimeCreated) $($_.ProviderName) ---"
      $_.Message
    } | Out-File (Join-Path $LogsDir "windows-event-log.txt") -Encoding utf8
  }
  else {
    "No matching Application Error events" | Out-File (Join-Path $LogsDir "windows-event-log.txt") -Encoding utf8
  }
}
catch {
  "Event log read failed: $_" | Out-File (Join-Path $LogsDir "windows-event-log.txt") -Encoding utf8
}

# Summary
$summary = [ordered]@{
  jobLabel      = $JobLabel
  pid           = $appPid
  aliveAfter2s  = $aliveAfter2
  survivedWait  = (-not $failed)
  waitSeconds   = $WaitSeconds
  windowOk      = $windowOk
  exitCode      = $process.ExitCode
  failReason    = $failReason
  extraArgs     = $ExtraArgs
  exePath       = $ExePath
}
$summary | ConvertTo-Json | Out-File (Join-Path $LogsDir "summary.json") -Encoding utf8
Write-Host "=== SUMMARY ==="
Get-Content (Join-Path $LogsDir "summary.json")

# Cleanup process
$proc = Get-Process -Id $appPid -ErrorAction SilentlyContinue
if ($proc) {
  Write-Host "Stopping PID $appPid"
  try { $proc.CloseMainWindow() | Out-Null } catch {}
  Start-Sleep -Seconds 2
  $proc = Get-Process -Id $appPid -ErrorAction SilentlyContinue
  if ($proc) { Stop-Process -Id $appPid -Force -ErrorAction SilentlyContinue }
}

if ($failed) {
  Write-Error $failReason
  exit 1
}
if ($RequireWindow -and -not $windowOk) {
  Write-Error "No top-level window appeared"
  exit 1
}

Write-Host "Smoke check passed for [$JobLabel]"
exit 0
