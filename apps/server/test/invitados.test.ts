import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { buildApp, migrate, openEmbedded, type Db } from "../src/index.js";
import type { SsoConfig } from "../src/sso.js";

/**
 * Invitaciones, como en un ERP: quien administra una empresa invita a otra persona con el rol que
 * elige. Dos técnicos, cada uno con su empresa reservada y con contraseña:
 *  - luis: IT y grupo Empresa/001.
 *  - ivan: administra solo la 002 (Empresa/002 + Rol/Administración).
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

describe("Invitar a otra persona a tu empresa con un rol", () => {
  let db: Db;
  let app: FastifyInstance;
  let kc: FastifyInstance;
  const cookies: Record<string, Record<string, string>> = { luis: {}, ivan: {} };
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
    for (const who of ["luis", "ivan"]) await login(who);
  });
  afterAll(async () => {
    await app.close();
    await kc.close();
    await db.close();
  });

  let rol: Record<string, string>;

  it("cada uno en su empresa reservada y con contraseña", async () => {
    A = (await call("luis", "PUT", "/api/v1/company", { name: "Luis Consultoría", tax_id: "B12345674" })).body.id;
    B = (await call("luis", "POST", "/api/v1/companies", { name: "Ivan Servicios", tax_id: "B41234568" })).body.id;
    expect((await call("luis", "POST", "/api/v1/session/company", { company_id: A })).status).toBe(200);
    expect((await call("luis", "PUT", "/api/v1/company/password", { nueva: "clave-de-luis" })).status).toBe(200);
    expect((await call("luis", "PUT", "/api/v1/company/sharing", { restricted: true })).status).toBe(200);
    expect((await call("luis", "POST", "/api/v1/session/company", { company_id: B })).status).toBe(200);
    expect((await call("luis", "PUT", "/api/v1/company/password", { nueva: "clave-de-ivan" })).status).toBe(200);
    expect((await call("luis", "PUT", "/api/v1/company/sharing", { restricted: true, aun_sin_verla: true })).status).toBe(200);
    // Reservada: Luis ya no la ve.
    expect((await me("luis")).companies.map((c: { id: string }) => c.id)).toEqual([A]);
    expect((await call("ivan", "POST", "/api/v1/session/company", { company_id: B, password: "clave-de-ivan" })).status).toBe(200);
    expect((await call("ivan", "POST", "/api/v1/session/company", { company_id: A })).status).toBe(403);
  });

  it("Ivan invita a Luis a la 002 solo para consultar", async () => {
    const r = await call("ivan", "GET", "/api/v1/company/members");
    expect(r.status).toBe(200);
    expect(r.body.members).toEqual([]);
    rol = Object.fromEntries(r.body.roles.map((x: { name: string; id: string }) => [x.name, x.id]));
    expect((await call("ivan", "POST", "/api/v1/company/members", { username: "ivan", role_id: rol.Consulta })).status).toBe(400);
    expect((await call("ivan", "POST", "/api/v1/company/members", { username: "luis", role_id: rol.Consulta })).status).toBe(201);
    const m = await me("luis");
    const b = m.companies.find((c: { id: string }) => c.id === B);
    expect(b.guest).toBe(true);
    // Entra sin la contraseña de Ivan: le ha invitado él.
    expect((await call("luis", "POST", "/api/v1/session/company", { company_id: B })).status).toBe(200);
    const dentro = await me("luis");
    expect(dentro.company).toBe(B);
    expect(dentro.guest).toBe(true);
    // Ahí no es administrador de nada: solo lo que dice su rol.
    expect(dentro.admin).toBe(false);
    expect(dentro.company_admin).toBe(false);
    expect(dentro.perms.facturas).toBe("ver");
    expect((await call("luis", "GET", "/api/v1/partners")).status).toBe(200);
    expect((await call("luis", "POST", "/api/v1/partners", { name: "X" })).status).toBe(403);
    expect((await call("luis", "GET", "/api/v1/users")).status).toBe(403);
    expect((await call("luis", "GET", "/api/v1/company/members")).status).toBe(403);
    expect((await call("luis", "GET", "/api/v1/integraciones/llaves")).status).toBe(403);
    expect((await call("luis", "PUT", "/api/v1/company/password", { actual: "clave-de-ivan", nueva: "otra-clave" })).status).toBe(403);
    expect((await call("luis", "PUT", "/api/v1/company/sharing", { restricted: false })).status).toBe(403);
  });

  it("Ivan le cambia el rol y luego le quita la invitación", async () => {
    const luis = (await call("ivan", "GET", "/api/v1/company/members")).body.members[0];
    expect(luis.username).toBe("luis");
    expect(luis.role_name).toBe("Consulta");
    expect(luis.invited_by).toBe("ivan");
    expect((await call("ivan", "PATCH", `/api/v1/company/members/${luis.user_id}`, { role_id: rol.Comercial })).status).toBe(200);
    expect((await me("luis")).perms.facturas).toBe("ver");
    expect((await me("luis")).perms.clientes).toBe("editar");
    expect((await call("ivan", "DELETE", `/api/v1/company/members/${luis.user_id}`)).status).toBe(200);
    const m = await me("luis");
    expect(m.companies.map((c: { id: string }) => c.id)).toEqual([A]);
    expect(m.company).toBeNull();
    expect((await call("luis", "GET", "/api/v1/partners")).status).toBe(409);
  });

  it("y al revés: Luis invita a Ivan a la 001 como comercial", async () => {
    expect((await call("luis", "POST", "/api/v1/session/company", { company_id: A, password: "clave-de-luis" })).status).toBe(200);
    expect((await me("luis")).admin).toBe(true);
    expect((await call("luis", "POST", "/api/v1/company/members", { username: "ivan", role_id: rol.Comercial })).status).toBe(201);
    expect((await call("ivan", "POST", "/api/v1/session/company", { company_id: A })).status).toBe(200);
    const m = await me("ivan");
    expect(m.guest).toBe(true);
    expect(m.company_admin).toBe(false);
    expect((await call("ivan", "GET", "/api/v1/integraciones/llaves")).status).toBe(403);
    // Al volver a la suya sigue siendo quien la administra (con su contraseña ya escrita).
    expect((await call("ivan", "POST", "/api/v1/session/company", { company_id: B })).status).toBe(200);
    expect((await me("ivan")).company_admin).toBe(true);
    // Lo que se toca en Usuarios no se lleva las invitaciones.
    const ivanId = (await call("luis", "GET", "/api/v1/company/members")).body.members[0].user_id;
    expect((await call("luis", "PATCH", `/api/v1/users/${ivanId}`, { company_ids: [] })).status).toBe(200);
    expect((await me("ivan")).companies.some((c: { id: string; guest: boolean }) => c.id === A && c.guest)).toBe(true);
    // Un rol en uso por una invitación no se borra.
    expect((await call("luis", "DELETE", `/api/v1/roles/${rol.Comercial}`)).status).toBe(409);
  });
});
