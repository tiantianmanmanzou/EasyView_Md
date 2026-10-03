# Resolve the latest GitHub Release asset that looks like the Windows x64 zip.
# Writes DOWNLOAD_URL and RELEASE_TAG to GITHUB_ENV.
param(
  [Parameter(Mandatory = $false)][string]$Repo = $env:GITHUB_REPOSITORY
)

$ErrorActionPreference = "Stop"

if (-not $Repo) {
  throw "GITHUB_REPOSITORY is not set and -Repo was not provided"
}

Write-Host "Resolving latest Windows x64 zip from GitHub Releases for $Repo ..."

$headers = @{
  Accept                 = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
}
if ($env:GITHUB_TOKEN) {
  $headers.Authorization = "Bearer $($env:GITHUB_TOKEN)"
}

$releasesUrl = "https://api.github.com/repos/$Repo/releases?per_page=20"
try {
  $releases = Invoke-RestMethod -Uri $releasesUrl -Headers $headers -Method Get
}
catch {
  throw "Failed to list GitHub Releases for ${Repo}: $_"
}

if (-not $releases -or $releases.Count -eq 0) {
  throw @"
No GitHub Releases found for $Repo.
Publish a Release that includes a Windows x64 zip asset (e.g. EasyView_Md-win-x64.zip), then re-run this workflow.
"@
}

# Prefer non-draft, non-prerelease; fall back to newest non-draft including prerelease.
$candidates = @($releases | Where-Object { -not $_.draft -and -not $_.prerelease })
if ($candidates.Count -eq 0) {
  $candidates = @($releases | Where-Object { -not $_.draft })
}
if ($candidates.Count -eq 0) {
  throw "Only draft releases exist for $Repo; publish a non-draft Release with a Windows x64 zip asset."
}

$patterns = @(
  '(?i)EasyView_Md-win-x64\.zip$',
  '(?i)EasyView_Md.*win.*x64.*\.zip$',
  '(?i).*win32-x64.*\.zip$',
  '(?i).*win-x64.*\.zip$',
  '(?i).*windows.*x64.*\.zip$'
)

foreach ($release in $candidates) {
  $assets = @($release.assets)
  Write-Host "Checking release $($release.tag_name) ($($assets.Count) assets)"
  foreach ($pattern in $patterns) {
    $match = $assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
    if ($match) {
      Write-Host "Matched asset '$($match.name)' on release $($release.tag_name)"
      Write-Host "browser_download_url=$($match.browser_download_url)"
      "DOWNLOAD_URL=$($match.browser_download_url)" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
      "RELEASE_TAG=$($release.tag_name)" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
      "RELEASE_ASSET=$($match.name)" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
      exit 0
    }
  }
}

$listed = ($candidates | ForEach-Object {
  $names = @($_.assets | ForEach-Object { $_.name }) -join ', '
  if (-not $names) { $names = '(no assets)' }
  "  - $($_.tag_name): $names"
}) -join "`n"

throw @"
No Windows x64 zip asset found on the latest GitHub Release(s) for $Repo.
Expected an asset name like EasyView_Md-win-x64.zip.
Recent releases:
$listed
"@
