// ═══════════════════════════════════════════════════════════════════════
//  WAITER HUB — the counter till acts as the local server for tablets
// ═══════════════════════════════════════════════════════════════════════
//
// WHY LAN AND NOT THE CLOUD: a waiter's order has to reach the bar within a
// second, and it has to keep working when the café's internet drops — which in
// practice it does. Toast solves this with a "local hub device" on the shop
// network and keeps kitchen printing alive through cloud outages; we do the
// same thing with the counter EXE, which is already the source of truth for
// what happened (ARCHITECTURE.md §1). servio.tn stays a reporting channel.
//
// WHY THE COUNTER PRINTS AND NOT THE TABLET: printing lives in the main
// process behind the print-receipt IPC and targets a Windows printer. Keeping
// the counter as the only printing device means the tablet needs no printer
// driver, no IP, no pairing with hardware — nothing for the owner to configure.
//
// TRUST MODEL: the server binds to the LAN, so anyone on the café Wi-Fi can
// reach the port. Therefore:
//   • it never listens unless the owner switched it on,
//   • a device must pair with a 6-digit code shown on the counter screen,
//   • pairing attempts are rate limited per IP so the code cannot be guessed,
//   • each device gets its own revocable bearer token,
//   • the tablet NEVER sends prices. It sends item ids and quantities, and the
//     till resolves the price from its own menu. Price is EXE-owned
//     (ARCHITECTURE.md §2) and a tablet is not allowed to invent one.
//
// TRANSPORT: plain HTTP + Server-Sent Events. No WebSocket, because SSE needs
// no handshake code, no framing, no dependency, and reconnects on its own —
// and the traffic here is one-way push plus small POSTs.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HUB_FILE = 'hub.json';
const ORDER_TIMEOUT_MS = 15000;
const PAIR_WINDOW_MS = 60000;
const PAIR_MAX_TRIES = 6;
const SSE_PING_MS = 25000;

let dataDir = '';
let cfg = null;
let server = null;
let listening = false;
let lastError = '';
let snapshot = null;                 // menu + tables, pushed by the renderer
const sseClients = new Set();
const pendingOrders = new Map();     // uid -> { resolve, timer }
const pairTries = new Map();         // ip -> { n, resetAt }

// Injected by main.js so the hub never imports electron.
let deliverOrder = null;             // (order) => void   — hand an order to the renderer
let notifyStatus = null;             // (state) => void   — tell the renderer what changed

// ── config ────────────────────────────────────────────────────────────
function genPin() { return String(crypto.randomInt(100000, 1000000)); }
function genToken() { return crypto.randomBytes(24).toString('hex'); }
function cfgPath() { return path.join(dataDir, HUB_FILE); }

function defaults() {
  return { enabled: false, port: 8420, pin: genPin(), devices: [] };
}
function loadCfg() {
  cfg = defaults();
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    if (raw && typeof raw === 'object') {
      cfg.enabled = !!raw.enabled;
      cfg.port = Number(raw.port) > 0 ? Number(raw.port) : cfg.port;
      cfg.pin = /^\d{6}$/.test(raw.pin) ? raw.pin : cfg.pin;
      cfg.devices = Array.isArray(raw.devices) ? raw.devices : [];
    }
  } catch (e) { /* first run */ }
  return cfg;
}
function saveCfg() {
  try { fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2), 'utf8'); }
  catch (e) { console.error('[Hub] cannot save hub.json:', e.message); }
}

