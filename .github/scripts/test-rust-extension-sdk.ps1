$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$externalRoot = Join-Path $env:RUNNER_TEMP ("linked-info-extension-example-" + [guid]::NewGuid().ToString('N'))
$externalSdk = Join-Path $externalRoot 'crates\extension-sdk'
$externalExample = Join-Path $externalRoot 'examples\rust-extension'
$artifacts = Join-Path $externalRoot 'artifacts'

New-Item -ItemType Directory -Path (Split-Path -Parent $externalSdk) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $externalExample) -Force | Out-Null
New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'crates\extension-sdk') -Destination $externalSdk -Recurse
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'examples\rust-extension') -Destination $externalExample -Recurse

Push-Location $externalExample
try {
    & cargo build --target wasm32-unknown-unknown --release
    if ($LASTEXITCODE -ne 0) {
        throw "external extension build failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

$coreModule = Join-Path $externalExample 'target\wasm32-unknown-unknown\release\linked_info_example_extension.wasm'
$component = Join-Path $artifacts 'extension.wasm'
$signingKey = Join-Path $artifacts 'publisher.key'
$package = Join-Path $artifacts 'linked-info-example-extension.liext'

Push-Location $repositoryRoot
try {
    & cargo run --quiet --locked -p linked-info-extension-tool -- componentize `
        --module $coreModule `
        --output $component
    if ($LASTEXITCODE -ne 0) {
        throw "extension componentization failed with exit code $LASTEXITCODE"
    }

    & cargo run --quiet --locked -p linked-info-extension-tool -- keygen `
        --output $signingKey | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "extension signing key generation failed with exit code $LASTEXITCODE"
    }

    $packOutput = & cargo run --quiet --locked -p linked-info-extension-tool -- pack `
        --manifest (Join-Path $externalExample 'manifest.json') `
        --component $component `
        --metadata-schema (Join-Path $externalExample 'metadata.schema.json') `
        --locales-dir (Join-Path $externalExample 'locales') `
        --signing-key $signingKey `
        --output $package
    if ($LASTEXITCODE -ne 0) {
        throw "extension packaging failed with exit code $LASTEXITCODE"
    }
    $packed = ($packOutput -join [Environment]::NewLine) | ConvertFrom-Json
    if (-not $packed.signed -or $packed.extensionId -ne 'dev.linked-info.example-inspector') {
        throw 'extension package summary did not describe the signed external example'
    }

    $verifyOutput = & cargo run --quiet --locked -p linked-info-extension-tool -- verify `
        --package $package
    if ($LASTEXITCODE -ne 0) {
        throw "extension verification failed with exit code $LASTEXITCODE"
    }
    $verified = ($verifyOutput -join [Environment]::NewLine) | ConvertFrom-Json
    if (-not $verified.signed -or $verified.packageSha256 -ne $packed.packageSha256) {
        throw 'extension verification did not reproduce the packaged identity'
    }

    $renderOutput = & cargo run --quiet --locked -p linked-info-extension-tool -- render `
        --package $package `
        --processor-id summary `
        --content 'example content'
    if ($LASTEXITCODE -ne 0) {
        throw "extension render test failed with exit code $LASTEXITCODE"
    }
    $rendered = ($renderOutput -join [Environment]::NewLine) | ConvertFrom-Json
    if ($rendered.elements.Count -ne 3 -or $rendered.elements[0].type -ne 'text') {
        throw 'extension render test returned an unexpected declarative presentation'
    }

    $invokeOutput = & cargo run --quiet --locked -p linked-info-extension-tool -- invoke `
        --package $package `
        --action-id uppercase `
        --content 'example content' `
        --base-revision 7
    if ($LASTEXITCODE -ne 0) {
        throw "extension action test failed with exit code $LASTEXITCODE"
    }
    $invoked = ($invokeOutput -join [Environment]::NewLine) | ConvertFrom-Json
    if ($invoked.nodeMetadata.lastAction -ne 'uppercase' -or $invoked.proposal.baseRevision -ne 7) {
        throw 'extension action test did not return metadata and a revision-bound proposal'
    }
}
finally {
    Pop-Location
}

Write-Output "External Rust extension SDK test passed: $package"
