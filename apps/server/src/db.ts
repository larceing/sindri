/**
 * Capa de base de datos con dos motores intercambiables y el mismo SQL:
 *  - "postgres": PostgreSQL real (servidor de la empresa en la red local, varios usuarios).
 *  - "embedded": PGlite, PostgreSQL compilado a WebAssembly dentro del propio proceso.
 *    Sin instalar nada y sin internet: ideal para el modo escritorio de un solo puesto.
 */
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";

export interface Queryable {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Ejecuta un script SQL con varias sentencias y sin parámetros (migraciones). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  readonly kind: "postgres" | "embedded";
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// OIDs de PostgreSQL que devolvemos como texto para no perder precisión ni zona horaria.
const NUMERIC = 1700;
const DATE = 1082;
const INT8 = 20;
const asText = (v: string) => v;

export function openPostgres(connectionString: string): Db {
  const types = {
    getTypeParser(oid: number, format?: "text" | "binary") {
      if (oid === NUMERIC || oid === DATE || oid === INT8) return asText;
      return pg.types.getTypeParser(oid, format as "text");
    },
  };
  const pool = new pg.Pool({ connectionString, types: types as pg.CustomTypesConfig });
  const run = async <T>(c: pg.Pool | pg.PoolClient, sql: string, params?: unknown[]) =>
    (await c.query(sql, params as unknown[])).rows as T[];
  return {
    kind: "postgres",
    query: (sql, params) => run(pool, sql, params),
    exec: async (sql) => void (await pool.query(sql)),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: (sql, params) => run(client, sql, params),
          exec: async (sql) => void (await client.query(sql)),
        });
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** `dataDir` = carpeta donde guardar los datos; sin ella, base de datos en memoria (tests). */
export async function openEmbedded(dataDir?: string): Promise<Db> {
  const parsers = { [NUMERIC]: asText, [DATE]: asText, [INT8]: asText };
  const db = new PGlite(dataDir, { parsers });
  await db.waitReady;
  // PGlite tiene una sola conexión: serializamos las transacciones para que no se mezclen.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const next = chain.then(job, job);
    chain = next.catch(() => undefined);
    return next;
  };
  return {
    kind: "embedded",
    query: (sql, params) => serial(async () => (await db.query(sql, params as unknown[])).rows as never),
    exec: (sql) => serial(async () => void (await db.exec(sql))),
    tx: (fn) =>
      serial(() =>
        db.transaction(async (t) =>
          fn({
            // Dentro de una transacción PGlite no aplica los parsers del arranque: se repiten.
            query: async (sql, params) => (await t.query(sql, params as unknown[], { parsers })).rows as never,
            exec: async (sql) => void (await t.exec(sql)),
          }),
        ),
      ),
    close: () => db.close(),
  };
}
