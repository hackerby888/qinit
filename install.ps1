# Downloads the newest Windows qinit CLI to %LOCALAPPDATA%\qinit\bin.
# Override the destination with $env:QINIT_BIN.
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo   = "hackerby888/qinit"
$BinDir = if ($env:QINIT_BIN) { $env:QINIT_BIN } else { Join-Path $env:LOCALAPPDATA "qinit\bin" }

# Only x64 ships today; ARM64 Windows runs it under emulation.
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq "AMD64" -or $arch -eq "x86" -or $arch -eq "ARM64") {
  $assetArch = "x64"
} else {
  Write-Error "qinit: unsupported arch '$arch'"
  return
}
$asset = "qinit-windows-$assetArch.exe"

# Resolve the newest qinit-cli-* tag from the API (NOT /releases/latest - verify-latest can hijack it).
Write-Host "qinit: resolving latest release..."
try {
  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases" -Headers @{ "User-Agent" = "qinit-installer" }
} catch {
  Write-Error "qinit: GitHub API unreachable ($($_.Exception.Message))"
  return
}
$tag = ($releases | Where-Object { $_.tag_name -like "qinit-cli-*" } | Select-Object -First 1).tag_name
if (-not $tag) {
  Write-Error "qinit: could not find a qinit-cli-* release"
  return
}
$base = "https://github.com/$Repo/releases/download/$tag"

$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("qinit-" + [Guid]::NewGuid().ToString("N"))) -Force
try {
  $dl = Join-Path $tmp "qinit.exe"
  Write-Host "qinit: downloading $asset ($tag)..."
  try {
    Invoke-WebRequest -Uri "$base/$asset" -OutFile $dl -UseBasicParsing
  } catch {
    Write-Error "qinit: download failed ($base/$asset)"
    return
  }

  # Verify sha256 against SHA256SUMS if present (lines: "<sha>  <name>", optional '*' before name).
  try {
    # PowerShell may return release assets as bytes, so decode before matching.
    $response = Invoke-WebRequest -Uri "$base/SHA256SUMS" -UseBasicParsing
    if ($response.Content -is [byte[]]) {
      $sums = [Text.Encoding]::UTF8.GetString($response.Content)
    } else {
      $sums = [string]$response.Content
    }
    $checksumPattern = '(?m)^([0-9a-fA-F]{64})\s+\*?' + [regex]::Escape($asset) + '\s*$'
    $checksumMatch = [regex]::Match($sums, $checksumPattern)
    if ($checksumMatch.Success) {
      $want = $checksumMatch.Groups[1].Value.ToLower()
      $got = (Get-FileHash -Algorithm SHA256 $dl).Hash.ToLower()
      if ($got -ne $want) {
        Write-Error "qinit: sha256 mismatch (want $want got $got)"
        return
      }
      Write-Host "qinit: sha256 ok"
    }
  } catch {
    # SHA256SUMS is optional.
  }

  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  $dest = Join-Path $BinDir "qinit.exe"
  # Windows locks a running .exe; if qinit is running, move the old one aside (rename is allowed) before copy.
  if (Test-Path $dest) {
    try {
      Move-Item -Force $dest "$dest.old"
    } catch {}
  }
  Move-Item -Force $dl $dest
  Write-Host "qinit: installed -> $dest"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# Add BinDir to the user PATH if missing (takes effect in new terminals).
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ';') -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable("Path", (($userPath.TrimEnd(';')) + ";" + $BinDir), "User")
  Write-Host "qinit: added $BinDir to your user PATH - open a new terminal to use 'qinit'"
}
# Make qinit available in this session too.
$env:Path = "$env:Path;$BinDir"
& (Join-Path $BinDir "qinit.exe") version 2>$null
