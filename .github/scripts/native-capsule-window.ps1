param(
    [string]$Action = "",
    [int]$ProcessId = 0,
    [string]$ExecutablePath = "",
    [string]$Role = "capsule",
    [int]$Port = 0
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Stop-CapsuleHelper([string]$Code) {
    [Console]::Error.WriteLine((@{ error = $Code } | ConvertTo-Json -Compress))
    exit 1
}

# This gate must precede parameter validation, filesystem access, process
# inspection, Add-Type, and every native operation, including Paths.
if (
    -not [string]::Equals($env:GITHUB_ACTIONS, "true", [StringComparison]::Ordinal) -or
    -not [string]::Equals($env:RUNNER_ENVIRONMENT, "github-hosted", [StringComparison]::Ordinal) -or
    -not [string]::Equals($env:RUNNER_OS, "Windows", [StringComparison]::Ordinal)
) {
    Stop-CapsuleHelper "native_capsule_ci_required"
}

function Assert-CapsuleProcess($TargetProcess, [string]$ExpectedPath) {
    try {
        $TargetProcess.Refresh()
        if ($TargetProcess.HasExited) {
            throw "native_capsule_process_unavailable"
        }
        $actualPath = [IO.Path]::GetFullPath($TargetProcess.MainModule.FileName)
        if (-not [string]::Equals($actualPath, $ExpectedPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw "native_capsule_process_path_mismatch"
        }
    } catch {
        if ($_.Exception.Message -eq "native_capsule_process_path_mismatch") {
            throw "native_capsule_process_path_mismatch"
        }
        throw "native_capsule_process_unavailable"
    }
}

function Test-CapsuleCdpProcess([uint32]$ListenerProcessId, $TargetProcess, [string]$ExpectedPath) {
    $candidateId = $ListenerProcessId
    $visited = [Collections.Generic.HashSet[uint32]]::new()
    $rootStarted = $TargetProcess.StartTime.ToUniversalTime()
    $descendantStarted = $null
    for ($depth = 0; $depth -lt 64; $depth += 1) {
        if ($candidateId -eq [uint32]$TargetProcess.Id) {
            Assert-CapsuleProcess $TargetProcess $ExpectedPath
            return $true
        }
        if ($candidateId -eq 0 -or -not $visited.Add($candidateId)) {
            return $false
        }
        # Query only the next PID in this listener's parent chain. Do not read
        # command lines, enumerate all processes, or return process metadata.
        $rows = @(Get-CimInstance -ClassName Win32_Process `
            -Filter "ProcessId = $candidateId" `
            -Property ProcessId, ParentProcessId, Name, CreationDate `
            -ErrorAction Stop)
        if ($rows.Count -ne 1 -or -not [string]::Equals($rows[0].Name, "msedgewebview2.exe", [StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }
        $candidateStarted = $rows[0].CreationDate.ToUniversalTime()
        if ($candidateStarted -lt $rootStarted -or ($null -ne $descendantStarted -and $candidateStarted -gt $descendantStarted)) {
            return $false
        }
        $descendantStarted = $candidateStarted
        $candidateId = [uint32]$rows[0].ParentProcessId
    }
    return $false
}

$verifiedProcess = $null
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw "native_capsule_ci_required"
    }
    if ($Action -cnotin @("Paths", "Inspect", "Focus", "Drag", "SessionLock", "Suspend", "Close", "CdpOwner")) {
        throw "native_capsule_action_invalid"
    }
    if ($Action -ceq "Paths") {
        $appDataRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
        $localDataRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
        if ([string]::IsNullOrWhiteSpace($appDataRoot) -or [string]::IsNullOrWhiteSpace($localDataRoot)) {
            throw "native_capsule_known_folder_unavailable"
        }
        @{
            appDataDirectory = [IO.Path]::Combine($appDataRoot, "com.linkedinfo.desktop")
            localDataDirectory = [IO.Path]::Combine($localDataRoot, "com.linkedinfo.desktop")
        } | ConvertTo-Json -Compress
        exit 0
    }
    if ($ProcessId -le 0 -or [string]::IsNullOrWhiteSpace($ExecutablePath)) {
        throw "native_capsule_target_required"
    }
    if ($Role -cnotin @("main", "capsule") -or ($Action -ceq "Drag" -and $Role -cne "capsule")) {
        throw "native_capsule_role_invalid"
    }
    if ($Action -ceq "CdpOwner" -and ($Port -lt 1 -or $Port -gt 65535)) {
        throw "native_capsule_port_invalid"
    }
    if (-not [IO.Path]::IsPathFullyQualified($ExecutablePath)) {
        throw "native_capsule_executable_invalid"
    }
    $repositoryRoot = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, "..", ".."))
    $releaseRoot = [IO.Path]::GetFullPath([IO.Path]::Combine($repositoryRoot, "target", "release"))
    $expectedExecutable = [IO.Path]::GetFullPath($ExecutablePath)
    $releasePrefix = $releaseRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (
        -not $expectedExecutable.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([IO.Path]::GetExtension($expectedExecutable), ".exe", [StringComparison]::OrdinalIgnoreCase)
    ) {
        throw "native_capsule_executable_outside_release"
    }
    $executableItem = Get-Item -LiteralPath $expectedExecutable -Force -ErrorAction Stop
    if ($executableItem.PSIsContainer) {
        throw "native_capsule_executable_invalid"
    }
    # A lexical prefix must not authorize a junction/symlink outside target.
    $checkedItem = $executableItem
    while (-not [string]::Equals($checkedItem.FullName, $repositoryRoot, [StringComparison]::OrdinalIgnoreCase)) {
        if (($checkedItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "native_capsule_executable_reparse_point"
        }
        $parentPath = [IO.Path]::GetDirectoryName($checkedItem.FullName)
        if ([string]::IsNullOrEmpty($parentPath)) {
            throw "native_capsule_executable_outside_release"
        }
        $checkedItem = Get-Item -LiteralPath $parentPath -Force -ErrorAction Stop
    }
    $verifiedProcess = [Diagnostics.Process]::GetProcessById($ProcessId)
    # Keep the process handle alive throughout the command to pin its identity.
    $null = $verifiedProcess.SafeHandle
    Assert-CapsuleProcess $verifiedProcess $expectedExecutable

    if ($Action -ceq "CdpOwner") {
        # Return false unless every listener at this port belongs to the exact
        # launched process or its WebView2 descendants, on either IP family.
        $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
            Where-Object { $_.LocalPort -eq $Port })
        $owned = $listeners.Count -gt 0
        foreach ($connection in $listeners) {
            if (
                $connection.LocalAddress -cnotin @("127.0.0.1", "::1") -or
                -not (Test-CapsuleCdpProcess ([uint32]$connection.OwningProcess) $verifiedProcess $expectedExecutable)
            ) {
                $owned = $false
                break
            }
        }
        Assert-CapsuleProcess $verifiedProcess $expectedExecutable
        @{ owned = $owned } | ConvertTo-Json -Compress
        exit 0
    }

    $nativeSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace LinkedInfo.CiCapsule {
    public sealed class WindowSnapshot {
        public string role { get; set; }
        public long handle { get; set; }
        public int x { get; set; }
        public int y { get; set; }
        public int width { get; set; }
        public int height { get; set; }
        public int clientWidth { get; set; }
        public int clientHeight { get; set; }
        public int clientTopInset { get; set; }
        public bool visible { get; set; }
        public bool topmost { get; set; }
        public bool captionStyle { get; set; }
        public long styleBits { get; set; }
        public long extendedStyleBits { get; set; }
        public uint dpi { get; set; }
    }

    public static class Native {
        [StructLayout(LayoutKind.Sequential)] private struct Rect {
            public int Left, Top, Right, Bottom;
        }
        [StructLayout(LayoutKind.Sequential)] private struct Point {
            public int X, Y;
        }
        [StructLayout(LayoutKind.Sequential)] private struct MouseInput {
            public int X, Y;
            public uint MouseData, Flags, Time;
            public UIntPtr ExtraInfo;
        }
        [StructLayout(LayoutKind.Explicit)] private struct InputUnion {
            [FieldOffset(0)] public MouseInput Mouse;
        }
        [StructLayout(LayoutKind.Sequential)] private struct Input {
            public uint Type;
            public InputUnion Data;
        }
        private delegate bool EnumerateWindow(IntPtr window, IntPtr parameter);
        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EnumThreadWindows(uint thread, EnumerateWindow callback, IntPtr parameter);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int GetWindowText(IntPtr window, StringBuilder title, int capacity);
        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetClientRect(IntPtr window, out Rect rectangle);
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
        private static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
        private static extern int GetWindowLong32(IntPtr window, int index);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool BringWindowToTop(IntPtr window);
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ShowWindowAsync(IntPtr window, int command);
        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AttachThreadInput(uint first, uint second, bool attach);
        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ClientToScreen(IntPtr window, ref Point point);
        [DllImport("user32.dll")]
        private static extern IntPtr WindowFromPoint(Point point);
        [DllImport("user32.dll")]
        private static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint count, Input[] inputs, int size);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SendMessageTimeout(IntPtr window, uint message,
            UIntPtr word, IntPtr parameter, uint flags, uint timeout, out UIntPtr result);
        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PostMessage(IntPtr window, uint message, UIntPtr word, IntPtr parameter);

        public static void UsePhysicalCoordinates() {
            if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero)
                throw new InvalidOperationException("native_capsule_dpi_unavailable");
        }

        private static void AssertWindow(IntPtr window, int process) {
            uint actual;
            GetWindowThreadProcessId(window, out actual);
            if (!IsWindow(window) || actual != (uint)process)
                throw new InvalidOperationException("native_capsule_window_unavailable");
        }

        private static long Style(IntPtr window, int index) {
            return IntPtr.Size == 8 ? GetWindowLongPtr64(window, index).ToInt64()
                : GetWindowLong32(window, index);
        }

        private static WindowSnapshot Snapshot(IntPtr window, int process, string role) {
            AssertWindow(window, process);
            Rect bounds, client;
            if (!GetWindowRect(window, out bounds) || !GetClientRect(window, out client))
                throw new InvalidOperationException("native_capsule_geometry_unavailable");
            var clientOrigin = new Point();
            if (!ClientToScreen(window, ref clientOrigin))
                throw new InvalidOperationException("native_capsule_geometry_unavailable");
            uint dpi = GetDpiForWindow(window);
            if (dpi == 0)
                throw new InvalidOperationException("native_capsule_dpi_unavailable");
            return new WindowSnapshot {
                role = role, handle = window.ToInt64(), x = bounds.Left, y = bounds.Top,
                width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top,
                clientWidth = client.Right - client.Left, clientHeight = client.Bottom - client.Top,
                clientTopInset = clientOrigin.Y - bounds.Top,
                visible = IsWindowVisible(window), topmost = (Style(window, -20) & 0x8) != 0,
                captionStyle = (Style(window, -16) & 0x00c00000) != 0, dpi = dpi,
                styleBits = Style(window, -16) & 0xffffffffL,
                extendedStyleBits = Style(window, -20) & 0xffffffffL
            };
        }

        public static WindowSnapshot[] Inspect(int process, bool allowExited) {
            var windows = new List<WindowSnapshot>();
            var handles = new HashSet<long>();
            Exception failed = null;
            EnumerateWindow callback = delegate(IntPtr window, IntPtr parameter) {
                try {
                    uint actual;
                    GetWindowThreadProcessId(window, out actual);
                    if (actual != (uint)process || !handles.Add(window.ToInt64())) return true;
                    var title = new StringBuilder(128);
                    GetWindowText(window, title, title.Capacity);
                    string role = title.ToString() == "\u5173\u8054\u4fe1\u606f" ? "main"
                        : title.ToString() == "Linked Info" ? "capsule" : null;
                    if (role != null) windows.Add(Snapshot(window, process, role));
                    return true;
                } catch (Exception error) {
                    failed = error;
                    return false;
                }
            };
            Process target = null;
            try {
                target = Process.GetProcessById(process);
                if (!target.HasExited) {
                    // Enumerate only the target's threads, not all desktop windows.
                    foreach (ProcessThread thread in target.Threads) {
                        EnumThreadWindows((uint)thread.Id, callback, IntPtr.Zero);
                        if (failed != null) throw failed;
                    }
                }
            } catch (ArgumentException) {
                if (!allowExited) throw new InvalidOperationException("native_capsule_process_unavailable");
            } catch (InvalidOperationException) {
                if (!allowExited || target == null || !target.HasExited) throw;
                windows.Clear();
            } finally {
                if (target != null) target.Dispose();
            }
            windows.Sort((left, right) => StringComparer.Ordinal.Compare(left.role, right.role));
            return windows.ToArray();
        }

        public static IntPtr Select(WindowSnapshot[] windows, string role) {
            IntPtr selected = IntPtr.Zero;
            foreach (WindowSnapshot window in windows) {
                if (window.role != role) continue;
                if (selected != IntPtr.Zero)
                    throw new InvalidOperationException("native_capsule_window_ambiguous");
                selected = new IntPtr(window.handle);
            }
            if (selected == IntPtr.Zero)
                throw new InvalidOperationException("native_capsule_window_unavailable");
            return selected;
        }

        public static void Focus(IntPtr window, int process) {
            AssertWindow(window, process);
            if (IsIconic(window)) ShowWindowAsync(window, 9);
            else if (!IsWindowVisible(window)) ShowWindowAsync(window, 5);
            uint ignored;
            uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
            uint callerThread = GetCurrentThreadId();
            bool attached = foregroundThread != 0 && foregroundThread != callerThread
                && AttachThreadInput(callerThread, foregroundThread, true);
            try {
                BringWindowToTop(window);
                SetForegroundWindow(window);
            } finally {
                if (attached) AttachThreadInput(callerThread, foregroundThread, false);
            }
            for (int attempt = 0; attempt < 60; attempt++) {
                AssertWindow(window, process);
                if (GetForegroundWindow() == window && IsWindowVisible(window)) return;
                if (attempt % 4 == 0 && IsWindowVisible(window)) {
                    BringWindowToTop(window);
                    SetForegroundWindow(window);
                }
                Thread.Sleep(25);
            }
            throw new InvalidOperationException("native_capsule_focus_failed");
        }

        private static void Mouse(uint flags, int x, int y) {
            var input = new Input {
                Type = 0,
                Data = new InputUnion { Mouse = new MouseInput { X = x, Y = y, Flags = flags } }
            };
            if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input))) != 1)
                throw new InvalidOperationException("native_capsule_input_failed");
        }

        private static void MoveMouse(int x, int y) {
            int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
            int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
            if (width < 2 || height < 2 || x < left || y < top || x >= left + width || y >= top + height)
                throw new InvalidOperationException("native_capsule_pointer_outside_desktop");
            int absoluteX = (int)Math.Round((x - left) * 65535.0 / (width - 1));
            int absoluteY = (int)Math.Round((y - top) * 65535.0 / (height - 1));
            Mouse(0x0001 | 0x4000 | 0x8000, absoluteX, absoluteY);
        }

        public static void Drag(IntPtr window, int process) {
            Focus(window, process);
            WindowSnapshot before = Snapshot(window, process, "capsule");
            double scale = before.dpi / 96.0;
            var start = new Point { X = (int)Math.Round(18 * scale), Y = (int)Math.Round(28 * scale) };
            if (!ClientToScreen(window, ref start))
                throw new InvalidOperationException("native_capsule_geometry_unavailable");
            if (GetAncestor(WindowFromPoint(start), 2) != window)
                throw new InvalidOperationException("native_capsule_grip_obscured");
            int deltaX = (int)Math.Round(80 * scale), deltaY = (int)Math.Round(40 * scale);
            MoveMouse(start.X, start.Y);
            Thread.Sleep(50);
            AssertWindow(window, process);
            if (GetForegroundWindow() != window || GetAncestor(WindowFromPoint(start), 2) != window)
                throw new InvalidOperationException("native_capsule_grip_obscured");
            bool pressed = false;
            try {
                Mouse(0x0002, 0, 0);
                pressed = true;
                // Leave the real pointer-down time to reach WebView2 and the
                // capsule's start_dragging command before moving the mouse.
                Thread.Sleep(120);
                for (int step = 1; step <= 8; step++) {
                    AssertWindow(window, process);
                    if (GetForegroundWindow() != window)
                        throw new InvalidOperationException("native_capsule_focus_failed");
                    MoveMouse(start.X + deltaX * step / 8, start.Y + deltaY * step / 8);
                    Thread.Sleep(40);
                }
            } finally {
                if (pressed) Mouse(0x0004, 0, 0);
            }
            Thread.Sleep(120);
            WindowSnapshot after = Snapshot(window, process, "capsule");
            int tolerance = Math.Max(3, (int)Math.Ceiling(scale * 2));
            if (Math.Abs(after.x - before.x - deltaX) > tolerance || Math.Abs(after.y - before.y - deltaY) > tolerance)
                throw new InvalidOperationException("native_capsule_drag_not_observed");
        }

        public static void Notify(IntPtr window, int process, bool suspend, int session) {
            AssertWindow(window, process);
            UIntPtr result;
            uint message = suspend ? 0x0218u : 0x02b1u;
            UIntPtr word = new UIntPtr(suspend ? 0x0004u : 0x0007u);
            IntPtr parameter = suspend ? IntPtr.Zero : new IntPtr(session);
            // Simulate only this application's notification. Never lock the
            // runner session, suspend Windows, or broadcast to other windows.
            if (SendMessageTimeout(window, message, word, parameter, 0x23, 3000, out result) == IntPtr.Zero)
                throw new InvalidOperationException("native_capsule_notification_failed");
        }

        public static void Close(IntPtr window, int process) {
            AssertWindow(window, process);
            if (!PostMessage(window, 0x0010, UIntPtr.Zero, IntPtr.Zero))
                throw new InvalidOperationException("native_capsule_close_failed");
            Thread.Sleep(50);
        }
    }
}
'@
    Add-Type -TypeDefinition $nativeSource -ErrorAction Stop | Out-Null
    [LinkedInfo.CiCapsule.Native]::UsePhysicalCoordinates()
    Assert-CapsuleProcess $verifiedProcess $expectedExecutable
    $windows = @([LinkedInfo.CiCapsule.Native]::Inspect($ProcessId, $false))
    if ($Action -cne "Inspect") {
        $selectedRole = if ($Action -cin @("SessionLock", "Suspend")) { "main" } else { $Role }
        $selectedWindow = [LinkedInfo.CiCapsule.Native]::Select($windows, $selectedRole)
        Assert-CapsuleProcess $verifiedProcess $expectedExecutable
        switch -CaseSensitive ($Action) {
            "Focus" { [LinkedInfo.CiCapsule.Native]::Focus($selectedWindow, $ProcessId) }
            "Drag" { [LinkedInfo.CiCapsule.Native]::Drag($selectedWindow, $ProcessId) }
            "SessionLock" { [LinkedInfo.CiCapsule.Native]::Notify($selectedWindow, $ProcessId, $false, $verifiedProcess.SessionId) }
            "Suspend" { [LinkedInfo.CiCapsule.Native]::Notify($selectedWindow, $ProcessId, $true, $verifiedProcess.SessionId) }
            "Close" { [LinkedInfo.CiCapsule.Native]::Close($selectedWindow, $ProcessId) }
        }
        $windows = @([LinkedInfo.CiCapsule.Native]::Inspect($ProcessId, $Action -ceq "Close"))
    }
    @{ windows = @($windows) } | ConvertTo-Json -Depth 4 -Compress
} catch {
    $failureCode = "native_capsule_action_failed"
    $exception = $_.Exception
    while ($null -ne $exception) {
        if ($exception.Message -cmatch '^native_capsule_[a-z_]+$') {
            $failureCode = $exception.Message
        }
        $exception = $exception.InnerException
    }
    Stop-CapsuleHelper $failureCode
} finally {
    if ($null -ne $verifiedProcess) {
        $verifiedProcess.Dispose()
    }
}
