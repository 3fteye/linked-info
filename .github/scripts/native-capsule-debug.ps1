param(
    [string]$Action,
    [string]$ExecutablePath,
    [int]$Port
)

$ErrorActionPreference = 'Stop'

function Write-NativeFailure([string]$Code) {
    [Console]::Out.WriteLine('{"error":"' + $Code + '"}')
    exit 1
}

# This helper is only for an ephemeral GitHub-hosted Windows runner. These
# guards must run before any path, registry, or process inspection.
if ($env:GITHUB_ACTIONS -cne 'true' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:RUNNER_OS -cne 'Windows' -or
    [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Write-NativeFailure 'native_capsule_ci_required'
}

if ($Action -cne 'Enable' -and $Action -cne 'Disable') {
    Write-NativeFailure 'native_capsule_debug_invalid_action'
}
if ($Port -lt 1024 -or $Port -gt 65535) {
    Write-NativeFailure 'native_capsule_debug_invalid_port'
}

$registryBase = $null
$policyKey = $null
$policyMutex = $null
$ownsMutex = $false
$failureCode = $null
$result = $null
$safeErrors = @(
    'native_capsule_debug_invalid_executable',
    'native_capsule_debug_policy_busy',
    'native_capsule_debug_policy_exists',
    'native_capsule_debug_policy_not_owned',
    'native_capsule_debug_verify_failed'
)

try {
    if ([string]::IsNullOrWhiteSpace($env:GITHUB_WORKSPACE) -or
        [string]::IsNullOrWhiteSpace($ExecutablePath) -or
        -not [IO.Path]::IsPathFullyQualified($ExecutablePath)) {
        throw 'native_capsule_debug_invalid_executable'
    }
    $repositoryPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $workspacePath = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
    $resolvedExecutable = [IO.Path]::GetFullPath($ExecutablePath)
    $executableName = [IO.Path]::GetFileName($resolvedExecutable)
    if ($executableName -cnotin @('linked-info-desktop.exe', 'linked-info-capture.exe')) {
        throw 'native_capsule_debug_invalid_executable'
    }
    $expectedExecutable = [IO.Path]::GetFullPath(
        (Join-Path $repositoryPath ('target/release/' + $executableName))
    )
    if (-not [string]::Equals($repositoryPath, $workspacePath, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($resolvedExecutable, $expectedExecutable, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'native_capsule_debug_invalid_executable'
    }
    # Do not accept a repository-local link that actually targets another app.
    foreach ($checkedPath in @(
        $repositoryPath,
        (Join-Path $repositoryPath 'target'),
        (Join-Path $repositoryPath 'target/release'),
        $expectedExecutable
    )) {
        $item = Get-Item -LiteralPath $checkedPath
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'native_capsule_debug_invalid_executable'
        }
    }
    if ($item.PSIsContainer -or $item.Name -cne $executableName) {
        throw 'native_capsule_debug_invalid_executable'
    }

    # Serialize this helper's Enable/Disable calls without broad registry locks.
    $policyMutex = [Threading.Mutex]::new($false, 'Local\LinkedInfo.NativeCapsuleDebugPolicy')
    try {
        $ownsMutex = $policyMutex.WaitOne(10000)
    } catch [Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }
    if (-not $ownsMutex) {
        throw 'native_capsule_debug_policy_busy'
    }

    $subkey = 'SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
    $valueName = $executableName
    $expectedValue = '--remote-debugging-port=' + $Port + ' --remote-debugging-address=127.0.0.1'
    $registryBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
        [Microsoft.Win32.RegistryHive]::LocalMachine,
        [Microsoft.Win32.RegistryView]::Registry64
    )
    $policyKey = $registryBase.OpenSubKey($subkey, $true)

    if ($Action -ceq 'Enable') {
        # Existence is checked by name only. Never read or overwrite a previous
        # value, even when its contents might happen to match this test's port.
        if ($null -ne $policyKey -and $policyKey.GetValueNames() -contains $valueName) {
            throw 'native_capsule_debug_policy_exists'
        }
        if ($null -eq $policyKey) {
            $policyKey = $registryBase.CreateSubKey($subkey, $true)
        }
        if ($policyKey.GetValueNames() -contains $valueName) {
            throw 'native_capsule_debug_policy_exists'
        }
        $policyKey.SetValue($valueName, $expectedValue, [Microsoft.Win32.RegistryValueKind]::String)
        $policyKey.Flush()
        $writtenValue = $policyKey.GetValue(
            $valueName,
            $null,
            [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
        )
        if ($policyKey.GetValueKind($valueName) -ne [Microsoft.Win32.RegistryValueKind]::String -or
            $writtenValue -isnot [string] -or $writtenValue -cne $expectedValue) {
            throw 'native_capsule_debug_verify_failed'
        }
        $result = '{"enabled":true}'
    } else {
        if ($null -ne $policyKey -and $policyKey.GetValueNames() -contains $valueName) {
            $currentValue = $policyKey.GetValue(
                $valueName,
                $null,
                [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
            )
            if ($policyKey.GetValueKind($valueName) -ne [Microsoft.Win32.RegistryValueKind]::String -or
                $currentValue -isnot [string] -or $currentValue -cne $expectedValue) {
                throw 'native_capsule_debug_policy_not_owned'
            }
            # Remove only the exact value owned by this invocation. Never
            # remove the key or any other application's policy value.
            $policyKey.DeleteValue($valueName, $true)
            $policyKey.Flush()
            if ($policyKey.GetValueNames() -contains $valueName) {
                throw 'native_capsule_debug_verify_failed'
            }
        }
        $result = '{"disabled":true}'
    }
} catch {
    $failureCode = if ($safeErrors -contains $_.Exception.Message) {
        $_.Exception.Message
    } else {
        'native_capsule_debug_failed'
    }
} finally {
    if ($null -ne $policyKey) { $policyKey.Dispose() }
    if ($null -ne $registryBase) { $registryBase.Dispose() }
    if ($ownsMutex) { $policyMutex.ReleaseMutex() }
    if ($null -ne $policyMutex) { $policyMutex.Dispose() }
}

if ($null -ne $failureCode) {
    Write-NativeFailure $failureCode
}
[Console]::Out.WriteLine($result)
