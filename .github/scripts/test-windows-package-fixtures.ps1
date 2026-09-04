$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'windows_package_fixture_ci_required'
}
. (Join-Path $PSScriptRoot '../../scripts/windows-package-validation.ps1')

$fixtureRoot = Join-Path ([IO.Path]::GetFullPath($env:RUNNER_TEMP)) ('capture-package-fixture-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$fixtureCount = 0
$fixtureFailures = 0

function New-PackageFixture {
    $directory = Join-Path $fixtureRoot ([guid]::NewGuid().ToString('N'))
    $runtime = Join-Path $directory 'llama-runtime'
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    $checksums = foreach ($name in @('linked-info-desktop.exe', 'linked-info-capture.exe', 'linked-info-extension-host.exe')) {
        $file = Join-Path $directory $name
        [IO.File]::WriteAllText($file, "synthetic package fixture $name")
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash *$name"
    }
    [IO.File]::WriteAllLines((Join-Path $directory 'linked-info-windows.sha256'), [string[]]$checksums)
    [IO.File]::WriteAllText((Join-Path $runtime 'llama-server.exe'), 'synthetic runtime')
    return $directory
}

function Assert-Rejected([string]$Directory, [string]$Code) {
    try { Test-WindowsPortablePackage -Directory $Directory | Out-Null }
    catch { return }
    throw "windows_package_fixture_accepted_$Code"
}

function Run-Fixture([string]$Name, [scriptblock]$Body) {
    $script:fixtureCount += 1
    try {
        & $Body (New-PackageFixture)
        Write-Output "PASS $Name"
    }
    catch {
        $script:fixtureFailures += 1
        Write-Output "FAIL $Name"
    }
}

try {
    Run-Fixture 'all three binaries verified' {
        param($directory)
        $result = Test-WindowsPortablePackage -Directory $directory
        if ($result.BinaryHashes.Count -ne 3 -or -not $result.CaptureExecutable.EndsWith('linked-info-capture.exe')) { throw 'missing_capture' }
    }
    Run-Fixture 'missing capture rejected' {
        param($directory)
        Remove-Item -LiteralPath (Join-Path $directory 'linked-info-capture.exe')
        Assert-Rejected $directory 'missing_capture'
    }
    Run-Fixture 'tampered capture rejected' {
        param($directory)
        [IO.File]::WriteAllText((Join-Path $directory 'linked-info-capture.exe'), 'changed')
        Assert-Rejected $directory 'changed_capture'
    }
    Run-Fixture 'tampered extension rejected' {
        param($directory)
        [IO.File]::WriteAllText((Join-Path $directory 'linked-info-extension-host.exe'), 'changed')
        Assert-Rejected $directory 'changed_extension'
    }
    Run-Fixture 'incomplete manifest rejected' {
        param($directory)
        $file = Join-Path $directory 'linked-info-windows.sha256'
        [IO.File]::WriteAllLines($file, @((Get-Content -LiteralPath $file) | Select-Object -First 2))
        Assert-Rejected $directory 'incomplete'
    }
    Run-Fixture 'duplicate manifest entry rejected' {
        param($directory)
        $file = Join-Path $directory 'linked-info-windows.sha256'
        [IO.File]::AppendAllText($file, (Get-Content -LiteralPath $file | Select-Object -First 1) + "`n")
        Assert-Rejected $directory 'duplicate'
    }
    Run-Fixture 'unexpected manifest filename rejected' {
        param($directory)
        $file = Join-Path $directory 'linked-info-windows.sha256'
        [IO.File]::AppendAllText($file, ('0' * 64) + " *../external.exe`n")
        Assert-Rejected $directory 'traversal'
    }
    Run-Fixture 'empty runtime rejected' {
        param($directory)
        [IO.File]::WriteAllText((Join-Path $directory 'llama-runtime/llama-server.exe'), '')
        Assert-Rejected $directory 'empty_runtime'
    }
    Run-Fixture 'second main binary rejected' {
        param($directory)
        $nested = Join-Path $directory 'duplicate'
        New-Item -ItemType Directory -Path $nested | Out-Null
        [IO.File]::WriteAllText((Join-Path $nested 'linked-info-desktop.exe'), 'duplicate')
        Assert-Rejected $directory 'second_main'
    }
}
finally {
    $resolvedFixture = (Resolve-Path -LiteralPath $fixtureRoot).Path
    $resolvedTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
    if (-not $resolvedFixture.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $resolvedFixture) -notmatch '^capture-package-fixture-[a-f0-9]{32}$') { throw 'fixture_cleanup_scope' }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
Write-Output "$fixtureCount package fixtures; $fixtureFailures failures"
if ($fixtureFailures -gt 0) { exit 1 }
