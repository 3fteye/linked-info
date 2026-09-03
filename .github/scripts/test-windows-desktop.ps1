$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'windows_desktop_test_ci_required'
}

$testExecutables = [Collections.Generic.List[string]]::new()
& cargo test -p linked-info-desktop --lib --no-run --message-format=json-render-diagnostics 2>&1 | ForEach-Object {
    $line = $_.ToString()
    if ($line.StartsWith('{')) {
        $message = $line | ConvertFrom-Json
        if ($message.reason -eq 'compiler-artifact' -and $message.target.name -eq 'linked_info_desktop_lib' -and
            $message.profile.test -eq $true -and $null -ne $message.executable) {
            $testExecutables.Add($message.executable)
        }
    } else {
        Write-Output $line
    }
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($testExecutables.Count -ne 1) { throw 'windows_desktop_test_artifact_ambiguous' }

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$testDirectory = [IO.Path]::GetFullPath((Join-Path $repoRoot 'target/debug/deps'))
$testExecutable = Get-Item -LiteralPath $testExecutables[0]
if ($testExecutable.PSIsContainer -or $testExecutable.DirectoryName -ne $testDirectory -or
    $testExecutable.Name -notmatch '^linked_info_desktop_lib-[0-9a-f]+\.exe$' -or
    ($testExecutable.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'windows_desktop_test_artifact_invalid'
}

# Tauri embeds the production binary's manifest, but not the lib-test harness.
# The latter now links TaskDialogIndirect and needs the same Common Controls v6.
$manifestTool = Get-ChildItem -Path (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin/*/x64/mt.exe') -File |
    Sort-Object FullName -Descending | Select-Object -First 1
if ($null -eq $manifestTool) { throw 'windows_desktop_test_manifest_tool_missing' }
$manifest = Join-Path $PSScriptRoot 'windows-desktop-test.manifest'
& $manifestTool.FullName -nologo -manifest $manifest "-outputresource:$($testExecutable.FullName);#1"
if ($LASTEXITCODE -ne 0) { throw 'windows_desktop_test_manifest_embed_failed' }
& $manifestTool.FullName -nologo "-inputresource:$($testExecutable.FullName);#1" -validate_manifest
if ($LASTEXITCODE -ne 0) { throw 'windows_desktop_test_manifest_invalid' }
Write-Output 'windows-desktop-test-manifest=common-controls-v6'

$loaderBinary = $null
& cargo test -p linked-info-desktop --lib 2>&1 | ForEach-Object {
    $line = $_.ToString()
    Write-Output $line
    if ($line -match 'process didn.t exit successfully: \x60([^\x60]+)\x60 \(exit code: 0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND\)') {
        $loaderBinary = $Matches[1]
    }
}
$testExitCode = $LASTEXITCODE
if ($testExitCode -ne 0 -and $null -ne $loaderBinary) {
    try {
        & (Join-Path $PSScriptRoot 'diagnose-windows-test-loader.ps1') -TestBinary $loaderBinary
    } catch {
        Write-Output 'windows_test_loader_diagnostics_incomplete'
    }
}
# Diagnostics never replace the original test result.
exit $testExitCode