// ── network ───────────────────────────────────────────────────────────
// The owner must never type an IP. We show the address; the installer opens it
// once on the tablet and adds it to the home screen.
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (/^169\.254\./.test(ni.address)) continue;      // link-local: not routable
      out.push({ iface: name, ip: ni.address });
    }
  }
  // Prefer a private range — a café router always hands out one of these.
  out.sort((a, b) => privateRank(a.ip) - privateRank(b.ip));
  return out;
}
function privateRank(ip) {
  if (/^192\.168\./.test(ip)) return 0;
  if (/^10\./.test(ip)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 9;
}

function publicState() {
  const addrs = lanAddresses();
  return {
    enabled: !!cfg.enabled,
    listening,
    port: cfg.port,
    pin: cfg.pin,
    error: lastError,
    addresses: addrs,
    url: addrs.length ? `http://${addrs[0].ip}:${cfg.port}` : '',
    devices: cfg.devices.map(d => ({
      id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen || 0,
      online: [...sseClients].some(c => c.deviceId === d.id),
    })),
  };
}
function pushStatus() { if (notifyStatus) { try { notifyStatus(publicState()); } catch (e) {} } }

// ── lifecycle ─────────────────────────────────────────────────────────
function init(opts) {
  dataDir = opts.dataDir;
  deliverOrder = opts.deliverOrder;
  notifyStatus = opts.notifyStatus;
  loadCfg();
  if (cfg.enabled) start();
  return publicState();
}

function start() {
  if (server) return publicState();
  lastError = '';
  server = http.createServer(handle);
  server.on('error', err => {
    lastError = err.code === 'EADDRINUSE'
      ? `Le port ${cfg.port} est déjà utilisé sur ce PC`
      : err.message;
    listening = false;
    try { server.close(); } catch (e) {}
    server = null;
    console.error('[Hub]', lastError);
    pushStatus();
  });
  // 0.0.0.0 is required: a tablet cannot reach 127.0.0.1. That is exactly why
  // pairing and per-device tokens above are not optional.
  server.listen(cfg.port, '0.0.0.0', () => {
    listening = true;
    console.log('[Hub] listening on ' + (publicState().url || ':' + cfg.port));
    pushStatus();
  });
  return publicState();
}

function stop() {
  for (const c of [...sseClients]) { try { c.res.end(); } catch (e) {} }
  sseClients.clear();
  if (server) { try { server.close(); } catch (e) {} }
  server = null;
  listening = false;
  pushStatus();
  return publicState();
}

function setEnabled(on) {
  cfg.enabled = !!on;
  saveCfg();
  return cfg.enabled ? start() : stop();
}
function setPort(port) {
  const p = Number(port);
  if (!(p > 1023 && p < 65536)) return publicState();
  cfg.port = p; saveCfg();
  if (cfg.enabled) { stop(); start(); }
  return publicState();
}
function regenPin() { cfg.pin = genPin(); saveCfg(); pushStatus(); return publicState(); }
function revokeDevice(id) {
  cfg.devices = cfg.devices.filter(d => d.id !== id);
  saveCfg();
  for (const c of [...sseClients]) if (c.deviceId === id) { try { c.res.end(); } catch (e) {} sseClients.delete(c); }
  pushStatus();
  return publicState();
}

// ── snapshot & broadcast ──────────────────────────────────────────────
// The renderer owns the menu and the table plan (localStorage), so it pushes a
// snapshot whenever they change and the hub just serves the last one it saw.
function setSnapshot(s) {
  snapshot = s || null;
  broadcast('snapshot', { rev: snapshot && snapshot.rev });
}
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
  for (const c of [...sseClients]) {
    try { c.res.write(frame); } catch (e) { sseClients.delete(c); }
  }
}

// ── order round-trip ──────────────────────────────────────────────────
// The renderer validates, prices, merges into the table and prints. The HTTP
// response waits for its verdict so the waiter sees a real confirmation and
// never a hopeful "sent" that vanished.
function resolveOrder(uid, result) {
  const p = pendingOrders.get(uid);
  if (!p) return;
  clearTimeout(p.timer);
  pendingOrders.delete(uid);
  p.resolve(result || { ok: false, error: 'Réponse vide de la caisse' });
}

function submitOrder(order) {
  return new Promise(resolve => {
    if (!deliverOrder) { resolve({ ok: false, error: 'Caisse indisponible' }); return; }
    const timer = setTimeout(() => {
      pendingOrders.delete(order.uid);
      resolve({ ok: false, error: "La caisse n'a pas répondu. Réessayez." });
    }, ORDER_TIMEOUT_MS);
    pendingOrders.set(order.uid, { resolve, timer });
    try { deliverOrder(order); }
    catch (e) {
      clearTimeout(timer);
      pendingOrders.delete(order.uid);
      resolve({ ok: false, error: 'Caisse indisponible' });
    }
  });
}

