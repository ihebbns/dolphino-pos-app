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

// ── Resolve client index.html ─────────────────────────────────────────
function resolveClientIndex() {
  // First, read the syncKey from the BUILT-IN index.html to init OTA paths per client
  const builtInIndex = path.join(__dirname, '..', 'index.html');
  try {
    const content = fs.readFileSync(builtInIndex, 'utf8');
    const keyMatch = content.match(/syncKey:\s*'([^']+)'/);
    if (keyMatch) initOtaPaths(keyMatch[1]);
  } catch (e) {}

  // Priority 1: OTA updated version for THIS client (keyed by syncKey)
  const updated = getUpdatedIndex();
  if (updated) return updated;

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
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.focus();
  });

  // (Focus recovery on window activation is registered further down, in the
  // FOCUS RECOVERY section, so all focus handling lives in one place.)

  if (process.platform === 'win32') {
    mainWindow.maximize();
  }

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

  printWin.loadFile(tmpFile);

  printWin.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      printWin.webContents.print(
        {
          silent: true,
          printBackground: false,
          margins: { marginType: 'none' },
          pageSize: { width: 80000, height: 297000 }, // 80mm wide, auto height in microns
        },
        (success, errorType) => {
          if (!success) console.error('Print failed:', errorType);
          setTimeout(() => {
            printWin.close();
            try { fs.unlinkSync(tmpFile); } catch(e) {}
            // Recover keyboard focus immediately + a couple of retries so the
            // cashier never notices (was ~800ms before → felt like a freeze).
            forceRecoverFocus();
            setTimeout(forceRecoverFocus, 100);
            setTimeout(forceRecoverFocus, 350);
          }, 200);
        }
      );
    }, 600);
  });
});

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
  return `$ErrorActionPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
${RAWPRINT_CS}
'@ -ErrorAction SilentlyContinue
$script:DrawerPrinter = (Get-Printer | Where-Object {$_.Name -match 'XP|80|POS|Thermal'} | Select-Object -First 1).Name
if (-not $script:DrawerPrinter) { $script:DrawerPrinter = (Get-Printer | Select-Object -First 1).Name }
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

// IPC contract UNCHANGED: resolves { ok, log }. Renderer/preload API unchanged.
ipcMain.handle('open-cash-drawer', async () => {
  // Fast path: warm, ready service → tens of ms, no recompile, no Get-Printer.
  if (drawerProc && drawerReady) {
    try {
      const payload = await kickViaService();
      if (payload && payload.indexOf('OK:') === 0) {
        setTimeout(forceRecoverFocus, 300);
        return { ok: true, log: payload };
      }
      // NO_PRINTER / ERR from the warm service: the cached printer may be stale.
      // Re-resolve by respawning the service, and fall back one-shot for THIS kick.
      restartDrawerService();
      const res = await kickViaOneShot();
      setTimeout(forceRecoverFocus, 500);
      return res;
    } catch (e) {
      // Timeout / write failure: respawn the service + fall back for this kick.
      console.log('[CashDrawer] warm kick failed, falling back:', e.message);
      restartDrawerService();
      const res = await kickViaOneShot();
      setTimeout(forceRecoverFocus, 500);
      return res;
    }
  }

  // Cold path (service not spawned yet, or still warming up): one-shot now, and
  // warm the service so subsequent kicks are instant.
  if (!drawerProc) startDrawerService();
  const res = await kickViaOneShot();
  setTimeout(forceRecoverFocus, 500);
  return res;
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
function escPs1SingleQuoted(s) {
  return String(s == null ? '' : s).replace(/'/g, "''");
}

function poleDisplayPsArgs(port, baudRate, line1, line2) {
  const l1 = escPs1SingleQuoted(String(line1 || '').slice(0, 20));
  const l2 = escPs1SingleQuoted(String(line2 || '').slice(0, 20));
  const p = escPs1SingleQuoted(port);
  return [
    '-NoProfile', '-NonInteractive', '-Command',
    `try {
  $sp = New-Object System.IO.Ports.SerialPort '${p}', ${baudRate}, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One);
  $sp.Open();
  $clr = [byte[]](0x0C);
  $sp.Write($clr, 0, 1);
  Start-Sleep -Milliseconds 30;
  $l1 = '${l1}';
  if ($l1.Length -gt 0) { $sp.Write($l1); }
  $cr = [byte[]](0x0D);
  $sp.Write($cr, 0, 1);
  $l2 = '${l2}';
  if ($l2.Length -gt 0) { $sp.Write($l2); }
  Start-Sleep -Milliseconds 30;
  $sp.Close();
  Write-Host 'OK';
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
  return new Promise((resolve) => {
    if (!port) { resolve({ ok: false, error: 'Aucun port COM configuré' }); return; }
    const args = poleDisplayPsArgs(port, baudRate || 9600, line1, line2);
    execFile('powershell', args, { timeout: 8000, windowsHide: true }, (err, stdout) => {
      const out = (stdout || '').trim();
      const ok = !err && out.startsWith('OK');
      if (!ok) console.log('[PoleDisplay]', out || err?.message);
      // Same fix as print/cash-drawer: spawning a PowerShell process steals
      // Chromium's internal keyboard focus. Recover it every time, since
      // pole writes happen frequently (on every cart/total change).
      forceRecoverFocus();
      resolve({ ok, log: out });
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
  // Read syncKey from built-in index.html to isolate database per client
  try {
    const builtInIndex = path.join(__dirname, '..', 'index.html');
    const content = fs.readFileSync(builtInIndex, 'utf8');
    const keyMatch = content.match(/syncKey:\s*'([^']+)'/);
    if (keyMatch) global.__servioSyncKey = keyMatch[1];
  } catch(e) {}

  getDatabaseReady(userDataPath()).catch(error => console.error('SQLite startup init failed:', error));
  createWindow();

  // Warm the persistent cash-drawer service so the FIRST Encaisser tap after
  // the initial ~1-3s compile is instant. Non-blocking; the one-shot fallback
  // covers any kick that arrives before this finishes warming up.
  startDrawerService();

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
    // Read syncUrl and syncKey from the loaded index.html
    try {
      const indexPath = resolveClientIndex();
      const indexContent = fs.readFileSync(indexPath, 'utf8');
      const syncUrlMatch = indexContent.match(/syncUrl:\s*'([^']+)'/);
      const syncKeyMatch = indexContent.match(/syncKey:\s*'([^']+)'/);
      if (syncUrlMatch && syncKeyMatch) {
        initOtaPaths(syncKeyMatch[1]);
        checkForUpdate(syncUrlMatch[1], syncKeyMatch[1]);
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
