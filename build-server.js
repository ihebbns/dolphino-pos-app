/**
 * ╔══════════════════════════════════════════════════════╗
 * ║   SERVIO OS — Local Build Server                     ║
 * ║   Runs on your dev machine to build client EXEs      ║
 * ║   Usage: node build-server.js                        ║
 * ║   Listens on http://localhost:4500                    ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * POST /build
 *   Body: { name, city, logo, logoLetter, tagline, phone, currency,
 *           syncKey, managerName, managerPin, cashierName, cashierPin,
 *           menu (optional), zone1Cats, zone2Cats, boissonCats }
 *   Returns: { ok, exePath, safeName } or { ok:false, error }
 *
 * GET /status
 *   Returns: { building, queue, lastBuild }
 *
 * GET /clients
 *   Returns: { clients: [...folder names in clients/] }
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT        = 4500;
const POS_DIR     = __dirname;
const CLIENTS_DIR = path.join(POS_DIR, 'clients');
const CORE_DIR    = path.join(POS_DIR, 'core');
const PKG_JSON    = path.join(POS_DIR, 'package.json');
const TEMPLATE    = path.join(CLIENTS_DIR, 'dolphino', 'index.html');
const TEMPLATE_CAFE = path.join(CLIENTS_DIR, 'dolphino', 'index-cafe.html');

let building   = false;
let lastBuild  = null;
let buildQueue = [];

// ── Helpers ───────────────────────────────────────────
function safeFilename(name) {
  return name.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_').slice(0, 30);
}

function replaceField(html, fieldName, newValue) {
  const re = new RegExp(`(${fieldName}:\\s*')[^']*(')`);
  return html.replace(re, `$1${newValue}$2`);
}

function replaceArrayField(html, fieldName, arr) {
  const re = new RegExp(`(${fieldName}:\\s*)\\[[^\\]]*\\]`);
  return html.replace(re, `$1${JSON.stringify(arr)}`);
}

function replaceMenu(html, menuObj) {
  // Replace the let MENU={...}; block
  const menuStr = JSON.stringify(menuObj, null, 2);
  // Match from "let MENU={" to the closing "};" before CAT_ICONS
  const re = /let MENU=\{[\s\S]*?\n\};/;
  return html.replace(re, `let MENU=${menuStr};`);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function jsonResponse(res, status, data) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX_SIZE = 20 * 1024 * 1024; // 20MB max (for icon images)
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_SIZE) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ── Icon Conversion (PNG → ICO) ───────────────────────
// Creates a minimal ICO file from a PNG buffer (single-size entry)
// For production quality, install 'png-to-ico' package. This is a fallback.
function pngToIco(pngBuffer) {
  // ICO format: ICONDIR + ICONDIRENTRY + PNG data
  const iconDir = Buffer.alloc(6);
  iconDir.writeUInt16LE(0, 0);      // Reserved
  iconDir.writeUInt16LE(1, 2);      // Type: 1 = ICO
  iconDir.writeUInt16LE(1, 4);      // Number of images

  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0);           // Width (0 = 256)
  entry.writeUInt8(0, 1);           // Height (0 = 256)
  entry.writeUInt8(0, 2);           // Color palette
  entry.writeUInt8(0, 3);           // Reserved
  entry.writeUInt16LE(1, 4);        // Color planes
  entry.writeUInt16LE(32, 6);       // Bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8);  // Image size
  entry.writeUInt32LE(22, 12);      // Offset (6 + 16 = 22)

  return Buffer.concat([iconDir, entry, pngBuffer]);
}

function tryConvertIcon(base64Data, destPath) {
  try {
    // Strip data URI prefix if present
    const raw = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');
    const pngBuffer = Buffer.from(raw, 'base64');

    // Try using png-to-ico if available
    try {
      const pngToIcoLib = require('png-to-ico');
      const icoBuffer = pngToIcoLib(pngBuffer);
      if (icoBuffer instanceof Promise) {
        // Synchronous fallback since we're in sync code
        throw new Error('async');
      }
      fs.writeFileSync(destPath, icoBuffer);
      return true;
    } catch (e) {
      // Fallback: our simple PNG-in-ICO wrapper
      const icoBuffer = pngToIco(pngBuffer);
      fs.writeFileSync(destPath, icoBuffer);
      return true;
    }
  } catch (e) {
    console.warn('Icon conversion failed:', e.message);
    return false;
  }
}

// ── Build Logic ───────────────────────────────────────
function buildClient(data) {
  const {
    name, city = 'Tunisie', logo = '🍽️', logoLetter, tagline,
    phone = '+216 52 050 581', currency = 'DT',
    syncKey, managerName = 'Manager', managerPin = '1234',
    cashierName = 'Caissier', cashierPin = '0000',
    menu, zone1Cats, zone2Cats, boissonCats,
    iconBase64,
    businessType = 'fastfood', tableCount = 12, printEnabled = true
  } = data;

  if (!name) throw new Error('name is required');
  if (!syncKey) throw new Error('syncKey (API key) is required');

  // Choose template based on business type
  const templateFile = businessType === 'cafe' ? TEMPLATE_CAFE : TEMPLATE;
  if (!fs.existsSync(templateFile)) throw new Error(`Template not found: ${templateFile}`);

  const safeName    = safeFilename(name);
  const letter      = logoLetter || name.charAt(0).toUpperCase();
  const tag         = tagline || `${name} — POS Pro`;
  const clientDir   = path.join(CLIENTS_DIR, safeName);
  const clientHtml  = path.join(clientDir, 'index.html');
  const outputDir   = path.join(POS_DIR, 'dist_clients', safeName);

  // Step 1: Create client folder
  if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir, { recursive: true });

  // Step 2: Generate client index.html from template
  let html = fs.readFileSync(templateFile, 'utf8');
  html = replaceField(html, 'name',        name.toUpperCase());
  html = replaceField(html, 'tagline',     tag);
  html = replaceField(html, 'logo',        logo);
  html = replaceField(html, 'logoLetter',  letter);
  html = replaceField(html, 'city',        city);
  html = replaceField(html, 'phone',       phone);
  html = replaceField(html, 'currency',    currency);
  html = replaceField(html, 'syncKey',     syncKey);
  html = replaceField(html, 'managerName', managerName);
  html = replaceField(html, 'managerPin',  managerPin);
  html = replaceField(html, 'cashierName', cashierName);
  html = replaceField(html, 'cashierPin',  cashierPin);

  // Café-specific fields
  if (businessType === 'cafe') {
    html = html.replace(/(tableCount:\s*)\d+/, `$1${tableCount}`);
    html = html.replace(/(printEnabled:\s*)(true|false)/, `$1${printEnabled}`);
  }

  // Replace kitchen zones if provided
  if (zone1Cats && Array.isArray(zone1Cats)) {
    html = replaceArrayField(html, 'zone1Cats', zone1Cats);
    html = replaceField(html, 'zone1Label', 'CUISINE 1 — ' + zone1Cats.join(' / '));
  }
  if (zone2Cats && Array.isArray(zone2Cats)) {
    html = replaceArrayField(html, 'zone2Cats', zone2Cats);
    html = replaceField(html, 'zone2Label', 'CUISINE 2 — ' + zone2Cats.join(' / '));
  }
  if (boissonCats && Array.isArray(boissonCats)) {
    html = replaceArrayField(html, 'boissonCats', boissonCats);
  }

  // Replace menu if provided
  if (menu && typeof menu === 'object' && Object.keys(menu).length > 0) {
    html = replaceMenu(html, menu);
  }

  fs.writeFileSync(clientHtml, html, 'utf8');

  // Step 3: Copy to root for electron-builder
  const rootIndex = path.join(POS_DIR, 'index.html');
  const rootBackup = fs.existsSync(rootIndex) ? fs.readFileSync(rootIndex, 'utf8') : null;
  fs.copyFileSync(clientHtml, rootIndex);

  // Step 3b: Set custom icon if provided
  const iconPath    = path.join(POS_DIR, 'assets', 'icon.ico');
  const iconPngPath = path.join(POS_DIR, 'assets', 'icon.png');
  const iconBackup  = fs.existsSync(iconPath) ? fs.readFileSync(iconPath) : null;
  const iconPngBackup = fs.existsSync(iconPngPath) ? fs.readFileSync(iconPngPath) : null;
  let customIconUsed = false;

  if (iconBase64) {
    // Save PNG to client folder for reference
    const raw = iconBase64.replace(/^data:image\/[a-z]+;base64,/, '');
    const pngBuf = Buffer.from(raw, 'base64');
    fs.writeFileSync(path.join(clientDir, 'icon.png'), pngBuf);
    fs.writeFileSync(iconPngPath, pngBuf);

    // Convert to ICO
    customIconUsed = tryConvertIcon(iconBase64, iconPath);
    if (customIconUsed) {
      console.log('  ✓ Custom icon applied');
    }
  }

  // Step 4: Update package.json
  const pkgOriginal = fs.readFileSync(PKG_JSON, 'utf8');
  const pkg = JSON.parse(pkgOriginal);
  const productName = `${name} POS`;
  pkg.build.productName           = productName;
  pkg.build.appId                 = `tn.servio.pos.${safeName.toLowerCase()}`;
  pkg.build.directories           = { output: `dist_clients/${safeName}` };
  pkg.build.nsis.shortcutName     = productName;
  pkg.build.nsis.artifactName     = `${safeName}_Setup.exe`;
  pkg.build.portable.artifactName = `${safeName}_Portable.exe`;
  fs.writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2), 'utf8');

  // Step 5: Build EXE
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  try {
    execSync('node node_modules\\electron-builder\\cli.js --win --x64', {
      cwd: POS_DIR,
      stdio: 'pipe',
      timeout: 300000, // 5 min max
    });
  } finally {
    // Step 6: Always restore original files
    fs.writeFileSync(PKG_JSON, pkgOriginal, 'utf8');
    if (rootBackup !== null) {
      fs.writeFileSync(rootIndex, rootBackup, 'utf8');
    } else {
      try { fs.unlinkSync(rootIndex); } catch (e) {}
    }
    // Restore original icon
    if (customIconUsed) {
      if (iconBackup) fs.writeFileSync(iconPath, iconBackup);
      if (iconPngBackup) fs.writeFileSync(iconPngPath, iconPngBackup);
    }
  }

  // Find the EXE
  const setupExe    = path.join(outputDir, `${safeName}_Setup.exe`);
  const portableExe = path.join(outputDir, `${safeName}_Portable.exe`);
  const exePath     = fs.existsSync(setupExe) ? setupExe : (fs.existsSync(portableExe) ? portableExe : outputDir);

  return { safeName, exePath, clientDir };
}

// ── HTTP Server ───────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /status
  if (req.method === 'GET' && req.url === '/status') {
    return jsonResponse(res, 200, { building, lastBuild, queueLength: buildQueue.length });
  }

  // GET /clients
  if (req.method === 'GET' && req.url === '/clients') {
    try {
      const clients = fs.readdirSync(CLIENTS_DIR).filter(f =>
        fs.statSync(path.join(CLIENTS_DIR, f)).isDirectory()
      );
      return jsonResponse(res, 200, { ok: true, clients });
    } catch (e) {
      return jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /build
  if (req.method === 'POST' && req.url === '/build') {
    let data;
    try { data = await readBody(req); }
    catch (e) { return jsonResponse(res, 400, { ok: false, error: 'Invalid JSON' }); }

    if (building) {
      return jsonResponse(res, 409, { ok: false, error: 'A build is already in progress. Please wait.' });
    }

    building = true;
    console.log(`\n🔨 Building EXE for: ${data.name}...`);

    try {
      const result = buildClient(data);
      lastBuild = { ...result, timestamp: new Date().toISOString(), name: data.name };
      building = false;
      console.log(`✅ Build complete: ${result.exePath}`);
      return jsonResponse(res, 200, { ok: true, ...result });
    } catch (e) {
      building = false;
      console.error(`❌ Build failed:`, e.message);
      return jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // 404
  jsonResponse(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════════╗`);
  console.log(`║  ⚡ SERVIO OS — Build Server               ║`);
  console.log(`║  🌐 http://localhost:${PORT}                  ║`);
  console.log(`║  📂 POS Dir: ${POS_DIR.slice(-40).padEnd(40)}║`);
  console.log(`╚════════════════════════════════════════════╝\n`);
  console.log(`Endpoints:`);
  console.log(`  POST /build   — Build a client EXE`);
  console.log(`  GET  /status  — Check build status`);
  console.log(`  GET  /clients — List existing clients\n`);
  console.log(`Waiting for build requests...\n`);
});
