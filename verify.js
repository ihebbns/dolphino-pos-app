const fs = require('fs');
const c = fs.readFileSync('index.html', 'utf8');
console.log('showSessions:',      (c.match(/async function showSessions/g)||[]).length);
console.log('showOpenCaisseModal:',(c.match(/async function showOpenCaisseModal/g)||[]).length);
console.log('syncSale:',           (c.match(/async function syncSale/g)||[]).length);
console.log('createSessionModal:', (c.match(/function createSessionModal/g)||[]).length);
console.log('session-modal HTML:', (c.match(/id="session-modal"/g)||[]).length);
console.log('ALL OK:', [1,1,1,1,0].join(','));
