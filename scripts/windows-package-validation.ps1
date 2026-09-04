# Definitions only: validates a selected package without switching links,
# creating shortcuts, starting programs, or downloading anything.
function Test-WindowsPortablePackage {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Directory)

    $resolvedDirectory = (Resolve-Path -LiteralPath $Directory -ErrorAction Stop).Path
    $executables = @(Get-ChildItem -LiteralPath $resolvedDirectory -Recurse -File -Filter 'linked-info-desktop.exe')
    if ($executables.Count -ne 1) { throw 'portable_package_main_count' }
    $releaseDirectory = $executables[0].Directory.FullName
    $required = @('linked-info-desktop.exe', 'linked-info-capture.exe', 'linked-info-extension-host.exe')
    $checksumPath = Join-Path $releaseDirectory 'linked-info-windows.sha256'
    if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) { throw 'portable_package_checksum_missing' }
    $manifest = @{}
    foreach ($line in (Get-Content -LiteralPath $checksumPath -Encoding ascii)) {
        if ($line -notmatch '^([0-9a-fA-F]{64}) \*(linked-info-(?:desktop|capture|extension-host)\.exe)$') {
            throw 'portable_package_checksum_format'
        }
        $name = $Matches[2]
        if ($manifest.ContainsKey($name)) { throw 'portable_package_checksum_duplicate' }
        $manifest[$name] = $Matches[1].ToLowerInvariant()
    }
    if ($manifest.Count -ne $required.Count) { throw 'portable_package_checksum_incomplete' }
    $hashes = [ordered]@{}
    foreach ($name in $required) {
        $file = Get-Item -LiteralPath (Join-Path $releaseDirectory $name) -ErrorAction Stop
        if ($file.PSIsContainer -or $file.Length -eq 0 -or
            ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'portable_package_binary_invalid'
        }
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -ne $manifest[$name]) { throw 'portable_package_checksum_mismatch' }
        $hashes[$name] = $hash
    }
    $runtime = Get-Item -LiteralPath (Join-Path $releaseDirectory 'llama-runtime/llama-server.exe') -ErrorAction Stop
    if ($runtime.PSIsContainer -or $runtime.Length -eq 0 -or
        ($runtime.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'portable_package_runtime_invalid'
    }
    [pscustomobject]@{
        ReleaseDirectory = $releaseDirectory
        Executable = $executables[0].FullName
        CaptureExecutable = Join-Path $releaseDirectory 'linked-info-capture.exe'
        Sha256 = $hashes['linked-info-desktop.exe']
        BinaryHashes = $hashes
    }
}
