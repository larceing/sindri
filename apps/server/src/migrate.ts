/** Migraciones SQL versionadas: cada fichero de /migrations se aplica una sola vez y en orden. */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Db } from "./db.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(
    "create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())",
  );
  const done = new Set((await db.query<{ version: string }>("select version from schema_migrations")).map((r) => r.version));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    const version = f.replace(/\.sql$/, "");
    if (done.has(version)) continue;
    const sql = await readFile(join(dir, f), "utf8");
    await db.tx(async (q) => {
      // Ejecutamos el fichero completo (puede contener funciones con $$ ... $$).
      await q.exec(sql);
      await q.query("insert into schema_migrations (version) values ($1)", [version]);
    });
    applied.push(version);
  }
  return applied;
}
