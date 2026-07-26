[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SourceDir,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [string[]]$ArgumentList = @()
  )

  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath failed with exit code $LASTEXITCODE"
  }
}

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [string[]]$ArgumentList = @()
  )

  $lines = & $FilePath @ArgumentList 2>&1
  $exitCode = $LASTEXITCODE
  $text = ($lines | ForEach-Object { "$_" }) -join [Environment]::NewLine
  if ($exitCode -ne 0) {
    throw "$FilePath failed with exit code $exitCode`n$text"
  }
  return $text
}

function Assert-StaticRuntimeProjects {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$BuildDirs
  )

  $requiredProjects = @(
    "cppast",
    "cppparser_lex_and_yacc",
    "cppparser",
    "contractverifylib",
    "contractverify"
  )

  foreach ($name in $requiredProjects) {
    $projects = @(
      foreach ($dir in $BuildDirs) {
        Get-ChildItem -LiteralPath $dir -Filter "$name.vcxproj" -File -Recurse
      }
    )
    if ($projects.Count -ne 1) {
      throw "expected one generated project '$name', found $($projects.Count)"
    }

    $project = $projects[0]
    [xml]$document = Get-Content -LiteralPath $project.FullName -Raw
    $runtimeNodes = @(
      $document.SelectNodes("//*[local-name()='RuntimeLibrary']")
    )
    if ($runtimeNodes.Count -eq 0) {
      throw "RuntimeLibrary was not found in generated project '$name'"
    }

    foreach ($node in $runtimeNodes) {
      if ($node.InnerText.Trim() -ne "MultiThreaded") {
        throw "$($project.FullName) uses RuntimeLibrary '$($node.InnerText)'"
      }
    }
  }

  Write-Host "RuntimeLibrary audit passed for $($requiredProjects.Count) linked projects"
}

function Assert-Smoke {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [string]$Executable,

    [string[]]$ArgumentList = @(),

    [Parameter(Mandatory = $true)]
    [int]$ExpectedExitCode,

    [Parameter(Mandatory = $true)]
    [string[]]$ExpectedText
  )

  $lines = & $Executable @ArgumentList 2>&1
  $exitCode = $LASTEXITCODE
  $text = ($lines | ForEach-Object { "$_" }) -join [Environment]::NewLine

  if ($exitCode -ne $ExpectedExitCode) {
    throw "$Name smoke exited $exitCode, expected $ExpectedExitCode`n$text"
  }
  foreach ($expected in $ExpectedText) {
    if (-not $text.Contains($expected)) {
      throw "$Name smoke did not emit '$expected'`n$text"
    }
  }

  Write-Host "$Name smoke passed"
  $global:LASTEXITCODE = 0
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "build-windows.ps1 must run on Windows"
}
if ([string]::IsNullOrWhiteSpace($SourceDir)) {
  throw "SourceDir must not be empty"
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  throw "OutputPath must not be empty"
}

$source = (Resolve-Path -LiteralPath $SourceDir).Path
$output = [IO.Path]::GetFullPath($OutputPath)
if ([IO.Path]::GetExtension($output) -ine ".exe") {
  throw "OutputPath must name an .exe file"
}

$cppParserSource = Join-Path $source "deps\CppParser"
$flex = Join-Path $cppParserSource "cppparser\third_party\flex_tp\flex.exe"
$expectedFlexSha256 = "5f985f95c4c02e31aa130149d1b8174000de82d9739f26375fcbf6215b6c6af7"
$validFixture = Join-Path $source "test\testfiles\test_ok.h"
$invalidFixture = Join-Path $source "test\testfiles\test_fail_div.h"
$oracleFixture = Join-Path $source "test\testfiles\oracle_interfaces\test_ok_Mock.h"
$invalidOracleFixture = Join-Path $source (
  "test\testfiles\oracle_interfaces\test_fail_forbidden_locals_type.h"
)

foreach ($required in @(
  (Join-Path $source "CMakeLists.txt"),
  (Join-Path $cppParserSource "CMakeLists.txt"),
  $flex,
  $validFixture,
  $invalidFixture,
  $oracleFixture,
  $invalidOracleFixture
)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "required source file not found: $required"
  }
}

$flexSha256 = (Get-FileHash -LiteralPath $flex -Algorithm SHA256).Hash.ToLowerInvariant()
if ($flexSha256 -ne $expectedFlexSha256) {
  throw "vendored flex.exe SHA-256 mismatch: expected $expectedFlexSha256, got $flexSha256"
}

$programFilesX86 = [Environment]::GetFolderPath(
  [Environment+SpecialFolder]::ProgramFilesX86
)
$vswhere = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
  throw "Visual Studio Installer vswhere.exe was not found"
}

$vsInstall = (
  Invoke-NativeCapture $vswhere @(
    "-latest",
    "-products", "*",
    "-version", "[17.0,18.0)",
    "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property", "installationPath"
  )
).Trim()
if ([string]::IsNullOrWhiteSpace($vsInstall)) {
  throw "Visual Studio 2022 with the x64 C++ toolchain was not found"
}

$msvcRoot = Join-Path $vsInstall "VC\Tools\MSVC"
$msvcVersion = Get-ChildItem -LiteralPath $msvcRoot -Directory |
  Sort-Object { [version]$_.Name } -Descending |
  Select-Object -First 1
