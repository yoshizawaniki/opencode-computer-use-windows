# System.Windows.Forms NotifyIcon balloon tip — native (.NET Framework
# ships it), no BurntToast/new dependency. WinRT toast notifications were
# considered but skipped: they need an AppId and can silently no-op when
# launched from a non-UI/headless process (exactly how this server spawns
# it, via -File so args bind cleanly through param() rather than -Command's
# less predictable argument binding), where NotifyIcon reliably works.
param(
    [string]$Title,
    [string]$Message,
    [string]$Icon = "info",
    [int]$DurationMs = 5000
)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = [System.Drawing.SystemIcons]::Information
$ni.Visible = $true
$iconType = switch ($Icon) {
    "error" { [System.Windows.Forms.ToolTipIcon]::Error }
    "warning" { [System.Windows.Forms.ToolTipIcon]::Warning }
    default { [System.Windows.Forms.ToolTipIcon]::Info }
}
$ni.ShowBalloonTip($DurationMs, $Title, $Message, $iconType)
Start-Sleep -Milliseconds ($DurationMs + 200)
$ni.Visible = $false
$ni.Dispose()
