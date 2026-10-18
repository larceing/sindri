/**
 * Entrada con Keycloak para el servidor DEV/PRO (AUTH_MODO=sso).
 *
 * Flujo Authorization Code con cliente confidencial: /login manda a Keycloak, Keycloak
 * vuelve a /sso con un code y Sindri lo cambia por un token y pide /userinfo. Las dos
 * llamadas van directas de Sindri al issuer, así que no hace falta validar la firma del
 * token. La sesión es una cookie firmada con HMAC, sin estado en el servidor.
 *
 * Variables (las pone el servidor en app.env): KEYCLOAK_ISSUER, KEYCLOAK_CLIENT_ID,
 * KEYCLOAK_CLIENT_SECRET, KEYCLOAK_GRUPO_APP (p. ej. DEV/Sindri) y
 * KEYCLOAK_GRUPO_ADMIN_GLOBAL (IT). Opcional: KEYCLOAK_INTERNO, para que las llamadas
 * de Sindri a Keycloak vayan por la red interna.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface SsoConfig {
  issuer: string;
  internalIssuer?: string;
  clientId: string;
  clientSecret: string;
  appGroup?: string;
  itGroup?: string;
  /** Clave para firmar la cookie de sesión. */
  sessionKey: string;
  /** Horas que dura la sesión. */
  sessionHours?: number;
}

export interface Person {
  user: string;
  name: string;
  email: string;
  admin: boolean;
}

export function ssoFromEnv(env: NodeJS.ProcessEnv = process.env): SsoConfig | undefined {
  if (env.AUTH_MODO !== "sso" || !env.KEYCLOAK_ISSUER || !env.KEYCLOAK_CLIENT_ID) return undefined;
  const secret = env.KEYCLOAK_CLIENT_SECRET ?? "";
  return {
    issuer: env.KEYCLOAK_ISSUER,
    internalIssuer: env.KEYCLOAK_INTERNO,
    clientId: env.KEYCLOAK_CLIENT_ID,
    clientSecret: secret,
    appGroup: env.KEYCLOAK_GRUPO_APP,
    itGroup: env.KEYCLOAK_GRUPO_ADMIN_GLOBAL ?? "IT",
    // Sin clave propia se deriva del secreto del cliente: estable entre reinicios y distinta por entorno.
    sessionKey: env.SINDRI_CLAVE_SESION || createHmac("sha256", secret || randomBytes(32)).update("sindri-sesion").digest("hex"),
  };
}

const trimSlashes = (g: string | undefined) => String(g ?? "").trim().replace(/^\/+|\/+$/g, "");
const noTrailing = (u: string) => u.replace(/\/+$/, "");

/** Quién entra y quién administra según los grupos del token (claim "groups", con el camino entero). */
export function access(groups: unknown, cfg: Pick<SsoConfig, "appGroup" | "itGroup">) {
  const names = new Set((Array.isArray(groups) ? groups : []).map((g) => trimSlashes(String(g))));
  const it = trimSlashes(cfg.itGroup);
  const app = trimSlashes(cfg.appGroup);
  const isIt = !!it && names.has(it);
  const inApp = !!app && [...names].some((g) => g === app || g.startsWith(app + "/"));
  return { enters: isIt || inApp, admin: isIt || (!!app && names.has(app + "/Admin")) };
}

// Cookies firmadas -------------------------------------------------------------------

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");

export function sign(value: object, key: string): string {
  const body = b64(JSON.stringify(value));
  const mac = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verify<T>(token: string | undefined, key: string): T | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const good = createHmac("sha256", key).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== good.length || !timingSafeEqual(given, good)) return null;
  try {
    const v = JSON.parse(unb64(body)) as T & { exp?: number };
    if (typeof v.exp === "number" && v.exp < Date.now()) return null;
    return v;
  } catch {
    return null;
  }
}

function readCookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

// Direcciones como las ve el navegador ------------------------------------------------

/** Prefijo de la app: X-Forwarded-Prefix (lo manda la entrada del servidor) o nada. */
export function prefix(req: FastifyRequest): string {
  const p = String(req.headers["x-forwarded-prefix"] ?? "").trim();
  return /^\/[A-Za-z0-9/_.-]*$/.test(p) ? noTrailing(p) : "";
}

export function publicBase(req: FastifyRequest): string {
  return `${req.protocol}://${req.host}${prefix(req)}`;
}

const SESSION = "sindri_sesion";
const STATE = "sindri_estado";

