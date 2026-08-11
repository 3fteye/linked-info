$ErrorActionPreference = "Stop"

$assetName = "llama-b10344-bin-win-cpu-x64.zip"
$expectedSha256 = "c0cec8825843957cae6620f927eb6eb9f7f4680da3206910932ea9075f91b405"
$downloadUrl = "https://github.com/ggml-org/llama.cpp/releases/download/b10344/$assetName"
$runtimeDirectory = Join-Path $PSScriptRoot "../../apps/desktop/src-tauri/resources/llama-runtime"
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("linked-info-llama-" + [guid]::NewGuid())
$archivePath = Join-Path $temporaryDirectory $assetName
$extractDirectory = Join-Path $temporaryDirectory "extracted"

try {
    New-Item -ItemType Directory -Force $temporaryDirectory, $extractDirectory, $runtimeDirectory | Out-Null
    Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath
    $actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $expectedSha256) {
        throw "llama.cpp runtime checksum mismatch: expected $expectedSha256, got $actualSha256"
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDirectory
    $server = Get-ChildItem -LiteralPath $extractDirectory -Recurse -Filter "llama-server.exe" | Select-Object -First 1
    if ($null -eq $server) {
        throw "llama-server.exe was not found in $assetName"
    }
    Get-ChildItem -LiteralPath $runtimeDirectory -Force | Remove-Item -Recurse -Force
    Copy-Item -Path (Join-Path $server.Directory.FullName "*") -Destination $runtimeDirectory -Recurse -Force
} finally {
    if (Test-Path -LiteralPath $temporaryDirectory) {
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
    }
}
