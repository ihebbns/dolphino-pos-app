const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const {
  closeDatabase,
  getDatabaseReady,
  getDatabaseStatus,
  getSales,
  saveSale,
  saveSession,
  closeSession,
  getSessions,
} = require('./database');

let mainWindow;

// Developer mode: full menu + DevTools. In packaged builds this is false,
// so DevTools / reload / inspection shortcuts are disabled (anti-tamper).
// Set SERVIO_DEV=1 to force dev tools on your own machine.
const IS_DEV = !app.isPackaged || process.env.SERVIO_DEV === '1';

// ── FOCUS RECOVERY (Electron keyboard fix) ──────────────────────────
// THE BUG: on Windows, after a child window (print), a native dialog or a
// spawned process, the POS window stays the OS foreground window while
// Chromium's internal focus state detaches. Inputs then show a focus ring but
// keystrokes go nowhere. The only user-visible cure was clicking outside the
// app and back in.
//
// WHY THE OBVIOUS FIX DOES NOTHING: BrowserWindow.focus() calls
// SetForegroundWindow, which Windows treats as a NO-OP when the window is
// already foreground — so no fresh WM_ACTIVATE is issued and Chromium never
// resyncs. webContents.focus() likewise early-returns when the widget thinks
// it already has focus. Both are no-ops in exactly the broken state.
//
// THE FIX: force a genuine focus TRANSITION at the web-view widget level.
// blurWebView() clears the widget's has_focus_ flag, so the following
// focusOnWebView() cannot early-return and performs a real re-focus. Neither
// call touches OS window z-order, so there is no taskbar/window flash — which
// is why this is preferred over the old blur()/focus() pair.
function forceRecoverFocus(depth) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Force the transition. Guarded: these are BrowserWindow methods, so fall
  // back to webContents.focus() alone if a future Electron drops them.
  try {
    if (typeof mainWindow.blurWebView === 'function') mainWindow.blurWebView();
    if (typeof mainWindow.focusOnWebView === 'function') mainWindow.focusOnWebView();
  } catch (e) {}
  try { mainWindow.webContents.focus(); } catch (e) {}

  // Put the caret back where the cashier left it.
  try {
    mainWindow.webContents.executeJavaScript(`
      (function(){
        var e = document.querySelector('input:focus,textarea:focus');
        if(!e && window.__lastFocusEl && document.body.contains(window.__lastFocusEl)){
          try{ window.__lastFocusEl.focus(); }catch(_){}
        }
        return document.hasFocus();
      })();
    `).then(hasFocus => {
      // Escalation: if Chromium STILL reports no focus, the native HWND focus
      // itself is wrong. Toggling focusable makes Windows re-evaluate and
      // deliver a real activation. Only on Windows, only once, and only as a
      // last resort since it is heavier than the widget-level path above.
      if (!hasFocus && process.platform === 'win32' && !depth) {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        try {
          mainWindow.setFocusable(false);
          mainWindow.setFocusable(true);
          mainWindow.focus();
        } catch (e) {}
        setTimeout(() => forceRecoverFocus(1), 30);
      }
    }).catch(() => {});
  } catch (e) {}
}

// ── OTA Auto-Update ───────────────────────────────────────────────────
// Downloads latest index.html from server silently in background.
// Fallback: always uses local version if download fails.
// Each client has its own OTA folder keyed by syncKey to prevent conflicts.
let UPDATE_DIR = path.join(app.getPath('userData'), 'servio-update');
let UPDATE_FILE = path.join(UPDATE_DIR, 'index.html');
let UPDATE_META = path.join(UPDATE_DIR, 'meta.json');

function initOtaPaths(syncKey) {
  // Each client gets their own OTA subfolder based on their unique API key
  if (syncKey) {
    const safeKey = syncKey.replace(/[^a-zA-Z0-9\-]/g, '').slice(0, 30);
    UPDATE_DIR = path.join(app.getPath('userData'), 'servio-update-' + safeKey);
  }
  UPDATE_FILE = path.join(UPDATE_DIR, 'index.html');
  UPDATE_META = path.join(UPDATE_DIR, 'meta.json');
}

function getLocalVersion() {
  try {
    if (fs.existsSync(UPDATE_META)) {
      return JSON.parse(fs.readFileSync(UPDATE_META, 'utf8')).version || 0;
    }
  } catch (e) {}
  return 0;
}

function getUpdatedIndex() {
  // Return the updated index.html if it exists and is valid (> 1KB)
  try {
    if (fs.existsSync(UPDATE_FILE)) {
      const stat = fs.statSync(UPDATE_FILE);
      if (stat.size > 1024) return UPDATE_FILE;
    }
  } catch (e) {}
  return null;
}

