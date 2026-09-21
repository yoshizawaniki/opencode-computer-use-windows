param([Parameter(Mandatory = $true)][string]$Title)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$window = New-Object System.Windows.Window
$window.Title = $Title
$window.Name = "OpenCodeCUTestWindow"
$window.Width = 680
$window.Height = 430
$window.WindowStartupLocation = "CenterScreen"
$window.Topmost = $true

$root = New-Object System.Windows.Controls.StackPanel
$root.Margin = New-Object System.Windows.Thickness(20)

$primary = New-Object System.Windows.Controls.StackPanel
$primary.Name = "PrimaryPanel"
$root.Children.Add($primary) | Out-Null

$secondary = New-Object System.Windows.Controls.StackPanel
$secondary.Name = "SecondaryPanel"
$secondary.Margin = New-Object System.Windows.Thickness(0, 20, 0, 0)

$text = New-Object System.Windows.Controls.TextBox
$text.Name = "MainText"
$text.AcceptsReturn = $true
$text.Height = 100
$text.TextWrapping = "Wrap"
[System.Windows.Automation.AutomationProperties]::SetName($text, "Main editor")
$primary.Children.Add($text) | Out-Null

$reparent = New-Object System.Windows.Controls.Button
$reparent.Name = "ReparentButton"
$reparent.Content = "Reparent editor"
$reparent.Width = 150
$reparent.Height = 36
$reparent.HorizontalAlignment = "Left"
$reparent.Margin = New-Object System.Windows.Thickness(0, 20, 0, 0)
$root.Children.Add($reparent) | Out-Null

$status = New-Object System.Windows.Controls.TextBlock
$status.Name = "StatusLabel"
$status.Text = "Ready"
$status.Margin = New-Object System.Windows.Thickness(0, 12, 0, 0)
$root.Children.Add($status) | Out-Null

# Keep the secondary container after the button/status in the ControlView
# ordering. Moving the editor here therefore changes its path-based UIA ref
# deterministically and exercises semantic stale-ref recovery.
$root.Children.Add($secondary) | Out-Null

$reparent.Add_Click({
    [void]$primary.Children.Remove($text)
    $text.Height = 70
    [void]$secondary.Children.Add($text)
    $status.Text = "Reparented"
})

$window.Content = $root
$window.Add_ContentRendered({
    [void]$text.Focus()
})

[void]$window.ShowDialog()
