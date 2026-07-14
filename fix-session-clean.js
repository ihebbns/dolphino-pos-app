const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'index.html');
let c = fs.readFileSync(filePath, 'utf8');

// ── Remove the broken first half of showSessions (orphaned, no function declaration) ──
// Pattern: the first occurrence starting with "  if (!USERS[currentUser].isManager)"
// that appears BEFORE "async function showSessions{"
const brokenFirstHalf = /  if \(!USERS\[currentUser\]\.isManager\) \{ alert\('Accès réservé au Manager\.'\); return; \}\n  let sessions = \[\];\n  if \(window\.electronAPI\?\.getSessions\) sessions = await window\.electronAPI\.getSessions\(\) \|\| \[\];\n\nasync function showSessions\(\)\{/;

c = c.replace(brokenFirstHalf, 'async function showSessions(){');
console.log('Fixed duplicate showSessions:', !c.match(brokenFirstHalf) ? '✓' : '✗');

// ── Verify no more duplicates ──
const count = (c.match(/async function showSessions/g)||[]).length;
console.log('showSessions count:', count, count === 1 ? '✓' : '✗ still duplicated');

const syncCount = (c.match(/async function syncSale/g)||[]).length;
console.log('syncSale count:', syncCount, syncCount === 1 ? '✓' : '✗');

fs.writeFileSync(filePath, c, 'utf8');
console.log('Done!');
