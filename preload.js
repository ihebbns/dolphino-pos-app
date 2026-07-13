const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  printReceipt: (htmlContent) => ipcRenderer.send('print-receipt', htmlContent),
  onTriggerPrint: (callback) => ipcRenderer.on('trigger-print', callback),
  getSales: () => ipcRenderer.invoke('db-get-sales'),
  saveSale: (sale) => ipcRenderer.invoke('db-save-sale', sale),
  getDbStatus: () => ipcRenderer.invoke('db-get-status'),
  openCashDrawer: () => ipcRenderer.invoke('open-cash-drawer'),
});