async function checkForUpdate(syncUrl, syncKey) {
  if (!syncUrl || !syncKey) return;
  try {
    const checkUrl = syncUrl.replace('/api/sync', '/api/update') + '?key=' + syncKey;
    const https = require('https');
    const http = require('http');
    const fetch = (checkUrl.startsWith('https') ? https : http).get;

    // Check version
    const versionData = await new Promise((resolve, reject) => {
      const req = (checkUrl.startsWith('https') ? https : http).get(checkUrl, { timeout: 8000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });

    if (!versionData || !versionData.ok || !versionData.version) return;

    const localVer = getLocalVersion();
    const serverVer = parseInt(versionData.version) || 0;

    if (serverVer <= localVer) return; // Already up to date

    // Download new HTML
    const htmlUrl = syncUrl.replace('/api/sync', '/api/update/html') + '?key=' + syncKey;
    const html = await new Promise((resolve, reject) => {
      const req = (htmlUrl.startsWith('https') ? https : http).get(htmlUrl, { timeout: 15000 }, (res) => {
        if (res.statusCode !== 200) { resolve(null); return; }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });

    if (!html || html.length < 1024) return; // Invalid or empty

    // Save update
    if (!fs.existsSync(UPDATE_DIR)) fs.mkdirSync(UPDATE_DIR, { recursive: true });
    fs.writeFileSync(UPDATE_FILE, html, 'utf8');
    fs.writeFileSync(UPDATE_META, JSON.stringify({ version: serverVer, updatedAt: new Date().toISOString() }), 'utf8');
    console.log('[OTA] Updated to version', serverVer);

    // Notify user — they'll get the update on next restart
    if (mainWindow) {
      mainWindow.webContents.executeJavaScript(`
        if(typeof flash==='function') flash('🔄 Mise à jour disponible — redémarrez l\\'app');
      `).catch(() => {});
    }
  } catch (e) {
    console.log('[OTA] Check failed (offline?):', e.message);
    // Silent fail — app continues normally
  }
}

// ── Client syncKey ────────────────────────────────────────────────────
// The built-in index.html carries CLIENT_CONFIG, whose syncKey identifies the
// client. It drives BOTH the per-client OTA folder and the per-client SQLite
// filename, so it MUST resolve or the app silently falls back to shared
// defaults — and can then load ANOTHER client's OTA copy.
//
// Do NOT read only the head of the file to "save time". CLIENT_CONFIG is
// emitted after the inline CSS/markup and sits ~1.2 MB in; a 64 KB bound never
// found it and Cafeina booted as the default/shared client. The full read is a
// few ms and was never the start-up bottleneck (that was sql.js WASM, the
// drawer PowerShell compile and maximize()). Read once, cache, share.
let _builtInSyncKey; // undefined = not resolved yet | null = genuinely absent
function readBuiltInSyncKey() {
  if (_builtInSyncKey !== undefined) return _builtInSyncKey;
  _builtInSyncKey = null;
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const m = html.match(/syncKey:\s*'([^']+)'/);
    if (m) _builtInSyncKey = m[1];
  } catch (e) {}
  if (_builtInSyncKey) {
    console.log('[client] syncKey resolved:', _builtInSyncKey.slice(0, 6) + '…');
  } else {
    console.warn('[client] syncKey NOT found in built-in index.html — OTA folder and DB will use SHARED defaults');
  }
  return _builtInSyncKey;
}

// ── Resolve client index.html ─────────────────────────────────────────
function resolveClientIndex() {
  const builtInIndex = path.join(__dirname, '..', 'index.html');
  // Init the OTA paths for THIS client before any OTA lookup below.
  const key = readBuiltInSyncKey();
  if (key) initOtaPaths(key);

  // Priority 1: OTA updated version for THIS client (keyed by syncKey).
  //
  // Only ever consult the OTA cache when the key resolved. UPDATE_DIR defaults
  // to the UNKEYED userData/servio-update folder, which on any machine that ran
  // an older build can still hold a DIFFERENT client's index.html. Serving it
  // makes the EXE render the wrong brand, wrong menu and wrong prices — exactly
  // what happened when the syncKey read was bounded to 64 KB. No key means we
  // cannot prove the cache belongs to this client, so we ignore it and ship the
  // bundled file, which is always correct.
  if (key) {
    const updated = getUpdatedIndex();
    if (updated) return updated;
  } else {
    console.warn('[OTA] skipped: no syncKey, refusing to load a possibly foreign cached index.html');
  }

  // Priority 2: Dev mode (CLIENT_DIR env)
  if (process.env.CLIENT_DIR) {
    const envPath = path.resolve(process.env.CLIENT_DIR, 'index.html');
    if (fs.existsSync(envPath)) return envPath;
  }

  // Priority 3: Original from EXE package (always works)
  return builtInIndex;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    title: 'POS Pro — by Servio ⚡',
    backgroundColor: '#0A0704',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    titleBarStyle: process.platform === 'win32' ? 'default' : 'hiddenInset',
    show: false,
  });

  mainWindow.loadFile(resolveClientIndex());

  // ── Anti-tamper: block DevTools / reload / inspection in production ──
  if (!IS_DEV) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const k = (input.key || '').toLowerCase();
      const ctrlOrCmd = input.control || input.meta;
      if (
        k === 'f12' ||
        k === 'f5' ||
        (ctrlOrCmd && input.shift && (k === 'i' || k === 'j' || k === 'c')) ||
        (ctrlOrCmd && k === 'r')
      ) {
        event.preventDefault();
      }
    });
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow.webContents.closeDevTools();
    });
  }

  mainWindow.once('ready-to-show', () => {
    // Maximize BEFORE showing. This used to run immediately after createWindow,
    // and on Windows maximizing a hidden window implicitly SHOWS it — so an
    // empty white window appeared instantly and sat there for seconds until the
    // renderer painted. Doing it here keeps the window invisible until there is
    // something to look at, which is the whole point of show:false.
    if (process.platform === 'win32') {
      mainWindow.maximize();
    }
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.focus();
    // Background services are NOT started here. 'ready-to-show' fires at first
    // paint, while the renderer is still executing its start-up script, so
    // spawning PowerShell and compiling WASM at this point competed with the UI
    // and left the first screen unresponsive to clicks. The renderer calls
    // signalInteractive() when it is genuinely ready; see startBackgroundServices().
    setTimeout(startBackgroundServices, 3000);   // safety net if that never arrives
  });

  // (Focus recovery on window activation is registered further down, in the
  // FOCUS RECOVERY section, so all focus handling lives in one place.)

  const template = [
    {
      label: '⚡ Servio',
      submenu: [
        { label: 'À propos', click: () => {
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Servio POS',
            message: 'Servio POS v1.1.0',
            detail: 'Système de caisse — Restaurant & Fast Food\nPowered by Servio OS',
            buttons: ['OK'],
          });
        }},
        { type: 'separator' },
        { role: 'quit', label: 'Quitter' }
      ]
    },
    {
      label: 'Affichage',
      submenu: [
        { label: 'Plein écran', role: 'togglefullscreen', accelerator: 'F11' },
        { type: 'separator' },
        { label: 'Zoom +', role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
        { label: 'Zoom −', role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
        { label: 'Réinitialiser zoom', role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
        // Reload + DevTools only in developer mode (hidden from clients)
        ...(IS_DEV ? [
          { type: 'separator' },
          { label: 'Recharger', role: 'reload', accelerator: 'CmdOrCtrl+R' },
          { label: 'DevTools', role: 'toggleDevTools', accelerator: 'F12' },
        ] : []),
      ]
    },
    {
      label: 'Impression',
      submenu: [
        { label: 'Imprimer reçu', accelerator: 'CmdOrCtrl+P', click: () => {
          mainWindow.webContents.send('trigger-print');
        }},
      ]
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function userDataPath() {
  return app.getPath('userData');
}

ipcMain.handle('db-get-sales', async () => {
  try {
    return await getSales(userDataPath());
  } catch (error) {
    console.error('db-get-sales failed:', error);
    return [];
  }
});

ipcMain.handle('db-save-sale', async (_event, sale) => {
  try {
    return await saveSale(userDataPath(), sale);
  } catch (error) {
    console.error('db-save-sale failed:', error);
    return { ok: false, error: error.message || 'Erreur SQLite' };
  }
});

ipcMain.handle('db-get-status', async () => {
  try {
    await getDatabaseReady(userDataPath());
    return getDatabaseStatus();
  } catch (error) {
    return {
      available: false,
      path: null,
      error: error.message || 'Erreur SQLite',
      schemaVersion: null,
    };
  }
});

// A ticket must go to paper or nowhere at all — never to a file on the PC.
// print({silent:true}) with no deviceName sends the job to the Windows DEFAULT
// printer. When that default is "Microsoft Print to PDF" or "XPS Document
// Writer" (which it is on most machines with no thermal printer installed),
// Windows opens "Save Print Output As" and the cashier gets asked to save the
// receipt on the computer. Resolving a real device and refusing to print when
// there is none removes that behaviour completely.
const VIRTUAL_PRINTER_RE = /PDF|XPS|OneNote|Fax|Print to|Adobe|Snagit|Document Writer|Foxit/i;
async function resolveReceiptPrinter(wc) {
  const cfg = hwConfig();
  let list = [];
  try { list = await wc.getPrintersAsync(); } catch (e) { return null; }
  const label = p => (p.name || '') + ' ' + (p.displayName || '') + ' ' + (p.description || '');
  const names = list.map(p => p.name);
  // An explicit choice always wins, as long as it still exists.
  if (cfg.receiptPrinter && names.includes(cfg.receiptPrinter)) return cfg.receiptPrinter;
  if (cfg.drawerPrinter && names.includes(cfg.drawerPrinter)) return cfg.drawerPrinter;
  const real = list.filter(p => !VIRTUAL_PRINTER_RE.test(label(p)));
  const thermal = real.find(p => /XP|80|58|POS|Thermal|Receipt|TM-T|Caisse|Ticket|Star|EPSON/i.test(label(p)));
  if (thermal) return thermal.name;
  if (real.length === 1) return real[0].name;
  const def = real.find(p => p.isDefault);   // a REAL default is fine; a virtual one is not
  return def ? def.name : null;
}

ipcMain.on('print-receipt', (event, htmlContent) => {
  // Inject @page 80mm CSS to fix thermal printer paper width
  const printCSS = `<style>
    @page { size: 80mm auto; margin: 0mm; }
    html, body { width: 72mm; max-width: 72mm; margin: 0; padding: 2mm; }
  </style>`;
  const fixedHtml = htmlContent.replace('</head>', printCSS + '</head>');

  // Write to temp file — data: URLs cause blank prints in some Electron versions
  const tmpFile = path.join(os.tmpdir(), 'servio_print_' + Date.now() + '.html');
  fs.writeFileSync(tmpFile, fixedHtml, 'utf8');

  const printWin = new BrowserWindow({
    width: 302, // 80mm at 96dpi
    height: 800,
    show: false,
    focusable: false,   // never take keyboard focus from the POS
    skipTaskbar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    setTimeout(() => {
      try { if (!printWin.isDestroyed()) printWin.close(); } catch (e) {}
      try { fs.unlinkSync(tmpFile); } catch (e) {}
      // Recover keyboard focus immediately + a couple of retries so the
      // cashier never notices (was ~800ms before → felt like a freeze).
      forceRecoverFocus();
      setTimeout(forceRecoverFocus, 100);
      setTimeout(forceRecoverFocus, 350);
    }, 200);
  };

  printWin.loadFile(tmpFile);

  printWin.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      const t0 = Date.now();
      const deviceName = await resolveReceiptPrinter(printWin.webContents);
      if (!deviceName) {
        console.log('[Print] no physical printer — ticket not printed (refusing PDF/XPS fallback)');
        cleanup();
        return;
      }
      printWin.webContents.print(
        {
          silent: true,
          deviceName,                 // pin the target so Windows cannot pick PDF
          printBackground: false,
          margins: { marginType: 'none' },
          pageSize: { width: 80000, height: 297000 }, // 80mm wide, auto height in microns
        },
        (success, errorType) => {
          console.log('[Print]', (success ? 'OK: ' : 'FAILED: ') + deviceName +
                      (errorType ? ' — ' + errorType : '') + '  ' + (Date.now() - t0) + 'ms');
          cleanup();
        }
      );
    }, 600);
  });

  // If the page never loads, still clean the temp file up.
  printWin.webContents.once('did-fail-load', cleanup);
});

// ── HARDWARE CONFIG ───────────────────────────────────────────────────
// Optional per-terminal override of which printer receives the ticket and the
// drawer kick, read from userData/hardware.json. Auto-detection below handles
// the normal case; this exists so a stubborn site can be pinned without a
// rebuild (set "receiptPrinter": "EXACT WINDOWS NAME").
const HW_DEFAULTS = {
  drawerPrinter: '',    // '' = auto-detect, and NEVER a blind "first printer"
  receiptPrinter: '',   // '' = auto-detect; virtual PDF/XPS devices are never used
};
let _hwCfg = null;
function hwConfig() {
  if (_hwCfg) return _hwCfg;
  _hwCfg = { ...HW_DEFAULTS };
  try {
    Object.assign(_hwCfg, JSON.parse(fs.readFileSync(path.join(userDataPath(), 'hardware.json'), 'utf8')));
  } catch (e) {}
  return _hwCfg;
}

// ── CASH DRAWER (XP-80T via RJ11 cable) ───────────────────────────────
// Uses Windows WritePrinter API — no printer sharing needed.
//
// PERFORMANCE: The naive approach spawns a fresh PowerShell on every kick
// that (a) starts PowerShell, (b) compiles C# via Add-Type at runtime, and
// (c) runs Get-Printer — ~1-3s of latency EVERY time, so the drawer opened
// "quelques secondes" after the cashier tapped Encaisser.
//
// FIX: warm ONE long-lived hidden PowerShell process at startup that compiles
// the RawPrint type ONCE and caches the resolved printer name. Each kick then
// just writes a one-line command to its stdin → the drawer fires in tens of ms.
// A robust one-shot fallback (the original code path) guarantees the drawer
// never behaves worse than before if the warm service is not available.

// C# RawPrint definition — shared verbatim by the warm service AND the fallback.
const RAWPRINT_CS = `using System;
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
}`;

// ── Persistent (warm) drawer service ──────────────────────────────────
let drawerProc = null;      // the long-lived PowerShell child (or null)
let drawerReady = false;    // true once the child has compiled + cached printer
let drawerKickSeq = 0;      // monotonic id per kick, for request/response matching
let drawerStdoutBuf = '';   // line-buffer for the child's stdout
const drawerPending = new Map(); // id -> { resolve, timer }

// The server script the warm PowerShell runs: compile RawPrint once, resolve +
// cache the printer once, then idle reading one-line commands from stdin.
function buildDrawerServerScript() {
  const forced = String(hwConfig().drawerPrinter || '').replace(/'/g, "''");
  return `$ErrorActionPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
${RAWPRINT_CS}
'@ -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
# Get-Printer is WMI and costs seconds on the start-up path; InstalledPrinters is
# effectively instant. And the old blind fallback to the FIRST printer was worse
# than useless: on most Windows boxes that is "Microsoft Print to PDF", so the
# kick reported bytes written while the drawer never moved. An ambiguous setup
# now returns NO_PRINTER so a human picks the right one.
function Resolve-Printer {
  if ('${forced}'.Length -gt 0) { return '${forced}' }
  $all = @()
  try { $all = @([System.Drawing.Printing.PrinterSettings]::InstalledPrinters) } catch {}
  $real = @($all | Where-Object { $_ -notmatch 'PDF|XPS|OneNote|Fax|Print to|Adobe|Snagit' })
  $pref = @($real | Where-Object { $_ -match 'XP|80|58|POS|Thermal|Receipt|TM-T|Caisse|Ticket|Star' })
  if ($pref.Count -gt 0) { return $pref[0] }
  if ($real.Count -eq 1) { return $real[0] }
  return $null
}
$script:DrawerPrinter = Resolve-Printer
function Invoke-Kick($id) {
  if (-not $script:DrawerPrinter) { Write-Output ("<<KICK $id NO_PRINTER>>"); return }
  try {
    $bytes = [byte[]](0x1B,0x70,0x00,0x19,0xFA)
    $h = [IntPtr]::Zero
    [RawPrint]::OpenPrinter($script:DrawerPrinter, [ref]$h, [IntPtr]::Zero) | Out-Null
    $doc = New-Object RawPrint+DOCINFO; $doc.pDocName='CashDrawer'; $doc.pDataType='RAW'
    [RawPrint]::StartDocPrinter($h,1,[ref]$doc) | Out-Null
    [RawPrint]::StartPagePrinter($h) | Out-Null
    $written=0; [RawPrint]::WritePrinter($h,$bytes,$bytes.Length,[ref]$written) | Out-Null
    [RawPrint]::EndPagePrinter($h) | Out-Null
    [RawPrint]::EndDocPrinter($h) | Out-Null
    [RawPrint]::ClosePrinter($h) | Out-Null
    Write-Output ("<<KICK $id OK:" + $script:DrawerPrinter + " bytes:" + $written + ">>")
  } catch {
    Write-Output ("<<KICK $id ERR:" + $_.Exception.Message + ">>")
  }
}
Write-Output '<<DRAWER_READY>>'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq 'EXIT') { break }
  if ($line -eq 'PRINTER') { Write-Output ("<<PRINTER " + $script:DrawerPrinter + ">>"); continue }
  if ($line.StartsWith('KICK')) {
    $parts = $line.Split(' ')
    $id = if ($parts.Length -gt 1) { $parts[1] } else { '0' }
    Invoke-Kick $id
  }
}`;
}

// PowerShell -EncodedCommand expects base64 of a UTF-16LE string. Passing the
// script this way (instead of on stdin) leaves the child's stdin free for the
// ReadLine command loop, and avoids all quoting/length limits.
function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function startDrawerService() {
  if (process.platform !== 'win32') return; // warm service is Windows-only
  if (drawerProc) return;                    // already running
  try {
    const encoded = encodePowerShell(buildDrawerServerScript());
    const proc = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    drawerProc = proc;
    drawerReady = false;
    drawerStdoutBuf = '';

    proc.stdout.on('data', (chunk) => {
      drawerStdoutBuf += chunk.toString();
      let idx;
      while ((idx = drawerStdoutBuf.indexOf('\n')) >= 0) {
        const line = drawerStdoutBuf.slice(0, idx).replace(/\r$/, '').trim();
        drawerStdoutBuf = drawerStdoutBuf.slice(idx + 1);
        if (!line) continue;
        if (line.indexOf('<<DRAWER_READY>>') >= 0) { drawerReady = true; continue; }
        const m = line.match(/<<KICK (\S+) (.*)>>/);
        if (m) {
          const pending = drawerPending.get(m[1]);
          if (pending) {
            drawerPending.delete(m[1]);
            clearTimeout(pending.timer);
            pending.resolve(m[2]);
          }
        }
      }
      if (drawerStdoutBuf.length > 20000) drawerStdoutBuf = drawerStdoutBuf.slice(-4000);
    });

    proc.on('error', () => { drawerReady = false; if (drawerProc === proc) drawerProc = null; });
    proc.on('exit', () => { drawerReady = false; if (drawerProc === proc) drawerProc = null; });
  } catch (e) {
    console.log('[CashDrawer] warm service spawn failed:', e.message);
    drawerReady = false;
    drawerProc = null;
  }
}

function stopDrawerService() {
  const proc = drawerProc;
  drawerProc = null;
  drawerReady = false;
  for (const [, p] of drawerPending) { try { clearTimeout(p.timer); } catch (e) {} }
  drawerPending.clear();
  if (proc) {
    try { if (proc.stdin && proc.stdin.writable) proc.stdin.write('EXIT\n'); } catch (e) {}
    try { proc.kill(); } catch (e) {}
  }
}

function restartDrawerService() {
  stopDrawerService();
  startDrawerService();
}

// Fire a kick through the warm service. Resolves with the raw payload string
// ("OK:..", "NO_PRINTER", "ERR:..") or rejects if the service is unusable.
function kickViaService(timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const proc = drawerProc;
    if (!proc || !drawerReady || !proc.stdin || !proc.stdin.writable) {
      reject(new Error('drawer-service-not-ready'));
      return;
    }
    const id = 'k' + (++drawerKickSeq);
    const timer = setTimeout(() => {
      if (drawerPending.has(id)) { drawerPending.delete(id); reject(new Error('drawer-service-timeout')); }
    }, timeoutMs);
    drawerPending.set(id, { resolve, timer });
    try {
      proc.stdin.write('KICK ' + id + '\n');
    } catch (e) {
      clearTimeout(timer);
      drawerPending.delete(id);
      reject(e);
    }
  });
}

