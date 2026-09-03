[CmdletBinding()]
param(
    [string]$RunId,
    [string]$SourceDirectory,
    [string]$Commit,
    [string]$ArtifactsRoot,
    [string]$ShortcutPath,
    [switch]$ValidateOnly,
    [switch]$Launch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDirectory 'windows-package-validation.ps1')
$repositoryRoot = Split-Path -Parent $scriptDirectory
if ([string]::IsNullOrWhiteSpace($ArtifactsRoot)) {
    $ArtifactsRoot = Join-Path $repositoryRoot "artifacts"
}
$ArtifactsRoot = [System.IO.Path]::GetFullPath($ArtifactsRoot)
[System.IO.Directory]::CreateDirectory($ArtifactsRoot) | Out-Null

function Assert-PathInsideArtifacts([string]$Path) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $rootPrefix = $ArtifactsRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) +
        [System.IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the configured artifacts directory: $fullPath"
    }
}

function Remove-ManagedLink([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    Assert-PathInsideArtifacts $Path
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
        throw "Refusing to replace a non-link path: $Path"
    }
    [System.IO.Directory]::Delete($item.FullName)
}

function Resolve-Package([string]$Directory) {
    $resolvedDirectory = (Resolve-Path -LiteralPath $Directory).Path
    Assert-PathInsideArtifacts $resolvedDirectory
    return Test-WindowsPortablePackage -Directory $resolvedDirectory
}

if ($ValidateOnly) {
    if ([string]::IsNullOrWhiteSpace($SourceDirectory)) {
        throw 'SourceDirectory is required for ValidateOnly'
    }
    Resolve-Package $SourceDirectory | ConvertTo-Json -Depth 4
    exit 0
}

if ([string]::IsNullOrWhiteSpace($SourceDirectory)) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw "GitHub CLI is required when SourceDirectory is not provided"
    }
    if ([string]::IsNullOrWhiteSpace($RunId)) {
        $runs = gh run list --workflow "Desktop packages" --branch main --status success --limit 1 `
            --json databaseId,headSha,status,conclusion | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or $runs.Count -ne 1) {
            throw "Cannot resolve the latest successful Windows package run"
        }
        $RunId = [string]$runs[0].databaseId
        $Commit = [string]$runs[0].headSha
    }
    else {
        $run = gh run view $RunId --json headSha,status,conclusion | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or $run.status -ne "completed" -or $run.conclusion -ne "success") {
            throw "The selected Windows package run is not successful"
        }
        $Commit = [string]$run.headSha
    }
    $shortCommit = $Commit.Substring(0, [Math]::Min(7, $Commit.Length))
    $SourceDirectory = Join-Path $ArtifactsRoot "linked-info-windows-$shortCommit"
    if (-not (Test-Path -LiteralPath $SourceDirectory)) {
        $temporaryDirectory = Join-Path $ArtifactsRoot (".linked-info-download-" + [guid]::NewGuid().ToString("N"))
        [System.IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null
        try {
            gh run download $RunId --name "linked-info-windows" --dir $temporaryDirectory
            if ($LASTEXITCODE -ne 0) {
                throw "GitHub artifact download failed"
            }
            Resolve-Package $temporaryDirectory | Out-Null
            Move-Item -LiteralPath $temporaryDirectory -Destination $SourceDirectory
        }
        catch {
            if (Test-Path -LiteralPath $temporaryDirectory) {
                Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
            }
            throw
        }
    }
}
elseif ([string]::IsNullOrWhiteSpace($Commit)) {
    throw "Commit is required when SourceDirectory is provided"
}

$package = Resolve-Package $SourceDirectory
$currentLink = Join-Path $ArtifactsRoot "linked-info-current"
$nextLink = Join-Path $ArtifactsRoot ".linked-info-current-next"
$previousLink = Join-Path $ArtifactsRoot ".linked-info-current-previous"
Remove-ManagedLink $nextLink
Remove-ManagedLink $previousLink
New-Item -ItemType Junction -Path $nextLink -Target $package.ReleaseDirectory | Out-Null

$nextExecutable = Join-Path $nextLink "linked-info-desktop.exe"
$nextHash = (Get-FileHash -LiteralPath $nextExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($nextHash -ne $package.Sha256) {
    Remove-ManagedLink $nextLink
    throw "The stable-link candidate failed checksum verification"
}

$hadCurrent = Test-Path -LiteralPath $currentLink
if ($hadCurrent) {
    $currentItem = Get-Item -LiteralPath $currentLink -Force
    if (($currentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
        Remove-ManagedLink $nextLink
        throw "Refusing to replace a non-link current package path: $currentLink"
    }
    Rename-Item -LiteralPath $currentLink -NewName (Split-Path -Leaf $previousLink)
}
try {
    Rename-Item -LiteralPath $nextLink -NewName (Split-Path -Leaf $currentLink)
}
catch {
    if ($hadCurrent -and (Test-Path -LiteralPath $previousLink)) {
        Rename-Item -LiteralPath $previousLink -NewName (Split-Path -Leaf $currentLink)
    }
    throw
}
Remove-ManagedLink $previousLink

$metadataPath = Join-Path $ArtifactsRoot "linked-info-current.json"
[pscustomobject]@{
    commit = $Commit
    runId = if ([string]::IsNullOrWhiteSpace($RunId)) { $null } else { $RunId }
    sha256 = $package.Sha256
    binaryHashes = $package.BinaryHashes
    releaseDirectory = $package.ReleaseDirectory
    synchronizedAt = [DateTimeOffset]::Now.ToString("o")
} | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8

if (-not [string]::IsNullOrWhiteSpace($ShortcutPath)) {
    $shortcutFullPath = [System.IO.Path]::GetFullPath($ShortcutPath)
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $shortcutFullPath)) | Out-Null
    $shortcutShell = New-Object -ComObject WScript.Shell
    $shortcut = $shortcutShell.CreateShortcut($shortcutFullPath)
    $shortcut.TargetPath = Join-Path $currentLink "linked-info-desktop.exe"
    $shortcut.WorkingDirectory = $currentLink
    $shortcut.IconLocation = (Join-Path $currentLink "linked-info-desktop.exe") + ",0"
    $shortcut.Save()
}

if ($Launch) {
    Start-Process -FilePath (Join-Path $currentLink "linked-info-desktop.exe") `
        -WorkingDirectory $currentLink
}

[pscustomobject]@{
    commit = $Commit
    currentExecutable = (Join-Path $currentLink "linked-info-desktop.exe")
    captureExecutable = (Join-Path $currentLink "linked-info-capture.exe")
    sha256 = $package.Sha256
    shortcut = if ([string]::IsNullOrWhiteSpace($ShortcutPath)) { $null } else { $ShortcutPath }
    launched = [bool]$Launch
} | ConvertTo-Json
