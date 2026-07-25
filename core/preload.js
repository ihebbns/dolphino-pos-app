const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  printReceipt:   (html)        => ipcRenderer.send('print-receipt', html),
  onTriggerPrint: (cb)          => ipcRenderer.on('trigger-print', cb),
  getSales:       ()            => ipcRenderer.invoke('db-get-sales'),
  saveSale:       (sale)        => ipcRenderer.invoke('db-save-sale', sale),
  getDbStatus:    ()            => ipcRenderer.invoke('db-get-status'),
  openCashDrawer: ()            => ipcRenderer.invoke('open-cash-drawer'),
  saveSession:    (session)     => ipcRenderer.invoke('db-save-session', session),
  closeSession:   (id, data)    => ipcRenderer.invoke('db-close-session', id, data),
  getSessions:    ()            => ipcRenderer.invoke('db-get-sessions'),
  requestFocusRecovery: ()      => ipcRenderer.send('request-focus-recovery'),
  poleListPorts:  ()            => ipcRenderer.invoke('pole-list-ports'),
  poleWrite:      (opts)        => ipcRenderer.invoke('pole-write', opts),
  // Renderer tells the main process the UI is interactive, so heavy native work
  // (sql.js WASM compile, drawer PowerShell warm-up) starts AFTER first paint
  // instead of competing with it and making the first screen unclickable.
  signalInteractive: ()         => ipcRenderer.send('app-interactive'),
});
