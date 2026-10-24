import { openEmbedded, openPostgres, type Db } from "./db.js";
import { migrate } from "./migrate.js";
import { buildApp } from "./app.js";
import { seedDemo, seedDemoPlanta } from "./demo.js";
import { repairCompanyColumns } from "./services.js";
import type { ReportServerConfig } from "./documentos.js";
import type { MailConfig } from "./correo.js";

export interface StartOptions {
  /** postgres://... para usar el servidor PostgreSQL de la empresa. */
  databaseUrl?: string;
  /** Carpeta de datos del modo embebido (si no hay databaseUrl). */
  dataDir?: string;
  host?: string;
  port?: number;
  webDir?: string;
  logger?: boolean;
  auth?: { user: string; password: string };
  sso?: import("./sso.js").SsoConfig;
  version?: string;
  trustProxy?: boolean;
  entorno?: string;
  /** Carga datos de demostración si la base está vacía. */
  demo?: boolean;
  reportServer?: ReportServerConfig;
  mail?: MailConfig;
  /** HTTPS propio (servidor de la fábrica): clave y certificado en PEM. */
  https?: { key: Buffer; cert: Buffer };
}

export interface RunningServer {
  url: string;
  db: Db;
  close(): Promise<void>;
}

export async function startServer(o: StartOptions = {}): Promise<RunningServer> {
  const db = o.databaseUrl ? openPostgres(o.databaseUrl) : await openEmbedded(o.dataDir);
  await migrate(db);
  await repairCompanyColumns(db);
  if (o.demo) {
    await seedDemo(db);
    await seedDemoPlanta(db);
  }
  const app = await buildApp({ db, webDir: o.webDir, logger: o.logger ?? false, auth: o.auth, sso: o.sso, version: o.version, trustProxy: o.trustProxy, entorno: o.entorno, reportServer: o.reportServer, mail: o.mail, https: o.https });
  const address = await app.listen({ host: o.host ?? "127.0.0.1", port: o.port ?? 8000 });
  return {
    url: address,
    db,
    async close() {
      await app.close();
      await db.close();
    },
  };
}
