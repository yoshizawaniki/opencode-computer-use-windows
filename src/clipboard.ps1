# Clipboard bridge. Uses the built-in Get-Clipboard/Set-Clipboard cmdlets
# (PowerShell 5.1+, no new dependency) rather than P/Invoke — same
# stdin/stdout JSON contract as uia.ps1/secret-resolve.ps1.
$ErrorActionPreference = "Stop"

function Write-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 5)
}

try {
    $raw = [Console]::In.ReadToEnd()
    $req = $raw | ConvertFrom-Json

    switch ($req.action) {
        "read" {
            $text = Get-Clipboard -Raw -ErrorAction SilentlyContinue
            if ($null -eq $text) { $text = "" }
            $sha256 = [Security.Cryptography.SHA256]::Create()
            $hashBytes = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))
            $hash = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
            Write-Result @{
                ok = $true
                data = @{ length = $text.Length; sha256 = $hash; value = $text }
            }
        }
        "write" {
            Set-Clipboard -Value ([string]$req.text)
            Write-Result @{ ok = $true; data = @{ written = $true; length = ([string]$req.text).Length } }
        }
        default {
            Write-Result @{ ok = $false; error = "unknown action '$($req.action)'" }
        }
    }
} catch {
    Write-Result @{ ok = $false; error = $_.Exception.Message }
}