// Original one-shot path (kept as the robust fallback): spawns a fresh
// PowerShell that compiles RawPrint and resolves the printer every time.
function kickViaOneShot() {
  return new Promise((resolve) => {
    try {
      const ps = [
        '-NoProfile', '-NonInteractive', '-Command',
        `Add-Type -TypeDefinition @'
${RAWPRINT_CS}
'@ -ErrorAction SilentlyContinue;
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue;
$forced = '${String(hwConfig().drawerPrinter || '').replace(/'/g, "''")}';
if ($forced.Length -gt 0) { $p = $forced } else {
  $all = @(); try { $all = @([System.Drawing.Printing.PrinterSettings]::InstalledPrinters) } catch {};
  $real = @($all | Where-Object { $_ -notmatch 'PDF|XPS|OneNote|Fax|Print to|Adobe|Snagit' });
  $pref = @($real | Where-Object { $_ -match 'XP|80|58|POS|Thermal|Receipt|TM-T|Caisse|Ticket|Star' });
  if ($pref.Count -gt 0) { $p = $pref[0] } elseif ($real.Count -eq 1) { $p = $real[0] } else { $p = $null }
};
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
Write-Host "OK:$p bytes:$written"`
      ];

      execFile('powershell', ps, { timeout: 12000, windowsHide: true }, (err, stdout) => {
        const ok = !err && stdout && stdout.includes('OK:');
        console.log('[CashDrawer:oneshot]', stdout?.trim() || err?.message);
        resolve({ ok, log: (stdout || (err && err.message) || '').trim() });
      });
    } catch (e) {
      console.error('[CashDrawer] Error:', e.message);
      resolve({ ok: false, error: e.message });
    }
  });
}

