import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { buildApp, migrate, openEmbedded, type Db } from "../src/index.js";
import { readDataset } from "../src/informes.js";
import type { SsoConfig } from "../src/sso.js";

/**
 * Dos personas en la misma base, cada una en su empresa, con clientes y productos comunes:
 *  - luis: IT y grupo Empresa/001.
 *  - ivan: grupos Empresa/002 y Rol/Comercial.
 *  - admin: administra Sindri, sin grupo de empresa.
 */
const GRUPOS: Record<string, string[]> = {
  luis: ["/IT", "/DEV/Sindri/Empresa/001"],
  ivan: ["/DEV/Sindri/Empresa/002", "/DEV/Sindri/Rol/Comercial"],
  admin: ["/DEV/Sindri/Admin"],
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

describe("Empresas separadas con clientes y productos comunes, filtradas por Keycloak", () => {
  let db: Db;
  let app: FastifyInstance;
  let kc: FastifyInstance;
  const cookies: Record<string, Record<string, string>> = { luis: {}, ivan: {}, admin: {} };
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
    return { status: r.statusCode, body: r.body && r.headers["content-type"]?.toString().includes("json") ? JSON.parse(r.body) : r.body };
  };
  const login = async (who: string) => {
    const r = await app.inject({ url: "/login" });
    keep(who, r.headers["set-cookie"]);
    const state = new URL(r.headers.location as string).searchParams.get("state");
    const back = await app.inject({ url: `/sso?code=${who}&state=${state}`, headers: header(who) });
    keep(who, back.headers["set-cookie"]);
    expect(back.statusCode).toBe(302);
  };
  const usar = async (who: string, company: string) => expect((await call(who, "POST", "/api/v1/session/company", { company_id: company })).status).toBe(200);

  let A: string, B: string, comun: string, servicio: string, pedidoIvan: string;

  beforeAll(async () => {
    const fake = await fakeKeycloak();
    kc = fake.kc;
    db = await openEmbedded();
    await migrate(db);
    const cfg: SsoConfig = { issuer: fake.issuer, clientId: "sindri-dev", clientSecret: "s", appGroup: "DEV/Sindri", itGroup: "IT", sessionKey: "k" };
    app = await buildApp({ db, sso: cfg });
    for (const who of ["luis", "ivan", "admin"]) await login(who);
  });
  afterAll(async () => {
    await app.close();
    await kc.close();
    await db.close();
  });

  it("dos empresas: la segunda usa los clientes y productos de la primera y cada una es reservada", async () => {
    A = (await call("luis", "PUT", "/api/v1/company", { name: "Luis Consultoría", tax_id: "B12345674" })).body.id;
    B = (await call("luis", "POST", "/api/v1/companies", { name: "Ivan Servicios", tax_id: "B41234568" })).body.id;
    await usar("luis", A);
    comun = (await call("luis", "POST", "/api/v1/partners", { name: "Cliente Común SL", tax_id: "B91234567" })).body.id;
    servicio = (await call("luis", "POST", "/api/v1/products", { sku: "SRV-H", name: "Hora de servicio", kind: "service", uom: "h", sale_price: "25" })).body.id;

    // Con clientes propios no se puede pasar a usar los de otra.
    expect((await call("luis", "PUT", "/api/v1/company/sharing", { master_company_id: B })).status).toBe(409);

    await usar("luis", B);
    expect((await call("luis", "PUT", "/api/v1/company/sharing", { master_company_id: A })).body.master_company_id).toBe(A);
    // Luis no está en Empresa/002: reservarla es dejar de verla, y lo tiene que confirmar.
    const sinConfirmar = await call("luis", "PUT", "/api/v1/company/sharing", { restricted: true });
    expect(sinConfirmar).toMatchObject({ status: 409, body: { code: "dejarias_de_verla" } });
    expect((await call("luis", "PUT", "/api/v1/company/sharing", { restricted: true, aun_sin_verla: true })).body.restricted).toBe(true);

    await usar("luis", A);
    expect((await call("luis", "PUT", "/api/v1/company/sharing", { restricted: true })).body.restricted).toBe(true);
    // A ya da maestros a B: no puede pasar a usar los de otra.
    expect((await call("luis", "PUT", "/api/v1/company/sharing", { master_company_id: B })).status).toBe(409);
  });

  it("cada uno ve solo su empresa; quien administra Sindri no ve las reservadas", async () => {
    // La sesión guarda las empresas al pedir /me de nuevo.
    expect((await call("luis", "GET", "/api/v1/me")).body.companies.map((c: { id: string }) => c.id)).toEqual([A]);
    const ivan = (await call("ivan", "GET", "/api/v1/me")).body;
    expect(ivan.companies.map((c: { id: string }) => c.id)).toEqual([B]);
    expect(ivan.company).toBe(B);
    expect(ivan.role).toBe("Comercial");
    expect((await call("luis", "GET", "/api/v1/companies")).body.map((c: { id: string }) => c.id)).toEqual([A]);
    expect((await call("admin", "GET", "/api/v1/companies")).body).toEqual([]);
    expect((await call("luis", "POST", "/api/v1/session/company", { company_id: B })).status).toBe(403);
    expect((await call("ivan", "POST", "/api/v1/session/company", { company_id: A })).status).toBe(403);
    // Ivan es comercial: no toca la configuración de empresas.
    expect((await call("ivan", "PUT", "/api/v1/company/sharing", { restricted: false })).status).toBe(403);
  });

  it("los clientes y productos son comunes: lo que da de alta uno lo ve el otro", async () => {
    const clientesIvan = (await call("ivan", "GET", "/api/v1/partners")).body.map((p: { name: string }) => p.name);
    expect(clientesIvan).toContain("Cliente Común SL");
    expect((await call("ivan", "GET", "/api/v1/products")).body.map((p: { sku: string }) => p.sku)).toContain("SRV-H");
    const nuevo = await call("ivan", "POST", "/api/v1/partners", { name: "Cliente de Ivan SL" });
    expect(nuevo.status).toBe(201);
    expect((await call("luis", "GET", "/api/v1/partners")).body.map((p: { name: string }) => p.name)).toContain("Cliente de Ivan SL");
  });

  it("el precio de la línea manda sobre la tarifa: 6 h a 30 € aunque la tarifa diga 25", async () => {
    const r = await call("ivan", "POST", "/api/v1/sales-orders", { partner_id: comun, lines: [{ product_id: servicio, quantity: "6", unit_price: "30" }] });
    expect(r.status).toBe(201);
    pedidoIvan = r.body.id;
    expect(r.body.totals.untaxed).toBe("180.00");
    // Sin precio, la tarifa común.
    const t = await call("ivan", "POST", "/api/v1/sales-orders", { partner_id: comun, lines: [{ product_id: servicio, quantity: "6" }] });
    expect(t.body.totals.untaxed).toBe("150.00");
    expect((await call("luis", "GET", `/api/v1/products`)).body.find((p: { sku: string }) => p.sku === "SRV-H").sale_price).toMatch(/^25/);
  });

  it("los documentos son de cada empresa: ni la lista, ni la ficha del cliente, ni los informes enseñan los del otro", async () => {
    expect((await call("luis", "GET", "/api/v1/sales-orders")).body).toEqual([]);
    expect((await call("luis", "GET", `/api/v1/sales-orders/${pedidoIvan}`)).status).toBe(404);
    const ficha = (await call("luis", "GET", `/api/v1/partners/${comun}`)).body;
    expect(ficha.orders).toEqual([]);
    expect(ficha.stats.orders).toBe("0");
    expect((await call("ivan", "GET", `/api/v1/partners/${comun}`)).body.stats.orders).toBe("2");

    expect(await readDataset(db, A, "pedidos")).toEqual([]);
    expect((await readDataset(db, B, "pedidos")).length).toBe(2);
    expect((await readDataset(db, B, "clientes")).map((c) => c.nombre)).toContain("Cliente Común SL");
  });
});
