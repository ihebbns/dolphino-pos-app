// ═══════════════════════════════════════════════════
// build-la-coupole.mjs — Rebuild the La Coupole EXE directly
// from clients/La_Coupole/index.html. Same pattern as build-dolphino.mjs.
// Bundles core/main.js (with OTA) + core/preload.js.
// ═══════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POS_DIR   = __dirname;
const PKG_JSON  = path.join(POS_DIR, 'package.json');
const ROOT_INDEX = path.join(POS_DIR, 'index.html');
const CLIENT_INDEX = path.join(POS_DIR, 'clients', 'La_Coupole', 'index.html');

const safeName = 'La_Coupole';

if (!fs.existsSync(CLIENT_INDEX)) {
  console.error('ERROR: clients/La_Coupole/index.html not found');
  process.exit(1);
}

const pkgOriginal = fs.readFileSync(PKG_JSON, 'utf8');
const rootBackup  = fs.existsSync(ROOT_INDEX) ? fs.readFileSync(ROOT_INDEX, 'utf8') : null;

try {
  fs.copyFileSync(CLIENT_INDEX, ROOT_INDEX);
  console.log('✓ Copied clients/La_Coupole/index.html → index.html');

  const pkg = JSON.parse(pkgOriginal);
  const productName = 'La Coupole POS';
  pkg.name                        = 'servio-la-coupole';
  pkg.build.productName           = productName;
  pkg.build.appId                 = 'tn.servio.pos.la_coupole';
  pkg.build.directories           = { output: `dist_clients/${safeName}` };
  pkg.build.nsis.shortcutName     = productName;
  pkg.build.nsis.artifactName     = `${safeName}_Setup.exe`;
  pkg.build.portable.artifactName = `${safeName}_Portable.exe`;
  fs.writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2), 'utf8');
  console.log('✓ Patched package.json for La Coupole (app folder: servio-la-coupole)');

  console.log('\n🔨 Building EXE (this can take a few minutes)...\n');
  execSync('node node_modules\\electron-builder\\cli.js --win --x64', {
    cwd: POS_DIR,
    stdio: 'inherit',
    timeout: 600000,
  });

  const outputDir = path.join(POS_DIR, 'dist_clients', safeName);
  const setupExe  = path.join(outputDir, `${safeName}_Setup.exe`);
  console.log('\n✅ Build complete.');
  console.log('   EXE:', fs.existsSync(setupExe) ? setupExe : outputDir);
} finally {
  fs.writeFileSync(PKG_JSON, pkgOriginal, 'utf8');
  if (rootBackup !== null) fs.writeFileSync(ROOT_INDEX, rootBackup, 'utf8');
  console.log('✓ Restored package.json');
}
