import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import mysql, { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export type Row = RowDataPacket & Record<string, any>;

/** A connection inside a transaction. Every service function that changes data takes one. */
export class Tx {
  constructor(readonly conn: PoolConnection) {}
  async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.conn.query<Row[]>(sql, params);
    return rows as unknown as T[];
  }
  async one<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.all<T>(sql, params);
    return rows[0] ?? null;
  }
  async run(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
    const [res] = await this.conn.query<ResultSetHeader>(sql, params);
    return res;
  }
}

const RETRYABLE = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]);

export class Db {
  readonly pool: Pool;
  constructor(url: string) {
    this.pool = mysql.createPool({
      uri: url,
      connectionLimit: 20,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      timezone: "Z",
      multipleStatements: true,
    });
  }

  async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.pool.query<Row[]>(sql, params);
    return rows as unknown as T[];
  }

  async one<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.all<T>(sql, params))[0] ?? null;
  }

  /** Runs `fn` in a transaction, retrying the whole thing when InnoDB picks it as a deadlock victim. */
  async tx<T>(fn: (tx: Tx) => Promise<T>, attempts = 4): Promise<T> {
    for (let i = 1; ; i++) {
      const conn = await this.pool.getConnection();
      try {
        await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        await conn.beginTransaction();
        const out = await fn(new Tx(conn));
        await conn.commit();
        return out;
      } catch (e) {
        await conn.rollback().catch(() => undefined);
        const code = (e as { code?: string }).code;
        if (i < attempts && code && RETRYABLE.has(code)) continue;
        throw e;
      } finally {
        conn.release();
      }
    }
  }

  async migrate(): Promise<string[]> {
    const dir = join(__dirname, "migrations");
    await this.pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(100) NOT NULL PRIMARY KEY)");
    const done = new Set((await this.all<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
    const applied: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(dir, f), "utf8").replace(/CREATE TABLE schema_migrations[\s\S]*?\);/, "");
      await this.pool.query(sql);
      await this.pool.query("INSERT INTO schema_migrations (name) VALUES (?)", [f]);
      applied.push(f);
    }
    return applied;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function isDuplicate(e: unknown): boolean {
  return (e as { code?: string }).code === "ER_DUP_ENTRY";
}
