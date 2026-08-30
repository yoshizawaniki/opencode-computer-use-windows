# Internal bridge for secret-broker.js ONLY — reads a secret registered by
# scripts/secret-cli.ps1 (the human-run registration tool) and returns its
# decrypted value + bound scope over stdout JSON, same stdin/stdout JSON
# contract as uia.ps1. There is no "set" action here: registration is
# CLI/human-only by design, so an LLM-driven tool call can never write a
# secret value (design doc: Secrets changes are ask/deny; the safest form of
# that is "no such Tool exists").
$ErrorActionPreference = "Stop"

function Write-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 5)
}

try {
    $raw = [Console]::In.ReadToEnd()
    $req = $raw | ConvertFrom-Json

    if ([string]::IsNullOrWhiteSpace($req.name)) {
        Write-Result @{ ok = $false; error = "missing 'name'" }
        exit 0
    }
    # Registration writes <name>.secret/.json using the raw -Name value as the
    # filename with no sanitization — reject path-traversal / separator
    # characters here so a crafted name can't read outside the secrets dir.
    if ($req.name -notmatch '^[A-Za-z0-9_.-]+$') {
        Write-Result @{ ok = $false; error = "invalid secret name" }
        exit 0
    }

    Add-Type -AssemblyName System.Security

    $dir = Join-Path $env:APPDATA "opencode-computer-use\secrets"
    $secretPath = Join-Path $dir "$($req.name).secret"
    $metaPath = Join-Path $dir "$($req.name).json"

    if (-not (Test-Path $secretPath) -or -not (Test-Path $metaPath)) {
        Write-Result @{ ok = $false; error = "secret '$($req.name)' is not registered (run scripts/secret-cli.ps1 -Action register)" }
        exit 0
    }

    $meta = Get-Content $metaPath -Raw | ConvertFrom-Json
    $protectedBytes = [Convert]::FromBase64String((Get-Content $secretPath -Raw))
    $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
        $protectedBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $value = [Text.Encoding]::UTF8.GetString($plainBytes)

    Write-Result @{ ok = $true; data = @{ value = $value; scope = $meta.scope } }
} catch {
    Write-Result @{ ok = $false; error = $_.Exception.Message }
}
