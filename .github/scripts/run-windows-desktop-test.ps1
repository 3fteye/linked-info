param(
    [string]$TestBinary,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$TestArguments
)

function Invoke-WindowsDesktopTestRunner {
    param(
        [string]$BinaryPath,
        [string[]]$BinaryArguments = @(),
        [scriptblock]$InvokeTool = {
            param([string]$Command, [string[]]$CommandArguments)
            & $Command @CommandArguments
            $global:LASTEXITCODE = $LASTEXITCODE
        }
    )

    $ErrorActionPreference = 'Stop'
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
        throw 'windows_desktop_test_ci_required'
    }
    if ([string]::IsNullOrWhiteSpace($BinaryPath)) {
        throw 'windows_desktop_test_artifact_invalid'
    }
    $repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $testDirectory = [IO.Path]::GetFullPath((Join-Path $repoRoot 'target/debug/deps'))
    $resolvedBinary = Get-Item -LiteralPath $BinaryPath
    if ($resolvedBinary.PSIsContainer -or $resolvedBinary.DirectoryName -ne $testDirectory -or
        $resolvedBinary.Name -notmatch '^linked_info_(?:desktop|capture)_lib-[0-9a-f]+\.exe$' -or
        ($resolvedBinary.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'windows_desktop_test_artifact_invalid'
    }
    $manifestTool = Get-ChildItem -Path (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin/*/x64/mt.exe') -File |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($null -eq $manifestTool) { throw 'windows_desktop_test_manifest_tool_missing' }
    $manifest = Join-Path $PSScriptRoot 'windows-desktop-test.manifest'
    $embedArguments = @('-nologo', '-manifest', $manifest, "-outputresource:$($resolvedBinary.FullName);#1")
    & $InvokeTool $manifestTool.FullName $embedArguments
    if ($LASTEXITCODE -ne 0) { throw 'windows_desktop_test_manifest_embed_failed' }
    $validateArguments = @('-nologo', "-inputresource:$($resolvedBinary.FullName);#1", '-validate_manifest')
    & $InvokeTool $manifestTool.FullName $validateArguments
    if ($LASTEXITCODE -ne 0) { throw 'windows_desktop_test_manifest_invalid' }
    Write-Output 'windows-desktop-test-manifest=common-controls-v6'

    # Execute the exact Cargo-selected artifact. Never invoke Cargo here: doing
    # so can relink this harness and discard its newly embedded manifest.
    & $InvokeTool $resolvedBinary.FullName $BinaryArguments
    $testExitCode = $LASTEXITCODE
    if ($testExitCode -in @(-1073741511, 3221225785)) {
        try {
            $diagnosticArguments = @('-TestBinary', $resolvedBinary.FullName)
            & $InvokeTool (Join-Path $PSScriptRoot 'diagnose-windows-test-loader.ps1') $diagnosticArguments
        } catch {
            Write-Output 'windows_test_loader_diagnostics_incomplete'
        }
    }
    $global:LASTEXITCODE = $testExitCode
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-WindowsDesktopTestRunner -BinaryPath $TestBinary -BinaryArguments $TestArguments
    exit $LASTEXITCODE
}
