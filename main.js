const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const {
  closeDatabase,
  getDatabaseReady,
  getDatabaseStatus,
  getSales,
  saveSale,
} = require('./database');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    title: 'Dolphino POS — Caisse',
    backgroundColor: '#0A0704',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    titleBarStyle: process.platform === 'win32' ? 'default' : 'hiddenInset',
    show: false,
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  if (process.platform === 'win32') {
    mainWindow.maximize();
  }

  const template = [
    {
      label: '🐬 Dolphino',
      submenu: [
        { label: 'À propos', click: () => {
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Dolphino POS',
            message: 'Dolphino POS v1.0.0',
            detail: 'Système de caisse — Restaurant & Fast Food\nDéveloppé pour Dolphino Tunisie',
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
        { type: 'separator' },
        { label: 'Recharger', role: 'reload', accelerator: 'CmdOrCtrl+R' },
        { label: 'DevTools', role: 'toggleDevTools', accelerator: 'F12' },
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
  const printWin = new BrowserWindow({
    width: 400,
    height: 600,
    show: false,
    webPreferences: { nodeIntegration: false },
  });
  printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent));
  printWin.webContents.once('did-finish-load', () => {
    printWin.webContents.print(
      { silent: true, printBackground: true, margins: { marginType: 'printableArea' } },
      (success, errorType) => {
        if (!success) console.error('Print failed:', errorType);
        printWin.close();
      }
    );
  });
});

// ── CASH DRAWER (XP-80T via RJ11 cable) ───────────────────────────────
// Uses Windows WritePrinter API via PowerShell — no printer sharing needed
ipcMain.handle('open-cash-drawer', async () => {
  return new Promise((resolve) => {
    try {
      const ps = [
        '-NoProfile', '-NonInteractive', '-Command',
        // Find XP-80T or first available printer, send ESC p pulse via WritePrinter
        `Add-Type -TypeDefinition @'
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
$bytes = [byte[]](0x1B,0x70,0x00,0x32,0xFA);
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

      execFile('powershell', ps, { timeout: 8000 }, (err, stdout) => {
        const ok = !err && stdout && stdout.includes('OK:');
        console.log('[CashDrawer]', stdout?.trim() || err?.message);
        resolve({ ok, log: stdout?.trim() });
      });
    } catch (e) {
      console.error('[CashDrawer] Error:', e.message);
      resolve({ ok: false, error: e.message });
    }
  });
});


app.whenReady().then(() => {
  getDatabaseReady(userDataPath()).catch(error => console.error('SQLite startup init failed:', error));
  createWindow();
});

app.on('window-all-closed', () => {
  closeDatabase();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  closeDatabase();
});