function setCookie(reply: FastifyReply, req: FastifyRequest, name: string, value: string, maxAgeSec: number) {
  const secure = req.protocol === "https" ? "; Secure" : "";
  const path = prefix(req) || "/";
  const cookie = `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
  const prev = reply.getHeader("set-cookie");
  reply.header("set-cookie", prev === undefined ? cookie : [...(Array.isArray(prev) ? prev : [String(prev)]), cookie]);
}

/** Persona con sesión, o null. */
export function currentPerson(req: FastifyRequest, cfg: SsoConfig): Person | null {
  return verify<Person>(readCookie(req, SESSION), cfg.sessionKey);
}

/** Rutas que no piden sesión. */
const OPEN = new Set(["/login", "/sso", "/logout", "/version", "/version/", "/api/health"]);

export function registerSso(app: FastifyInstance, cfg: SsoConfig) {
  const issuer = noTrailing(cfg.issuer);
  const internal = noTrailing(cfg.internalIssuer || cfg.issuer);
  const back = (req: FastifyRequest) => `${publicBase(req)}/sso`;
  const hours = cfg.sessionHours ?? 12;

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (OPEN.has(path)) return;
    if (currentPerson(req, cfg)) return;
    if (path.startsWith("/api/")) return reply.status(401).send({ error: "La sesión ha caducado. Vuelve a entrar." });
    return reply.redirect(`${publicBase(req)}/login`);
  });

  app.get("/login", async (req, reply) => {
    const state = randomBytes(16).toString("base64url");
    setCookie(reply, req, STATE, sign({ state, exp: Date.now() + 10 * 60_000 }, cfg.sessionKey), 600);
    const q = new URLSearchParams({ client_id: cfg.clientId, response_type: "code", scope: "openid", redirect_uri: back(req), state });
    return reply.redirect(`${issuer}/protocol/openid-connect/auth?${q}`);
  });

  app.get<{ Querystring: { code?: string; state?: string } }>("/sso", async (req, reply) => {
    const saved = verify<{ state: string }>(readCookie(req, STATE), cfg.sessionKey);
    if (!saved || !req.query.code || saved.state !== req.query.state)
      return reply.status(400).type("text/html").send(page("No se ha podido entrar", "El enlace de entrada ha caducado.", `${publicBase(req)}/login`));

    const token = await fetch(`${internal}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: back(req),
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
      signal: AbortSignal.timeout(8000),
    }).then((r) => (r.ok ? (r.json() as Promise<{ access_token?: string }>) : null));
    if (!token?.access_token)
      return reply.status(502).type("text/html").send(page("No se ha podido entrar", "Keycloak no ha aceptado la entrada.", `${publicBase(req)}/login`));

    const info = await fetch(`${internal}/protocol/openid-connect/userinfo`, {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(8000),
    }).then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : null));
    if (!info?.preferred_username)
      return reply.status(502).type("text/html").send(page("No se ha podido entrar", "Keycloak no ha devuelto tus datos.", `${publicBase(req)}/login`));

    const { enters, admin } = access(info.groups, cfg);
    if (!enters)
      return reply
        .status(403)
        .type("text/html")
        .send(page("No tienes acceso a Sindri", `Tu usuario no está en el grupo ${cfg.appGroup ?? "de la aplicación"}. Pide a IT que te añada.`, `${publicBase(req)}/logout`, "Salir"));

    const person: Person & { exp: number } = {
      user: String(info.preferred_username).slice(0, 64),
      name: String(info.name ?? info.preferred_username).slice(0, 128),
      email: String(info.email ?? ""),
      admin,
      exp: Date.now() + hours * 3600_000,
    };
    setCookie(reply, req, STATE, "", 0);
    setCookie(reply, req, SESSION, sign(person, cfg.sessionKey), hours * 3600);
    return reply.redirect(`${publicBase(req)}/`);
  });

  app.get("/logout", async (req, reply) => {
    setCookie(reply, req, SESSION, "", 0);
    // Cierra también la sesión de Keycloak: si no, la siguiente visita entraría sola.
    const q = new URLSearchParams({ client_id: cfg.clientId, post_logout_redirect_uri: `${publicBase(req)}/` });
    return reply.redirect(`${issuer}/protocol/openid-connect/logout?${q}`);
  });

  app.get("/api/me", async (req) => {
    const p = currentPerson(req, cfg)!;
    return { user: p.user, name: p.name, email: p.email, admin: p.admin, logout: "logout" };
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function page(title: string, text: string, link: string, label = "Volver a entrar") {
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#181d24">
<h1 style="font-size:1.25rem">${esc(title)}</h1><p>${esc(text)}</p><p><a href="${esc(link)}">${esc(label)}</a></p></body></html>`;
}
