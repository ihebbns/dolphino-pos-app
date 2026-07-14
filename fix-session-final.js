const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'index.html');
let c = fs.readFileSync(filePath, 'utf8');

// ── Fix 1: showOpenCaisseModal — orphaned code without function declaration
const brokenOpen = `  const box = document.getElementById('session-box-content');
  box.innerHTML = \`
    <div class="session-icon">💰</div>
    <div class="session-title">Ouverture de Caisse</div>
    <div class="session-sub">Comptez l'argent dans le tiroir<br>et saisissez le fond de caisse initial.</div>
    <div class="session-input-row">
      <label>Fond de caisse (DT)</label>
      <input class="session-inp" type="number" id="fond-inp" placeholder="0.000"
        step="0.5" inputmode="decimal" autocomplete="off" onfocus="this.select()">
    </div>
    <button class="btn-session-open" onclick="confirmOpenCaisse()">✓ Ouvrir la caisse</button>
  \`;
  /* modal created dynamically */;
  setTimeout(() => { const i = document.getElementById('fond-inp'); if(i) i.focus(); }, 100);
}`;

const fixedOpen = `async function showOpenCaisseModal(){
  createSessionModal(\`
    <div class="session-icon">💰</div>
    <div class="session-title">Ouverture de Caisse</div>
    <div class="session-sub">Comptez l'argent dans le tiroir<br>et saisissez le fond de caisse initial.</div>
    <div class="session-input-row">
      <label>Fond de caisse (DT)</label>
      <input class="session-inp" type="number" id="fond-inp" placeholder="0.000"
        step="0.5" inputmode="decimal" autocomplete="off" onfocus="this.select()">
    </div>
    <button class="btn-session-open" onclick="confirmOpenCaisse()">✓ Ouvrir la caisse</button>
  \`);
  setTimeout(() => { const i = document.getElementById('fond-inp'); if(i) i.focus(); }, 100);
}`;

// ── Fix 2: showSessions — orphaned box.innerHTML without function declaration
const brokenSessions = `  const box = document.getElementById('session-box-content');
  const rows = sessions.slice(0, 10).map(s => {`;

const fixedSessions = `async function showSessions(){
  if (!USERS[currentUser].isManager) { alert('Accès réservé au Manager.'); return; }
  let sessions = [];
  if (window.electronAPI?.getSessions) sessions = await window.electronAPI.getSessions() || [];
  const rows = sessions.slice(0, 10).map(s => {`;

// ── Fix 3: showSessions end — orphaned function closure
const brokenSessionsEnd = `    <button class="mcancel" style="margin-top:14px" onclick="destroySessionModal()">Fermer</button>
  \`;
  /* modal created dynamically */;
}
  if (!SYNC_ENABLED) return;`;

const fixedSessionsEnd = `    <button class="mcancel" style="margin-top:14px" onclick="destroySessionModal()">Fermer</button>
  \`);
}

async function syncSale(od) {
  if (!SYNC_ENABLED) return;`;

// Also fix showSessions body to use createSessionModal
const brokenSessionsBody = `  box.innerHTML = \`
    <div class="session-icon">📋</div>`;
const fixedSessionsBody = `  createSessionModal(\`
    <div class="session-icon">📋</div>`;

if (c.includes(brokenOpen)) {
  c = c.replace(brokenOpen, fixedOpen);
  console.log('✓ Fixed showOpenCaisseModal');
} else {
  console.log('⚠ showOpenCaisseModal pattern not found — may already be fixed');
}

if (c.includes(brokenSessions)) {
  c = c.replace(brokenSessions, fixedSessions);
  console.log('✓ Fixed showSessions start');
} else {
  console.log('⚠ showSessions start pattern not found');
}

if (c.includes(brokenSessionsBody)) {
  c = c.replace(brokenSessionsBody, fixedSessionsBody);
  console.log('✓ Fixed showSessions body');
} else {
  console.log('⚠ showSessions body pattern not found');
}

if (c.includes(brokenSessionsEnd)) {
  c = c.replace(brokenSessionsEnd, fixedSessionsEnd);
  console.log('✓ Fixed showSessions end + syncSale');
} else {
  console.log('⚠ showSessions end pattern not found');
}

// Also remove duplicate syncSale if it exists now
const dupSyncSale = `async function syncSale(od) {\n  if (!SYNC_ENABLED) return;\n  try {\n    const res = await fetch(SYNC_API_URL, {`;
const countSyncSale = (c.match(/async function syncSale/g)||[]).length;
console.log('syncSale count:', countSyncSale);

fs.writeFileSync(filePath, c, 'utf8');
console.log('Done!');
