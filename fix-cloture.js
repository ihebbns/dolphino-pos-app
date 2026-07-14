const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'index.html');
let c = fs.readFileSync(filePath, 'utf8');

// Find and replace the cloturerJournee function - fix the box.innerHTML to use createSessionModal
// The broken pattern: uses getElementById('session-box-content') which doesn't exist yet
const broken = /  const box = document\.getElementById\('session-box-content'\);\n  box\.innerHTML = `/;
const fixed = `  createSessionModal(\``;

if (broken.test(c)) {
  c = c.replace(broken, fixed);
  console.log('✓ Step 1: replaced box.innerHTML with createSessionModal');
} else {
  console.log('⚠ Step 1: pattern not found');
}

// Fix the closing backtick + semicolon of box.innerHTML
// Change:  `;
//   /* modal created dynamically */;
// to:  `);
const broken2 = /  `;\n  \/\* modal created dynamically \*\/;/;
const fixed2  = `  \`);`;

if (broken2.test(c)) {
  c = c.replace(broken2, fixed2);
  console.log('✓ Step 2: fixed closing backtick');
} else {
  console.log('⚠ Step 2: closing backtick pattern not found');
}

// Fix the event listener - it runs before modal exists, move it inside setTimeout
// The getCurrentEventListener code should run after modal is created (inside setTimeout)
const broken3 = `  /* modal created dynamically */;\n  setTimeout(()=>{ const i=document.getElementById('compte-inp'); if(i)i.focus(); },100);\n\n  // Live écart calculation\n  document.getElementById('compte-inp')?.addEventListener('input', function(){`;
const fixed3  = `  setTimeout(()=>{\n    const i=document.getElementById('compte-inp'); if(i)i.focus();\n    // Live écart calculation\n    document.getElementById('compte-inp')?.addEventListener('input', function(){`;

if (c.includes(broken3)) {
  c = c.replace(broken3, fixed3);
  console.log('✓ Step 3: fixed event listener timing');
} else {
  console.log('⚠ Step 3: event listener pattern not found — trying alternate');
  // Try alternate: just the setTimeout part
  const alt3 = `  setTimeout(()=>{ const i=document.getElementById('compte-inp'); if(i)i.focus(); },100);\n\n  // Live écart calculation\n  document.getElementById('compte-inp')?.addEventListener('input', function(){`;
  const fixedAlt3 = `  setTimeout(()=>{\n    const i=document.getElementById('compte-inp'); if(i)i.focus();\n    document.getElementById('compte-inp')?.addEventListener('input', function(){`;
  if (c.includes(alt3)) {
    c = c.replace(alt3, fixedAlt3);
    console.log('✓ Step 3 alt: fixed event listener');
  }
}

// Fix the closing brace of the event listener callback + setTimeout
// Change:  });
// }   (end of cloturerJournee)
// to:  });
//   },100);
// }
const broken4 = `      el.style.display = 'none';\n    }\n  });\n}`;
const fixed4  = `      el.style.display = 'none';\n    }\n  });\n  },100);\n}`;

if (c.includes(broken4)) {
  c = c.replace(broken4, fixed4);
  console.log('✓ Step 4: fixed setTimeout closing');
} else {
  console.log('⚠ Step 4: not found (may already be correct)');
}

fs.writeFileSync(filePath, c, 'utf8');
console.log('\nDone!');
