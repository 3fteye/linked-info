param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$desktopDirectory = Join-Path $repositoryRoot 'apps\desktop'
$resolvedOutputDirectory = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputDirectory))
$frontendDestination = Join-Path $resolvedOutputDirectory 'linked-info-desktop-frontend.cdx.json'

New-Item -ItemType Directory -Path $resolvedOutputDirectory -Force | Out-Null

$metadataJson = & cargo metadata --format-version 1 --locked --no-deps
if ($LASTEXITCODE -ne 0) {
    throw "cargo metadata failed with exit code $LASTEXITCODE"
}
$metadata = $metadataJson | ConvertFrom-Json
$workspacePackages = @($metadata.packages | Where-Object { $metadata.workspace_members -contains $_.id })
if ($workspacePackages.Count -eq 0) {
    throw 'Cargo metadata returned no workspace packages'
}

$rustOutputs = @($workspacePackages | ForEach-Object {
    $manifestDirectory = Split-Path -Parent $_.manifest_path
    [pscustomobject]@{
        Source = Join-Path $manifestDirectory "$($_.name).cdx.json"
        Destination = Join-Path $resolvedOutputDirectory "$($_.name).cdx.json"
    }
})
foreach ($rustOutput in $rustOutputs) {
    if (Test-Path -LiteralPath $rustOutput.Source) {
        throw "Refusing to overwrite an existing Rust SBOM source file: $($rustOutput.Source)"
    }
}

Push-Location $repositoryRoot
try {
    & cargo cyclonedx `
        --format json `
        --all `
        --target x86_64-pc-windows-msvc `
        --spec-version 1.5
    if ($LASTEXITCODE -ne 0) {
        throw "cargo cyclonedx failed with exit code $LASTEXITCODE"
    }

    foreach ($rustOutput in $rustOutputs) {
        if (-not (Test-Path -LiteralPath $rustOutput.Source)) {
            throw "Expected Rust SBOM was not generated: $($rustOutput.Source)"
        }
        Copy-Item -LiteralPath $rustOutput.Source -Destination $rustOutput.Destination -Force
    }
}
finally {
    Pop-Location
    foreach ($rustOutput in $rustOutputs) {
        if (Test-Path -LiteralPath $rustOutput.Source) {
            Remove-Item -LiteralPath $rustOutput.Source -Force
        }
    }
}

Push-Location $desktopDirectory
try {
    & pnpm sbom `
        --sbom-format cyclonedx `
        --sbom-spec-version 1.5 `
        --sbom-type application `
        --prod `
        --out $frontendDestination
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm sbom failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

$sbomFiles = @($rustOutputs | ForEach-Object { $_.Destination }) + @($frontendDestination)
& node (Join-Path $repositoryRoot 'scripts\validate-sbom.mjs') @sbomFiles
if ($LASTEXITCODE -ne 0) {
    throw "SBOM validation failed with exit code $LASTEXITCODE"
}

Write-Output ($rustOutputs | ForEach-Object { $_.Destination })
Write-Output $frontendDestination