// A kick landing mid warm-up used to trigger a full one-shot: a SECOND
// PowerShell compiling the same C# alongside the one already compiling it.
// Waiting briefly for the service that is nearly ready is far cheaper.
// ── Deferred start-up work ────────────────────────────────────────────
// Only the DRAWER service is deferred, and only because it spawns a PowerShell
// process that JIT-compiles C#.
//
// SQLite is deliberately NOT deferred. The renderer awaits it at login
// (hydrateBusinessState reads today's sales to continue the ticket numbering),
// so every millisecond it starts late is a millisecond the cashier stares at a
// PIN pad that has already accepted the code. It used to be deferred here along
// with the drawer, which is why the first screen felt frozen for seconds. The
// original reason for deferring — a renderer busy parsing 1.9 MB of embedded
// logo — no longer exists now that the page is 254 KB.
let _bgStarted = false;
function startBackgroundServices() {
  if (_bgStarted) return;
  _bgStarted = true;
  setTimeout(startDrawerService, 250);
}
ipcMain.on('app-interactive', () => startBackgroundServices());

function waitForDrawerReady(ms) {
  return new Promise(resolve => {
    const t0 = Date.now();
    (function poll() {
      if (drawerReady) return resolve(true);
      if (Date.now() - t0 > ms) return resolve(false);
      setTimeout(poll, 40);
    })();
  });
}

