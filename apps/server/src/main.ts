/**
 * Arranque del servidor.
 *   DATABASE_URL=postgres://...  -> PostgreSQL (modo empresa, varios usuarios en la red local)
 *   sin DATABASE_URL             -> base embebida en SINDRI_DATA_DIR (por defecto ./.data)
 *   SINDRI_HOST=0.0.0.0 para aceptar conexiones desde otros equipos de la red.
 *   SINDRI_USUARIO y SINDRI_CLAVE: piden usuario y clave para entrar.
 *   SINDRI_DEMO=1: carga datos de demostración si la base está vacía (en DEV del servidor, siempre).
 *
 * En el servidor DEV/PRO (larceing/servidor) el agente pone en app.env SERVIDOR_ENTORNO,
 * AUTH_MODO=sso y KEYCLOAK_*: entonces se entra con Keycloak y se confía en el proxy.
 * APP_VERSION la fija la imagen al construirla.
 */
import { fileURLToPath } from "node:url";
import { startServer } from "./start.js";
import { ssoFromEnv } from "./sso.js";
import { reportServerFromEnv } from "./documentos.js";
import { mailFromEnv } from "./correo.js";

// En PRO lo bueno es PostgreSQL. Mientras el servidor no lo dé, PRO arranca con la base integrada
// en /datos para ir probando, y lo avisa; cuando llegue DATABASE_URL empezará con una base nueva.
if (process.env.SERVIDOR_ENTORNO === "pro" && !process.env.DATABASE_URL) {
  console.warn("Aviso: Sindri en PRO sin DATABASE_URL usa la base integrada en /datos. Vale para probar; los datos de verdad tienen que ir a PostgreSQL.");
}

const webDir =process.env.SINDRI_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const server = await startServer({
  databaseUrl: process.env.DATABASE_URL,
  dataDir: process.env.SINDRI_DATA_DIR ?? ".data",
  host: process.env.SINDRI_HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8000),
  webDir,
  logger: true,
  sso: ssoFromEnv(),
  version: process.env.APP_VERSION ?? "dev",
  entorno: process.env.SERVIDOR_ENTORNO ?? "local",
  trustProxy: !!process.env.SERVIDOR_ENTORNO || process.env.SINDRI_PROXY === "1",
  auth: process.env.SINDRI_USUARIO && process.env.SINDRI_CLAVE
    ? { user: process.env.SINDRI_USUARIO, password: process.env.SINDRI_CLAVE }
    : undefined,
  reportServer: reportServerFromEnv(),
  mail: mailFromEnv(),
  demo: process.env.SINDRI_DEMO === "1" || (process.env.SERVIDOR_ENTORNO === "dev" && process.env.SINDRI_DEMO !== "0"),
});
if (!process.env.SINDRI_USUARIO && process.env.AUTH_MODO !== "sso" && process.env.SINDRI_HOST === "0.0.0.0")
  console.warn("Aviso: el servidor acepta conexiones de la red sin usuario ni clave. Define SINDRI_USUARIO y SINDRI_CLAVE.");
console.log(`Sindri ERP escuchando en ${server.url} (base de datos: ${server.db.kind})`);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void server.close().then(() => process.exit(0)));
