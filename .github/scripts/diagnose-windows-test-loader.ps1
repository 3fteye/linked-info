param([string]$TestBinary)

$ErrorActionPreference = 'Stop'

# Only inspect synthetic CI test binaries; never run this on a user machine.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'windows_test_loader_ci_required'
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$testDirectory = [IO.Path]::GetFullPath((Join-Path $repoRoot 'target/debug/deps'))
$resolvedTestBinary = Get-Item -LiteralPath $TestBinary
if ($resolvedTestBinary.PSIsContainer -or $resolvedTestBinary.DirectoryName -ne $testDirectory -or
    $resolvedTestBinary.Name -notmatch '^linked_info_desktop_lib-[0-9a-f]+\.exe$' -or
    ($resolvedTestBinary.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'windows_test_loader_binary_invalid'
}
Write-Output "test-loader-binary=$($resolvedTestBinary.Name)"

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$installations = & $vswhere -all -prerelease -products '*' -format json | ConvertFrom-Json
$dumpbin = $null
foreach ($installation in $installations) {
    Write-Output "test-loader-vs=$($installation.installationVersion) prerelease=$($installation.isPrerelease)"
    $candidates = Get-ChildItem -Path (Join-Path $installation.installationPath 'VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe') -File -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending
    if ($null -ne $candidates) {
        $dumpbin = ($candidates | Select-Object -First 1).FullName
        break
    }
}

# Missing diagnostic tools must not suppress Windows' own loader events.
if ($null -ne $dumpbin) {
    # PE imports contain binary/symbol names, not application payloads.
    & $dumpbin /imports $resolvedTestBinary.FullName
    Write-Output "test-loader-imports-exit=$LASTEXITCODE"
    & $dumpbin /headers $resolvedTestBinary.FullName
    Write-Output "test-loader-headers-exit=$LASTEXITCODE"
} else {
    Write-Output 'test-loader-dumpbin-unavailable'
}

# Windows can name the missing entry point in an application popup event.
# Only emit matching test-process events from this disposable runner.
$eventCount = 0
foreach ($logName in @('Application', 'System')) {
    $events = Get-WinEvent -FilterHashtable @{
        LogName = $logName
        StartTime = (Get-Date).AddMinutes(-15)
    } -MaxEvents 200 -ErrorAction SilentlyContinue
    foreach ($event in $events) {
        if ($event.ProviderName -in @('Application Error', 'Application Popup', 'Windows Error Reporting') -and
            $event.Message -like "*$($resolvedTestBinary.Name)*") {
            $eventCount += 1
            Write-Output "test-loader-event=$($event.Id) provider=$($event.ProviderName)"
            Write-Output $event.Message
        }
    }
}
Write-Output "test-loader-event-count=$eventCount"
