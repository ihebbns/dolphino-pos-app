// ═══════════════════════════════════════════════════
// push-ota.mjs — Push OTA update for a client
// Usage: node push-ota.mjs <client_folder> <api_key>
//
// Example: node push-ota.mjs dolphino DOLPH-TEST-KEY-001
// ═══════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ADMIN_KEY = 'servio-admin-iheb-2026';
const SERVER_URL = 'https://dolphino-saas.vercel.app';

const clientFolder = process.argv[2];
const apiKey = process.argv[3];

if (!clientFolder || !apiKey) {
  console.log('Usage: node push-ota.mjs <client_folder> <api_key>');
  console.log('Example: node push-ota.mjs dolphino DOLPH-TEST-KEY-001');
  process.exit(1);
}

const htmlPath = path.join(__dirname, 'clients', clientFolder, 'index.html');
if (!fs.existsSync(htmlPath)) {
  console.error(`ERROR: File not found: ${htmlPath}`);
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf8');
// Numeric version — core/main.js does parseInt() on it, so it MUST be a plain number.
const version = Date.now();

console.log(`\n📦 Pushing OTA update for: ${clientFolder}`);
console.log(`   API Key: ${apiKey}`);
console.log(`   HTML size: ${(html.length / 1024).toFixed(1)} KB`);
console.log(`   Version: ${version}`);
console.log('');

// First, get existing config to merge
const getRes = await fetch(`${SERVER_URL}/api/admin/config?admin_key=${ADMIN_KEY}&api_key=${apiKey}`);
const getData = await getRes.json();

if (!getData.ok) {
  console.error('ERROR: Could not fetch current config:', getData.error);
  process.exit(1);
}

const existingConfig = getData.config || {};

// Merge — keep existing config, add/update appVersion and latestHtml
const newConfig = {
  ...existingConfig,
  appVersion: version,
  latestHtml: html,
};

// Push to server
const pushRes = await fetch(`${SERVER_URL}/api/admin/config`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    admin_key: ADMIN_KEY,
    api_key: apiKey,
    config: newConfig,
  }),
});

const pushData = await pushRes.json();

if (pushData.ok) {
  console.log('✅ OTA update pushed successfully!');
  console.log(`   Version: ${version}`);
  console.log(`   The EXE will auto-update on next license check (within 30 minutes).`);
} else {
  console.error('ERROR: Push failed:', pushData.error);
  process.exit(1);
}
