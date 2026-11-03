# SPDX-License-Identifier: Apache-2.0
# Crewtree installer for Windows (PLAN.md 16.1). No admin rights; never touches ~/.claude.
#
#   irm https://github.com/NamHuynh98/Crewtree/releases/latest/download/install.ps1 | iex
#
# Environment:
#   CREWTREE_VERSION      release tag to install (default: latest)
#   CREWTREE_INSTALL_DIR  versions folder (default: %USERPROFILE%\.crewtree\app)
#   CREWTREE_ARCHIVE      install from a local .zip (with SHA256SUMS next to it) instead of downloading
#   NO_COLOR              plain output

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'NamHuynh98/Crewtree'
$CrewtreeDir = if ($env:CREWTREE_DIR) { $env:CREWTREE_DIR } else { Join-Path $env:USERPROFILE '.crewtree' }
$InstallDir = if ($env:CREWTREE_INSTALL_DIR) { $env:CREWTREE_INSTALL_DIR } else { Join-Path $CrewtreeDir 'app' }
$BinDir = Join-Path $CrewtreeDir 'bin'
$Started = Get-Date

New-Item -ItemType Directory -Force -Path (Join-Path $CrewtreeDir 'logs') | Out-Null
$Log = Join-Path $CrewtreeDir ("logs\install-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Set-Content -Path $Log -Value "Crewtree install $(Get-Date -Format o)"

$Color = -not $env:NO_COLOR -and -not [Console]::IsOutputRedirected
function Write-Log([string]$Text) { Add-Content -Path $Log -Value $Text }
function Step([int]$N, [string]$Label) {
  Write-Host ''
  Write-Host ("  [{0}/4] {1}" -f $N, $Label)
  Write-Log "[$N/4] $Label"
}
function Ok([string]$Text) {
  if ($Color) { Write-Host '      ' -NoNewline; Write-Host 'OK' -ForegroundColor Green -NoNewline; Write-Host " $Text" }
  else { Write-Host "      OK $Text" }
  Write-Log "  ok: $Text"
}
function Fail([string]$Text, [string]$Hint = '') {
  if ($Color) { Write-Host '      ' -NoNewline; Write-Host 'X' -ForegroundColor Red -NoNewline; Write-Host " $Text" }
  else { Write-Host "      X $Text" }
  if ($Hint) { Write-Host "        $Hint" }
  Write-Log "error: $Text $Hint"
  Write-Host ''
  Write-Host "  Log: $Log"
  throw "Crewtree install failed: $Text"
}

Write-Host 'Crewtree installer'

# ------------------------------------------------------------------ 1. environment
Step 1 'Checking environment'
$Arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  default { Fail "Unsupported CPU: $($env:PROCESSOR_ARCHITECTURE)" }
}
Ok "win32-$Arch"

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) { Fail 'Node.js is not installed' 'Install Node 22 LTS from https://nodejs.org and run this again.' }
$NodeMajor = [int](& node -p 'process.versions.node.split(".")[0]')
if ($NodeMajor -lt 22) { Fail "Node $(& node -v) is too old: Crewtree needs Node 22 or newer" 'Install Node 22 LTS from https://nodejs.org' }
Ok "Node $(& node -v)"
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm is missing' 'It comes with Node.js; reinstall Node 22.' }

if (Get-Command claude -ErrorAction SilentlyContinue) {
  Ok "Claude Code $((& claude --version 2>$null) | Select-Object -First 1)"
} elseif (-not $env:CREWTREE_SKIP_CLAUDE_CHECK) {
  Fail 'Claude Code is not installed' 'Install it (https://docs.claude.com/claude-code), run `claude` once to log in, then run this again.'
}

