import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { buildApp, migrate, openEmbedded, type Db } from "../src/index.js";
import type { SsoConfig } from "../src/sso.js";

/**
 * Contraseña por empresa y administración de una sola empresa:
 *  - luis: IT y grupo Empresa/001; crea las empresas y le da a Ivan la contraseña inicial.
 *  - ivan: administra solo la 002 (Empresa/002 + Rol/Administración).
 *  - pepe: comercial de la 002.
 */
const GRUPOS: Record<string, string[]> = {
  luis: ["/IT", "/DEV/Sindri/Empresa/001"],
  ivan: ["/DEV/Sindri/Empresa/002", "/DEV/Sindri/Rol/Administración"],
  pepe: ["/DEV/Sindri/Empresa/002", "/DEV/Sindri/Rol/Comercial"],
};

async function fakeKeycloak() {
  const kc = Fastify();
  kc.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_r, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  kc.post("/realms/general/protocol/openid-connect/token", async (req) => ({ access_token: (req.body as Record<string, string>).code }));
  kc.get("/realms/general/protocol/openid-connect/userinfo", async (req) => {
    const who = String(req.headers.authorization).slice(7);
    return { preferred_username: who, name: who, groups: GRUPOS[who] };
  });
  await kc.listen({ port: 0, host: "127.0.0.1" });
  return { kc, issuer: `http://127.0.0.1:${(kc.server.address() as { port: number }).port}/realms/general` };
}

