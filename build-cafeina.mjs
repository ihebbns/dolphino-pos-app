// Rebuild the Cafeina client EXE from its EDITED clients/Cafeina/index.html
// (does NOT regenerate the HTML from a template — keeps the focus + history fixes).
// Keeps Cafeina's original appId so it installs over the existing app and
// preserves the local SQLite data.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const POS = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(POS, 'package.json');
const ROOT_INDEX = path.join(POS, 'index.html');
const CAFEINA = path.join(POS, 'clients', 'Cafeina', 'index.html');
const OUT = path.join(POS, 'dist_clients', 'Cafeina');

if (!fs.existsSync(CAFEINA)) throw new Error('clients/Cafeina/index.html not found');

const pkgOriginal = fs.readFileSync(PKG, 'utf8');
const rootBackup = fs.existsSync(ROOT_INDEX) ? fs.readFileSync(ROOT_INDEX, 'utf8') : null;

try {
  const pkg = JSON.parse(pkgOriginal);
  pkg.build.productName = 'Cafeina POS';
  pkg.build.appId = 'tn.servio.pos.cafeina';
  pkg.build.directories = { output: 'dist_clients/Cafeina' };
  pkg.build.nsis = Object.assign({}, pkg.build.nsis, { shortcutName: 'Cafeina POS', artifactName: 'Cafeina_Setup.exe' });
  pkg.build.portable = Object.assign({}, pkg.build.portable, { artifactName: 'Cafeina_Portable.exe' });
  fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2), 'utf8');

  // Package the edited Cafeina HTML as the app's index.html
  fs.copyFileSync(CAFEINA, ROOT_INDEX);

  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  console.log('▶ Building Cafeina EXE (electron-builder)...');
  execSync('node node_modules\\electron-builder\\cli.js --win --x64', { cwd: POS, stdio: 'inherit', timeout: 900000 });
  console.log('\n✅ Build complete → ' + OUT);
} finally {
  fs.writeFileSync(PKG, pkgOriginal, 'utf8');
  if (rootBackup !== null) fs.writeFileSync(ROOT_INDEX, rootBackup, 'utf8');
  else { try { fs.unlinkSync(ROOT_INDEX); } catch (e) {} }
  console.log('↩ Restored package.json + root index.html');
}
