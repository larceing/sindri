/** Configuración del escritorio: a qué Sindri se conecta. Sin Electron, para poder probarlo. */
export interface Entorno {
  entorno: "dev" | "pro" | "local";
  /** Dirección de Sindri, acabada en "/", p. ej. https://dev.<dominio>/sindri/ */
  url: string;
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * entorno.json (lo genera el workflow al construir el instalador) manda. Sin él, al
 * desarrollar, valen SINDRI_URL y SINDRI_ENTORNO.
 */
export function leerEntorno(env: Record<string, string | undefined>, fichero?: unknown): Entorno {
  const f = (fichero ?? {}) as Partial<Entorno>;
  const url = fichero ? f.url : env.SINDRI_URL;
  const entorno = (fichero ? f.entorno : env.SINDRI_ENTORNO) ?? "local";
  if (!url) throw new Error("Este Sindri no sabe a qué servidor conectarse: falta entorno.json (o SINDRI_URL al desarrollar).");
  if (!["dev", "pro", "local"].includes(entorno)) throw new Error(`Entorno desconocido: ${entorno}`);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Dirección no válida: ${url}`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL.has(u.hostname)))
    throw new Error(`La dirección tiene que ir por HTTPS: ${url}`);
  if (entorno === "pro" && u.protocol !== "https:") throw new Error("PRO solo por HTTPS.");
  u.hash = "";
  u.search = "";
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  return { entorno: entorno as Entorno["entorno"], url: u.toString() };
}

const partes = (v: string) => v.split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);

/** ¿La versión `a` es más vieja que `b`? (X.Y.Z) */
export function esMasVieja(a: string, b: string): boolean {
  const [x, y] = [partes(a), partes(b)];
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! < y[i]!;
  return false;
}

/** Dónde está Keycloak: a donde manda <sindri>/login. Así no hay que configurarlo aparte. */
export async function origenKeycloak(url: string, f: typeof fetch = fetch): Promise<string | null> {
  try {
    const r = await f(new URL("login", url), { redirect: "manual", signal: AbortSignal.timeout(8000) });
    const destino = r.headers.get("location");
    if (r.status < 300 || r.status >= 400 || !destino) return null;
    const o = new URL(destino, url);
    return o.protocol === "https:" || LOCAL.has(o.hostname) ? o.origin : null;
  } catch {
    return null;
  }
}
