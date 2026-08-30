# UI Automation bridge for src/uia.js. Reads one JSON request from stdin,
# writes exactly one JSON response to stdout ({ok:true,data} or {ok:false,error}).
# All diagnostics go to stderr/Write-Error so stdout stays pure JSON.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing, WindowsBase

# Desktop Computer Use (Phase 4) fallback: coordinate/keyboard input via real
# SendInput events (not SendKeys/WinForms simulation), so it works against
# elevated windows and apps that ignore synthetic window messages.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class NativeInput
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;

    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint KEYEVENTF_KEYUP = 0x0002;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);

    public static void MoveTo(int x, int y) { SetCursorPos(x, y); }

    public static void MouseDown(uint flag)
    {
        INPUT[] arr = new INPUT[1];
        arr[0].type = INPUT_MOUSE;
        arr[0].u.mi.dwFlags = flag;
        SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void MouseUp(uint flag) { MouseDown(flag); }

    public static void MouseButton(uint downFlag, uint upFlag)
    {
        MouseDown(downFlag);
        MouseUp(upFlag);
    }

    public static void MouseWheel(int wheelData)
    {
        INPUT[] arr = new INPUT[1];
        arr[0].type = INPUT_MOUSE;
        arr[0].u.mi.dwFlags = MOUSEEVENTF_WHEEL;
        arr[0].u.mi.mouseData = unchecked((uint)wheelData);
        SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void KeyUnicodeChar(char c)
    {
        INPUT[] down = new INPUT[1];
        down[0].type = INPUT_KEYBOARD;
        down[0].u.ki.wScan = c;
        down[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
        SendInput(1, down, Marshal.SizeOf(typeof(INPUT)));

        INPUT[] up = new INPUT[1];
        up[0].type = INPUT_KEYBOARD;
        up[0].u.ki.wScan = c;
        up[0].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        SendInput(1, up, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void KeyVk(ushort vk, bool keyUp)
    {
        INPUT[] arr = new INPUT[1];
        arr[0].type = INPUT_KEYBOARD;
        arr[0].u.ki.wVk = vk;
        arr[0].u.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : 0;
        SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));
    }
}
"@

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

# ref = "<hwnd>|<pid>|<dot-separated ControlView child indices>", e.g. "132456|18280|2.0".
# The embedded pid is what makes a stale ref detectable: HWNDs get reused by
# Windows once a window is destroyed (observed on a live desktop within
# fractions of a second — a stale ref silently resolved to an unrelated
# process, e.g. Firefox, before this check existed). FromHandle succeeding is
# NOT enough evidence the ref still points at the window it was issued for.
function Make-Ref([long]$Hwnd, [int]$OwnerPid, [string]$Path) {
    return "$Hwnd|$OwnerPid|$Path"
}

# Single ref<->element resolver, used by every action. No caching: UIA handles
# can't cross process boundaries, so every call re-walks from FromHandle.
function Resolve-Ref([string]$Ref) {
    if ([string]::IsNullOrEmpty($Ref)) { throw "ref is required" }
    $parts = $Ref.Split('|', 3)
    if ($parts.Count -lt 3) { throw "Invalid ref format (expected 'hwnd|pid|path'): $Ref" }
    $hwndStr = $parts[0]
    $pidStr = $parts[1]
    $path = $parts[2]
    $hwndNum = 0L
    if (-not [int64]::TryParse($hwndStr, [ref]$hwndNum)) { throw "Invalid hwnd in ref: $hwndStr" }
    $expectedPid = 0
    if (-not [int]::TryParse($pidStr, [ref]$expectedPid)) { throw "Invalid pid in ref: $pidStr" }

    $root = $null
    try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwndNum) } catch { $root = $null }
    if ($null -eq $root) { throw "Window not found for hwnd $hwndStr (it may have closed)" }
    $actualPid = $root.Current.ProcessId
    if ($actualPid -ne $expectedPid) {
        throw "ref is stale: hwnd $hwndStr was reused (issued for pid $expectedPid, now belongs to pid $actualPid). Re-fetch via windows_list/windows_tree."
    }

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
    return @{ Element = $element; Hwnd = $hwndNum; Pid = $expectedPid }
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
        if (($name -and $name -match '(?i)(password|passwd|secret|token|csrf|cvv|api[-_]?key|access[-_]?key|private[-_]?key|\bkey\b|\bauth\b|\bpin\b)') -or
            ($automationId -and $automationId -match '(?i)(password|passwd|secret|token|csrf|cvv|api[-_]?key|access[-_]?key|private[-_]?key|\bkey\b|\bauth\b|\bpin\b)')) {
            $isPassword = $true
        }
    }

    $valueLength = 0
    if ($null -ne $rawValue) { $valueLength = $rawValue.Length }
    $valueOut = $rawValue
    if ($isPassword) { $valueOut = $null }

    # A standard password box's Name is a short label ("Password") and is
    # safe to keep — redacting it would remove useful, harmless UI context.
    # But a non-standard control could put the actual secret INTO its Name;
    # a long name on a password-flagged element is the tell for that, so
    # redact only in that case rather than always destroying the label.
    if ($isPassword -and $name -and $name.Length -gt 40) {
        $name = "<redacted, length=$($name.Length)>"
    }

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
    $basePath = ($Ref.Split('|', 3))[2]
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
            $refStr = Make-Ref -Hwnd $resolved.Hwnd -OwnerPid $resolved.Pid -Path $item.Path
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

