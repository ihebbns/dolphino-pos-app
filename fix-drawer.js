const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'main.js');
let c = fs.readFileSync(filePath, 'utf8');

// Replace everything between the drawer comment and SESSION HANDLERS
const drawerStart = /\/\/ ── CASH DRAWER[\s\S]*?ipcMain\.handle\('open-cash-drawer'[\s\S]*?\}\);/;

const newDrawer = `// ── CASH DRAWER (XP-80T via RJ11 cable) ───────────────────────────────
// Uses Windows WritePrinter API — no printer sharing needed
ipcMain.handle('open-cash-drawer', async () => {
  return new Promise((resolve) => {
    try {
      const ps = [
        '-NoProfile', '-NonInteractive', '-Command',
        \`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class RawPrint {
  [DllImport("winspool.drv", CharSet=CharSet.Auto, SetLastError=true)]
  public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool StartDocPrinter(IntPtr h, int l, ref DOCINFO d);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int w);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct DOCINFO {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
}
'@ -ErrorAction SilentlyContinue;
$p = (Get-Printer | Where-Object {$_.Name -match 'XP|80|POS|Thermal'} | Select-Object -First 1).Name;
if (-not $p) { $p = (Get-Printer | Select-Object -First 1).Name };
if (-not $p) { Write-Host 'NO_PRINTER'; exit };
$bytes = [byte[]](0x1B,0x70,0x00,0x19,0xFA);
$hPrinter = [IntPtr]::Zero;
[RawPrint]::OpenPrinter($p, [ref]$hPrinter, [IntPtr]::Zero) | Out-Null;
$doc = New-Object RawPrint+DOCINFO; $doc.pDocName='CashDrawer'; $doc.pDataType='RAW';
[RawPrint]::StartDocPrinter($hPrinter,1,[ref]$doc) | Out-Null;
[RawPrint]::StartPagePrinter($hPrinter) | Out-Null;
$written=0; [RawPrint]::WritePrinter($hPrinter,$bytes,$bytes.Length,[ref]$written) | Out-Null;
[RawPrint]::EndPagePrinter($hPrinter) | Out-Null;
[RawPrint]::EndDocPrinter($hPrinter) | Out-Null;
[RawPrint]::ClosePrinter($hPrinter) | Out-Null;
Write-Host "OK:$p bytes:$written"\`
      ];

      execFile('powershell', ps, { timeout: 12000 }, (err, stdout) => {
        const ok = !err && stdout && stdout.includes('OK:');
        console.log('[CashDrawer]', stdout?.trim() || err?.message);
        resolve({ ok, log: stdout?.trim() });
      });
    } catch (e) {
      console.error('[CashDrawer] Error:', e.message);
      resolve({ ok: false, error: e.message });
    }
  });
});`;

if (drawerStart.test(c)) {
  c = c.replace(drawerStart, newDrawer);
  fs.writeFileSync(filePath, c, 'utf8');
  console.log('✓ Cash drawer restored to WritePrinter version');
} else {
  console.log('✗ Pattern not found — checking manually');
  // Show what's there
  const idx = c.indexOf('open-cash-drawer');
  if (idx > -1) console.log('Found at index', idx, ':', c.slice(idx, idx+100));
}
