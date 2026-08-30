# UI Automation bridge for src/uia.js. Reads one JSON request from stdin,
# writes exactly one JSON response to stdout ({ok:true,data} or {ok:false,error}).
# All diagnostics go to stderr/Write-Error so stdout stays pure JSON.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms

# ---- shared helpers -------------------------------------------------------

function Get-ChildrenList($Element) {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $children = @()
    $child = $walker.GetFirstChild($Element)
    while ($null -ne $child) {
        $children += $child
        $child = $walker.GetNextSibling($child)
    }
    return $children
}

# Single ref<->element resolver, used by every action. ref = "<hwnd>|<dot-separated
# ControlView child indices>", e.g. "132456|2.0". No caching: UIA handles can't
# cross process boundaries, so every call re-walks from AutomationElement.FromHandle.
function Resolve-Ref([string]$Ref) {
    if ([string]::IsNullOrEmpty($Ref)) { throw "ref is required" }
    $parts = $Ref.Split('|', 2)
    if ($parts.Count -lt 2) { throw "Invalid ref format (expected 'hwnd|path'): $Ref" }
    $hwndStr = $parts[0]
    $path = $parts[1]
    $hwndNum = 0L
    if (-not [int64]::TryParse($hwndStr, [ref]$hwndNum)) { throw "Invalid hwnd in ref: $hwndStr" }

    $root = $null
    try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwndNum) } catch { $root = $null }
    if ($null -eq $root) { throw "Window not found for hwnd $hwndStr (it may have closed)" }

    $element = $root
    if ($path -ne '') {
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        foreach ($idxStr in $path.Split('.')) {
            $idx = 0
            if (-not [int]::TryParse($idxStr, [ref]$idx)) { throw "Invalid ref path segment '$idxStr' in $Ref" }
            $child = $walker.GetFirstChild($element)
            $i = 0
            while ($i -lt $idx -and $null -ne $child) { $child = $walker.GetNextSibling($child); $i++ }
            if ($null -eq $child) { throw "Cannot resolve ref '$Ref': no child at index $idx (element tree changed?)" }
            $element = $child
        }
    }
    return @{ Element = $element; Hwnd = $hwndNum }
}

function Get-ControlTypeByName([string]$Name) {
    $flags = [System.Reflection.BindingFlags]::Public -bor [System.Reflection.BindingFlags]::Static
    $field = [System.Windows.Automation.ControlType].GetField($Name, $flags)
    if (-not $field) {
        $field = [System.Windows.Automation.ControlType].GetFields($flags) | Where-Object { $_.Name -ieq $Name } | Select-Object -First 1
    }
    if (-not $field) { throw "Unknown controlType: $Name" }
    return $field.GetValue($null)
}

# Single element->JSON serializer (incl. password redaction), used by every action.
function ConvertTo-ElementJson($Element, [string]$Ref) {
    $cur = $Element.Current

    $ctName = $cur.ControlType.ProgrammaticName
    if ($ctName -and $ctName.Contains('.')) { $ctName = $ctName.Split('.')[-1] }

    $rect = $cur.BoundingRectangle
    $bounds = @{ x = 0; y = 0; width = 0; height = 0 }
    if (-not $rect.IsEmpty) {
        $bounds = @{ x = [math]::Round($rect.X); y = [math]::Round($rect.Y); width = [math]::Round($rect.Width); height = [math]::Round($rect.Height) }
    }

    $rawValue = $null
    $valuePattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        try { $rawValue = $valuePattern.Current.Value } catch { $rawValue = $null }
    }

    $toggleState = $null
    $togglePattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$togglePattern)) {
        try { $toggleState = $togglePattern.Current.ToggleState.ToString() } catch { $toggleState = $null }
    }

    $name = $cur.Name
    $automationId = $cur.AutomationId

    # Redaction lives here only: AutomationElement.IsPassword first, plus a
    # belt-and-braces name/automationId regex match, so no caller has to remember to check.
    $isPassword = [bool]$cur.IsPassword
    if (-not $isPassword) {
        if (($name -and $name -match '(?i)(password|secret|token|pin|cvv)') -or
            ($automationId -and $automationId -match '(?i)(password|secret|token|pin|cvv)')) {
            $isPassword = $true
        }
    }

    $valueLength = 0
    if ($null -ne $rawValue) { $valueLength = $rawValue.Length }
    $valueOut = $rawValue
    if ($isPassword) { $valueOut = $null }

    $processName = $null
    try {
        $proc = [System.Diagnostics.Process]::GetProcessById($cur.ProcessId)
        $processName = "$($proc.ProcessName).exe"
    } catch { $processName = $null }

    return [ordered]@{
        ref              = $Ref
        name             = $name
        controlType      = $ctName
        automationId     = $automationId
        className        = $cur.ClassName
        bounds           = $bounds
        isEnabled        = [bool]$cur.IsEnabled
        isOffscreen      = [bool]$cur.IsOffscreen
        hasKeyboardFocus = [bool]$cur.HasKeyboardFocus
        isPassword       = $isPassword
        value            = $valueOut
        valueLength      = $valueLength
        toggleState      = $toggleState
        processName      = $processName
        processId        = $cur.ProcessId
    }
}

