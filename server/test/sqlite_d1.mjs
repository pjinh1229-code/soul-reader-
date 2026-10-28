import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

/** Real SQLite constraints/triggers/atomic batch, matching the D1 methods used here. */
export class SqliteD1 {
  #db;
  constructor(path = ':memory:', { migrate = true } = {}) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA foreign_keys=ON');
    if (migrate) this.#db.exec(readFileSync(new URL('../migrations/0001_billing.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) { return new Statement(this.#db, sql); }
  async batch(statements) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = statements.map(statement => statement.execute());
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  close() { this.#db.close(); }
}
class Statement {
  constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.db, this.sql, values); }
  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.values);
    return row ? (column ? row[column] : { ...row }) : null;
  }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.values).map(row => ({ ...row })) }; }
  execute() {
    const result = this.db.prepare(this.sql).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  async run() { return this.execute(); }
}
