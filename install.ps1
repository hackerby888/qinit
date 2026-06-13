# qinit installer (Windows) - downloads the prebuilt CLI binary from the newest qinit-cli release.
#   irm https://raw.githubusercontent.com/hackerby888/qinit/main/install.ps1 | iex
# Mirrors install.sh (Linux/macOS). Installs to %LOCALAPPDATA%\qinit\bin (override with $env:QINIT_BIN) and
# adds it to your user PATH.
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo   = "hackerby888/qinit"
$BinDir = if ($env:QINIT_BIN) { $env:QINIT_BIN } else { Join-Path $env:LOCALAPPDATA "qinit\bin" }

# arch: only x64 ships today (bun-windows-x64). ARM64 Windows runs the x64 build under emulation.
$arch = $env:PROCESSOR_ARCHITECTURE
$a = if ($arch -eq "AMD64" -or $arch -eq "x86" -or $arch -eq "ARM64") { "x64" } else { Write-Error "qinit: unsupported arch '$arch'"; return }
$asset = "qinit-windows-$a.exe"

# Resolve the newest qinit-cli-* tag from the API (NOT /releases/latest - verify-latest can hijack it).
Write-Host "qinit: resolving latest release..."
try {
  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases" -Headers @{ "User-Agent" = "qinit-installer" }
} catch { Write-Error "qinit: GitHub API unreachable ($($_.Exception.Message))"; return }
$tag = ($releases | Where-Object { $_.tag_name -like "qinit-cli-*" } | Select-Object -First 1).tag_name
if (-not $tag) { Write-Error "qinit: could not find a qinit-cli-* release"; return }
$base = "https://github.com/$Repo/releases/download/$tag"

$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("qinit-" + [Guid]::NewGuid().ToString("N"))) -Force
try {
  $dl = Join-Path $tmp "qinit.exe"
  Write-Host "qinit: downloading $asset ($tag)..."
  try { Invoke-WebRequest -Uri "$base/$asset" -OutFile $dl -UseBasicParsing }
  catch { Write-Error "qinit: download failed ($base/$asset)"; return }

  # Verify sha256 against SHA256SUMS if present (lines: "<sha>  <name>", optional '*' before name).
  try {
    # GitHub serves release assets as application/octet-stream, so -UseBasicParsing gives .Content as a
    # byte[] (not a string) on Windows PowerShell — decode it before regexing, else the check silently skips.
    $resp = Invoke-WebRequest -Uri "$base/SHA256SUMS" -UseBasicParsing
    $sums = if ($resp.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($resp.Content) } else { [string]$resp.Content }
    $rx = '(?m)^([0-9a-fA-F]{64})\s+\*?' + [regex]::Escape($asset) + '\s*$'
    $m = [regex]::Match($sums, $rx)
    if ($m.Success) {
      $want = $m.Groups[1].Value.ToLower()
      $got = (Get-FileHash -Algorithm SHA256 $dl).Hash.ToLower()
      if ($got -ne $want) { Write-Error "qinit: sha256 mismatch (want $want got $got)"; return }
      Write-Host "qinit: sha256 ok"
    }
  } catch { }   # SHA256SUMS optional

  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  $dest = Join-Path $BinDir "qinit.exe"
  # Windows locks a running .exe; if qinit is running, move the old one aside (rename is allowed) before copy.
  if (Test-Path $dest) { try { Move-Item -Force $dest "$dest.old" } catch {} }
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
$env:Path = "$env:Path;$BinDir"   # make it usable in THIS session too
& (Join-Path $BinDir "qinit.exe") version 2>$null