// ── HTTP ──────────────────────────────────────────────────────────────
function send(res, code, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
}
function sendJson(res, code, obj) { send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8'); }

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function bearer(req, url) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (m) return m[1];
  // EventSource cannot set headers, so the SSE endpoint accepts ?t= instead.
  return url.searchParams.get('t') || '';
}
function deviceFor(req, url) {
  const tok = bearer(req, url);
  if (!tok) return null;
  const d = cfg.devices.find(x => x.token === tok);
  if (d) { d.lastSeen = Date.now(); }
  return d || null;
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > (limit || 64 * 1024)) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function pairAllowed(ip) {
  const now = Date.now();
  const rec = pairTries.get(ip);
  if (!rec || now > rec.resetAt) { pairTries.set(ip, { n: 1, resetAt: now + PAIR_WINDOW_MS }); return true; }
  rec.n++;
  return rec.n <= PAIR_MAX_TRIES;
}

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://hub'); }
  catch (e) { send(res, 400, 'Bad request'); return; }
  const p = url.pathname;

  try {
    // ── static: the waiter app ──
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const file = path.join(__dirname, 'waiter.html');
      let html;
      try { html = fs.readFileSync(file, 'utf8'); }
      catch (e) { send(res, 500, 'waiter.html manquant dans le build'); return; }
      send(res, 200, html, 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && p === '/manifest.webmanifest') {
      sendJson(res, 200, {
        name: 'Servio Serveur', short_name: 'Serveur', start_url: '/', display: 'standalone',
        background_color: '#12100e', theme_color: '#12100e', orientation: 'portrait',
      });
      return;
    }

    // ── pairing: the only unauthenticated write ──
    if (req.method === 'POST' && p === '/api/pair') {
      const ip = clientIp(req);
      if (!pairAllowed(ip)) { sendJson(res, 429, { ok: false, error: 'Trop de tentatives. Attendez une minute.' }); return; }
      let body = {};
      try { body = JSON.parse(await readBody(req, 4096) || '{}'); } catch (e) {}
      const pin = String(body.pin || '').trim();
      const name = String(body.name || '').trim().slice(0, 40) || 'Tablette';
      // Constant-time compare so response timing cannot leak the code.
      const a = Buffer.from(pin.padEnd(6, ' ').slice(0, 6));
      const b = Buffer.from(String(cfg.pin).padEnd(6, ' ').slice(0, 6));
      if (!crypto.timingSafeEqual(a, b)) { sendJson(res, 403, { ok: false, error: 'Code incorrect' }); return; }
      const device = { id: crypto.randomBytes(8).toString('hex'), name, token: genToken(), pairedAt: Date.now(), lastSeen: Date.now() };
      cfg.devices.push(device);
      saveCfg();
      pushStatus();
      sendJson(res, 200, { ok: true, token: device.token, deviceId: device.id, name: device.name });
      return;
    }

    // ── everything below needs a paired device ──
    const dev = deviceFor(req, url);
    if (!dev) { sendJson(res, 401, { ok: false, error: 'unpaired' }); return; }

    if (req.method === 'GET' && p === '/api/bootstrap') {
      if (!snapshot) { sendJson(res, 503, { ok: false, error: "La caisse n'est pas prête" }); return; }
      sendJson(res, 200, { ok: true, device: { id: dev.id, name: dev.name }, ...snapshot });
      return;
    }

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const entry = { res, deviceId: dev.id };
      sseClients.add(entry);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, SSE_PING_MS);
      req.on('close', () => { clearInterval(ping); sseClients.delete(entry); pushStatus(); });
      pushStatus();
      return;
    }

    if (req.method === 'POST' && p === '/api/order') {
      let body = {};
      try { body = JSON.parse(await readBody(req, 128 * 1024) || '{}'); }
      catch (e) { sendJson(res, 400, { ok: false, error: 'Requête invalide' }); return; }
      const lines = Array.isArray(body.items) ? body.items : [];
      if (!lines.length) { sendJson(res, 400, { ok: false, error: 'Commande vide' }); return; }
      // Only ids, quantities and notes cross the wire. No prices, ever.
      const order = {
        uid: /^[a-zA-Z0-9_-]{6,64}$/.test(String(body.uid || '')) ? String(body.uid) : crypto.randomBytes(8).toString('hex'),
        tableId: Number(body.tableId),
        deviceId: dev.id,
        waiter: dev.name,
        clientTs: Date.now(),
        items: lines.slice(0, 200).map(l => ({
          id: String(l.id || '').slice(0, 64),
          variant: String(l.variant || '').slice(0, 32),
          qty: Math.max(1, Math.min(99, parseInt(l.qty, 10) || 1)),
          note: String(l.note || '').slice(0, 120),
        })).filter(l => l.id),
      };
      if (!order.items.length) { sendJson(res, 400, { ok: false, error: 'Commande vide' }); return; }
      const result = await submitOrder(order);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error('[Hub] request failed:', e && e.message);
    try { sendJson(res, 500, { ok: false, error: 'Erreur interne' }); } catch (_) {}
  }
}

module.exports = {
  init, start, stop, setEnabled, setPort, regenPin, revokeDevice,
  setSnapshot, broadcast, resolveOrder, publicState, lanAddresses,
};
