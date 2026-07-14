const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'index.html');
let c = fs.readFileSync(filePath, 'utf8');

// Replace classList.add('active') with createSessionModal approach
// Replace show calls
c = c.replace(
  /document\.getElementById\('session-modal'\)\.classList\.add\('active'\)/g,
  "/* modal created dynamically */"
);
// Replace hide calls  
c = c.replace(
  /document\.getElementById\('session-modal'\)\.classList\.remove\('active'\)/g,
  "destroySessionModal()"
);

fs.writeFileSync(filePath, c, 'utf8');
console.log('Done');
