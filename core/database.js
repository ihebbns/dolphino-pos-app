const path = require('path');
const fs = require('fs');

let db = null;
let SQL = null;
let dbPath = null;
let dbAvailable = false;
let dbInitError = null;
let dbReadyPromise = null;

const SCHEMA_VERSION = 2;

function businessDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function resultToObjects(result) {
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(rowValues => {
    const row = {};
    columns.forEach((column, index) => {
      row[column] = rowValues[index];
    });
    return row;
  });
}

function closeDatabase() {
  if (db) {
    try {
      persistDatabase();
    } catch (error) {
      console.error('SQLite persist on close failed:', error);
    }
    db.close();
    db = null;
  }
  dbAvailable = false;
}

function persistDatabase() {
  if (!db || !dbPath) return;
  const tmpPath = `${dbPath}.tmp`;
  const backupPath = `${dbPath}.bak`;
  const data = db.export();
  fs.writeFileSync(tmpPath, Buffer.from(data));
  if (fs.existsSync(dbPath)) {
    try {
      fs.copyFileSync(dbPath, backupPath);
    } catch (error) {
      console.warn('SQLite backup skipped:', error.message);
    }
  }
  fs.renameSync(tmpPath, dbPath);
}

function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      num INTEGER NOT NULL,
      business_date TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      items_json TEXT NOT NULL,
      sub REAL NOT NULL,
      disc REAL NOT NULL,
      discount REAL NOT NULL,
      grand REAL NOT NULL,
      pay_method TEXT NOT NULL,
      received REAL NOT NULL,
      monnaie REAL NOT NULL,
      cashier TEXT NOT NULL,
      order_type TEXT NOT NULL DEFAULT 'place',
      cli_name TEXT NOT NULL DEFAULT '',
      cli_tel TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_date TEXT NOT NULL,
      cashier TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      fond_initial REAL NOT NULL DEFAULT 0,
      total_sales REAL NOT NULL DEFAULT 0,
      cash_sales REAL NOT NULL DEFAULT 0,
      card_sales REAL NOT NULL DEFAULT 0,
      mobile_sales REAL NOT NULL DEFAULT 0,
      orders_count INTEGER NOT NULL DEFAULT 0,
      montant_compte REAL,
      theorique REAL,
      ecart REAL,
      synced INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const columns = resultToObjects(db.exec('PRAGMA table_info(sales)'));
  const columnNames = new Set(columns.map(column => column.name));

  if (!columnNames.has('business_date')) {
    db.exec("ALTER TABLE sales ADD COLUMN business_date TEXT NOT NULL DEFAULT ''");
  }
  if (!columnNames.has('order_type')) {
    db.exec("ALTER TABLE sales ADD COLUMN order_type TEXT NOT NULL DEFAULT 'place'");
  }
  if (!columnNames.has('cli_name')) {
    db.exec("ALTER TABLE sales ADD COLUMN cli_name TEXT NOT NULL DEFAULT ''");
  }
  if (!columnNames.has('cli_tel')) {
    db.exec("ALTER TABLE sales ADD COLUMN cli_tel TEXT NOT NULL DEFAULT ''");
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_sales_business_date ON sales(business_date)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sales_num ON sales(num)');

  db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['schema_version', String(SCHEMA_VERSION)]);
}

function normalizeSaleInput(raw = {}) {
  const sub = Number(raw.sub ?? raw.s ?? 0);
  const discountAmount = Number(raw.discount ?? raw.d ?? 0);
  const discPercent = Number(raw.disc ?? 0);
  const grand = Number(raw.grand ?? raw.g ?? 0);
  const payMethod = raw.payMethod || raw.payMode || 'cash';

  return {
    num: Number(raw.num) || 0,
    businessDate: raw.businessDate || businessDateKey(),
    date: raw.date || '',
    time: raw.time || '',
    items: Array.isArray(raw.items) ? raw.items : [],
    sub,
    disc: discPercent,
    discount: discountAmount,
    grand,
    payMethod,
    received: Number(raw.received ?? raw.r ?? grand),
    monnaie: Number(raw.monnaie ?? 0),
    cashier: raw.cashier || 'Ahmed',
    type: raw.type || raw.orderType || 'place',
    cliName: raw.cliName || '',
    cliTel: raw.cliTel || '',
  };
}

function serializeSaleRow(row) {
  let items = [];
  try {
    items = JSON.parse(row.items_json || '[]');
    if (!Array.isArray(items)) items = [];
  } catch (error) {
    console.warn('Invalid items_json for sale', row.id, error.message);
    items = [];
  }

  return {
    id: row.id,
    num: row.num,
    businessDate: row.business_date,
    date: row.date,
    time: row.time,
    items,
    sub: row.sub,
    disc: row.disc,
    discount: row.discount,
    grand: row.grand,
    payMethod: row.pay_method,
    received: row.received,
    monnaie: row.monnaie,
    cashier: row.cashier,
    type: row.order_type || 'place',
    cliName: row.cli_name || '',
    cliTel: row.cli_tel || '',
    createdAt: row.created_at,
  };
}

