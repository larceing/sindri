import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { buildApp, migrate, openEmbedded, type Db } from "../src/index.js";
import { access, sign, verify, type SsoConfig } from "../src/sso.js";

/** Keycloak de mentira: acepta el code "bueno" y devuelve una persona con los grupos indicados. */
async function fakeKeycloak(groups: () => string[]) {
  const kc = Fastify();
  kc.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_r, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  kc.post("/realms/general/protocol/openid-connect/token", async (req, reply) => {
    const b = req.body as Record<string, string>;
    if (b.code !== "bueno" || b.client_secret !== "secreto") return reply.status(400).send({ error: "invalid_grant" });
    return { access_token: "tok" };
  });
  kc.get("/realms/general/protocol/openid-connect/userinfo", async () => ({ preferred_username: "luis", name: "Luis", email: "l@x.test", groups: groups() }));
  await kc.listen({ port: 0, host: "127.0.0.1" });
  const addr = kc.server.address() as { port: number };
  return { kc, issuer: `http://127.0.0.1:${addr.port}/realms/general` };
}

describe("Entrada con Keycloak en el servidor DEV/PRO", () => {
  let db: Db;
  let app: FastifyInstance;
  let kc: FastifyInstance;
  let groups = ["/DEV/Sindri"];
  let cfg: SsoConfig;
  const proxied = { "x-forwarded-proto": "https", "x-forwarded-host": "dev.ejemplo.test", "x-forwarded-prefix": "/sindri" };

  beforeAll(async () => {
    const fake = await fakeKeycloak(() => groups);
    kc = fake.kc;
    db = await openEmbedded();
    await migrate(db);
    await db.query("insert into company (name, tax_id) values ('Metal Demo SL', 'B12345674')");
    cfg = { issuer: fake.issuer, clientId: "sindri-dev", clientSecret: "secreto", appGroup: "DEV/Sindri", itGroup: "IT", sessionKey: "k" };
    app = await buildApp({ db, sso: cfg, version: "sha-abc1234", trustProxy: true });
  });
  afterAll(async () => {
    await app.close();
    await kc.close();
    await db.close();
  });

  it("responde la versión sin sesión, como espera Ajustes", async () => {
    const r = await app.inject({ url: "/version/" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ version: "sha-abc1234", escritorio_minima: expect.any(String) });
  });

  it("sin sesión, la web lleva al login y la API responde 401", async () => {
    const page = await app.inject({ url: "/", headers: proxied });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe("https://dev.ejemplo.test/sindri/login");
    expect((await app.inject({ url: "/api/v1/invoices", headers: proxied })).statusCode).toBe(401);
  });

  it("el login va a Keycloak con la vuelta bajo la ruta de la app", async () => {
    const r = await app.inject({ url: "/login", headers: proxied });
    const to = new URL(r.headers.location as string);
    expect(to.pathname).toBe("/realms/general/protocol/openid-connect/auth");
    expect(to.searchParams.get("redirect_uri")).toBe("https://dev.ejemplo.test/sindri/sso");
    expect(r.headers["set-cookie"]).toContain("Path=/sindri");
    expect(r.headers["set-cookie"]).toContain("Secure");
  });

  const login = async () => {
    const r = await app.inject({ url: "/login", headers: proxied });
    const state = new URL(r.headers.location as string).searchParams.get("state")!;
    const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
    return app.inject({ url: `/sso?code=bueno&state=${state}`, headers: { ...proxied, cookie } });
  };

  it("vuelve de Keycloak, abre sesión y deja usar la API", async () => {
    groups = ["/DEV/Sindri"];
    const r = await login();
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe("https://dev.ejemplo.test/sindri/");
    const cookies = ([] as string[]).concat(r.headers["set-cookie"] ?? []);
    const session = cookies.find((c) => c.startsWith("sindri_sesion="))!.split(";")[0]!;
    const me = await app.inject({ url: "/api/v1/me", headers: { ...proxied, cookie: session } });
    expect(JSON.parse(me.body)).toMatchObject({ user: "luis", admin: false });
    expect((await app.inject({ url: "/api/v1/invoices", headers: { ...proxied, cookie: session } })).statusCode).toBe(200);
  });

  it("rechaza a quien no está en el grupo de la app ni en IT", async () => {
    groups = ["/PRO/Sindri", "/DEV/Otra"];
    expect((await login()).statusCode).toBe(403);
  });

  it("rechaza un estado que no coincide", async () => {
    const r = await app.inject({ url: "/sso?code=bueno&state=otro", headers: proxied });
    expect(r.statusCode).toBe(400);
  });

  it("grupos: entra el de la app y sus subgrupos; administran Admin e IT", () => {
    const c = { appGroup: "DEV/Sindri", itGroup: "IT" };
    expect(access(["/DEV/Sindri/Almacen"], c)).toEqual({ enters: true, admin: false });
    expect(access(["/DEV/Sindri/Admin"], c)).toEqual({ enters: true, admin: true });
    expect(access(["/IT"], c)).toEqual({ enters: true, admin: true });
    expect(access(["/DEV/SindriX"], c)).toEqual({ enters: false, admin: false });
  });

  it("una cookie manipulada o caducada no vale", () => {
    const t = sign({ user: "a", exp: Date.now() + 1000 }, "k");
    expect(verify(t, "k")).toMatchObject({ user: "a" });
    expect(verify(t, "otra")).toBeNull();
    expect(verify(t.replace(/^./, "x"), "k")).toBeNull();
    expect(verify(sign({ user: "a", exp: Date.now() - 1 }, "k"), "k")).toBeNull();
  });
});
