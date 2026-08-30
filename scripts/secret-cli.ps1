# Human-run CLI for registering secrets with the Secret Broker. NOT called
# by the MCP server or any Tool — this is deliberate: there is no code path
# by which an LLM tool call can write a secret value, only resolve one it
# didn't choose the name/scope of. Run this yourself in your own terminal.
#
# Usage:
#   powershell -File scripts\secret-cli.ps1 -Action register -Name mysite -Scope "https://example.com"
#   powershell -File scripts\secret-cli.ps1 -Action register -Name notepad-demo -Scope "notepad.exe"
#   powershell -File scripts\secret-cli.ps1 -Action list
#   powershell -File scripts\secret-cli.ps1 -Action remove -Name mysite
#
# Scope binding: for browser_secret_fill, Scope must be the exact page
# origin (scheme://host[:port]) the secret may be used on. For
# desktop_secret_type, Scope must be the exact process name (e.g.
# "notepad.exe") the secret may be typed into. Resolution refuses the
# secret if the current target doesn't match — this is what stops a
# malicious page/UI from tricking a fill call into using the wrong
# credential.
param(
    [Parameter(Mandatory = $true)][ValidateSet("register", "list", "remove")][string]$Action,
    [string]$Name,
    [string]$Scope
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security

$dir = Join-Path $env:APPDATA "opencode-computer-use\secrets"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function Assert-ValidName($n) {
    if ($n -notmatch '^[A-Za-z0-9_.-]+$') {
        throw "name must match [A-Za-z0-9_.-]+ (got '$n')"
    }
}

switch ($Action) {
    "register" {
        if (-not $Name -or -not $Scope) { throw "register requires -Name and -Scope" }
        Assert-ValidName $Name

        # Interactive terminal: prompt with masked input (the normal, intended
        # path). Redirected stdin (piped input, e.g. from an automated test):
        # Read-Host -AsSecureString reads raw chars off a redirected stream
        # as plaintext anyway, so reading a plain line directly is no less
        # secure and avoids Read-Host hanging when there's no console to
        # prompt on.
        if ([Console]::IsInputRedirected) {
            $plain = [Console]::In.ReadLine()
        } else {
            $secure = Read-Host -Prompt "Enter secret value for '$Name'" -AsSecureString
            $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            try {
                $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
            } finally {
                [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
            }
        }
        if ([string]::IsNullOrEmpty($plain)) { throw "empty secret value refused" }

        $bytes = [Text.Encoding]::UTF8.GetBytes($plain)
        $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
            $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [IO.File]::WriteAllText((Join-Path $dir "$Name.secret"), [Convert]::ToBase64String($protectedBytes))

        $meta = @{ name = $Name; scope = $Scope; createdAt = (Get-Date).ToString("o") } | ConvertTo-Json
        [IO.File]::WriteAllText((Join-Path $dir "$Name.json"), $meta)

        Write-Host "Registered '$Name' -> scope '$Scope'. Value stored DPAPI-encrypted (CurrentUser), never shown again."
    }
    "list" {
        Get-ChildItem $dir -Filter "*.json" -ErrorAction SilentlyContinue | ForEach-Object {
            $m = Get-Content $_.FullName -Raw | ConvertFrom-Json
            [PSCustomObject]@{ name = $m.name; scope = $m.scope; createdAt = $m.createdAt }
        } | Format-Table -AutoSize
    }
    "remove" {
        if (-not $Name) { throw "remove requires -Name" }
        Assert-ValidName $Name
        Remove-Item (Join-Path $dir "$Name.secret") -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $dir "$Name.json") -ErrorAction SilentlyContinue
        Write-Host "Removed '$Name'."
    }
}