# key_press name -> virtual-key code. Covers the common cases named in the
# spec; not exhaustive (add here if a caller needs a key that's missing).
$script:VkMap = @{
    'ENTER' = 0x0D; 'RETURN' = 0x0D; 'ESCAPE' = 0x1B; 'ESC' = 0x1B; 'TAB' = 0x09
    'BACKSPACE' = 0x08; 'DELETE' = 0x2E; 'DEL' = 0x2E; 'SPACE' = 0x20
    'HOME' = 0x24; 'END' = 0x23; 'PAGEUP' = 0x21; 'PAGEDOWN' = 0x22
    'UP' = 0x26; 'DOWN' = 0x28; 'LEFT' = 0x25; 'RIGHT' = 0x27
    'CTRL' = 0x11; 'CONTROL' = 0x11; 'ALT' = 0x12; 'SHIFT' = 0x10; 'WIN' = 0x5B; 'WINDOWS' = 0x5B
    'F1' = 0x70; 'F2' = 0x71; 'F3' = 0x72; 'F4' = 0x73; 'F5' = 0x74; 'F6' = 0x75
    'F7' = 0x76; 'F8' = 0x77; 'F9' = 0x78; 'F10' = 0x79; 'F11' = 0x7A; 'F12' = 0x7B
}
function Get-VkCode([string]$Name) {
    $u = $Name.Trim().ToUpperInvariant()
    if ($script:VkMap.ContainsKey($u)) { return $script:VkMap[$u] }
    if ($u.Length -eq 1) {
        $c = $u[0]
        if (($c -ge '0' -and $c -le '9') -or ($c -ge 'A' -and $c -le 'Z')) { return [byte][char]$c }
    }
    throw "Unknown key: $Name"
}

