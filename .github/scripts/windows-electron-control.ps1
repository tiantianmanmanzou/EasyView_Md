param(
  [Parameter(Mandatory = $false)][string]$LogsDir = "logs-control",
  [Parameter(Mandatory = $false)][int]$WaitSeconds = 25,
  [Parameter(Mandatory = $false)][string]$ExtraArgs = ""
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

$controlDir = Join-Path $env:GITHUB_WORKSPACE ".github\electron-control"
Set-Location $controlDir

Write-Host "Installing electron control deps..."
npm install --no-fund --no-audit

$electronCmd = Join-Path $controlDir "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electronCmd)) {
  # Fallback to npx path resolution
  $electronCmd = (Get-Command npx -ErrorAction SilentlyContinue)
  throw "electron.exe not found after npm install under $controlDir"
}

Write-Host "Electron control exe: $electronCmd"
& $electronCmd --version

$stdout = Join-Path $LogsDir "stdout.log"
$stderr = Join-Path $LogsDir "stderr.log"
$mainJs = Join-Path $controlDir "main.js"

# Move cwd log into LogsDir via env if needed; control app writes electron-control.log in cwd
$argList = @(".")
if ($ExtraArgs -and $ExtraArgs.Trim().Length -gt 0) {
  $argList = @($ExtraArgs -split '\s+' | Where-Object { $_ -ne "" }) + $argList
}

Write-Host "Starting control with args: $($argList -join ' ')"
$process = Start-Process -FilePath $electronCmd -ArgumentList $argList -WorkingDirectory $controlDir -PassThru `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr

$appPid = $process.Id
Write-Host "Control PID=$appPid"

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
    $failReason = "Control Electron exited after ~${elapsed}s ExitCode=$($process.ExitCode)"
    Write-Host $failReason
    break
  }
  Write-Host "t=${elapsed}s control alive MainWindow='$($proc.MainWindowTitle)' Handle=$($proc.MainWindowHandle)"
}

$windowOk = $false
$proc = Get-Process -Id $appPid -ErrorAction SilentlyContinue
if ($proc -and $proc.MainWindowHandle -ne 0) {
  $windowOk = $true
  Write-Host "Control window: $($proc.MainWindowTitle)"
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
  Write-Host "Screenshot saved $shot"
}
catch {
  Write-Host "Screenshot failed: $_"
}

if (Test-Path (Join-Path $controlDir "electron-control.log")) {
  Copy-Item (Join-Path $controlDir "electron-control.log") (Join-Path $LogsDir "electron-control.log") -Force
}

$summary = [ordered]@{
  jobLabel     = "electron-control"
  pid          = $appPid
  survivedWait = (-not $failed)
  waitSeconds  = $WaitSeconds
  windowOk     = $windowOk
  exitCode     = $process.ExitCode
  failReason   = $failReason
  extraArgs    = $ExtraArgs
  electronExe  = $electronCmd
}
$summary | ConvertTo-Json | Out-File (Join-Path $LogsDir "summary.json") -Encoding utf8
Get-Content (Join-Path $LogsDir "summary.json")

$proc = Get-Process -Id $appPid -ErrorAction SilentlyContinue
if ($proc) {
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
  Write-Error "Control app had no top-level window"
  exit 1
}

Write-Host "Control smoke passed"
exit 0