if (-not $msvcVersion) {
  throw "Visual Studio 2022 MSVC tools were not found"
}
$dumpbin = Join-Path $msvcVersion.FullName "bin\Hostx64\x64\dumpbin.exe"
if (-not (Test-Path -LiteralPath $dumpbin -PathType Leaf)) {
  throw "x64 dumpbin.exe was not found: $dumpbin"
}

$cmake = (Get-Command cmake.exe -ErrorAction Stop).Source
$tempRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  [IO.Path]::GetTempPath()
} else {
  $env:RUNNER_TEMP
}
$buildRoot = Join-Path $tempRoot (
  "qinit-contractverify-windows-" + [Guid]::NewGuid().ToString("N")
)
$cppParserBuild = Join-Path $buildRoot "cppparser"
$mainBuild = Join-Path $buildRoot "contractverify"
Write-Host "build root: $buildRoot"

$commonConfigure = @(
  "-G", "Visual Studio 17 2022",
  "-A", "x64",
  "-DCMAKE_CONFIGURATION_TYPES=Release",
  "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW",
  "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
  "-DBUILD_SHARED_LIBS=OFF"
)

Write-Host "Configuring CppParser"
Invoke-Native $cmake (
  @("-S", $cppParserSource, "-B", $cppParserBuild) +
  $commonConfigure +
  @(
    "-DCPPPARSER_BUILD_TESTS=OFF",
    "-DFLEX=$flex"
  )
)

Write-Host "Building CppParser static libraries"
Invoke-Native $cmake @(
  "--build", $cppParserBuild,
  "--config", "Release",
  "--target", "cppparser",
  "--parallel"
)

Write-Host "Configuring contractverify"
Invoke-Native $cmake (
  @("-S", $source, "-B", $mainBuild) +
  $commonConfigure +
  @(
    "-DBUILD_CONTRACTVERIFY_TESTS=OFF",
    "-Dcppparser_DIR=$cppParserBuild",
    "-DCMAKE_PREFIX_PATH=$cppParserBuild"
  )
)

Write-Host "Building contractverify"
Invoke-Native $cmake @(
  "--build", $mainBuild,
  "--config", "Release",
  "--target", "contractverify",
  "--parallel"
)

$executable = Join-Path $mainBuild "src\Release\contractverify.exe"
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "contractverify.exe was not produced: $executable"
}

$sharedLibraries = @(
  Get-ChildItem -LiteralPath $cppParserBuild, $mainBuild -Filter "*.dll" -File -Recurse
)
if ($sharedLibraries.Count -ne 0) {
  throw "shared libraries were produced:`n$($sharedLibraries.FullName -join [Environment]::NewLine)"
}

Assert-StaticRuntimeProjects @($cppParserBuild, $mainBuild)

$headers = Invoke-NativeCapture $dumpbin @("/nologo", "/headers", $executable)
if ($headers -notmatch "(?im)^\s*8664 machine \(x64\)") {
  throw "PE audit did not identify an x64 executable"
}
Write-Host "PE x64 audit passed"

$dependencyOutput = Invoke-NativeCapture $dumpbin @(
  "/nologo",
  "/dependents",
  $executable
)
$dependencies = @(
  [regex]::Matches(
    $dependencyOutput,
    "(?im)^\s*([a-z0-9._-]+\.dll)\s*$"
  ) | ForEach-Object { $_.Groups[1].Value.ToUpperInvariant() }
)
if ($dependencies.Count -eq 0) {
  throw "dumpbin did not report any PE dependencies"
}

$allowedDependencies = @("KERNEL32.DLL")
$unexpectedDependencies = @(
  $dependencies | Where-Object { $_ -notin $allowedDependencies }
)
if ($unexpectedDependencies.Count -ne 0) {
  throw "non-system dependency found: $($unexpectedDependencies -join ', ')"
}
Write-Host "PE dependencies: $($dependencies -join ', ')"

Assert-Smoke `
  -Name "valid contract" `
  -Executable $executable `
  -ArgumentList @($validFixture) `
  -ExpectedExitCode 0 `
  -ExpectedText @("Contract compliance check PASSED")

Assert-Smoke `
  -Name "invalid contract" `
  -Executable $executable `
  -ArgumentList @($invalidFixture) `
  -ExpectedExitCode 1 `
  -ExpectedText @("[ ERROR ]", "Contract compliance check FAILED")

Assert-Smoke `
  -Name "oracle interface" `
  -Executable $executable `
  -ArgumentList @("--oi", $oracleFixture) `
  -ExpectedExitCode 0 `
  -ExpectedText @("Oracle interface compliance check PASSED")

Assert-Smoke `
  -Name "invalid oracle interface" `
  -Executable $executable `
  -ArgumentList @("--oi", $invalidOracleFixture) `
  -ExpectedExitCode 1 `
  -ExpectedText @(
    "[ ERROR ] Found local variable of forbidden type with name forbidden.",
    "Oracle interface compliance check FAILED"
  )

$outputDir = Split-Path -Parent $output
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
Copy-Item -LiteralPath $executable -Destination $output -Force

$hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "ready: $output"
Write-Host "sha256: $hash"
