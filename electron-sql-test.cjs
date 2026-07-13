try {
  const initSqlJs = require('sql.js');
  (async () => {
    const SQL = await initSqlJs({
      locateFile: file => require('path').join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
    });
    const db = new SQL.Database();
    db.run('CREATE TABLE t(x INTEGER)');
    db.run('INSERT INTO t VALUES (?)', [1]);
    const result = db.exec('SELECT * FROM t');
    console.log(JSON.stringify(result));
  })().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
