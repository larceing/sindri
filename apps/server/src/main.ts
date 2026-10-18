/**
 * Arranque del servidor.
 *   DATABASE_URL=postgres://...  -> PostgreSQL (modo empresa, varios usuarios en la red local)
 *   sin DATABASE_URL             -> base embebida en FORJA_DATA_DIR (por defecto ./.data)
 *   FORJA_HOST=0.0.0.0 para aceptar conexiones desde otros equipos de la red.
 */
import { fileURLToPath } from "node:url";
import { startServer } from "./start.js";

const webDir = process.env.FORJA_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const server = await startServer({
  databaseUrl: process.env.DATABASE_URL,
  dataDir: process.env.FORJA_DATA_DIR ?? ".data",
  host: process.env.FORJA_HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3210),
  webDir,
  logger: true,
});
console.log(`Forja ERP escuchando en ${server.url} (base de datos: ${server.db.kind})`);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void server.close().then(() => process.exit(0)));
