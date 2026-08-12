param(
    [Parameter(Mandatory = $true)]
    [string]$DestinationDirectory
)

$ErrorActionPreference = 'Stop'

$version = '0.5.9'
$expectedSha256 = '8750e00775661dcb75bc482c1a298839fd94e8a0c033b49905ba0f246ffed202'
$downloadUrl = "https://github.com/CycloneDX/cyclonedx-rust-cargo/releases/download/cargo-cyclonedx-$version/cargo-cyclonedx-x86_64-pc-windows-msvc.zip"
$archivePath = Join-Path $DestinationDirectory 'cargo-cyclonedx.zip'
$extractPath = Join-Path $DestinationDirectory 'bin'

New-Item -ItemType Directory -Path $DestinationDirectory -Force | Out-Null
$curl = Get-Command 'curl.exe' -ErrorAction Stop
& $curl.Source `
    --fail `
    --location `
    --retry 3 `
    --retry-max-time 120 `
    --connect-timeout 15 `
    --max-time 120 `
    --output $archivePath `
    $downloadUrl
if ($LASTEXITCODE -ne 0) {
    throw "cargo-cyclonedx download failed with exit code $LASTEXITCODE"
}

$actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
    throw "cargo-cyclonedx archive SHA-256 mismatch: expected $expectedSha256, got $actualSha256"
}

Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath -Force
$executables = @(Get-ChildItem -LiteralPath $extractPath -Filter 'cargo-cyclonedx.exe' -File -Recurse)
if ($executables.Count -ne 1) {
    throw "Expected exactly one cargo-cyclonedx.exe, found $($executables.Count)"
}

$binDirectory = $executables[0].Directory.FullName
if ($env:GITHUB_PATH) {
    $binDirectory | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
}

Write-Output $executables[0].FullName