// IPC contract UNCHANGED: resolves { ok, log }. Renderer/preload API unchanged.
ipcMain.handle('open-cash-drawer', async () => {
  const _t0 = Date.now();

  // Give the warming service a moment before paying for a one-shot compile.
  if (!drawerProc) startDrawerService();
  if (!drawerReady) await waitForDrawerReady(2000);

  // Fast path: warm, ready service → tens of ms, no recompile, no Get-Printer.
  if (drawerProc && drawerReady) {
    try {
      const payload = await kickViaService();
      if (payload && payload.indexOf('OK:') === 0) {
        console.log('[CashDrawer] warm kick ' + (Date.now() - _t0) + 'ms', payload);
        setTimeout(forceRecoverFocus, 300);
        return { ok: true, log: payload, ms: Date.now() - _t0 };
      }
      // NO_PRINTER / ERR from the warm service: the cached printer may be stale.
      // Re-resolve by respawning the service, and fall back one-shot for THIS kick.
      restartDrawerService();
      const res = await kickViaOneShot();
      setTimeout(forceRecoverFocus, 500);
      return { ...res, ms: Date.now() - _t0 };
    } catch (e) {
      // Timeout / write failure: respawn the service + fall back for this kick.
      console.log('[CashDrawer] warm kick failed, falling back:', e.message);
      restartDrawerService();
      const res = await kickViaOneShot();
      setTimeout(forceRecoverFocus, 500);
      return { ...res, ms: Date.now() - _t0 };
    }
  }

  // Cold path: the service never became ready within the wait above, so pay for
  // a one-shot rather than leave the drawer shut.
  const res = await kickViaOneShot();
  setTimeout(forceRecoverFocus, 500);
  console.log('[CashDrawer] one-shot ' + (Date.now() - _t0) + 'ms (service not ready)', res.log || '');
  return { ...res, ms: Date.now() - _t0 };
});


