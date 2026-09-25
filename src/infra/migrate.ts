import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "db", "migrations");

/**
 * Applies pending `db/migrations/*.sql` files in name order, each in its own
 * transaction. Applied migrations are recorded in `musecourt.schema_migrations`.
 */
export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('musecourt_migrations'))");
    await client.query("CREATE SCHEMA IF NOT EXISTS musecourt");
    await client.query(`
      CREATE TABLE IF NOT EXISTS musecourt.schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM musecourt.schema_migrations")).rows.map(
        (r) => r.name,
      ),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO musecourt.schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
      ran.push(file);
    }
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('musecourt_migrations'))").catch(() => undefined);
    client.release();
  }
}
