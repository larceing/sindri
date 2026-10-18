/**
 * Arranque del servidor.
 *   DATABASE_URL=postgres://...  -> PostgreSQL (modo empresa, varios usuarios en la red local)
 *   sin DATABASE_URL             -> base embebida en SINDRI_DATA_DIR (por defecto ./.data)
 *   SINDRI_HOST=0.0.0.0 para aceptar conexiones desde otros equipos de la red.
 *   SINDRI_USUARIO y SINDRI_CLAVE: piden usuario y clave para entrar.
 *   SINDRI_DEMO=1: carga datos de demostración si la base está vacía.
 */
import { fileURLToPath } from "node:url";
import { startServer } from "./start.js";

const webDir = process.env.SINDRI_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const server = await startServer({
  databaseUrl: process.env.DATABASE_URL,
  dataDir: process.env.SINDRI_DATA_DIR ?? ".data",
  host: process.env.SINDRI_HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3210),
  webDir,
  logger: true,
  auth: process.env.SINDRI_USUARIO && process.env.SINDRI_CLAVE
    ? { user: process.env.SINDRI_USUARIO, password: process.env.SINDRI_CLAVE }
    : undefined,
  demo: process.env.SINDRI_DEMO === "1",
});
if (!process.env.SINDRI_USUARIO && process.env.SINDRI_HOST === "0.0.0.0")
  console.warn("Aviso: el servidor acepta conexiones de la red sin usuario ni clave. Define SINDRI_USUARIO y SINDRI_CLAVE.");
console.log(`Sindri ERP escuchando en ${server.url} (base de datos: ${server.db.kind})`);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void server.close().then(() => process.exit(0)));