// ── CUSTOMER POLE DISPLAY (VFD, CD5220 protocol via serial port) ──────
// Pro POS software (Square, generic Windows POS) drives these generic VFD
// pole displays over a serial COM port using the CD5220 command set:
//   0x0C = clear display + home cursor (line 1 start)
//   0x0D = carriage return -> move to line 2 start
// We drive it via PowerShell's System.IO.Ports.SerialPort (.NET) instead of
// the native "serialport" npm module — that module needs a native addon
// rebuilt against Electron's ABI, which is fragile to package with
// electron-builder. This mirrors the same approach already used below for
// the cash drawer (raw Windows API via PowerShell), so no new native
// dependency or rebuild step is introduced.
// Faults this replaces, all of which left the display blank while reporting OK:
//  1. DtrEnable/RtsEnable were never set. .NET defaults both to false, and many
//     USB pole displays are powered or gated off those lines.
//  2. the port was closed 30ms after writing, with no Flush and no wait on
//     BytesToWrite, so at 9600 baud the bytes could be discarded unsent.
//  3. it printed 'OK' whenever no exception was thrown. Opening a COM port with
//     NOTHING attached succeeds — serial has no handshake — so OK never meant
//     the customer saw anything. It now reports SENT:n, which is only a claim
//     that the bytes left the port, and the UI asks a human to confirm.
//  4. a missing port produced a vague exception instead of a clear diagnosis.
//  5. text went out through .NET's default encoding, mangling accents. Bytes are
//     built here instead. NOTE: this client's display is a NUMERIC-ONLY 5-digit
//     VFD, so the renderer sends plain digits and the wire format below is kept
//     byte-identical to before (0x0C, line1, 0x0D, line2) on purpose.
function poleBytes(line1, line2) {
  const enc = s => {
    const out = [];
    for (const ch of String(s == null ? '' : s).slice(0, 20)) {
      const c = ch.codePointAt(0);
      out.push(c >= 0x20 && c <= 0x7E ? c : 0x20);
    }
    return out;
  };
  const b = [0x0C, ...enc(line1), 0x0D, ...enc(line2)];
  return b;
}