# Shared by screenshot_window/screenshot_region/app_context.
function Save-ScreenRegion([int]$X, [int]$Y, [int]$W, [int]$H, [string]$SavePath) {
    $bmp = New-Object System.Drawing.Bitmap($W, $H)
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try { $g.CopyFromScreen($X, $Y, 0, 0, $bmp.Size) } finally { $g.Dispose() }
        $bmp.Save($SavePath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bmp.Dispose() }
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
                $list += (ConvertTo-ElementJson -Element $w -Ref (Make-Ref -Hwnd $hwnd -OwnerPid $cur.ProcessId -Path ''))
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
                    $data = ConvertTo-ElementJson -Element $current -Ref (Make-Ref -Hwnd $hwnd -OwnerPid $current.Current.ProcessId -Path '')
                }
            }
        }

        'tree' {
            $resolved = Resolve-Ref $req.ref
            $maxDepth = if ($null -ne $req.maxDepth) { [int]$req.maxDepth } else { 4 }
            $maxNodes = if ($null -ne $req.maxNodes) { [int]$req.maxNodes } else { 200 }
            # Hard ceilings regardless of what the caller asks for — an LLM
            # passing maxNodes/maxDepth far larger than intended must not be
            # able to force an unbounded walk of the desktop's UI tree.
            if ($maxDepth -gt 20) { $maxDepth = 20 }
            if ($maxNodes -gt 2000) { $maxNodes = 2000 }
            $basePath = ($req.ref.Split('|', 3))[2]

            $elements = @()
            $queue = New-Object System.Collections.Generic.Queue[object]
            $queue.Enqueue(@{ Element = $resolved.Element; Path = $basePath; Depth = 0 })
            $visited = 0
            $safetyCap = 20000 # ponytail: same hard cap as Find-Elements, in case a real subtree is huge before maxNodes/maxDepth trims it
            while ($queue.Count -gt 0 -and $elements.Count -lt $maxNodes -and $visited -lt $safetyCap) {
                $item = $queue.Dequeue()
                $visited++
                $refStr = Make-Ref -Hwnd $resolved.Hwnd -OwnerPid $resolved.Pid -Path $item.Path
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
            # SetFocus() returns before the OS has actually committed the
            # focus change — sending raw input (desktop_type_text/key) right
            # after this returns can land on the PREVIOUS focus target and
            # silently lose most of the input. Observed in practice: only
            # the first 2-3 characters of a typed string landed without this.
            Start-Sleep -Milliseconds 200
            $resolved2 = Resolve-Ref $req.ref
            $data = ConvertTo-ElementJson -Element $resolved2.Element -Ref $req.ref
        }

        # ---- Desktop Computer Use (Phase 4) coordinate-based fallback actions ----

        'window_at_point' {
            $data = $null
            $pt = New-Object System.Windows.Point([double]$req.x, [double]$req.y)
            $el = $null
            try { $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt) } catch { $el = $null }
            if ($null -ne $el) {
                $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
                $rootEl = [System.Windows.Automation.AutomationElement]::RootElement
                $current = $el
                while ($true) {
                    $parent = $null
                    try { $parent = $walker.GetParent($current) } catch { $parent = $null }
                    if ($null -eq $parent -or $parent.Equals($rootEl)) { break }
                    $current = $parent
                }
                $hwnd = $current.Current.NativeWindowHandle
                if ($hwnd -ne 0) { $data = ConvertTo-ElementJson -Element $current -Ref (Make-Ref -Hwnd $hwnd -OwnerPid $current.Current.ProcessId -Path '') }
            }
        }

        'screenshot_fullscreen' {
            $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
            Save-ScreenRegion -X $vs.X -Y $vs.Y -W $vs.Width -H $vs.Height -SavePath $req.savePath
            $data = @{ path = $req.savePath; width = $vs.Width; height = $vs.Height }
        }

        'screenshot_window' {
            $resolved = Resolve-Ref $req.ref
            $rect = $resolved.Element.Current.BoundingRectangle
            if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { throw "Element has no visible bounds to capture: $($req.ref)" }
            $w = [int][math]::Round($rect.Width); $h = [int][math]::Round($rect.Height)
            Save-ScreenRegion -X ([int][math]::Round($rect.X)) -Y ([int][math]::Round($rect.Y)) -W $w -H $h -SavePath $req.savePath
            $data = @{ path = $req.savePath; width = $w; height = $h }
        }

        'screenshot_region' {
            $w = [int]$req.width; $h = [int]$req.height
            Save-ScreenRegion -X ([int]$req.x) -Y ([int]$req.y) -W $w -H $h -SavePath $req.savePath
            $data = @{ path = $req.savePath; width = $w; height = $h }
        }

        'app_context' {
            $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
            if ($null -eq $focused) { throw "No active window" }
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
            if ($hwnd -eq 0) { throw "No active window" }
            $winData = ConvertTo-ElementJson -Element $current -Ref (Make-Ref -Hwnd $hwnd -OwnerPid $current.Current.ProcessId -Path '')
            $rect = $current.Current.BoundingRectangle
            if (-not $rect.IsEmpty -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
                Save-ScreenRegion -X ([int][math]::Round($rect.X)) -Y ([int][math]::Round($rect.Y)) -W ([int][math]::Round($rect.Width)) -H ([int][math]::Round($rect.Height)) -SavePath $req.savePath
            }
            $winData['screenshotPath'] = $req.savePath
            $data = $winData
        }

        'launch_app' {
            $startParams = @{ FilePath = $req.path; PassThru = $true }
            if ($req.args) { $startParams['ArgumentList'] = @($req.args) }
            $proc = Start-Process @startParams
            $data = @{ pid = $proc.Id }
        }

        'close_window' {
            $resolved = Resolve-Ref $req.ref
            $wp = $null
            if ($resolved.Element.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) {
                $wp.Close()
            } else {
                try {
                    $proc = [System.Diagnostics.Process]::GetProcessById($resolved.Element.Current.ProcessId)
                    [void]$proc.CloseMainWindow()
                } catch { throw "Element does not support WindowPattern and process fallback failed: $($req.ref)" }
            }
            $data = @{ closed = $true }
        }

        'kill_process' {
            Stop-Process -Id ([int]$req.pid) -Force
            $data = @{ killed = $true; pid = [int]$req.pid }
        }

        'click' {
            $x = [int]$req.x; $y = [int]$req.y
            $button = if ($req.button) { [string]$req.button } else { 'left' }
            [NativeInput]::MoveTo($x, $y)
            switch ($button) {
                'left' { [NativeInput]::MouseButton([NativeInput]::MOUSEEVENTF_LEFTDOWN, [NativeInput]::MOUSEEVENTF_LEFTUP) }
                'right' { [NativeInput]::MouseButton([NativeInput]::MOUSEEVENTF_RIGHTDOWN, [NativeInput]::MOUSEEVENTF_RIGHTUP) }
                'double' {
                    [NativeInput]::MouseButton([NativeInput]::MOUSEEVENTF_LEFTDOWN, [NativeInput]::MOUSEEVENTF_LEFTUP)
                    Start-Sleep -Milliseconds 50
                    [NativeInput]::MouseButton([NativeInput]::MOUSEEVENTF_LEFTDOWN, [NativeInput]::MOUSEEVENTF_LEFTUP)
                }
                default { throw "Unknown button: $button" }
            }
            # A real click is the reliable way to move OS-level foreground
            # focus (unlike UIA SetFocus, which Windows' foreground-lock can
            # silently ignore for a background caller) — but the OS still
            # needs a moment to commit that focus change before raw
            # keyboard input sent right after this returns will land here.
            Start-Sleep -Milliseconds 150
            $data = @{ clicked = $true; x = $x; y = $y; button = $button }
        }

        'move' {
            $x = [int]$req.x; $y = [int]$req.y
            [NativeInput]::MoveTo($x, $y)
            $data = @{ moved = $true; x = $x; y = $y }
        }

        'drag' {
            $fx = [int]$req.fromX; $fy = [int]$req.fromY; $tx = [int]$req.toX; $ty = [int]$req.toY
            [NativeInput]::MoveTo($fx, $fy)
            [NativeInput]::MouseDown([NativeInput]::MOUSEEVENTF_LEFTDOWN)
            $steps = 10
            for ($i = 1; $i -le $steps; $i++) {
                $sx = $fx + [int](($tx - $fx) * $i / $steps)
                $sy = $fy + [int](($ty - $fy) * $i / $steps)
                [NativeInput]::MoveTo($sx, $sy)
                Start-Sleep -Milliseconds 15
            }
            [NativeInput]::MouseUp([NativeInput]::MOUSEEVENTF_LEFTUP)
            $data = @{ dragged = $true; fromX = $fx; fromY = $fy; toX = $tx; toY = $ty }
        }

        'scroll' {
            $x = [int]$req.x; $y = [int]$req.y; $deltaY = [int]$req.deltaY
            [NativeInput]::MoveTo($x, $y)
            [NativeInput]::MouseWheel($deltaY * 120)
            $data = @{ scrolled = $true }
        }

        'type_text' {
            $t = [string]$req.text
            foreach ($ch in $t.ToCharArray()) {
                [NativeInput]::KeyUnicodeChar($ch)
                Start-Sleep -Milliseconds 5
            }
            $data = @{ typed = $true; length = $t.Length }
        }

        'key_press' {
            $keyStr = [string]$req.key
            $parts = $keyStr.Split('+')
            $mainKey = $parts[$parts.Count - 1]
            $modNames = @()
            if ($parts.Count -gt 1) { $modNames = $parts[0..($parts.Count - 2)] }
            $modVks = @($modNames | ForEach-Object { Get-VkCode $_ })
            $mainVk = Get-VkCode $mainKey
            foreach ($mv in $modVks) { [NativeInput]::KeyVk([UInt16]$mv, $false) }
            [NativeInput]::KeyVk([UInt16]$mainVk, $false)
            [NativeInput]::KeyVk([UInt16]$mainVk, $true)
            for ($i = $modVks.Count - 1; $i -ge 0; $i--) { [NativeInput]::KeyVk([UInt16]$modVks[$i], $true) }
            $data = @{ pressed = $true; key = $keyStr }
        }

        'wait' {
            $ms = [int]$req.ms
            Start-Sleep -Milliseconds $ms
            $data = @{ waited = $ms }
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
