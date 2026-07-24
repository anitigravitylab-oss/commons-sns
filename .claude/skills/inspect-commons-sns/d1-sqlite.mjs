// A D1Database implementation backed by node:sqlite.
//
// The app talks to D1 through a small slice of its API (prepare / bind /
// first / all / run / batch). This maps that slice onto node:sqlite's
// DatabaseSync so the server bundle can run under plain Node, with no
// workerd and no Miniflare.
//
// The database lives in memory and is built from migrations/ on every run, so
// each invocation starts from the same seeded state and nothing here can
// reach a real database — local or deployed.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// D1 accepts booleans and stores them as 0/1; node:sqlite rejects them
// outright. Everything else is passed through so unsupported types still
// surface as an error rather than being silently coerced.
function toSqliteParam(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) {
    throw new TypeError("D1 does not accept undefined as a bound parameter (use null)");
  }
  return value;
}

// node:sqlite returns INTEGER as number, but lastInsertRowid/changes come back
// as BigInt. Callers read meta.changes as a number, so normalise here.
function toNumber(value) {
  return typeof value === "bigint" ? Number(value) : value;
}

function makeStatement(db, sql, params) {
  return {
    bind(...args) {
      return makeStatement(db, sql, args.map(toSqliteParam));
    },
    async first(column) {
      const row = db.prepare(sql).get(...params);
      if (row === undefined) return null;
      return column === undefined ? row : (row[column] ?? null);
    },
    async all() {
      return {
        success: true,
        results: db.prepare(sql).all(...params),
        meta: { changes: 0, duration: 0, rows_read: 0, rows_written: 0 },
      };
    },
    async run() {
      const result = db.prepare(sql).run(...params);
      return {
        success: true,
        results: [],
        meta: {
          changes: toNumber(result.changes),
          last_row_id: toNumber(result.lastInsertRowid),
          duration: 0,
          rows_read: 0,
          rows_written: toNumber(result.changes),
        },
      };
    },
  };
}

/**
 * Builds an in-memory database with every migration applied, in filename
 * order — the same order wrangler applies them.
 *
 * @param migrationsDir - Path to the repo's migrations/ directory.
 */
export function createSqliteD1(migrationsDir) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (files.length === 0) throw new Error(`no .sql migrations found in ${migrationsDir}`);
  for (const name of files) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }

  return {
    appliedMigrations: files,
    prepare: (sql) => makeStatement(db, sql, []),
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const results = [];
        // Statements run in order inside one transaction, so Promise.all would
        // be wrong here even though each run() is async.
        // eslint-disable-next-line no-await-in-loop
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}
