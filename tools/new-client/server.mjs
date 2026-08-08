// ═══════════════════════════════════════════════════
// tools/new-client/server.mjs — local graphical wizard to create a new
// Servio POS client without hand-editing HTML.
//
// Run:  node tools/new-client/server.mjs   (from servio-pos-package/)
// Then open the printed http://localhost:PORT URL in a browser.
//
// What it does:
//   1) Serves wizard.html (plain HTML/JS, no external deps/CDN).
//   2) POST /api/create — clones one of the 3 base clients (table service /
//      counter service / retail), injects the new identity + kitchen zones
//      + menu the user built in the form, and writes clients/<slug>/index.html
//      plus a build-<slug>.mjs (cloned from build-dolphino.mjs's pattern).
//   3) POST /api/build  — runs the generated build script synchronously and
//      returns its output (takes a few minutes — same as any other client).
// ═══════════════════════════════════════════════════

import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POS_DIR = path.resolve(__dirname, '..', '..');
const WEB_DIR = path.resolve(POS_DIR, '..', 'servio-web');
const PORT = 4790;

// ── servio-web admin API (creates the client's back-office login) ───────
// Reads servio-web/.env.local directly — no dependency on servio-web's
// node_modules, no dotenv package, just a minimal KEY=VALUE parser.
function readWebEnv() {
  const envPath = path.join(WEB_DIR, '.env.local');
  const out = {};
  try {
    const txt = fs.readFileSync(envPath, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch (e) { /* servio-web not present alongside — web creation just gets skipped */ }
  return out;
}

// Inserts directly into the production Neon Postgres DB, mirroring exactly
// what PUT /api/admin/clients does server-side (same table, same columns,
// same bcrypt cost) — avoids depending on the deployed Vercel env matching
// this machine's local ADMIN_SECRET_KEY, which isn't guaranteed.
async function createWebDashboard({ name, email, password, apiKey, city, phone, tagline, logo, zones }) {
  const env = readWebEnv();
  if (!env.DATABASE_URL) return { ok: false, error: 'DATABASE_URL introuvable (servio-web/.env.local manquant ou incomplet)' };
  try {
    const { neon } = await import(pathToFileURL(path.join(WEB_DIR, 'node_modules', '@neondatabase', 'serverless', 'index.mjs')));
    const bcryptMod = await import(pathToFileURL(path.join(WEB_DIR, 'node_modules', 'bcryptjs', 'index.js')));
    const bcrypt = bcryptMod.default || bcryptMod;
    const sql = neon(env.DATABASE_URL);
    const hash = await bcrypt.hash(password, 10);
    const config = { tagline, logo, ...zones };
    await sql`
      INSERT INTO restaurants (name, owner_email, password_hash, api_key, city, phone, plan, config)
      VALUES (${name}, ${email.toLowerCase()}, ${hash}, ${apiKey}, ${city}, ${phone}, 'active', ${JSON.stringify(config)})
    `;
    return { ok: true };
  } catch (e) {
    const msg = String(e?.message || e);
    const isDupe = msg.toLowerCase().includes('unique') || msg.includes('duplicate') || msg.includes('23505');
    if (isDupe) {
      const field = msg.includes('api_key') ? 'clé de synchronisation' : msg.includes('email') ? 'email' : 'clé API ou email';
      return { ok: false, error: `Ce ${field} existe déjà — choisissez une valeur unique` };
    }
    return { ok: false, error: msg };
  }
}

// ── Base templates ─────────────────────────────────────────────────────
// Each existing client is a proven, working base — new clients are always
// built by cloning one of these, never from scratch, so every feature that
// base already has (split-bill, ingredient tracking, printer test, barcode
// scan, etc.) comes along for free.
const BASES = {
  table: {
    label: 'Service à table',
    hint: 'Plan de salle, addition par table, split de l\'addition — comme DA COFFEE MORE.',
    file: 'clients/Coffee_More/index.html',
    zones: true,
    maxZones: 3,
    retail: false,
  },
  counter: {
    label: 'Comptoir / Fast-food',
    hint: 'Vente directe au comptoir, sans plan de salle — comme DOLPHINO.',
    file: 'clients/dolphino/index.html',
    zones: true,
    maxZones: 2,
    retail: false,
  },
  retail: {
    label: 'Commerce / Pharmacie',
    hint: 'Scan code-barres, stock par quantité directe, sans cuisine — comme PARAPHARMA PLUS.',
    file: 'clients/ParaPharma_Plus/index.html',
    zones: false,
    retail: true,
  },
};

function slugify(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'client';
}

function pascalCase(slug) {
  return slug.split('_').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('_');
}

function esc(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ── CLIENT_CONFIG block builders (one per base shape) ──────────────────
function buildConfigBlock(baseKey, cfg) {
  const lines = [];
  lines.push('const CLIENT_CONFIG = {');
  lines.push('  // ── Identity ──────────────────────────────────────────');
  lines.push(`  name:        '${esc(cfg.name)}',`);
  lines.push(`  tagline:     '${esc(cfg.tagline)}',`);
  lines.push(`  logo:        '${esc(cfg.logo)}',`);
  lines.push(`  logoLetter:  '${esc(cfg.logoLetter)}',`);
  lines.push(`  city:        '${esc(cfg.city)}',`);
  lines.push(`  phone:       '${esc(cfg.phone)}',`);
  lines.push(`  currency:    '${esc(cfg.currency || 'DT')}',`);
  lines.push('');
  lines.push('  // ── Sync / Dashboard ──────────────────────────────────');
  lines.push('  syncEnabled: true,');
  lines.push(`  syncUrl:     '${esc(cfg.syncUrl || 'https://servio.tn/api/sync')}',`);
  lines.push(`  syncKey:     '${esc(cfg.syncKey)}',    // ← unique par client`);
  if (baseKey !== 'retail') lines.push('  posStockLocked: false,');
  lines.push('');
  lines.push('  // ── Users / PINs ────────────────────────────────────');
  lines.push(`  managerName: '${esc(cfg.managerName)}',`);
  lines.push(`  managerPin:  '${esc(cfg.managerPin)}',`);
  lines.push(`  cashierName: '${esc(cfg.cashierName)}',`);
  lines.push(`  cashierPin:  '${esc(cfg.cashierPin)}',`);

  if (baseKey === 'retail') {
    lines.push('');
    lines.push('  // ── Retail specific ───────────────────────────────────');
    lines.push(`  alertThreshold: ${Number(cfg.alertThreshold) || 5},`);
  } else {
    lines.push('');
    lines.push('  // ── Kitchen zones ─────────────────────────────────────');
    lines.push(`  zone1Cats:   ${JSON.stringify(cfg.zone1Cats || [])},`);
    lines.push(`  zone2Cats:   ${JSON.stringify(cfg.zone2Cats || [])},`);
    if (baseKey === 'table' && cfg.zone3Cats && cfg.zone3Cats.length) {
      lines.push(`  zone3Cats:   ${JSON.stringify(cfg.zone3Cats)},`);
    }
    lines.push(`  boissonCats: ${JSON.stringify(cfg.boissonCats || [])},`);
    lines.push(`  zone1Label:  '${esc(cfg.zone1Label)}',`);
    lines.push(`  zone2Label:  '${esc(cfg.zone2Label)}',`);
    if (baseKey === 'table' && cfg.zone3Cats && cfg.zone3Cats.length) {
      lines.push(`  zone3Label:  '${esc(cfg.zone3Label)}',`);
    }
  }

  // ── Feature modules ────────────────────────────────────────────────
  // Only emitted for flags the wizard actually turned off — omitting a key
  // entirely means "on" (isCreditEnabled()/isCardEnabled()/isStockEnabled()
  // all default to true when CLIENT_CONFIG.modules or the specific key is
  // missing), so a fully-featured client gets no modules block at all.
  const moduleFlags = [];
  if (baseKey !== 'retail') {
    if (cfg.cardEnabled === false) moduleFlags.push('card: false');
    if (cfg.creditEnabled === false) moduleFlags.push('credit: false');
    if (cfg.stockEnabled === false) moduleFlags.push('stockTracking: false');
  }
  if (moduleFlags.length) {
    lines.push('');
    lines.push('  // ── Modules ───────────────────────────────────────────');
    lines.push(`  modules: { ${moduleFlags.join(', ')} },`);
  }

  lines.push('};');
  return lines.join('\n');
}

// ── MENU block builder ──────────────────────────────────────────────────
function buildMenuBlock(baseKey, categories) {
  const menu = {};
  let n = 1;
  for (const cat of categories) {
    if (!cat.name) continue;
    menu[cat.name] = {
      icon: cat.icon || '📦',
      items: (cat.items || []).filter(it => it.name).map(it => {
        const item = {
          id: 'p' + (n++),
          name: it.name,
          e: it.emoji || cat.icon || '📦',
          p: Number(it.price) || 0,
        };
        if (baseKey === 'retail') {
          if (it.barcode) item.barcode = it.barcode;
          item.cost = Number(it.cost) || 0;
          item.qty = Number(it.qty) || 0;
        } else if (cat.tracked === false) {
          item.tracked = false;
        }
        return item;
      }),
    };
  }
  return 'let MENU=' + JSON.stringify(menu, null, 2) + ';';
}

function injectBlocks(source, baseKey, configBlock, menuBlock) {
  const configRe = /const CLIENT_CONFIG = \{[\s\S]*?\n\};\n/;
  const menuRe = /let MENU=\{[\s\S]*?\n\};\n/;
  if (!configRe.test(source)) throw new Error('CLIENT_CONFIG block not found in base template');
  if (!menuRe.test(source)) throw new Error('MENU block not found in base template');
  let out = source.replace(configRe, configBlock + '\n\n');
  out = out.replace(menuRe, menuBlock + '\n\n');
  return out;
}

function buildScriptFor(slug, displayName) {
  const Safe = pascalCase(slug);
  return `// Auto-generated by tools/new-client wizard — rebuilds the ${displayName} EXE
// from clients/${slug}/index.html. Same pattern as build-dolphino.mjs.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POS_DIR   = __dirname;
const PKG_JSON  = path.join(POS_DIR, 'package.json');
const ROOT_INDEX = path.join(POS_DIR, 'index.html');
const CLIENT_INDEX = path.join(POS_DIR, 'clients', '${slug}', 'index.html');

const safeName = '${Safe}';

if (!fs.existsSync(CLIENT_INDEX)) {
  console.error('ERROR: clients/${slug}/index.html not found');
  process.exit(1);
}

const pkgOriginal = fs.readFileSync(PKG_JSON, 'utf8');
const rootBackup  = fs.existsSync(ROOT_INDEX) ? fs.readFileSync(ROOT_INDEX, 'utf8') : null;

try {
  fs.copyFileSync(CLIENT_INDEX, ROOT_INDEX);
  console.log('✓ Copied clients/${slug}/index.html → index.html');

  const pkg = JSON.parse(pkgOriginal);
  const productName = '${displayName} POS';
  pkg.name                        = 'servio-${slug}';
  pkg.build.productName           = productName;
  pkg.build.appId                 = 'tn.servio.pos.${slug}';
  pkg.build.directories           = { output: \`dist_clients/\${safeName}\` };
  pkg.build.nsis.shortcutName     = productName;
  pkg.build.nsis.artifactName     = \`\${safeName}_Setup.exe\`;
  pkg.build.portable.artifactName = \`\${safeName}_Portable.exe\`;
  fs.writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2), 'utf8');
  console.log('✓ Patched package.json for ${displayName} (app folder: servio-${slug})');

  console.log('\\n🔨 Building EXE (this can take a few minutes)...\\n');
  execSync('node node_modules\\\\electron-builder\\\\cli.js --win --x64', {
    cwd: POS_DIR,
    stdio: 'inherit',
    timeout: 600000,
  });

  const outputDir = path.join(POS_DIR, 'dist_clients', safeName);
  const setupExe  = path.join(outputDir, \`\${safeName}_Setup.exe\`);
  console.log('\\n✅ Build complete.');
  console.log('   EXE:', fs.existsSync(setupExe) ? setupExe : outputDir);
} finally {
  fs.writeFileSync(PKG_JSON, pkgOriginal, 'utf8');
  if (rootBackup !== null) fs.writeFileSync(ROOT_INDEX, rootBackup, 'utf8');
  console.log('✓ Restored package.json');
}
`;
}

function syntaxCheck(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  for (const s of scripts) {
    // eslint-disable-next-line no-new-func
    new Function(s);
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 10_000_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/wizard.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'wizard.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/bases') {
      const out = {};
      for (const [k, v] of Object.entries(BASES)) out[k] = { label: v.label, hint: v.hint, zones: v.zones, maxZones: v.maxZones || 0, retail: v.retail };
      sendJson(res, 200, out);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/create') {
      const body = JSON.parse(await readBody(req));
      const { baseKey, config, categories } = body;
      const base = BASES[baseKey];
      if (!base) return sendJson(res, 400, { ok: false, error: 'Type de client invalide' });
      if (!config?.name) return sendJson(res, 400, { ok: false, error: 'Nom du client requis' });

      const slug = slugify(config.name);
      const clientDir = path.join(POS_DIR, 'clients', slug);
      if (fs.existsSync(clientDir)) {
        return sendJson(res, 409, { ok: false, error: `Un client "${slug}" existe déjà — choisissez un autre nom.` });
      }

      const sourcePath = path.join(POS_DIR, base.file);
      const source = fs.readFileSync(sourcePath, 'utf8');

      const configBlock = buildConfigBlock(baseKey, config);
      const menuBlock = buildMenuBlock(baseKey, categories || []);
      const finalHtml = injectBlocks(source, baseKey, configBlock, menuBlock);

      syntaxCheck(finalHtml); // throws if the generated blocks broke JS syntax

      fs.mkdirSync(clientDir, { recursive: true });
      fs.writeFileSync(path.join(clientDir, 'index.html'), finalHtml, 'utf8');

      const buildScriptPath = path.join(POS_DIR, `build-${slug}.mjs`);
      fs.writeFileSync(buildScriptPath, buildScriptFor(slug, config.name), 'utf8');

      let web = null;
      if (config.webEmail && config.webPassword) {
        const zones = baseKey === 'retail' ? {} : {
          zone1Label: config.zone1Label, zone2Label: config.zone2Label,
          zone1Cats: config.zone1Cats, zone2Cats: config.zone2Cats,
        };
        web = await createWebDashboard({
          name: config.name, email: config.webEmail, password: config.webPassword,
          apiKey: config.syncKey, city: config.city, phone: config.phone,
          tagline: config.tagline, logo: config.logo, zones,
        });
      }

      sendJson(res, 200, {
        ok: true,
        slug,
        clientFile: `clients/${slug}/index.html`,
        buildScript: `build-${slug}.mjs`,
        web,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/build') {
      const body = JSON.parse(await readBody(req));
      const { slug } = body;
      const scriptPath = path.join(POS_DIR, `build-${slug}.mjs`);
      if (!fs.existsSync(scriptPath)) return sendJson(res, 404, { ok: false, error: 'Script de build introuvable — créez le client d\'abord.' });
      try {
        const out = execSync(`node "${scriptPath}"`, { cwd: POS_DIR, timeout: 600000 }).toString();
        sendJson(res, 200, { ok: true, log: out });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message, log: (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '') });
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n✓ Servio — Assistant nouveau client\n  Ouvrez : http://localhost:${PORT}\n`);
});