async function initSqlEngine() {
  const initSqlJs = require('sql.js');
  try {
    // Electron/Node résout sql-wasm.wasm automatiquement (plus fiable en .exe).
    return await initSqlJs();
  } catch (error) {
    console.warn('sql-wasm init failed, falling back to sql-asm:', error.message);
    const initSqlAsm = require('sql.js/dist/sql-asm.js');
    return await initSqlAsm();
  }
}

async function initDatabase(userDataPath) {
  if (db && dbAvailable) return db;

  try {
    SQL = await initSqlEngine();

    dbPath = path.join(userDataPath, 'dolphino-pos.sqlite');
    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      db = new SQL.Database(new Uint8Array(fileBuffer));
    } else {
      db = new SQL.Database();
    }

    runMigrations();
    persistDatabase();
    dbAvailable = true;
    dbInitError = null;
    return db;
  } catch (error) {
    console.error('SQLite init failed:', error);
    closeDatabase();
    dbAvailable = false;
    dbInitError = error;
    return null;
  }
}

function getDatabaseReady(userDataPath) {
  if (!dbReadyPromise) {
    dbReadyPromise = initDatabase(userDataPath).catch(error => {
      console.error('SQLite ready check failed:', error);
      dbAvailable = false;
      dbInitError = error;
      return null;
    });
  }
  return dbReadyPromise;
}

async function getSales(userDataPath) {
  await getDatabaseReady(userDataPath);
  if (!dbAvailable || !db) return [];
  const rows = resultToObjects(db.exec('SELECT * FROM sales ORDER BY id DESC'));
  return rows.map(serializeSaleRow);
}

async function saveSale(userDataPath, rawSale) {
  await getDatabaseReady(userDataPath);
  if (!dbAvailable || !db) {
    return { ok: false, error: dbInitError?.message || 'SQLite indisponible' };
  }

  const sale = normalizeSaleInput(rawSale);
  db.run(
    `INSERT INTO sales (
      num, business_date, date, time, items_json, sub, disc, discount, grand,
      pay_method, received, monnaie, cashier, order_type, cli_name, cli_tel
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sale.num,
      sale.businessDate,
      sale.date,
      sale.time,
      JSON.stringify(sale.items),
      sale.sub,
      sale.disc,
      sale.discount,
      sale.grand,
      sale.payMethod,
      sale.received,
      sale.monnaie,
      sale.cashier,
      sale.type,
      sale.cliName,
      sale.cliTel,
    ]
  );
  persistDatabase();

  const rows = db.exec('SELECT last_insert_rowid() AS id');
  const id = rows[0]?.values?.[0]?.[0] ?? null;
  return { ok: true, id, ...sale };
}

function getDatabaseStatus() {
  return {
    available: dbAvailable,
    path: dbPath,
    error: dbInitError ? dbInitError.message : null,
    schemaVersion: SCHEMA_VERSION,
  };
}

async function saveSession(userDataPath, session) {
  await getDatabaseReady(userDataPath);
  if (!dbAvailable || !db) return { ok: false, error: 'SQLite indisponible' };
  db.run(
    `INSERT INTO sessions (business_date, cashier, opened_at, fond_initial)
     VALUES (?, ?, ?, ?)`,
    [session.businessDate, session.cashier, session.openedAt, session.fondInitial]
  );
  persistDatabase();
  const rows = db.exec('SELECT last_insert_rowid() AS id');
  const id = rows[0]?.values?.[0]?.[0] ?? null;
  return { ok: true, id };
}

async function closeSession(userDataPath, id, data) {
  await getDatabaseReady(userDataPath);
  if (!dbAvailable || !db) return { ok: false, error: 'SQLite indisponible' };
  db.run(
    `UPDATE sessions SET
       closed_at=?, total_sales=?, cash_sales=?, card_sales=?, mobile_sales=?,
       orders_count=?, montant_compte=?, theorique=?, ecart=?
     WHERE id=?`,
    [
      data.closedAt, data.totalSales, data.cashSales, data.cardSales, data.mobileSales,
      data.ordersCount, data.montantCompte, data.theorique, data.ecart, id
    ]
  );
  persistDatabase();
  return { ok: true };
}

async function getSessions(userDataPath) {
  await getDatabaseReady(userDataPath);
  if (!dbAvailable || !db) return [];
  const rows = resultToObjects(db.exec('SELECT * FROM sessions ORDER BY id DESC LIMIT 30'));
  return rows;
}

module.exports = {
  businessDateKey,
  closeDatabase,
  getDatabaseReady,
  getDatabaseStatus,
  getSales,
  saveSale,
  saveSession,
  closeSession,
  getSessions,
};
