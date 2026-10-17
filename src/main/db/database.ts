import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations';

export class MesaiDatabase {
  public readonly db: DatabaseSync;
  public readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.runMigrations();
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>;
    const appliedVersions = new Set(appliedRows.map((r) => r.version));

    for (const migration of MIGRATIONS) {
      if (!appliedVersions.has(migration.version)) {
        this.db.exec('BEGIN;');
        try {
          this.db.exec(migration.upSql);
          this.db
            .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
            .run(migration.version, migration.name, new Date().toISOString());
          this.db.exec('COMMIT;');
        } catch (err) {
          this.db.exec('ROLLBACK;');
          throw err;
        }
      }
    }
  }

  public close(): void {
    this.db.close();
  }
}
