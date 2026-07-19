// VoiceLatch injector — native text injection helper.
// Compiled with the C# 5 compiler that ships in Windows (.NET Framework 4.x):
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
//     /nologo /optimize /target:exe /out:injector.exe
//     /r:System.Windows.Forms.dll /r:System.Drawing.dll injector.cs
//
// Commands:
//   injector paste            synthesize Ctrl+V (caller has set the clipboard)
//   injector type             read UTF-8 text from stdin, inject as Unicode keystrokes
//   injector fginfo           print "title|processName" of the foreground window
//   injector typetest  <t|->  round-trip test: own textbox window, type-inject, verify
//   injector pastetest <t|->  round-trip test: own textbox window, clipboard+Ctrl+V, verify
//   ("-" reads the test text from stdin as UTF-8)
//
// Exit codes: 0 ok | 1 usage | 2 test mismatch | 3 SendInput failure

using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Injector
{
    // ---------- Win32 ----------
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT
    {
        public uint type;      // 1 = INPUT_KEYBOARD
        public InputUnion U;
    }

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const ushort VK_RETURN = 0x0D;
    const ushort VK_TAB = 0x09;
    const ushort VK_CONTROL = 0x11;
    const ushort VK_MENU = 0x12;      // Alt
    const ushort VK_SHIFT = 0x10;
    const ushort VK_LWIN = 0x5B;
    const ushort VK_RWIN = 0x5C;
    const ushort VK_LCONTROL = 0xA2;
    const ushort VK_RCONTROL = 0xA3;
    const ushort VK_LSHIFT = 0xA0;
    const ushort VK_RSHIFT = 0xA1;
    const ushort VK_LMENU = 0xA4;
    const ushort VK_RMENU = 0xA5;
    const ushort VK_V = 0x56;

    // Marker so our own synthetic events are distinguishable (defensive; also
    // useful in debugging with input monitors).
    static readonly IntPtr MAGIC = new IntPtr(0x564C4657); // "VFLW"

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vKey);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr tok);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr tok, int cls, out uint info, uint len, out uint retLen);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);

    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint TOKEN_QUERY = 0x0008;
    const int TokenElevation = 20;

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [DllImport("user32.dll")]
    static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    // ---------- input building ----------
    static INPUT KeyEvent(ushort vk, bool up)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.U.ki.wVk = vk;
        i.U.ki.wScan = 0;
        i.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0u;
        i.U.ki.time = 0;
        i.U.ki.dwExtraInfo = MAGIC;
        return i;
    }

    static INPUT UnicodeEvent(char c, bool up)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.U.ki.wVk = 0;
        i.U.ki.wScan = c;                       // UTF-16 code unit (surrogates ok)
        i.U.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0u);
        i.U.ki.time = 0;
        i.U.ki.dwExtraInfo = MAGIC;
        return i;
    }

    static bool Send(List<INPUT> events)
    {
        if (events.Count == 0) return true;
        INPUT[] arr = events.ToArray();
        uint sent = SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
        return sent == arr.Length;
    }

    // If the user is still physically holding a modifier (e.g. the push-to-talk
    // key, or Ctrl from a shortcut), a synthesized keystroke would combine with
    // it (Ctrl + our 'v' text = shortcut soup). Release any modifier the OS
    // currently considers down before injecting. The user's eventual physical
    // release then arrives as a harmless duplicate key-up.
    static void ReleaseStuckModifiers()
    {
        ushort[] mods = new ushort[] {
            VK_LCONTROL, VK_RCONTROL, VK_LSHIFT, VK_RSHIFT,
            VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN
        };
        List<INPUT> ups = new List<INPUT>();
        foreach (ushort vk in mods)
        {
            if ((GetAsyncKeyState(vk) & 0x8000) != 0) ups.Add(KeyEvent(vk, true));
        }
        if (ups.Count > 0)
        {
            Send(ups);
            Thread.Sleep(15);
        }
    }

    // ---------- commands ----------
    // One chord implementation for every Ctrl+<key> the helper synthesizes —
    // paste and the E2E readback must never diverge in keystroke behavior.
    static bool SendCtrlChord(ushort vk)
    {
        List<INPUT> seq = new List<INPUT>();
        seq.Add(KeyEvent(VK_LCONTROL, false));
        seq.Add(KeyEvent(vk, false));
        seq.Add(KeyEvent(vk, true));
        seq.Add(KeyEvent(VK_LCONTROL, true));
        return Send(seq);
    }

    static int DoPaste()
    {
        ReleaseStuckModifiers();
        return SendCtrlChord(VK_V) ? 0 : 3;
    }

    static int DoType(string text)
    {
        ReleaseStuckModifiers();
        // Normalize newlines, then send in batches. \n and \t become real key
        // presses (many apps ignore the unicode control chars).
        text = text.Replace("\r\n", "\n").Replace("\r", "\n");
        List<INPUT> batch = new List<INPUT>();
        foreach (char c in text)
        {
            if (c == '\n')
            {
                batch.Add(KeyEvent(VK_RETURN, false));
                batch.Add(KeyEvent(VK_RETURN, true));
            }
            else if (c == '\t')
            {
                batch.Add(KeyEvent(VK_TAB, false));
                batch.Add(KeyEvent(VK_TAB, true));
            }
            else
            {
                batch.Add(UnicodeEvent(c, false));
                batch.Add(UnicodeEvent(c, true));
            }
            if (batch.Count >= 128)
            {
                if (!Send(batch)) return 3;
                batch.Clear();
                Thread.Sleep(8); // let slow apps drain their queue
            }
        }
        if (!Send(batch)) return 3;
        return 0;
    }

    // Prints "hwnd|elevated|process|title" for the foreground window.
    // elevated=1 when the target runs above us (UIPI silently discards our
    // SendInput there — the app must fall back to clipboard-only).
    // Failure to open the process for query is itself treated as elevated.
    static int DoFgInfo()
    {
        IntPtr h = GetForegroundWindow();
        string title = "";
        string proc = "";
        int elevated = 0;
        if (h != IntPtr.Zero)
        {
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(h, sb, sb.Capacity);
            title = sb.ToString();
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            try { proc = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
            catch (Exception) { proc = ""; }
            elevated = IsProcessElevated(pid);
        }
        Console.Out.Write(
            h.ToInt64().ToString() + "|" + elevated + "|" +
            proc.Replace("|", "/") + "|" + title.Replace("|", "/"));
        return 0;
    }

    static int IsProcessElevated(uint pid)
    {
        IntPtr hProc = IntPtr.Zero;
        IntPtr hTok = IntPtr.Zero;
        try
        {
            hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (hProc == IntPtr.Zero) return 1; // can't even query → elevated
            if (!OpenProcessToken(hProc, TOKEN_QUERY, out hTok)) return 1;
            uint info; uint retLen;
            if (!GetTokenInformation(hTok, TokenElevation, out info, 4, out retLen)) return 0;
            return info != 0 ? 1 : 0;
        }
        catch (Exception) { return 0; }
        finally
        {
            if (hTok != IntPtr.Zero) CloseHandle(hTok);
            if (hProc != IntPtr.Zero) CloseHandle(hProc);
        }
    }

    // ---------- round-trip test window ----------
    // Opens a real Win32 textbox, focuses it, injects into it, reads it back.
    // Proves the whole synthesis path with zero external dependencies.
    static int DoRoundTrip(string text, bool viaPaste)
    {
        string previousClipboard = null;
        bool hadClipboardText = false;
        if (viaPaste)
        {
            try
            {
                if (Clipboard.ContainsText())
                {
                    previousClipboard = Clipboard.GetText();
                    hadClipboardText = true;
                }
                Clipboard.SetText(text);
            }
            catch (Exception e)
            {
                Console.Error.Write("CLIPBOARD-ERR: " + e.Message);
                return 3;
            }
        }

        Form form = new Form();
        form.Text = "VoiceLatch selftest";
        form.Width = 480;
        form.Height = 160;
        form.StartPosition = FormStartPosition.CenterScreen;
        form.TopMost = true;
        TextBox box = new TextBox();
        box.Multiline = true;
        box.Dock = DockStyle.Fill;
        form.Controls.Add(box);

        string result = null;
        int rc = 3;

        form.Shown += delegate(object s, EventArgs e)
        {
            Thread worker = new Thread(delegate()
            {
                Thread.Sleep(350); // window settle
                SetForegroundWindow(form.Handle);
                Thread.Sleep(150);
                form.Invoke((MethodInvoker)delegate { box.Focus(); });
                Thread.Sleep(100);
                int irc = viaPaste ? DoPaste() : DoType(text);
                // Wait for the message queue to drain into the textbox.
                int waited = 0;
                while (waited < 5000)
                {
                    Thread.Sleep(200);
                    waited += 200;
                    string current = null;
                    form.Invoke((MethodInvoker)delegate { current = box.Text; });
                    if (current != null &&
                        current.Replace("\r\n", "\n") == text.Replace("\r\n", "\n"))
                        break;
                }
                form.Invoke((MethodInvoker)delegate
                {
                    result = box.Text;
                    form.Close();
                });
                rc = irc;
            });
            worker.IsBackground = true;
            worker.Start();
        };

        Application.Run(form);

        if (viaPaste)
        {
            try
            {
                if (hadClipboardText) Clipboard.SetText(previousClipboard);
                else Clipboard.Clear();
            }
            catch (Exception) { }
        }

        string got = (result == null ? "" : result).Replace("\r\n", "\n");
        string want = text.Replace("\r\n", "\n");
        Console.Out.Write("RESULT:" + got);
        if (rc != 0) return rc;
        return got == want ? 0 : 2;
    }

    // ---------- E2E-test support commands ----------
    static int DoFocus(string titlePart)
    {
        IntPtr found = IntPtr.Zero;
        string want = titlePart.ToLowerInvariant();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lp)
        {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(hWnd, sb, sb.Capacity);
            if (sb.Length > 0 && sb.ToString().ToLowerInvariant().Contains(want))
            {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero) { Console.Error.Write("window not found: " + titlePart); return 4; }
        SetForegroundWindow(found);
        Thread.Sleep(200);
        Console.Out.Write(found.ToInt64().ToString());
        return 0;
    }

    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;

    static INPUT KeyEventFull(ushort vk, ushort scan, bool ext, bool up)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.U.ki.wVk = vk;
        i.U.ki.wScan = scan;
        i.U.ki.dwFlags = (ext ? KEYEVENTF_EXTENDEDKEY : 0u) | (up ? KEYEVENTF_KEYUP : 0u);
        i.U.ki.time = 0;
        i.U.ki.dwExtraInfo = MAGIC;
        return i;
    }

    // Press a key, hold it for N ms, release. Used to drive the app's own
    // global hotkey in the chained E2E test. Real scancodes matter: low-level
    // hooks (uiohook) identify keys by scancode, not just the virtual key.
    static int DoHoldKey(string keyName, int ms)
    {
        ushort vk; ushort scan; bool ext;
        switch (keyName.ToLowerInvariant())
        {
            case "rctrl": vk = VK_RCONTROL; scan = 0x1D; ext = true; break;
            case "lctrl": vk = VK_LCONTROL; scan = 0x1D; ext = false; break;
            case "f8": vk = 0x77; scan = 0x42; ext = false; break;
            case "f9": vk = 0x78; scan = 0x43; ext = false; break;
            case "f10": vk = 0x79; scan = 0x44; ext = false; break;
            default:
                if (!ushort.TryParse(keyName, out vk) || vk == 0)
                { Console.Error.Write("unknown key: " + keyName); return 1; }
                scan = 0; ext = false; break;
        }
        INPUT[] down = new INPUT[] { KeyEventFull(vk, scan, ext, false) };
        if (SendInput(1, down, Marshal.SizeOf(typeof(INPUT))) != 1) return 3;
        Thread.Sleep(Math.Max(50, ms));
        INPUT[] up = new INPUT[] { KeyEventFull(vk, scan, ext, true) };
        if (SendInput(1, up, Marshal.SizeOf(typeof(INPUT))) != 1) return 3;
        return 0;
    }

    static int DoCopyAll()
    {
        ReleaseStuckModifiers();
        if (!SendCtrlChord(0x41)) return 3; // Ctrl+A
        Thread.Sleep(150);
        if (!SendCtrlChord(0x43)) return 3; // Ctrl+C
        Thread.Sleep(200);
        return 0;
    }

    // Milliseconds since the user's last keyboard/mouse input. Test suites use
    // this to wait for an idle desktop before focus-sensitive steps (Windows
    // restricts SetForegroundWindow while the user is actively typing).
    static int DoIdleMs()
    {
        LASTINPUTINFO lii = new LASTINPUTINFO();
        lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref lii)) { Console.Error.Write("GetLastInputInfo failed"); return 3; }
        long idle = (long)(unchecked((uint)Environment.TickCount) - lii.dwTime);
        if (idle < 0) idle = 0;
        Console.Out.Write(idle.ToString());
        return 0;
    }

    static int DoGetClip()
    {
        try
        {
            Console.Out.Write(Clipboard.ContainsText() ? Clipboard.GetText() : "");
            return 0;
        }
        catch (Exception e) { Console.Error.Write(e.Message); return 3; }
    }

    static string ReadArgOrStdin(string[] args)
    {
        if (args.Length >= 2 && args[1] == "-")
        {
            using (StreamReader r = new StreamReader(
                Console.OpenStandardInput(), new UTF8Encoding(false)))
                return r.ReadToEnd();
        }
        if (args.Length >= 2)
            return string.Join(" ", args, 1, args.Length - 1);
        return null;
    }

    [STAThread]
    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 0)
        {
            Console.Error.Write("usage: injector paste|type|fginfo|typetest|pastetest");
            return 1;
        }
        string cmd = args[0].ToLowerInvariant();
        try
        {
            switch (cmd)
            {
                case "paste":
                    return DoPaste();
                case "type":
                    using (StreamReader r = new StreamReader(
                        Console.OpenStandardInput(), new UTF8Encoding(false)))
                        return DoType(r.ReadToEnd());
                case "fginfo":
                    return DoFgInfo();
                case "focus":
                    if (args.Length < 2) { Console.Error.Write("usage: injector focus <titlePart>"); return 1; }
                    return DoFocus(string.Join(" ", args, 1, args.Length - 1));
                case "holdkey":
                    if (args.Length < 3) { Console.Error.Write("usage: injector holdkey <key> <ms>"); return 1; }
                    return DoHoldKey(args[1], int.Parse(args[2]));
                case "copyall":
                    return DoCopyAll();
                case "getclip":
                    return DoGetClip();
                case "idlems":
                    return DoIdleMs();
                case "typetest":
                case "pastetest":
                    string t = ReadArgOrStdin(args);
                    if (t == null)
                    {
                        Console.Error.Write("usage: injector " + cmd + " <text|->");
                        return 1;
                    }
                    return DoRoundTrip(t, cmd == "pastetest");
                default:
                    Console.Error.Write("unknown command: " + cmd);
                    return 1;
            }
        }
        catch (Exception ex)
        {
            Console.Error.Write("FATAL: " + ex.GetType().Name + ": " + ex.Message);
            return 3;
        }
    }
}
