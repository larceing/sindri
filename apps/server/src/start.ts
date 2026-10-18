import { openEmbedded, openPostgres, type Db } from "./db.js";
import { migrate } from "./migrate.js";
import { buildApp } from "./app.js";

export interface StartOptions {
  /** postgres://... para usar el servidor PostgreSQL de la empresa. */
  databaseUrl?: string;
  /** Carpeta de datos del modo embebido (si no hay databaseUrl). */
  dataDir?: string;
  host?: string;
  port?: number;
  webDir?: string;
  logger?: boolean;
}

export interface RunningServer {
  url: string;
  db: Db;
  close(): Promise<void>;
}

export async function startServer(o: StartOptions = {}): Promise<RunningServer> {
  const db = o.databaseUrl ? openPostgres(o.databaseUrl) : await openEmbedded(o.dataDir);
  await migrate(db);
  const app = await buildApp({ db, webDir: o.webDir, logger: o.logger ?? false });
  const address = await app.listen({ host: o.host ?? "127.0.0.1", port: o.port ?? 3210 });
  return {
    url: address,
    db,
    async close() {
      await app.close();
      await db.close();
    },
  };
}