function poleWritePsArgs(port, baudRate, bytes) {
  const p = String(port).replace(/'/g, "''");
  return [
    '-NoProfile', '-NonInteractive', '-Command',
    `try {
  $names = [System.IO.Ports.SerialPort]::GetPortNames();
  if ($names -notcontains '${p}') { Write-Host 'ERR:PORT_ABSENT'; exit };
  $sp = New-Object System.IO.Ports.SerialPort '${p}', ${baudRate}, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One);
  $sp.DtrEnable = $true;
  $sp.RtsEnable = $true;
  $sp.WriteTimeout = 2000;
  $sp.Open();
  $b = [byte[]](${bytes.join(',')});
  $sp.Write($b, 0, $b.Length);
  $sp.BaseStream.Flush();
  $sw = [System.Diagnostics.Stopwatch]::StartNew();
  while ($sp.BytesToWrite -gt 0 -and $sw.ElapsedMilliseconds -lt 1500) { Start-Sleep -Milliseconds 5 };
  Start-Sleep -Milliseconds 60;
  $sp.Close();
  Write-Host ('SENT:' + $b.Length);
} catch {
  Write-Host ('ERR:' + $_.Exception.Message);
}`
  ];
}

ipcMain.handle('pole-list-ports', async () => {
  return new Promise((resolve) => {
    execFile('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      '[System.IO.Ports.SerialPort]::GetPortNames()'
    ], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const ports = (stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      resolve(ports);
    });
  });
});

