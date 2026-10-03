# Launch + wait MUST stay in one GHA step. Splitting Start-Process into a later
# step causes Windows runners to tear down the process tree (~silent ~10s exit).
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$TestFile,
  [Parameter(Mandatory = $false)][string]$LogsDir = "logs",
  [Parameter(Mandatory = $false)][int]$WaitSeconds = 25,
  [Parameter(Mandatory = $false)][string]$JobLabel = "app"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
$LogsDir = (Resolve-Path $LogsDir).Path

if (-not (Test-Path $ExePath)) {
  throw "Executable not found: $ExePath"
}
if (-not (Test-Path $TestFile)) {
  throw "Test markdown file not found: $TestFile"
}

Write-Host "=== Launch [$JobLabel] ==="
Write-Host "Exe: $ExePath"
Write-Host "TestFile: $TestFile"
Write-Host "WaitSeconds: $WaitSeconds"

$stdout = Join-Path $LogsDir "stdout.log"
$stderr = Join-Path $LogsDir "stderr.log"

$process = Start-Process -FilePath $ExePath -ArgumentList @($TestFile) -PassThru `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr

if (-not $process) {
  throw "Failed to start process"
}

$appPid = $process.Id
Write-Host "Started PID=$appPid"

$failed = $false
$failReason = ""
$elapsed = 0
$checkInterval = 5

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
if ($proc -and $proc.MainWindowHandle -ne 0) {
  $windowOk = $true
  Write-Host "Window present: '$($proc.MainWindowTitle)'"
}
elseif ($proc) {
  Write-Host "No main window yet; waiting 5s more..."
  Start-Sleep -Seconds 5
  $proc = Get-Process -Id $appPid -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne 0) {
    $windowOk = $true
    Write-Host "Window present: '$($proc.MainWindowTitle)'"
  }
}

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

$summary = [ordered]@{
  jobLabel     = $JobLabel
  pid          = $appPid
  survivedWait = (-not $failed)
  waitSeconds  = $WaitSeconds
  windowOk     = $windowOk
  exitCode     = $process.ExitCode
  failReason   = $failReason
  exePath      = $ExePath
  testFile     = $TestFile
}
$summary | ConvertTo-Json | Out-File (Join-Path $LogsDir "summary.json") -Encoding utf8
Write-Host "=== SUMMARY ==="
Get-Content (Join-Path $LogsDir "summary.json")

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
if (-not $windowOk) {
  Write-Error "No top-level window appeared for [$JobLabel]"
  exit 1
}

Write-Host "Smoke check passed for [$JobLabel]"
exit 0
