import { DatabaseSync } from "node:sqlite";

/** Exercises the same synchronous SQLite primitives as Durable Objects. */
export function context() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    ctx: {
      storage: {
        sql: {
          exec(sql, ...params) {
            const statement = db.prepare(sql);
            if (/^\s*SELECT\b/i.test(sql)) return { toArray: () => statement.all(...params), raw: () => ({ toArray: () => (statement.setReturnArrays(true), statement.all(...params)) }) };
            statement.run(...params);
            return { toArray: () => [] };
          }
        },
        transactionSync(fn) {
          db.exec("BEGIN");
          try { const result = fn(); db.exec("COMMIT"); return result; }
          catch (error) { db.exec("ROLLBACK"); throw error; }
        }
      }
    }
  };
}