describe("Contraseña de la empresa y quien administra solo la suya", () => {
  let db: Db;
  let app: FastifyInstance;
  let kc: FastifyInstance;
  const cookies: Record<string, Record<string, string>> = { luis: {}, ivan: {}, pepe: {} };
  const header = (who: string) => ({ cookie: Object.entries(cookies[who]!).map(([k, v]) => `${k}=${v}`).join("; ") });
  const keep = (who: string, set: unknown) => {
    for (const c of ([] as string[]).concat((set as string[]) ?? [])) {
      const [kv] = c.split(";");
      const i = kv!.indexOf("=");
      cookies[who]![kv!.slice(0, i)] = kv!.slice(i + 1);
    }
  };
  const call = async (who: string, method: string, url: string, body?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, payload: body as object, headers: header(who) });
    keep(who, r.headers["set-cookie"]);
    return { status: r.statusCode, text: r.body, body: r.body && r.headers["content-type"]?.toString().includes("json") ? JSON.parse(r.body) : r.body };
  };
  const login = async (who: string) => {
    const r = await app.inject({ url: "/login" });
    keep(who, r.headers["set-cookie"]);
    const state = new URL(r.headers.location as string).searchParams.get("state");
    const back = await app.inject({ url: `/sso?code=${encodeURIComponent(who)}&state=${state}`, headers: header(who) });
    keep(who, back.headers["set-cookie"]);
    expect(back.statusCode).toBe(302);
  };
  const me = async (who: string) => (await call(who, "GET", "/api/v1/me")).body;
  let A: string, B: string;

  beforeAll(async () => {
    const fake = await fakeKeycloak();
    kc = fake.kc;
    db = await openEmbedded();
    await migrate(db);
    const cfg: SsoConfig = { issuer: fake.issuer, clientId: "sindri-dev", clientSecret: "s", appGroup: "DEV/Sindri", itGroup: "IT", sessionKey: "k" };
    app = await buildApp({ db, sso: cfg });
    for (const who of ["luis", "ivan", "pepe"]) await login(who);
  });
  afterAll(async () => {
    await app.close();
    await kc.close();
    await db.close();
  });

  it("Luis crea la 002 y le pone la contraseña inicial", async () => {
    A = (await call("luis", "PUT", "/api/v1/company", { name: "Luis Consultoría", tax_id: "B12345674" })).body.id;
    B = (await call("luis", "POST", "/api/v1/companies", { name: "Ivan Servicios", tax_id: "B41234568" })).body.id;
    expect((await call("luis", "POST", "/api/v1/session/company", { company_id: B })).status).toBe(200);
    expect((await call("luis", "PUT", "/api/v1/company/password", { nueva: "corta" })).status).toBe(400);
    expect((await call("luis", "PUT", "/api/v1/company/password", { nueva: "inicial-123" })).body).toEqual({ has_password: true });
    // Quien la pone sigue dentro.
    expect((await me("luis")).company).toBe(B);
    expect((await call("luis", "GET", "/api/v1/company")).body.has_password).toBe(true);
  });

  it("Ivan solo ve la 002 y para entrar escribe la contraseña", async () => {
    const m = await me("ivan");
    expect(m.companies.map((c: { id: string }) => c.id)).toEqual([B]);
    expect(m.companies[0].has_password).toBe(true);
    expect(m.company).toBeNull();
    expect(m.needs_company).toBe(true);
    expect(m.admin).toBe(false);
    expect(m.company_admin).toBe(true);
    expect(m.perms.usuarios).toBeUndefined();
    expect((await call("ivan", "GET", "/api/v1/partners")).body.code).toBe("elegir_empresa");
    expect((await call("ivan", "POST", "/api/v1/session/company", { company_id: B })).body.code).toBe("clave_empresa");
    expect((await call("ivan", "POST", "/api/v1/session/company", { company_id: B, password: "otra-cosa" })).status).toBe(401);
    expect((await call("ivan", "POST", "/api/v1/session/company", { company_id: B, password: "inicial-123" })).status).toBe(200);
    expect((await me("ivan")).company).toBe(B);
    expect((await call("ivan", "GET", "/api/v1/partners")).status).toBe(200);
  });

  it("Ivan la cambia y Luis deja de poder entrar con la inicial", async () => {
    expect((await call("ivan", "PUT", "/api/v1/company/password", { nueva: "solo-de-ivan" })).status).toBe(401);
    expect((await call("ivan", "PUT", "/api/v1/company/password", { actual: "inicial-123", nueva: "solo-de-ivan" })).status).toBe(200);
    expect((await me("ivan")).company).toBe(B);
    expect((await me("luis")).company).toBeNull();
    expect((await call("luis", "POST", "/api/v1/session/company", { company_id: B, password: "inicial-123" })).status).toBe(401);
    // La contraseña no sale nunca, ni cifrada.
    for (const who of ["luis", "ivan"]) expect((await call(who, "GET", "/api/v1/me")).text).not.toContain("s1$");
    expect((await call("luis", "GET", "/api/v1/companies")).text).not.toContain("s1$");
  });

  it("Ivan administra su empresa, pero no usuarios, roles ni otras empresas", async () => {
    expect((await call("ivan", "PUT", "/api/v1/company", { name: "Ivan Servicios SL", tax_id: "B41234568" })).status).toBe(200);
    expect((await call("ivan", "GET", "/api/v1/users")).status).toBe(403);
    expect((await call("ivan", "GET", "/api/v1/roles")).status).toBe(403);
    expect((await call("ivan", "POST", "/api/v1/companies", { name: "Otra SL", tax_id: "B12345674" })).status).toBe(403);
    expect((await call("ivan", "PUT", "/api/v1/company/sharing", { restricted: true })).status).toBe(403);
    expect((await call("ivan", "POST", "/api/v1/session/company", { company_id: A })).status).toBe(403);
    expect((await call("ivan", "DELETE", `/api/v1/companies/${B}/password`)).status).toBe(403);
    // Lo de su empresa sí: sus llaves de integración (p. ej. para que Odin le mande sus horas) y el
    // correo de sus pedidos; la conexión al Mail es de todo Sindri.
    const llave = await call("ivan", "POST", "/api/v1/integraciones/llaves", { name: "incidencias" });
    expect(llave.status).toBe(201);
    expect(llave.body.key).toMatch(/^sdi_/);
    expect((await call("ivan", "GET", "/api/v1/integraciones/llaves")).body).toHaveLength(1);
    const yo = await app.inject({ url: "/api/integracion/v1/yo", headers: { authorization: `Bearer ${llave.body.key}` } });
    expect(JSON.parse(yo.body).empresa.code).toBe("002");
    expect((await call("ivan", "PUT", "/api/v1/correo/pedidos", { activo: true })).status).toBe(200);
    expect((await call("ivan", "PUT", "/api/v1/correo/conexion", { url: "http://mail:3000", llave: "ml_x" })).status).toBe(403);
    expect((await call("ivan", "GET", "/api/v1/datos/exportar")).status).toBe(403);
  });

  it("un comercial de la 002 entra con la contraseña pero no la cambia", async () => {
    expect((await call("pepe", "POST", "/api/v1/session/company", { company_id: B, password: "solo-de-ivan" })).status).toBe(200);
    expect((await call("pepe", "POST", "/api/v1/integraciones/llaves", { name: "otra" })).status).toBe(403);
    expect((await call("pepe", "PUT", "/api/v1/company/password", { actual: "solo-de-ivan", nueva: "de-pepe-123" })).status).toBe(403);
  });

  it("si se olvida, administración general la quita y se entra sin ella", async () => {
    expect((await call("luis", "DELETE", `/api/v1/companies/${B}/password`)).status).toBe(200);
    expect((await call("luis", "POST", "/api/v1/session/company", { company_id: B })).status).toBe(200);
    expect((await me("ivan")).company).toBe(B);
  });
});