ipcMain.handle('pole-write', async (_event, opts) => {
  const { port, baudRate, line1, line2 } = opts || {};
  const bytes = poleBytes(line1, line2);

  return new Promise((resolve) => {
    if (!port) { resolve({ ok: false, error: 'Aucun port COM configuré' }); return; }
    const t0 = Date.now();
    execFile('powershell', poleWritePsArgs(port, baudRate || 9600, bytes),
      { timeout: 8000, windowsHide: true }, (err, stdout) => {
        const out = (stdout || '').trim();
        // 'SENT' means the bytes left the port. It does NOT prove the customer
        // saw them — no cheap VFD can be read back.
        const sent = !err && out.startsWith('SENT:');
        if (!sent) console.log('[PoleDisplay]', out || err?.message);
        // Same fix as print/cash-drawer: spawning a PowerShell process steals
        // Chromium's internal keyboard focus. Recover it every time, since
        // pole writes happen frequently (on every cart/total change).
        forceRecoverFocus();
        resolve({ ok: sent, log: out, transmitted: sent });
      });
  });
});

// ── SESSION HANDLERS ──────────────────────────────────
ipcMain.handle('db-save-session', async (_event, session) => {
  try { return await saveSession(userDataPath(), session); }
  catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('db-close-session', async (_event, id, data) => {
  try { return await closeSession(userDataPath(), id, data); }
  catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('db-get-sessions', async () => {
  try { return await getSessions(userDataPath()); }
  catch(e) { return []; }
});

app.whenReady().then(() => {
  // ── Startup order matters ────────────────────────────────────────────
  // Everything below used to run BEFORE createWindow(), on the main process,
  // synchronously. Between reading the whole index.html, compiling the sql.js
  // WASM module and compiling the drawer service's PowerShell, first paint was
  // delayed by seconds. The window is created first now, and the heavy work is
  // either bounded or deferred until after the UI is on screen.

  // Resolve the syncKey to isolate the database per client. This MUST run before
  // getDatabaseReady() below, since database.js reads global.__servioSyncKey to
  // pick the SQLite filename. Cached full read — see readBuiltInSyncKey().
  {
    const key = readBuiltInSyncKey();
    if (key) global.__servioSyncKey = key;
  }

  // Start compiling the sql.js WASM module NOW, in parallel with the window.
  // The renderer blocks on this at login, so it must be as far ahead as possible;
  // by the time a human has picked a user and typed four digits it is long done.
  getDatabaseReady(userDataPath()).catch(error => console.error('SQLite startup init failed:', error));

  // Window second, so the renderer can start parsing and painting immediately.
  createWindow();

  // ── FOCUS RECOVERY (Electron keyboard fix) ──────────────────────────
  // Problem: After printing, cash drawer, or child windows, Electron loses
  // internal Chromium focus. Inputs stop receiving keyboard events.
  // Solution: Periodically check if focus is stuck, but NEVER steal focus
  // from an active input/textarea — that causes the "type one letter and lose focus" bug.

  // 1) After print/cash drawer — handled where printWin is created

  // 2) Watchdog: detect the stale-focus state and heal it BEFORE the cashier
  // notices. The condition is "the OS says we are the foreground window, but
  // Chromium says the document has no focus" — that mismatch is the bug, and
  // document.hasFocus() is the only reliable way to observe it from here.
  // Note we deliberately do NOT check whether an input is focused: in the
  // broken state an input often IS focused (it shows a ring) yet still cannot
  // receive keystrokes. The old check skipped repair in exactly that case.
  setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isFocused()) return;
    mainWindow.webContents.executeJavaScript('document.hasFocus()')
      .then(hasFocus => {
        if (!hasFocus && mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {
          forceRecoverFocus();
        }
      })
      .catch(() => {});
  }, 1000);

  // 3) When the window regains OS focus, force a real content-focus transition.
  // webContents.focus() alone can no-op here, so route through the recovery
  // helper which guarantees a transition.
  mainWindow.on('focus', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    setTimeout(() => forceRecoverFocus(), 150);
  });

  // 4) IPC channel for renderer to request focus recovery on-demand
  ipcMain.on('request-focus-recovery', () => {
    forceRecoverFocus();
  });

  // OTA: check for updates 10 seconds after startup (non-blocking)
  setTimeout(() => {
    // Identity comes from the BUNDLED index.html, never from the loaded one.
    // resolveClientIndex() can return the OTA cache, so reading the key back out
    // of it lets a bad cache point this terminal at another client's update
    // channel and keep it there. The bundle is immutable and always right.
    try {
      const indexContent = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
      const syncUrlMatch = indexContent.match(/syncUrl:\s*'([^']+)'/);
      const syncKey = readBuiltInSyncKey();
      if (syncUrlMatch && syncKey) {
        initOtaPaths(syncKey);
        checkForUpdate(syncUrlMatch[1], syncKey);
      }
    } catch (e) {
      console.log('[OTA] Could not read config:', e.message);
    }
  }, 10000);
});

app.on('window-all-closed', () => {
  closeDatabase();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  stopDrawerService();
  closeDatabase();
});
