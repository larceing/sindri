/**
 * Arranque del servidor.
 *   DATABASE_URL=postgres://...  -> PostgreSQL (modo empresa, varios usuarios en la red local)
 *   sin DATABASE_URL             -> base embebida en ERGANE_DATA_DIR (por defecto ./.data)
 *   ERGANE_HOST=0.0.0.0 para aceptar conexiones desde otros equipos de la red.
 *   ERGANE_USUARIO y ERGANE_CLAVE: piden usuario y clave para entrar.
 *   ERGANE_DEMO=1: carga datos de demostración si la base está vacía.
 */
import { fileURLToPath } from "node:url";
import { startServer } from "./start.js";

const webDir = process.env.ERGANE_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const server = await startServer({
  databaseUrl: process.env.DATABASE_URL,
  dataDir: process.env.ERGANE_DATA_DIR ?? ".data",
  host: process.env.ERGANE_HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3210),
  webDir,
  logger: true,
  auth: process.env.ERGANE_USUARIO && process.env.ERGANE_CLAVE
    ? { user: process.env.ERGANE_USUARIO, password: process.env.ERGANE_CLAVE }
    : undefined,
  demo: process.env.ERGANE_DEMO === "1",
});
if (!process.env.ERGANE_USUARIO && process.env.ERGANE_HOST === "0.0.0.0")
  console.warn("Aviso: el servidor acepta conexiones de la red sin usuario ni clave. Define ERGANE_USUARIO y ERGANE_CLAVE.");
console.log(`Ergane ERP escuchando en ${server.url} (base de datos: ${server.db.kind})`);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void server.close().then(() => process.exit(0)));
