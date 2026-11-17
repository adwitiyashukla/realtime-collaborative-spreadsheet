import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as postgres } from "drizzle-orm/node-postgres";
import { drizzle as embedded } from "drizzle-orm/pglite";
import pg from "pg";
import * as schema from "./schema.ts";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type Database = {
  db: Db;
  kind: "pglite" | "postgres";
  exec: (sql: string) => Promise<void>;
  rows: <T>(sql: string) => Promise<T[]>;
  close: () => Promise<void>;
};

const MIGRATIONS = join(import.meta.dirname, "migrations");

export async function openDatabase(url: string, dir: string): Promise<Database> {
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    await pool.query("select 1");
    return {
      db: postgres({ client: pool, schema }) as unknown as Db,
      kind: "postgres",
      exec: async (sql) => {
        await pool.query(sql);
      },
      rows: async <T>(sql: string) => (await pool.query(sql)).rows as T[],
      close: () => pool.end(),
    };
  }
  const memory = dir === "memory://";
  if (!memory) mkdirSync(dir, { recursive: true });
  const client = await PGlite.create(memory ? undefined : dir);
  return {
    db: embedded({ client, schema }) as unknown as Db,
    kind: "pglite",
    exec: async (sql) => {
      await client.exec(sql);
    },
    rows: async <T>(sql: string) => (await client.query<T>(sql)).rows,
    close: () => client.close(),
  };
}

export async function migrate(database: Database): Promise<string[]> {
  await database.exec("create table if not exists migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await database.rows<{ name: string }>("select name from migrations")).map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(MIGRATIONS).filter((f) => /^\d+_[a-z0-9_]+\.sql$/.test(f)).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    await database.exec(`begin;\n${sql}\ninsert into migrations (name) values ('${file}');\ncommit;`);
    applied.push(file);
  }
  return applied;
}
