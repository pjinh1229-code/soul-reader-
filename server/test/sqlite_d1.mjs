import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

/** Real SQLite constraints/triggers/atomic batch, matching the D1 methods used here. */
export class SqliteD1 {
  #db;
  constructor(path = ':memory:', { migrate = true } = {}) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA foreign_keys=ON');
    if (migrate) {
      const directory = new URL('../migrations/', import.meta.url);
      for (const name of readdirSync(directory).filter(name => /^\d+_[a-z_]+\.sql$/.test(name)).sort()) {
        this.#db.exec(readFileSync(new URL(name, directory), 'utf8'));
      }
    }
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
