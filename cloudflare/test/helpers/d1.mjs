// A stand-in for Cloudflare D1 backed by real SQLite (sql.js, pure WebAssembly, so it runs on any Node), for tests that
// need real SQL: joins, UPDATE ... WHERE guards, unique keys. Same surface the Worker uses: prepare(sql).bind(...).first() /
// .all() / .run() (with meta.changes), and batch().
import initSqlJs from 'sql.js';

let sqlPromise = null;

export async function createD1() {
  sqlPromise ||= initSqlJs();
  const SQL = await sqlPromise;
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  const exec = (sql, params) => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return { rows, changes: db.getRowsModified() };
    } finally {
      stmt.free();
    }
  };
  const statement = (sql, params = []) => ({
    sql,
    params,
    bind: (...values) => statement(sql, values),
    first: async () => exec(sql, params).rows[0] ?? null,
    all: async () => ({ results: exec(sql, params).rows }),
    run: async () => {
      const { changes } = exec(sql, params);
      return { success: true, meta: { changes } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
    // for tests: run SQL directly
    sql: (sql, ...params) => exec(sql, params).rows,
    raw: db,
  };
}