# Shared walk used by find/wait_for: BFS over descendants (ControlView) from ref,
# matching automationId/name/controlType (AND of whichever are given). Capped at
# $Limit results and a hard node-visit safety cap so a huge tree can't hang the call.
function Find-Elements([string]$Ref, $AutomationId, $Name, $ControlType, [int]$Limit) {
    $resolved = Resolve-Ref $Ref
    $basePath = ($Ref.Split('|', 2))[1]
    $ctObj = $null
    if ($ControlType) { $ctObj = Get-ControlTypeByName $ControlType }

    $queue = New-Object System.Collections.Generic.Queue[object]
    $i = 0
    foreach ($k in (Get-ChildrenList $resolved.Element)) {
        $cp = if ($basePath -eq '') { "$i" } else { "$basePath.$i" }
        $queue.Enqueue(@{ Element = $k; Path = $cp })
        $i++
    }

    $results = @()
    $visited = 0
    $safetyCap = 20000 # ponytail: hard cap on nodes visited, raise if a legitimate huge tree needs deeper search
    $truncated = $false
    while ($queue.Count -gt 0) {
        if ($results.Count -ge $Limit) { $truncated = $true; break }
        if ($visited -ge $safetyCap) { $truncated = $true; break }
        $item = $queue.Dequeue()
        $visited++
        $el = $item.Element
        $cur = $el.Current

        $isMatch = $true
        if ($AutomationId -and $cur.AutomationId -ne $AutomationId) { $isMatch = $false }
        if ($isMatch -and $Name -and $cur.Name -ne $Name) { $isMatch = $false }
        if ($isMatch -and $ctObj -and $cur.ControlType -ne $ctObj) { $isMatch = $false }
        if ($isMatch) {
            $refStr = "$($resolved.Hwnd)|$($item.Path)"
            $results += (ConvertTo-ElementJson -Element $el -Ref $refStr)
        }

        $j = 0
        foreach ($k2 in (Get-ChildrenList $el)) {
            $queue.Enqueue(@{ Element = $k2; Path = "$($item.Path).$j" })
            $j++
        }
    }
    if (-not $truncated -and $queue.Count -gt 0) { $truncated = $true }
    return @{ elements = $results; truncated = $truncated }
}

# ---- main -------------------------------------------------------------

