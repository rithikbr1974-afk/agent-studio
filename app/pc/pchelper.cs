// pchelper: Agent Studio's hands on the desktop. Reads one JSON request per line on stdin and writes one
// JSON reply per line on stdout. It only does what it is told; every safety check (blocked windows,
// confirmations, logging) happens in pc.js before a request reaches it.
// Coordinates are physical screen pixels (the process is per-monitor DPI aware).
// Built by build.cmd with the .NET Framework compiler that ships with Windows.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

static class PcHelper
{
    // ------------------------------------------------------------ Win32
    [DllImport("user32")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32")] static extern int GetSystemMetrics(int i);
    [DllImport("user32")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("dwmapi")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    delegate bool EnumProc(IntPtr h, IntPtr l);

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

    const uint MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4, MOUSEEVENTF_RIGHTDOWN = 0x8, MOUSEEVENTF_RIGHTUP = 0x10;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x20, MOUSEEVENTF_MIDDLEUP = 0x40, MOUSEEVENTF_WHEEL = 0x800, MOUSEEVENTF_HWHEEL = 0x1000;
    const uint KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4, KEYEVENTF_EXTENDEDKEY = 0x1;
    const uint WM_CLOSE = 0x10, GA_ROOT = 2;

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

    // ------------------------------------------------------------ windows
    static string Text(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
    static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
    static string ProcName(uint pid)
    {
        try { using (var p = Process.GetProcessById((int)pid)) return p.ProcessName.ToLowerInvariant() + ".exe"; } catch { return ""; }
    }

    static Dictionary<string, object> Describe(IntPtr h)
    {
        uint pid; GetWindowThreadProcessId(h, out pid);
        RECT r; GetWindowRect(h, out r);
        return new Dictionary<string, object> {
            { "hwnd", h.ToInt64() }, { "pid", pid }, { "proc", ProcName(pid) }, { "cls", Class(h) }, { "title", Text(h) },
            { "x", r.L }, { "y", r.T }, { "w", r.R - r.L }, { "h", r.B - r.T },
            { "minimized", IsIconic(h) }, { "maximized", IsZoomed(h) },
        };
    }

    static List<Dictionary<string, object>> Windows()
    {
        var list = new List<Dictionary<string, object>>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h) || Text(h).Length == 0) return true;
            int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;   // DWMWA_CLOAKED
            int ex = GetWindowLong(h, -20);
            if ((ex & 0x80) != 0 || (ex & 0x08000000) != 0) return true;   // tool windows, no-activate overlays
            list.Add(Describe(h));
            return true;
        }, IntPtr.Zero);
        return list;
    }

    [DllImport("user32")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("kernel32")] static extern uint GetCurrentThreadId();

    // Windows refuses to hand the foreground to a background process while you work in another window.
    // Joining the active window's input queue for a moment (plus a lone Alt tap) is the accepted way round.
    static void Focus(IntPtr h)
    {
        if (IsIconic(h)) ShowWindow(h, 9);   // SW_RESTORE
        for (int attempt = 0; attempt < 3 && GetForegroundWindow() != h; attempt++)
        {
            uint dummy, fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out dummy), me = GetCurrentThreadId();
            Send(Key(0x12, false), Key(0x12, true));
            bool joined = fgThread != me && AttachThreadInput(me, fgThread, true);
            BringWindowToTop(h); SetForegroundWindow(h); ShowWindow(h, 5);   // SW_SHOW
            if (joined) AttachThreadInput(me, fgThread, false);
            Thread.Sleep(120);
        }
    }

    // ------------------------------------------------------------ input
    static void Send(params INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }
    static INPUT Mouse(uint flags, uint data = 0) { var i = new INPUT { type = 0 }; i.u.mi.flags = flags; i.u.mi.data = data; return i; }
    static INPUT Key(ushort vk, bool up, bool unicode = false, ushort ch = 0)
    {
        var i = new INPUT { type = 1 };
        if (unicode) { i.u.ki.scan = ch; i.u.ki.flags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0); }
        else {
            i.u.ki.vk = vk;
            bool ext = vk >= 0x21 && vk <= 0x2E || vk == 0x5B || vk == 0x5C;   // arrows, page/home/end, insert/delete, Win
            i.u.ki.flags = (up ? KEYEVENTF_KEYUP : 0) | (ext ? KEYEVENTF_EXTENDEDKEY : 0);
        }
        return i;
    }

    static void Click(int x, int y, string button, int count)
    {
        SetCursorPos(x, y); Thread.Sleep(60);
        uint down = MOUSEEVENTF_LEFTDOWN, up = MOUSEEVENTF_LEFTUP;
        if (button == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
        if (button == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
        for (int i = 0; i < Math.Max(1, count); i++) { Send(Mouse(down), Mouse(up)); Thread.Sleep(70); }
    }

    static void Drag(int x1, int y1, int x2, int y2)
    {
        SetCursorPos(x1, y1); Thread.Sleep(80); Send(Mouse(MOUSEEVENTF_LEFTDOWN)); Thread.Sleep(80);
        for (int s = 1; s <= 12; s++) { SetCursorPos(x1 + (x2 - x1) * s / 12, y1 + (y2 - y1) * s / 12); Thread.Sleep(25); }
        Thread.Sleep(80); Send(Mouse(MOUSEEVENTF_LEFTUP));
    }

    static void TypeText(string text, int delay)
    {
        foreach (char c in text.Replace("\r\n", "\n"))
        {
            if (c == '\n') { Send(Key(0x0D, false), Key(0x0D, true)); }
            else if (c == '\t') { Send(Key(0x09, false), Key(0x09, true)); }
            else Send(Key(0, false, true, c), Key(0, true, true, c));
            Thread.Sleep(delay);
        }
    }

    static readonly Dictionary<string, ushort> VK = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
        { "ctrl", 0x11 }, { "control", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 }, { "win", 0x5B },
        { "enter", 0x0D }, { "return", 0x0D }, { "tab", 0x09 }, { "esc", 0x1B }, { "escape", 0x1B }, { "space", 0x20 },
        { "backspace", 0x08 }, { "delete", 0x2E }, { "del", 0x2E }, { "insert", 0x2D }, { "home", 0x24 }, { "end", 0x23 },
        { "pageup", 0x21 }, { "pagedown", 0x22 }, { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 },
        { "capslock", 0x14 }, { "printscreen", 0x2C }, { "menu", 0x5D }, { "apps", 0x5D },
        { "volumeup", 0xAF }, { "volumedown", 0xAE }, { "volumemute", 0xAD }, { "playpause", 0xB3 }, { "nexttrack", 0xB0 }, { "prevtrack", 0xB1 },
        { "plus", 0xBB }, { "minus", 0xBD }, { "comma", 0xBC }, { "period", 0xBE },
    };

    static ushort KeyCode(string k)
    {
        ushort v;
        if (VK.TryGetValue(k, out v)) return v;
        if (k.Length == 1) { char c = char.ToUpperInvariant(k[0]); if (c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') return c; }
        if (k.Length >= 2 && (k[0] == 'f' || k[0] == 'F')) { int n; if (int.TryParse(k.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x6F + n); }
        throw new Exception("unknown key: " + k);
    }

    static void Keys(string combo)
    {
        var codes = combo.Split('+').Select(s => s.Trim()).Where(s => s.Length > 0).Select(KeyCode).ToList();
        foreach (var c in codes) Send(Key(c, false));
        Thread.Sleep(40);
        for (int i = codes.Count - 1; i >= 0; i--) Send(Key(codes[i], true));
    }

    // ------------------------------------------------------------ screen
    static Dictionary<string, object> Shot(int maxW, string path)
    {
        int x = GetSystemMetrics(76), y = GetSystemMetrics(77), w = GetSystemMetrics(78), h = GetSystemMetrics(79);
        using (var bmp = new Bitmap(w, h))
        {
            using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
            double scale = Math.Min(1.0, (double)maxW / w);
            int sw = (int)(w * scale), sh = (int)(h * scale);
            using (var small = new Bitmap(bmp, sw, sh))
            using (var ms = new MemoryStream())
            {
                var enc = ImageCodecInfo.GetImageEncoders().First(e => e.MimeType == "image/jpeg");
                var p = new EncoderParameters(1); p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 70L);
                small.Save(ms, enc, p);
                if (!string.IsNullOrEmpty(path)) File.WriteAllBytes(path, ms.ToArray());
                return new Dictionary<string, object> { { "data", Convert.ToBase64String(ms.ToArray()) }, { "originX", x }, { "originY", y },
                    { "scale", scale }, { "w", sw }, { "h", sh }, { "screenW", w }, { "screenH", h } };
            }
        }
    }

    // UI Automation: the clickable and readable things in one window, without screenshots.
    static readonly ControlType[] Useful = {
        ControlType.Button, ControlType.MenuItem, ControlType.Hyperlink, ControlType.ListItem, ControlType.TabItem,
        ControlType.TreeItem, ControlType.CheckBox, ControlType.RadioButton, ControlType.ComboBox, ControlType.Edit,
        ControlType.Document, ControlType.SplitButton, ControlType.DataItem, ControlType.Text, ControlType.Image, ControlType.Slider,
    };

    static List<Dictionary<string, object>> Elements(IntPtr h, int max, int ms)
    {
        var list = new List<Dictionary<string, object>>();
        var root = AutomationElement.FromHandle(h);
        var cond = new AndCondition(new PropertyCondition(AutomationElement.IsOffscreenProperty, false),
                                    new PropertyCondition(AutomationElement.IsControlElementProperty, true));
        var sw = Stopwatch.StartNew();
        var walker = new TreeWalker(cond);
        var stack = new Stack<AutomationElement>(); stack.Push(root);
        while (stack.Count > 0 && list.Count < max && sw.ElapsedMilliseconds < ms)
        {
            var e = stack.Pop();
            try
            {
                var cur = e.Current;
                if (e != root && Useful.Contains(cur.ControlType))
                {
                    var r = cur.BoundingRectangle;
                    string name = (cur.Name ?? "").Trim();
                    if (name.Length == 0 && cur.ControlType == ControlType.Edit) name = "(text box)";
                    if (!r.IsEmpty && r.Width > 1 && r.Height > 1 && name.Length > 0 && !(cur.ControlType == ControlType.Text && name.Length > 200))
                        list.Add(new Dictionary<string, object> {
                            { "role", cur.ControlType.ProgrammaticName.Replace("ControlType.", "") },
                            { "name", name.Length > 120 ? name.Substring(0, 120) + "…" : name },
                            { "x", (int)(r.X + r.Width / 2) }, { "y", (int)(r.Y + r.Height / 2) },
                            { "enabled", cur.IsEnabled },
                        });
                }
                var kids = new List<AutomationElement>();
                for (var c = walker.GetFirstChild(e); c != null; c = walker.GetNextSibling(c)) kids.Add(c);
                for (int i = kids.Count - 1; i >= 0; i--) stack.Push(kids[i]);
            }
            catch { }   // elements vanish while being read
        }
        return list;
    }

    // What is under a point: its top window and the UI element's name (for the risky-click check).
    static Dictionary<string, object> At(int x, int y)
    {
        var top = GetAncestor(WindowFromPoint(new POINT { X = x, Y = y }), GA_ROOT);
        var d = Describe(top);
        try
        {
            var e = AutomationElement.FromPoint(new System.Windows.Point(x, y));
            var names = new List<string>();
            for (int i = 0; e != null && i < 3; i++)
            {
                string n = (e.Current.Name ?? "").Trim();
                if (n.Length > 0 && n.Length < 200) names.Add(n);
                e = TreeWalker.ControlViewWalker.GetParent(e);
            }
            d["element"] = string.Join(" / ", names);
        }
        catch { d["element"] = ""; }
        return d;
    }

    // ------------------------------------------------------------ loop
    static object Handle(Dictionary<string, object> q)
    {
        Func<string, int> I = k => Convert.ToInt32(q[k]);
        Func<string, string> S = k => q.ContainsKey(k) && q[k] != null ? q[k].ToString() : "";
        switch (S("op"))
        {
            case "fg": return Describe(GetForegroundWindow());
            case "at": return At(I("x"), I("y"));
            case "windows": return Windows();
            case "window": return Describe(new IntPtr(Convert.ToInt64(q["hwnd"])));
            case "focus": Focus(new IntPtr(Convert.ToInt64(q["hwnd"]))); return Describe(GetForegroundWindow());
            case "show": ShowWindow(new IntPtr(Convert.ToInt64(q["hwnd"])), I("cmd")); return true;
            case "close": PostMessage(new IntPtr(Convert.ToInt64(q["hwnd"])), WM_CLOSE, IntPtr.Zero, IntPtr.Zero); return true;
            case "click": Click(I("x"), I("y"), S("button"), q.ContainsKey("count") ? I("count") : 1); return true;
            case "move": SetCursorPos(I("x"), I("y")); return true;
            case "drag": Drag(I("x1"), I("y1"), I("x2"), I("y2")); return true;
            case "scroll":
                SetCursorPos(I("x"), I("y")); Thread.Sleep(40);
                Send(Mouse(S("axis") == "h" ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, unchecked((uint)(I("delta") * 120))));
                return true;
            case "type": TypeText(S("text"), q.ContainsKey("delay") ? I("delay") : 25); return true;
            case "keys": Keys(S("combo")); return true;
            case "cursor": { POINT p; GetCursorPos(out p); return new Dictionary<string, object> { { "x", p.X }, { "y", p.Y } }; }
            case "shot": return Shot(q.ContainsKey("maxw") ? I("maxw") : 1280, S("path"));
            case "elements": return Elements(new IntPtr(Convert.ToInt64(q["hwnd"])), q.ContainsKey("max") ? I("max") : 150, 4000);
            default: throw new Exception("unknown op " + S("op"));
        }
    }

    [STAThread]
    static void Main()
    {
        SetProcessDpiAwarenessContext(new IntPtr(-4));   // per-monitor v2: physical pixels everywhere
        Console.InputEncoding = Encoding.UTF8;
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            object id = null;
            try
            {
                var q = Json.Deserialize<Dictionary<string, object>>(line);
                id = q.ContainsKey("id") ? q["id"] : null;
                stdout.WriteLine(Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", Handle(q) } }));
            }
            catch (Exception e)
            {
                stdout.WriteLine(Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", e.Message } }));
            }
        }
    }
}
