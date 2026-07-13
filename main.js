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
      { silent: false, printBackground: true, margins: { marginType: 'printableArea' } },
      (success, errorType) => {
        if (!success) console.error('Print failed:', errorType);
        printWin.close();
      }
    );
  });
});

// ── CASH DRAWER (XP-80T via RJ11 cable) ───────────────────────────────
// Sends ESC p pulse bytes directly to the default printer via Windows raw print
ipcMain.handle('open-cash-drawer', async () => {
  return new Promise((resolve) => {
    try {
      // ESC p 0 50 250 — standard cash drawer pulse for XP-80T
      const bytes = Buffer.from([0x1B, 0x70, 0x00, 0x32, 0xFA]);
      const tmpFile = path.join(os.tmpdir(), 'dolphino_drawer.bin');
      fs.writeFileSync(tmpFile, bytes);

      // Use PowerShell to get the first available printer and send raw bytes
      const ps = [
        '-NoProfile', '-NonInteractive', '-Command',
        // Get first printer name (XP-80T or any USB/POS printer first)
        `$p = (Get-Printer | Sort-Object {$_.Name -match 'XP|80|POS|Thermal|printer'} -Descending | Select-Object -First 1).Name;` +
        `if ($p) { cmd /c "copy /b \\"${tmpFile.replace(/\\/g, '\\\\')}\\" \\"\\\\\\\\localhost\\\\$p\\" > nul 2>&1"; Write-Host "OK: $p" } else { Write-Host "NO_PRINTER" }`
      ];

      execFile('powershell', ps, { timeout: 6000 }, (err, stdout) => {
        const ok = !err && stdout && !stdout.includes('NO_PRINTER');
        console.log('[CashDrawer]', stdout?.trim() || err?.message);
        resolve({ ok, log: stdout?.trim() });
      });
    } catch (e) {
      console.error('[CashDrawer] Error:', e.message);
      resolve({ ok: false, error: e.message });
    }
  });
});

    } catch (e) {
      console.error('Cash drawer error:', e);
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
