$ErrorActionPreference = 'Stop'

# Only inspect synthetic CI test binaries; never run this on a user machine.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'windows_test_loader_ci_required'
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$testDirectory = Join-Path $repoRoot 'target/debug/deps'
$testBinary = Get-ChildItem -LiteralPath $testDirectory -Filter 'linked_info_desktop_lib-*.exe' -File |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if ($null -eq $testBinary) { throw 'windows_test_loader_binary_missing' }
Write-Output "test-loader-binary=$($testBinary.Name)"

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$dumpbin = & $vswhere -latest -products '*' -find 'VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe' |
    Select-Object -First 1
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($dumpbin)) {
    throw 'windows_test_loader_dumpbin_missing'
}

# PE imports contain binary/symbol names, not workspace or application payloads.
& $dumpbin /imports $testBinary.FullName
if ($LASTEXITCODE -ne 0) { throw 'windows_test_loader_imports_failed' }

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
            $event.Message -like "*$($testBinary.Name)*") {
            $eventCount += 1
            Write-Output "test-loader-event=$($event.Id) provider=$($event.ProviderName)"
            Write-Output $event.Message
        }
    }
}
Write-Output "test-loader-event-count=$eventCount"
