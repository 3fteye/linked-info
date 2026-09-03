function Invoke-WindowsDesktopTests {
    param(
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
    $runnerScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'run-windows-desktop-test.ps1'))
    $runnerArguments = @('pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $runnerScript)
    # JSON string arrays are valid TOML arrays, including escaped Windows paths.
    # Cargo invokes this absolute runner only after linking, with its DLL PATH.
    $runnerConfig = 'target.x86_64-pc-windows-msvc.runner=' + (ConvertTo-Json -InputObject $runnerArguments -Compress)
    $cargoArguments = @('test', '-p', 'linked-info-desktop', '--lib', '--config', $runnerConfig)
    & $InvokeTool 'cargo' $cargoArguments
    $global:LASTEXITCODE = $LASTEXITCODE
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-WindowsDesktopTests
    exit $LASTEXITCODE
}