try {
    $stdin = [Console]::In.ReadToEnd()
    $req = $stdin | ConvertFrom-Json
    $action = $req.action
    if ([string]::IsNullOrEmpty($action)) { throw "action is required" }

    $data = $null

    switch ($action) {
        'list_windows' {
            $root = [System.Windows.Automation.AutomationElement]::RootElement
            $list = @()
            foreach ($w in (Get-ChildrenList $root)) {
                $cur = $w.Current
                $rect = $cur.BoundingRectangle
                if ($cur.IsOffscreen) { continue }
                if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
                $hwnd = $cur.NativeWindowHandle
                $list += (ConvertTo-ElementJson -Element $w -Ref "$hwnd|")
            }
            $data = $list
        }

        'active_window' {
            $data = $null
            $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
            if ($null -ne $focused) {
                $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
                $rootEl = [System.Windows.Automation.AutomationElement]::RootElement
                $current = $focused
                while ($true) {
                    $parent = $null
                    try { $parent = $walker.GetParent($current) } catch { $parent = $null }
                    if ($null -eq $parent -or $parent.Equals($rootEl)) { break }
                    $current = $parent
                }
                $hwnd = $current.Current.NativeWindowHandle
                if ($hwnd -ne 0) {
                    $data = ConvertTo-ElementJson -Element $current -Ref "$hwnd|"
                }
            }
        }

        'tree' {
            $resolved = Resolve-Ref $req.ref
            $maxDepth = if ($null -ne $req.maxDepth) { [int]$req.maxDepth } else { 4 }
            $maxNodes = if ($null -ne $req.maxNodes) { [int]$req.maxNodes } else { 200 }
            $basePath = ($req.ref.Split('|', 2))[1]

            $elements = @()
            $queue = New-Object System.Collections.Generic.Queue[object]
            $queue.Enqueue(@{ Element = $resolved.Element; Path = $basePath; Depth = 0 })
            while ($queue.Count -gt 0 -and $elements.Count -lt $maxNodes) {
                $item = $queue.Dequeue()
                $refStr = "$($resolved.Hwnd)|$($item.Path)"
                $j = ConvertTo-ElementJson -Element $item.Element -Ref $refStr
                $j['depth'] = $item.Depth
                $elements += $j
                if ($item.Depth -lt $maxDepth) {
                    $i = 0
                    foreach ($k in (Get-ChildrenList $item.Element)) {
                        $cp = if ($item.Path -eq '') { "$i" } else { "$($item.Path).$i" }
                        $queue.Enqueue(@{ Element = $k; Path = $cp; Depth = $item.Depth + 1 })
                        $i++
                    }
                }
            }
            $data = @{ elements = $elements; truncated = ($queue.Count -gt 0) }
        }

        'find' {
            $limit = if ($null -ne $req.limit) { [int]$req.limit } else { 50 }
            $data = Find-Elements -Ref $req.ref -AutomationId $req.automationId -Name $req.name -ControlType $req.controlType -Limit $limit
        }

        'wait_for' {
            $timeoutMs = if ($null -ne $req.timeoutMs) { [int]$req.timeoutMs } else { 5000 }
            $deadline = (Get-Date).AddMilliseconds($timeoutMs)
            $found = $false
            $foundEl = $null
            while ($true) {
                $r = Find-Elements -Ref $req.ref -AutomationId $req.automationId -Name $req.name -ControlType $req.controlType -Limit 1
                if ($r.elements.Count -gt 0) { $found = $true; $foundEl = $r.elements[0]; break }
                if ((Get-Date) -ge $deadline) { break }
                Start-Sleep -Milliseconds 300
            }
            $data = @{ found = $found; element = $foundEl }
        }

        'get_value' {
            $resolved = Resolve-Ref $req.ref
            $data = ConvertTo-ElementJson -Element $resolved.Element -Ref $req.ref
        }

        'set_value' {
            $resolved = Resolve-Ref $req.ref
            $vp = $null
            if (-not $resolved.Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
                throw "Element does not support ValuePattern (cannot set value): $($req.ref)"
            }
            $vp.SetValue([string]$req.value)
            $resolved2 = Resolve-Ref $req.ref
            $data = ConvertTo-ElementJson -Element $resolved2.Element -Ref $req.ref
        }

        'invoke' {
            $resolved = Resolve-Ref $req.ref
            $ip = $null
            if (-not $resolved.Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {
                throw "Element does not support InvokePattern: $($req.ref)"
            }
            $ip.Invoke()
            $resolved2 = Resolve-Ref $req.ref
            $data = ConvertTo-ElementJson -Element $resolved2.Element -Ref $req.ref
        }

        'toggle' {
            $resolved = Resolve-Ref $req.ref
            $tp = $null
            if (-not $resolved.Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp)) {
                throw "Element does not support TogglePattern: $($req.ref)"
            }
            $tp.Toggle()
            $resolved2 = Resolve-Ref $req.ref
            $data = ConvertTo-ElementJson -Element $resolved2.Element -Ref $req.ref
        }

        'select' {
            $resolved = Resolve-Ref $req.ref
            $sp = $null
            if (-not $resolved.Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sp)) {
                throw "Element does not support SelectionItemPattern: $($req.ref)"
            }
            $sp.Select()
            $resolved2 = Resolve-Ref $req.ref
            $data = ConvertTo-ElementJson -Element $resolved2.Element -Ref $req.ref
        }

        'focus' {
            $resolved = Resolve-Ref $req.ref
            $resolved.Element.SetFocus()
            $resolved2 = Resolve-Ref $req.ref
            $data = ConvertTo-ElementJson -Element $resolved2.Element -Ref $req.ref
        }

        default { throw "Unknown action: $action" }
    }

    $out = @{ ok = $true; data = $data } | ConvertTo-Json -Depth 12 -Compress
    [Console]::Out.Write($out)
}
catch {
    $errObj = @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    [Console]::Out.Write($errObj)
}
