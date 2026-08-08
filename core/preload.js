const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  printReceipt:   (html, zone)  => ipcRenderer.send('print-receipt', html, zone),
  // A ticket that silently never reached the printer used to be visible only
  // in a console nobody's watching — no different from it just not existing.
  // This is the till's own signal that one just failed, so the renderer can
  // put something in front of a human instead.
  onPrintFailed:  (cb)          => ipcRenderer.on('print-failed', (_e, info) => cb(info)),
  listPrinters:   ()            => ipcRenderer.invoke('list-printers'),
  getHwConfig:    ()            => ipcRenderer.invoke('hw-get-config'),
  saveHwConfig:   (partial)     => ipcRenderer.invoke('hw-save-config', partial),
  onTriggerPrint: (cb)          => ipcRenderer.on('trigger-print', cb),
  getSales:       ()            => ipcRenderer.invoke('db-get-sales'),
  saveSale:       (sale)        => ipcRenderer.invoke('db-save-sale', sale),
  voidSale:       (id, reason, voidedBy) => ipcRenderer.invoke('db-void-sale', id, reason, voidedBy),
  getDbStatus:    ()            => ipcRenderer.invoke('db-get-status'),
  openCashDrawer: ()            => ipcRenderer.invoke('open-cash-drawer'),
  saveSession:    (session)     => ipcRenderer.invoke('db-save-session', session),
  closeSession:   (id, data)    => ipcRenderer.invoke('db-close-session', id, data),
  getSessions:    ()            => ipcRenderer.invoke('db-get-sessions'),
  requestFocusRecovery: ()      => ipcRenderer.send('request-focus-recovery'),
  poleListPorts:  ()            => ipcRenderer.invoke('pole-list-ports'),
  poleWrite:      (opts)        => ipcRenderer.invoke('pole-write', opts),
  // A cashier just logged in. Lets the main process warm the cash drawer while
  // they browse the menu, instead of during start-up where the PowerShell
  // compile collided with the UI settling and looked like a freeze.
  signalLoggedIn: ()            => ipcRenderer.send('app-logged-in'),
  // Renderer tells the main process the UI is interactive, so heavy native work
  // (sql.js WASM compile, drawer PowerShell warm-up) starts AFTER first paint
  // instead of competing with it and making the first screen unclickable.
  signalInteractive: ()         => ipcRenderer.send('app-interactive'),

  // ── Waiter hub (LAN tablets) ────────────────────────────────────────
  // The till serves a waiter app to tablets on the shop Wi-Fi. The renderer
  // owns the menu and the table plan, so it pushes a snapshot and answers the
  // orders the hub forwards to it.
  hubState:       ()            => ipcRenderer.invoke('hub-state'),
  hubSetEnabled:  (on)          => ipcRenderer.invoke('hub-set-enabled', on),
  hubSetPort:     (port)        => ipcRenderer.invoke('hub-set-port', port),
  hubRegenPin:    ()            => ipcRenderer.invoke('hub-regen-pin'),
  hubRevoke:      (deviceId)    => ipcRenderer.invoke('hub-revoke', deviceId),
  hubSnapshot:    (snap)        => ipcRenderer.send('hub-snapshot', snap),
  hubOrderResult: (uid, result) => ipcRenderer.send('hub-order-result', uid, result),
  onHubOrder:     (cb)          => ipcRenderer.on('hub-order',  (_e, order) => cb(order)),
  onHubStatus:    (cb)          => ipcRenderer.on('hub-status',  (_e, state) => cb(state)),
});
