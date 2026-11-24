// lowrun <program> [args...]
// Starts a program at Windows' Low integrity level and waits for it. A Low process can't write to
// anything that isn't labelled Low (only the AI agent folder and the agent's own data folders are),
// can't send input to normal windows, and can't install drivers or change system settings.
// The program is kept in a job object, so it (and everything it starts) ends when lowrun ends; with
// LOWRUN_PARENT=<pid> set, lowrun also ends when that process does.
//
// lowrun --protect <file or folder>
// Labels it Medium with no-read-up, so Low processes can't read it either (Agent Studio's own data).
// Built by build.cmd with the .NET Framework compiler that ships with Windows.
using System;
using System.Runtime.InteropServices;
using System.Text;

static class LowRun
{
    const uint TOKEN_ALL = 0xF01FF, CREATE_SUSPENDED = 0x4, CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    const int STARTF_USESTDHANDLES = 0x100;
    const uint INFINITE = 0xFFFFFFFF;
    const int TokenIntegrityLevel = 25, SecurityImpersonation = 2, TokenPrimary = 1;
    const int JobObjectExtendedLimitInformation = 9, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public int LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public int ActiveProcessLimit;
        public UIntPtr Affinity; public int PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("advapi32", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attrs, int level, int type, out IntPtr copy);
    [DllImport("advapi32", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSid(string sid, out IntPtr psid);
    [DllImport("advapi32", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int cls, ref TOKEN_MANDATORY_LABEL info, int size);
    [DllImport("advapi32", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
                                           uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
    [DllImport("kernel32")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32")] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint ms);
    [DllImport("advapi32", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint rev, out IntPtr sd, IntPtr size);
    [DllImport("advapi32", SetLastError = true)]
    static extern bool GetSecurityDescriptorSacl(IntPtr sd, out bool present, out IntPtr sacl, out bool defaulted);
    [DllImport("advapi32", CharSet = CharSet.Unicode)]
    static extern uint SetNamedSecurityInfo(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    static int Protect(string target)
    {
        bool dir = System.IO.Directory.Exists(target);
        // Medium label, no write-up and no read-up; folders pass it on to everything inside.
        string sddl = dir ? "S:(ML;OICI;NWNR;;;ME)" : "S:(ML;;NWNR;;;ME)";
        IntPtr sd, sacl; bool present, defaulted;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out sd, IntPtr.Zero)) return Fail("ConvertStringSecurityDescriptor");
        if (!GetSecurityDescriptorSacl(sd, out present, out sacl, out defaulted)) return Fail("GetSecurityDescriptorSacl");
        uint err = SetNamedSecurityInfo(target, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);   // SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION
        if (err != 0) { Console.Error.WriteLine("lowrun: protecting " + target + " failed (error " + err + ")"); return 1; }
        return 0;
    }

    static int Fail(string what) { Console.Error.WriteLine("lowrun: " + what + " failed (error " + Marshal.GetLastWin32Error() + ")"); return 126; }

    // Everything after lowrun's own path in the raw command line, quoting untouched.
    static string ChildCommandLine()
    {
        string s = Environment.CommandLine.TrimStart();
        int i = 0;
        if (s.StartsWith("\"")) { i = s.IndexOf('"', 1); i = i < 0 ? s.Length : i + 1; }
        else { while (i < s.Length && s[i] != ' ' && s[i] != '\t') i++; }
        return s.Substring(i).Trim();
    }

    static int Main()
    {
        string cmd = ChildCommandLine();
        if (cmd.Length == 0) { Console.Error.WriteLine("usage: lowrun <program> [args...]  |  lowrun --protect <path>"); return 2; }
        string[] argv = Environment.GetCommandLineArgs();
        if (argv.Length == 3 && argv[1] == "--protect") return Protect(argv[2]);

        IntPtr token, low, sid;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL, out token)) return Fail("OpenProcessToken");
        if (!DuplicateTokenEx(token, TOKEN_ALL, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out low)) return Fail("DuplicateTokenEx");
        if (!ConvertStringSidToSid("S-1-16-4096", out sid)) return Fail("ConvertStringSidToSid");   // Low mandatory level
        var label = new TOKEN_MANDATORY_LABEL { Label = new SID_AND_ATTRIBUTES { Sid = sid, Attributes = 0x20 } }; // SE_GROUP_INTEGRITY
        if (!SetTokenInformation(low, TokenIntegrityLevel, ref label, Marshal.SizeOf(label) + 12)) return Fail("SetTokenInformation");

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(limits));

        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(si);
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = GetStdHandle(-10); si.hStdOutput = GetStdHandle(-11); si.hStdError = GetStdHandle(-12);
        PROCESS_INFORMATION pi;
        if (!CreateProcessAsUser(low, null, new StringBuilder(cmd), IntPtr.Zero, IntPtr.Zero, true,
                                 CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB, IntPtr.Zero, null, ref si, out pi)
            && !CreateProcessAsUser(low, null, new StringBuilder(cmd), IntPtr.Zero, IntPtr.Zero, true,
                                    CREATE_SUSPENDED, IntPtr.Zero, null, ref si, out pi))
            return Fail("CreateProcessAsUser (" + cmd + ")");
        AssignProcessToJobObject(job, pi.hProcess);
        ResumeThread(pi.hThread);
        int parent;
        IntPtr ph = int.TryParse(Environment.GetEnvironmentVariable("LOWRUN_PARENT"), out parent)
            ? OpenProcess(0x00100000, false, parent) : IntPtr.Zero;   // SYNCHRONIZE
        if (ph != IntPtr.Zero)
        {
            if (WaitForMultipleObjects(2, new[] { pi.hProcess, ph }, false, INFINITE) == 1) return 0;   // parent gone: the job ends the child
        }
        else WaitForSingleObject(pi.hProcess, INFINITE);
        uint code; GetExitCodeProcess(pi.hProcess, out code);
        return (int)code;
    }
}
