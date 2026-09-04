$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'windows_desktop_fixture_ci_required'
}

# Dot-sourcing loads definitions only. Every filesystem/native query below is
# replaced by a fixture; no compiler, SDK tool, executable, or event log is used.
. (Join-Path $PSScriptRoot 'test-windows-desktop.ps1')
. (Join-Path $PSScriptRoot 'run-windows-desktop-test.ps1')
. (Join-Path $PSScriptRoot 'diagnose-windows-test-loader.ps1')

$fixtureFailures = 0
$fixtureCount = 0

function Assert-Fixture([bool]$Condition, [string]$Code) {
    if (-not $Condition) { throw "windows_desktop_fixture_$Code" }
}

function Reset-Fixture {
    $directory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../target/debug/deps'))
    $binaryPath = Join-Path $directory 'linked_info_desktop_lib-1234abcd.exe'
    $visualStudio = 'C:\Synthetic Visual Studio\2022\Preview'
    $script:fixtureState = [pscustomobject]@{
        BinaryPath = $binaryPath
        BinaryMetadata = [pscustomobject]@{
            FullName = $binaryPath
            DirectoryName = $directory
            Name = 'linked_info_desktop_lib-1234abcd.exe'
            PSIsContainer = $false
            Attributes = [IO.FileAttributes]::Normal
        }
        MtPath = 'C:\Synthetic SDK\10.0.99999.0\x64\mt.exe'
        MtQuery = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin/*/x64/mt.exe'
        VswherePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
        VisualStudio = $visualStudio
        DumpbinPath = Join-Path $visualStudio 'VC/Tools/MSVC/14.99.0/bin/Hostx64/x64/dumpbin.exe'
        DumpbinQuery = Join-Path $visualStudio 'VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe'
        DiagnosticPath = Join-Path $PSScriptRoot 'diagnose-windows-test-loader.ps1'
        DumpbinAvailable = $true
        MtEmbedExit = 0
        MtValidateExit = 0
        TestExit = 0
        CargoExit = 0
        DiagnosticExit = 79
        DiagnosticThrows = $false
        TestOutput = 'synthetic test result'
        OriginalPath = $env:PATH
        Calls = [Collections.Generic.List[object]]::new()
        FileQueries = [Collections.Generic.List[string]]::new()
        ToolQueries = [Collections.Generic.List[string]]::new()
        EventQueries = [Collections.Generic.List[string]]::new()
    }
    $global:LASTEXITCODE = 0
}

function Get-Item {
    [CmdletBinding()]
    param([string]$LiteralPath)
    $script:fixtureState.FileQueries.Add($LiteralPath)
    Assert-Fixture ($LiteralPath -eq $script:fixtureState.BinaryPath) 'unexpected_file_query'
    $script:fixtureState.BinaryMetadata
}

function Get-ChildItem {
    [CmdletBinding()]
    param([string]$Path, [switch]$File)
    $script:fixtureState.ToolQueries.Add($Path)
    Assert-Fixture $File.IsPresent 'file_only_lookup_required'
    if ($Path -eq $script:fixtureState.MtQuery) {
        return [pscustomobject]@{ FullName = $script:fixtureState.MtPath }
    }
    Assert-Fixture ($Path -eq $script:fixtureState.DumpbinQuery) 'metadata_installation_path_not_used'
    if ($script:fixtureState.DumpbinAvailable) {
        [pscustomobject]@{ FullName = $script:fixtureState.DumpbinPath }
    }
}

function Get-WinEvent {
    [CmdletBinding()]
    param([hashtable]$FilterHashtable, [int]$MaxEvents)
    $script:fixtureState.EventQueries.Add($FilterHashtable.LogName)
    Assert-Fixture ($MaxEvents -eq 200 -and $FilterHashtable.StartTime -is [datetime]) 'event_query_unbounded'
    @(
        [pscustomobject]@{ Id = 26; ProviderName = 'Application Popup'; Message = "synthetic loader: $($script:fixtureState.BinaryMetadata.Name)" }
        [pscustomobject]@{ Id = 27; ProviderName = 'Other Provider'; Message = "ignored provider: $($script:fixtureState.BinaryMetadata.Name)" }
        [pscustomobject]@{ Id = 28; ProviderName = 'Application Error'; Message = 'ignored unrelated executable' }
    )
}

$invokeFixtureTool = {
    param([string]$Command, [string[]]$CommandArguments)
    $state = $script:fixtureState
    $state.Calls.Add([pscustomobject]@{ Command = $Command; Arguments = @($CommandArguments) })
    if ($Command -eq 'cargo') {
        $global:LASTEXITCODE = $state.CargoExit
    } elseif ($Command -eq $state.MtPath) {
        $global:LASTEXITCODE = if ($CommandArguments -contains '-validate_manifest') {
            $state.MtValidateExit
        } else { $state.MtEmbedExit }
    } elseif ($Command -eq $state.BinaryPath) {
        Assert-Fixture ($env:PATH -eq $state.OriginalPath) 'cargo_dll_path_changed'
        Write-Output $state.TestOutput
        $global:LASTEXITCODE = $state.TestExit
    } elseif ($Command -eq $state.DiagnosticPath) {
        $global:LASTEXITCODE = $state.DiagnosticExit
        if ($state.DiagnosticThrows) { throw 'synthetic diagnostic failure' }
    } elseif ($Command -eq $state.VswherePath) {
        $global:LASTEXITCODE = 0
        ConvertTo-Json -InputObject @([pscustomobject]@{
            installationPath = $state.VisualStudio
            installationVersion = '17.99.0'
            isPrerelease = $true
        }) -Compress
    } elseif ($Command -eq $state.DumpbinPath) {
        $global:LASTEXITCODE = 0
        Write-Output 'synthetic PE diagnostic'
    } else {
        throw 'windows_desktop_fixture_unexpected_native_command'
    }
}

function Invoke-Fixture([string]$Name, [scriptblock]$Case) {
    Reset-Fixture
    $script:fixtureCount += 1
    try {
        & $Case
        Write-Output "windows-desktop-fixture=$Name status=passed"
    } catch {
        $script:fixtureFailures += 1
        $code = if ($_.Exception.Message -like 'windows_desktop_fixture_*') { $_.Exception.Message } else { 'windows_desktop_fixture_unexpected_failure' }
        Write-Output "windows-desktop-fixture=$Name status=failed error=$code"
    }
}

function Assert-FixtureThrows([scriptblock]$Operation, [string]$Expected) {
    $actual = $null
    try { & $Operation | Out-Null } catch { $actual = $_.Exception.Message }
    Assert-Fixture ($actual -eq $Expected) 'expected_rejection_missing'
}

Invoke-Fixture 'cargo-selects-one-absolute-runner-with-one-test-invocation' {
    $fixtureState.CargoExit = 23
    Invoke-WindowsDesktopTests -InvokeTool $invokeFixtureTool | Out-Null
    Assert-Fixture ($LASTEXITCODE -eq 23) 'cargo_exit_lost'
    Assert-Fixture ($fixtureState.Calls.Count -eq 1) 'cargo_invoked_more_than_once'
    $call = $fixtureState.Calls[0]
    Assert-Fixture ($call.Command -eq 'cargo' -and $call.Arguments.Count -eq 8) 'cargo_command_changed'
    Assert-Fixture (($call.Arguments[0..6] -join '|') -eq 'test|-p|linked-info-desktop|-p|linked-info-capture|--lib|--config') 'cargo_test_scope_changed'
    $prefix = 'target.x86_64-pc-windows-msvc.runner='
    Assert-Fixture ($call.Arguments[7].StartsWith($prefix)) 'runner_config_missing'
    $runner = $call.Arguments[7].Substring($prefix.Length) | ConvertFrom-Json
    $expectedRunner = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'run-windows-desktop-test.ps1'))
    Assert-Fixture ($runner.Count -eq 6 -and $runner[5] -eq $expectedRunner) 'runner_path_not_absolute'
    Assert-Fixture (($runner[0..4] -join '|') -eq 'pwsh|-NoLogo|-NoProfile|-NonInteractive|-File') 'runner_arguments_split'
    Assert-Fixture ($fixtureState.FileQueries.Count -eq 0) 'wrapper_selected_or_mutated_artifact'
}

Invoke-Fixture 'manifest-is-embedded-and-validated-after-link-before-exact-test' {
    $fixtureState.TestExit = 17
    $forwarded = @('--exact', 'synthetic test with spaces', '--nocapture')
    Invoke-WindowsDesktopTestRunner -BinaryPath $fixtureState.BinaryPath -BinaryArguments $forwarded -InvokeTool $invokeFixtureTool | Out-Null
    Assert-Fixture ($LASTEXITCODE -eq 17) 'test_exit_lost'
    Assert-Fixture ($fixtureState.Calls.Count -eq 3) 'runner_invoked_cargo_or_extra_tool'
    Assert-Fixture ($fixtureState.Calls[0].Command -eq $fixtureState.MtPath -and $fixtureState.Calls[1].Command -eq $fixtureState.MtPath) 'manifest_not_before_test'
    Assert-Fixture ($fixtureState.Calls[0].Arguments -contains "-outputresource:$($fixtureState.BinaryPath);#1") 'manifest_wrong_output_artifact'
    Assert-Fixture ($fixtureState.Calls[1].Arguments -contains "-inputresource:$($fixtureState.BinaryPath);#1") 'manifest_wrong_input_artifact'
    Assert-Fixture ($fixtureState.Calls[1].Arguments -contains '-validate_manifest') 'manifest_not_validated'
    Assert-Fixture ($fixtureState.Calls[2].Command -eq $fixtureState.BinaryPath) 'different_test_artifact_executed'
    Assert-Fixture (($fixtureState.Calls[2].Arguments -join '|') -eq ($forwarded -join '|')) 'test_arguments_not_preserved'
    Assert-Fixture ($fixtureState.ToolQueries.Count -eq 1) 'test_artifact_enumerated'
}

Invoke-Fixture 'empty-artifact-is-rejected-before-file-or-tool-access' {
    Assert-FixtureThrows { Invoke-WindowsDesktopTestRunner -BinaryPath '' -InvokeTool $invokeFixtureTool } 'windows_desktop_test_artifact_invalid'
    Assert-Fixture ($fixtureState.Calls.Count -eq 0 -and $fixtureState.FileQueries.Count -eq 0) 'empty_path_used'
}

Invoke-Fixture 'independent-capture-test-binary-uses-same-guarded-runner' {
    $directory = $fixtureState.BinaryMetadata.DirectoryName
    $fixtureState.BinaryPath = Join-Path $directory 'linked_info_capture_lib-1234abcd.exe'
    $fixtureState.BinaryMetadata.FullName = $fixtureState.BinaryPath
    $fixtureState.BinaryMetadata.Name = 'linked_info_capture_lib-1234abcd.exe'
    Invoke-WindowsDesktopTestRunner -BinaryPath $fixtureState.BinaryPath -InvokeTool $invokeFixtureTool | Out-Null
    Assert-Fixture ($fixtureState.Calls.Count -eq 3) 'capture_test_not_executed'
    Assert-Fixture ($fixtureState.Calls[2].Command -eq $fixtureState.BinaryPath) 'capture_wrong_binary'
}

foreach ($invalid in @('directory', 'filename', 'folder', 'reparse')) {
    Invoke-Fixture "invalid-artifact-$invalid-is-rejected" {
        switch ($invalid) {
            'directory' { $fixtureState.BinaryMetadata.DirectoryName = 'C:\Synthetic Outside\deps' }
            'filename' { $fixtureState.BinaryMetadata.Name = 'unrelated.exe' }
            'folder' { $fixtureState.BinaryMetadata.PSIsContainer = $true }
            'reparse' { $fixtureState.BinaryMetadata.Attributes = [IO.FileAttributes]::ReparsePoint }
        }
        Assert-FixtureThrows { Invoke-WindowsDesktopTestRunner -BinaryPath $fixtureState.BinaryPath -InvokeTool $invokeFixtureTool } 'windows_desktop_test_artifact_invalid'
        Assert-Fixture ($fixtureState.Calls.Count -eq 0) 'invalid_artifact_executed'
    }
}

foreach ($phase in @('embed', 'validate')) {
    Invoke-Fixture "manifest-$phase-failure-stops-before-test" {
        if ($phase -eq 'embed') { $fixtureState.MtEmbedExit = 9 } else { $fixtureState.MtValidateExit = 9 }
        $expected = if ($phase -eq 'embed') { 'windows_desktop_test_manifest_embed_failed' } else { 'windows_desktop_test_manifest_invalid' }
        Assert-FixtureThrows { Invoke-WindowsDesktopTestRunner -BinaryPath $fixtureState.BinaryPath -InvokeTool $invokeFixtureTool } $expected
        Assert-Fixture (@($fixtureState.Calls | Where-Object Command -eq $fixtureState.BinaryPath).Count -eq 0) 'test_ran_after_manifest_failure'
    }
}

Invoke-Fixture 'ordinary-assertion-failure-does-not-trigger-loader-diagnostics' {
    $fixtureState.TestExit = 101
    $fixtureState.TestOutput = 'synthetic assertion mentions STATUS_ENTRYPOINT_NOT_FOUND'
    Invoke-WindowsDesktopTestRunner -BinaryPath $fixtureState.BinaryPath -InvokeTool $invokeFixtureTool | Out-Null
    Assert-Fixture ($LASTEXITCODE -eq 101 -and $fixtureState.Calls.Count -eq 3) 'ordinary_failure_misclassified'
}

foreach ($diagnosticThrows in @($false, $true)) {
    Invoke-Fixture "entrypoint-failure-preserves-exit-diagnostic-throws-$diagnosticThrows" {
        $fixtureState.TestExit = -1073741511
        $fixtureState.DiagnosticThrows = $diagnosticThrows
        Invoke-WindowsDesktopTestRunner -BinaryPath $fixtureState.BinaryPath -InvokeTool $invokeFixtureTool | Out-Null
        Assert-Fixture ($LASTEXITCODE -eq -1073741511) 'diagnostic_replaced_test_exit'
        Assert-Fixture ($fixtureState.Calls.Count -eq 4) 'loader_diagnostic_missing'
        $call = $fixtureState.Calls[3]
        Assert-Fixture ($call.Command -eq $fixtureState.DiagnosticPath) 'wrong_loader_diagnostic'
        Assert-Fixture (($call.Arguments -join '|') -eq "-TestBinary|$($fixtureState.BinaryPath)") 'diagnostic_not_bound_to_failed_artifact'
    }
}

Invoke-Fixture 'vswhere-metadata-selects-dumpbin-and-preserves-fileinfo' {
    $output = @(Invoke-WindowsTestLoaderDiagnostics -BinaryPath $fixtureState.BinaryPath -InvokeTool $invokeFixtureTool)
    Assert-Fixture ($fixtureState.Calls.Count -eq 3) 'dumpbin_not_invoked'
    Assert-Fixture ($fixtureState.ToolQueries[0] -eq $fixtureState.DumpbinQuery) 'vswhere_metadata_ignored'
    Assert-Fixture (($fixtureState.Calls[0].Arguments -join '|') -eq '-all|-prerelease|-products|*|-format|json') 'vswhere_not_metadata_mode'
    Assert-Fixture ($fixtureState.Calls[1].Command -eq $fixtureState.DumpbinPath -and $fixtureState.Calls[2].Command -eq $fixtureState.DumpbinPath) 'wrong_dumpbin_selected'
    Assert-Fixture (($fixtureState.Calls[1].Arguments -join '|') -eq "/imports|$($fixtureState.BinaryPath)") 'imports_wrong_binary'
    Assert-Fixture (($fixtureState.Calls[2].Arguments -join '|') -eq "/headers|$($fixtureState.BinaryPath)") 'headers_wrong_binary'
    Assert-Fixture ($output -contains 'test-loader-binary=linked_info_desktop_lib-1234abcd.exe') 'typed_parameter_lost_fileinfo'
    Assert-Fixture ($output -contains 'test-loader-event-count=2') 'loader_events_missing'
}

Invoke-Fixture 'missing-dumpbin-still-reads-filtered-windows-loader-events' {
    $fixtureState.DumpbinAvailable = $false
    $output = @(Invoke-WindowsTestLoaderDiagnostics -BinaryPath $fixtureState.BinaryPath -InvokeTool $invokeFixtureTool)
    Assert-Fixture ($fixtureState.Calls.Count -eq 1) 'unavailable_dumpbin_invoked'
    Assert-Fixture (($fixtureState.EventQueries -join '|') -eq 'Application|System') 'missing_dumpbin_skipped_event_logs'
    Assert-Fixture ($output -contains 'test-loader-dumpbin-unavailable' -and $output -contains 'test-loader-event-count=2') 'fallback_diagnostic_missing'
    Assert-Fixture (-not ($output -match 'ignored provider|ignored unrelated')) 'unrelated_events_emitted'
}

Write-Output "windows-desktop-fixtures=$fixtureCount failed=$fixtureFailures"
if ($fixtureFailures -ne 0) { exit 1 }
exit 0