$GitBash = @($env:CLAUDE_CODE_GIT_BASH_PATH, 'C:\Program Files\Git\bin\bash.exe', 'C:\Program Files (x86)\Git\bin\bash.exe', (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')) |
  Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($GitBash) { Ok "Git Bash $GitBash" }
else { Write-Host '      ! Git Bash not found: Claude Code needs it for the Bash tool (install Git for Windows)'; Write-Log 'warn: no Git Bash' }

# ------------------------------------------------------------------ 2. download
Step 2 'Downloading'
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("crewtree-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  if ($env:CREWTREE_ARCHIVE) {
    if (-not (Test-Path $env:CREWTREE_ARCHIVE)) { Fail "Archive not found: $($env:CREWTREE_ARCHIVE)" }
    $Name = Split-Path $env:CREWTREE_ARCHIVE -Leaf
    Copy-Item $env:CREWTREE_ARCHIVE (Join-Path $Tmp $Name)
    $SumsSrc = Join-Path (Split-Path $env:CREWTREE_ARCHIVE -Parent) 'SHA256SUMS'
    if (-not (Test-Path $SumsSrc)) { Fail 'SHA256SUMS not found next to the archive' }
    Copy-Item $SumsSrc (Join-Path $Tmp 'SHA256SUMS')
    if ($Name -notmatch "^crewtree-(v[^-]+(-[0-9A-Za-z.]+)?)-win32-$Arch\.zip$") { Fail "Unexpected archive name: $Name" }
    $Version = $Matches[1]
    Ok "local archive $Name"
  } else {
    $Headers = @{ 'User-Agent' = 'crewtree-installer'; Accept = 'application/vnd.github+json' }
    if ($env:CREWTREE_VERSION) {
      $Version = 'v' + ($env:CREWTREE_VERSION -replace '^v', '')
    } else {
      try { $Version = (Invoke-RestMethod -Headers $Headers "https://api.github.com/repos/$Repo/releases/latest").tag_name }
      catch { Fail 'Could not find the latest release' 'Check your connection, or set $env:CREWTREE_VERSION="v0.1.0"' }
    }
    $Base = "https://github.com/$Repo/releases/download/$Version"
    $Name = "crewtree-$Version-win32-$Arch.zip"
    Write-Host "      $Name"
    try { Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Name" -OutFile (Join-Path $Tmp $Name) }
    catch { Fail "Download failed: $Base/$Name" }
    try { Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS" -OutFile (Join-Path $Tmp 'SHA256SUMS') }
    catch { Fail 'SHA256SUMS is missing in the release' 'Refusing to install an unverified download.' }
    Ok "downloaded $Version"
  }

  # ---------------------------------------------------------------- 3. verify & extract
  Step 3 'Verifying & extracting'
  $Line = Get-Content (Join-Path $Tmp 'SHA256SUMS') | Where-Object { $_ -match "\s\*?$([regex]::Escape($Name))$" } | Select-Object -First 1
  if (-not $Line) { Fail "$Name is not listed in SHA256SUMS" }
  $Expected = ($Line -split '\s+')[0].ToLower()
  $Actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Tmp $Name)).Hash.ToLower()
  if ($Expected -ne $Actual) {
    Remove-Item (Join-Path $Tmp $Name) -Force
    Fail 'Checksum mismatch: the download was deleted' "expected $Expected, got $Actual"
  }
  Ok 'SHA256 OK'

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Expand-Archive -Path (Join-Path $Tmp $Name) -DestinationPath (Join-Path $Tmp 'x') -Force
  $Extracted = Join-Path $Tmp "x\crewtree-$Version-win32-$Arch"
  if (-not (Test-Path (Join-Path $Extracted 'VERSION'))) { Fail 'The archive is not a Crewtree bundle' }
  # The Claude Agent SDK is not redistributed: npm installs the pinned version from the registry (see NOTICE)
  Write-Host '      installing the Claude Agent SDK from npm...'
  Push-Location $Extracted
  try {
    & npm install --omit=dev --no-audit --no-fund --loglevel=error *>> $Log
    if ($LASTEXITCODE -ne 0) { Fail 'npm install of the Claude Agent SDK failed' 'See the log; check your connection to registry.npmjs.org.' }
  } finally { Pop-Location }

  $Target = Join-Path $InstallDir $Version
  if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
  Move-Item $Extracted $Target

  $Current = Join-Path $InstallDir 'current'
  $Previous = ''
  if (Test-Path $Current) {
    $Previous = Split-Path (Get-Item $Current).Target -Leaf
    (Get-Item $Current).Delete()  # removes the junction only, never its target
  }
  New-Item -ItemType Junction -Path $Current -Target $Target | Out-Null
  $Versions = @{ current = $Version }
  if ($Previous -and $Previous -ne $Version) { $Versions.previous = $Previous }
  $Versions | ConvertTo-Json | Set-Content -Path (Join-Path $InstallDir 'versions.json')
  Ok $Target
} finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# ------------------------------------------------------------------ 4. set up
Step 4 'Setting up'
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Shim = Join-Path $BinDir 'crewtree.cmd'
Set-Content -Path $Shim -Encoding ASCII -Value "@echo off`r`nnode `"$InstallDir\current\cli\dist\index.js`" %*"
Ok "crewtree -> $Shim"

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($UserPath -split ';') -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable('Path', (($UserPath, $BinDir) | Where-Object { $_ }) -join ';', 'User')
  $env:Path = "$env:Path;$BinDir"
  Ok "added $BinDir to your user PATH (new terminals pick it up)"
} else {
  Ok "$BinDir is on PATH"
}

$Elapsed = [int]((Get-Date) - $Started).TotalSeconds
Write-Host ''
Write-Host "  Crewtree $Version installed in ${Elapsed}s"
Write-Host '    Start it in a project folder:  crewtree'
Write-Host "    Log: $Log"
