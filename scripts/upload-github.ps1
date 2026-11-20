param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Owner = 'RDYRD',
  [string]$Repo = 'dsh-imagegen',
  [string]$Root = '',
  [string]$Description = 'DSH plugin: Seedream image generation with in-composer toggle, settings page and usage dashboard'
)

if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
Write-Output "root: $Root"

$ErrorActionPreference = 'Stop'
$headers = @{
  Authorization = "token $Token"
  'User-Agent'  = 'dsh-imagegen-uploader'
  Accept        = 'application/vnd.github+json'
}

function Api([string]$Method, [string]$Uri, $Body) {
  $json = $null
  if ($null -ne $Body) { $json = $Body | ConvertTo-Json -Depth 6 -Compress }
  try {
    if ($json) {
      $bytes = [Text.Encoding]::UTF8.GetBytes($json)
      return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $headers -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 60
    }
    return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $headers -TimeoutSec 60
  } catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    throw "HTTP $code $Method $Uri :: $($_.Exception.Message)"
  }
}

$exists = $false
try {
  $null = Api 'GET' "https://api.github.com/repos/$Owner/$Repo"
  $exists = $true
  Write-Output "repo exists: $Owner/$Repo"
} catch {
  if ($_.Exception.Message -match '^HTTP 404') {
    Write-Output "repo missing, will create: $Owner/$Repo"
  } else {
    throw
  }
}

if (-not $exists) {
  $created = Api 'POST' 'https://api.github.com/user/repos' @{
    name        = $Repo
    description = $Description
    private     = $false
    has_issues  = $true
    has_wiki    = $false
    auto_init   = $false
  }
  Write-Output ("created: " + $created.html_url + " default=" + $created.default_branch)
  Start-Sleep -Seconds 2
}

$skipDirs = @('node_modules', '.git', 'images', 'dist')
$all = Get-ChildItem $Root -Recurse -File
$files = @()
foreach ($f in $all) {
  $rel = $f.FullName.Substring($Root.Length + 1).Replace('\', '/')
  $parts = $rel -split '/'
  $bad = $false
  if ($parts.Length -gt 1) {
    for ($i = 0; $i -lt ($parts.Length - 1); $i++) {
      if ($skipDirs -contains $parts[$i]) { $bad = $true }
    }
  }
  if ($bad) { continue }
  if ($rel -like 'test-*') { continue }
  if ($rel -like '*secrets.env') { continue }
  if ($rel -match '\.(log|secret)$') { continue }
  $files += $rel
}
$files = $files | Sort-Object
Write-Output ("files: " + $files.Count)

$ok = 0
foreach ($rel in $files) {
  $path = Join-Path $Root ($rel.Replace('/', '\'))
  $bytes = [IO.File]::ReadAllBytes($path)
  $body = @{
    message = "add $rel"
    content = [Convert]::ToBase64String($bytes)
    branch  = 'main'
  }
  try {
    $cur = Api 'GET' ("https://api.github.com/repos/$Owner/$Repo/contents/" + $rel + '?ref=main')
    if ($cur -and $cur.sha) {
      $body.sha = $cur.sha
      $body.message = "update $rel"
    }
  } catch {
    # new file
  }
  try {
    $null = Api 'PUT' ("https://api.github.com/repos/$Owner/$Repo/contents/" + $rel) $body
    $ok++
    Write-Output ("  ok  $rel")
  } catch {
    Write-Output ("  FAIL $rel :: " + $_.Exception.Message)
  }
}

Write-Output ("uploaded $ok / " + $files.Count)
Write-Output ("url https://github.com/$Owner/$Repo")
