// ═══════════════════════════════════════════════════════════════════
// servio-drawer.exe — opens the cash drawer, and nothing else.
//
// WHY THIS EXISTS
// The drawer kick is five ESC/POS bytes sent as a RAW job to the receipt
// printer, which needs the Win32 winspool API. That was done by asking
// PowerShell to Add-Type this same C# at runtime — and JIT-compiling it cost
// ~890 ms of solid CPU on every cold start. Wherever that landed, it showed as
// a freeze: at start-up it swallowed the first taps, after login it would have
// hit while the cashier browsed the menu.
//
// Compiling it HERE, at build time, removes the cost rather than moving it.
// Spawning an already-compiled 5 KB native exe is a few milliseconds and needs
// no warm-up, no persistent PowerShell, and no runtime code generation — which
// also means nothing is written into %APPDATA% for antivirus to be suspicious
// about. It ships in resources/ next to the elevate.exe electron-builder
// already puts there.
//
// Built with the csc.exe that ships with .NET Framework 4 on every Windows
// machine, so no toolchain has to be installed.
//
// USAGE:  servio-drawer.exe "<printer name>" [1B,70,00,19,FA]
// PRINTS: OK:<bytes>  |  ERR:<reason>
// ═══════════════════════════════════════════════════════════════════
using System;
using System.Runtime.InteropServices;

class ServioDrawer
{
    [StructLayout(LayoutKind.Sequential)]
    public struct DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
    static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
    static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOA di);
    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
    static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
    static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
    static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
    static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

    static int Main(string[] args)
    {
        if (args.Length < 1 || args[0].Length == 0)
        {
            Console.WriteLine("ERR:NO_PRINTER");
            return 2;
        }

        string printer = args[0];
        // Default is the standard kick: ESC p 0 25 250 — pin 2, 25ms on, 250ms off.
        byte[] bytes = args.Length > 1 && args[1].Length > 0
            ? ParseHex(args[1])
            : new byte[] { 0x1B, 0x70, 0x00, 0x19, 0xFA };

        IntPtr h;
        if (!OpenPrinter(printer, out h, IntPtr.Zero))
        {
            Console.WriteLine("ERR:OPEN:" + Marshal.GetLastWin32Error());
            return 3;
        }

        IntPtr buf = IntPtr.Zero;
        try
        {
            DOCINFOA di = new DOCINFOA();
            di.pDocName = "ServioCashDrawer";
            di.pDataType = "RAW";

            if (!StartDocPrinter(h, 1, ref di))
            {
                Console.WriteLine("ERR:STARTDOC:" + Marshal.GetLastWin32Error());
                return 4;
            }
            StartPagePrinter(h);

            buf = Marshal.AllocCoTaskMem(bytes.Length);
            Marshal.Copy(bytes, 0, buf, bytes.Length);

            int written;
            bool ok = WritePrinter(h, buf, bytes.Length, out written);

            EndPagePrinter(h);
            EndDocPrinter(h);

            Console.WriteLine(ok ? ("OK:" + written) : ("ERR:WRITE:" + Marshal.GetLastWin32Error()));
            return ok ? 0 : 5;
        }
        catch (Exception e)
        {
            Console.WriteLine("ERR:" + e.Message);
            return 6;
        }
        finally
        {
            if (buf != IntPtr.Zero) Marshal.FreeCoTaskMem(buf);
            ClosePrinter(h);
        }
    }

    /** "1B,70,00,19,FA" -> bytes. Comma-separated hex keeps quoting simple. */
    static byte[] ParseHex(string s)
    {
        string[] parts = s.Split(',');
        byte[] b = new byte[parts.Length];
        for (int i = 0; i < parts.Length; i++)
            b[i] = Convert.ToByte(parts[i].Trim(), 16);
        return b;
    }
}
