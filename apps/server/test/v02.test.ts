import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { buildApp, migrate, openEmbedded, type Db } from "../src/index.js";
import type { SsoConfig } from "../src/sso.js";

/** Keycloak de mentira: el code dice quién entra ("admin" o "comercial"). */
async function fakeKeycloak() {
  const kc = Fastify();
  kc.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_r, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  kc.post("/realms/general/protocol/openid-connect/token", async (req) => ({ access_token: (req.body as Record<string, string>).code }));
  kc.get("/realms/general/protocol/openid-connect/userinfo", async (req) => {
    const who = String(req.headers.authorization).slice(7);
    return { preferred_username: who, name: who === "admin" ? "Admin" : "Carla Comercial", groups: who === "admin" ? ["/DEV/Sindri/Admin"] : ["/DEV/Sindri"] };
  });
  await kc.listen({ port: 0, host: "127.0.0.1" });
  return { kc, issuer: `http://127.0.0.1:${(kc.server.address() as { port: number }).port}/realms/general` };
}

describe("Versión 0.2: empresas, usuarios, ficha de cliente, comerciales, separar pedidos, hojas de ruta e informes", () => {
  let db: Db;
  let app: FastifyInstance;
  let kc: FastifyInstance;
  const cookies: Record<string, Record<string, string>> = { admin: {}, comercial: {} };
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
    return { status: r.statusCode, body: r.body && r.headers["content-type"]?.toString().includes("json") ? JSON.parse(r.body) : r.body, headers: r.headers };
  };
  const login = async (who: string) => {
    const r = await app.inject({ url: "/login" });
    keep(who, r.headers["set-cookie"]);
    const state = new URL(r.headers.location as string).searchParams.get("state");
    const back = await app.inject({ url: `/sso?code=${who}&state=${state}`, headers: header(who) });
    keep(who, back.headers["set-cookie"]);
    expect(back.statusCode).toBe(302);
  };

  let empresaA: string, empresaB: string, cliente: string, comercial: string, acero: string, pedido: string;

  beforeAll(async () => {
    const fake = await fakeKeycloak();
    kc = fake.kc;
    db = await openEmbedded();
    await migrate(db);
    const cfg: SsoConfig = { issuer: fake.issuer, clientId: "sindri-dev", clientSecret: "s", appGroup: "DEV/Sindri", itGroup: "IT", sessionKey: "k" };
    app = await buildApp({ db, sso: cfg });
    await login("admin");
    await login("comercial");
  });
  afterAll(async () => {
    await app.close();
    await kc.close();
    await db.close();
  });

  it("sin empresa, pide configurarla; administración crea dos y al entrar se elige", async () => {
    expect((await call("admin", "GET", "/api/v1/partners")).body.code).toBe("sin_empresa");
    empresaA = (await call("admin", "PUT", "/api/v1/company", { name: "Metal Norte SL", tax_id: "B12345674" })).body.id;
    expect((await call("admin", "GET", "/api/v1/partners")).status).toBe(200); // una sola: se elige sola
    expect((await call("comercial", "POST", "/api/v1/companies", { name: "Otra SL", tax_id: "B41234568" })).status).toBe(403);
    empresaB = (await call("admin", "POST", "/api/v1/companies", { name: "Metal Sur SL", tax_id: "B41234568" })).body.id;
    expect((await call("admin", "GET", "/api/v1/partners")).body.code).toBe("elegir_empresa");
    expect((await call("admin", "GET", "/api/v1/me")).body).toMatchObject({ needs_company: true, admin: true });
    expect((await call("admin", "POST", "/api/v1/session/company", { company_id: empresaA })).status).toBe(200);
    expect((await call("admin", "GET", "/api/v1/me")).body.company).toBe(empresaA);
  });

  it("roles: una persona nueva entra como Consulta; con el rol Comercial edita clientes y pedidos, pero no productos ni usuarios", async () => {
    await call("comercial", "POST", "/api/v1/session/company", { company_id: empresaA });
    const me = (await call("comercial", "GET", "/api/v1/me")).body;
    expect(me.role).toBe("Consulta");
    expect(me.perms.clientes).toBe("ver");
    expect((await call("comercial", "POST", "/api/v1/partners", { name: "X" })).status).toBe(403);

    const roles = (await call("admin", "GET", "/api/v1/roles")).body as { id: string; name: string }[];
    const deps = (await call("admin", "GET", "/api/v1/departments")).body as { id: string; name: string }[];
    const users = (await call("admin", "GET", "/api/v1/users")).body as { id: string; username: string }[];
    const carla = users.find((u) => u.username === "comercial")!;
    await call("admin", "PATCH", `/api/v1/users/${carla.id}`, {
      role_id: roles.find((r) => r.name === "Comercial")!.id,
      department_id: deps.find((d) => d.name === "Comercial")!.id,
      company_ids: [empresaA],
    });
    const after = (await call("comercial", "GET", "/api/v1/me")).body;
    expect(after).toMatchObject({ role: "Comercial", department: "Comercial" });
    expect(after.companies.map((c: { id: string }) => c.id)).toEqual([empresaA]);
    expect((await call("comercial", "POST", "/api/v1/products", { sku: "X", name: "X" })).status).toBe(403);
    expect((await call("comercial", "GET", "/api/v1/users")).status).toBe(403);
    // Una empresa que no es suya no se puede elegir.
    expect((await call("comercial", "POST", "/api/v1/session/company", { company_id: empresaB })).status).toBe(403);
  });

  it("cada persona guarda su menú", async () => {
    const menu = { posicion: "inferior", orden: ["pedidos", "clientes", "inicio"], ocultos: ["planta"] };
    expect((await call("comercial", "PUT", "/api/v1/me/menu", menu)).status).toBe(200);
    expect((await call("comercial", "GET", "/api/v1/me")).body.menu).toEqual(menu);
    expect((await call("comercial", "PUT", "/api/v1/me/menu", { ...menu, posicion: "diagonal" })).status).toBe(400);
  });

  it("comerciales y ficha de cliente completa, con contactos y direcciones de entrega", async () => {
    comercial = (await call("admin", "POST", "/api/v1/sales-reps", { code: "C01", name: "Carla", commission_pct: "4", zone: "Norte" })).body.id;
    const c = await call("comercial", "POST", "/api/v1/partners", {
      name: "Ferretería Norte SL", trade_name: "Ferrenorte", tax_id: "A58818501", sales_rep_id: comercial,
      payment_method: "Recibo SEPA", payment_days: 30, credit_limit: "5000", discount_pct: "5", iban: "ES91 2100 0418 4502 0005 1332", route_zone: "Norte",
    });
    expect(c.status).toBe(201);
    cliente = c.body.id;
    expect(c.body.iban).toBe("ES9121000418450200051332");
    expect((await call("comercial", "POST", "/api/v1/partners", { name: "Mal", iban: "123" })).status).toBe(422);
    await call("comercial", "POST", `/api/v1/partners/${cliente}/contacts`, { name: "Pedro Compras", phone: "600111222" });
    await call("comercial", "POST", `/api/v1/partners/${cliente}/addresses`, { label: "Almacén", address: "Pol. Ind. 3", city: "Bilbao", is_default: true });
    const ficha = (await call("comercial", "GET", `/api/v1/partners/${cliente}`)).body;
    expect(ficha).toMatchObject({ trade_name: "Ferrenorte", sales_rep_name: "Carla", payment_days: 30 });
    expect(ficha.contacts).toHaveLength(1);
    expect(ficha.addresses[0]).toMatchObject({ label: "Almacén", is_default: true });
    // Los datos de una empresa no se ven desde la otra.
    await call("admin", "POST", "/api/v1/session/company", { company_id: empresaB });
    expect((await call("admin", "GET", `/api/v1/partners/${cliente}`)).status).toBe(404);
    expect((await call("admin", "GET", "/api/v1/partners")).body).toHaveLength(0);
    await call("admin", "POST", "/api/v1/session/company", { company_id: empresaA });
  });

  it("el pedido toma comercial, descuento y dirección del cliente; se separa en dos", async () => {
    acero = (await call("admin", "POST", "/api/v1/products", { sku: "SOP-01", name: "Soporte acero", sale_price: "10" })).body.id;
    await call("admin", "POST", "/api/v1/stock/receipts", { product_id: acero, quantity: "100" });
    const o = (await call("comercial", "POST", "/api/v1/sales-orders", { partner_id: cliente, lines: [{ product_id: acero, quantity: "10" }] })).body;
    pedido = o.id;
    expect(o).toMatchObject({ sales_rep_name: "Carla" });
    expect(o.delivery_address.label).toBe("Almacén");
    expect(o.lines[0].discount_pct).toBe("5.00");
    expect(o.actions).toContain("split");

    const lineId = o.lines[0].id;
    expect((await call("comercial", "POST", `/api/v1/sales-orders/${pedido}/split`, { lines: [{ line_id: lineId, quantity: "10" }] })).status).toBe(422);
    expect((await call("comercial", "POST", `/api/v1/sales-orders/${pedido}/split`, { lines: [{ line_id: lineId, quantity: "11" }] })).status).toBe(422);
    const r = await call("comercial", "POST", `/api/v1/sales-orders/${pedido}/split`, { lines: [{ line_id: lineId, quantity: "4" }] });
    expect(r.status).toBe(201);
    expect(r.body.order.lines[0].quantity).toBe("6.0000");
    expect(r.body.new_order).toMatchObject({ state: "draft", split_from_number: o.number, sales_rep_name: "Carla" });
    expect(r.body.new_order.lines[0].quantity).toBe("4.0000");
    expect(r.body.order.splits).toHaveLength(1);
  });

  it("hoja de ruta: mete pedidos confirmados, sale, marca cada parada y se cierra", async () => {
    expect((await call("admin", "POST", "/api/v1/routes", { order_ids: [pedido] })).status).toBe(422); // en borrador no se reparte
    await call("admin", "POST", `/api/v1/sales-orders/${pedido}/confirm`);
    await call("admin", "POST", `/api/v1/sales-orders/${pedido}/deliver`);
    expect((await call("admin", "GET", "/api/v1/routes/candidates")).body.map((x: { id: string }) => x.id)).toContain(pedido);
    const hr = (await call("admin", "POST", "/api/v1/routes", { driver: "Juan", vehicle: "1234-ABC", order_ids: [pedido] })).body;
    expect(hr.number).toMatch(/^HR\d{4}-00001$/);
    expect(hr.stops[0]).toMatchObject({ partner_name: "Ferretería Norte SL", city: "Bilbao", address_label: "Almacén" });
    expect(hr.stops[0].lines[0].sku).toBe("SOP-01");
    expect((await call("admin", "POST", "/api/v1/routes", { order_ids: [pedido] })).status).toBe(409); // ya va en otra hoja
    await call("admin", "POST", `/api/v1/routes/${hr.id}/start`);
    expect((await call("admin", "POST", `/api/v1/routes/${hr.id}/close`)).status).toBe(422);
    await call("admin", "POST", `/api/v1/routes/${hr.id}/stops/${hr.stops[0].id}/state`, { state: "delivered", note: "Firma Pedro" });
    expect((await call("admin", "POST", `/api/v1/routes/${hr.id}/close`)).body.state).toBe("closed");
  });

  it("informes: lector con token propio, solo de su empresa, en JSON, CSV y XML", async () => {
    const lector = (await call("admin", "POST", "/api/v1/informes/lectores", { name: "Report Server" })).body;
    expect(lector.token).toMatch(/^sdi_/);
    expect((await app.inject({ url: "/api/informes/v1/clientes" })).statusCode).toBe(401);
    const json = await app.inject({ url: "/api/informes/v1/clientes", headers: { authorization: `Bearer ${lector.token}` } });
    expect(JSON.parse(json.body)[0]).toMatchObject({ nombre: "Ferretería Norte SL", comercial: "Carla" });
    const csv = await app.inject({ url: `/api/informes/v1/pedidos?formato=csv&token=${lector.token}` });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("pedido;fecha");
    const xml = await app.inject({ url: `/api/informes/v1/hojas_ruta?formato=xml&token=${lector.token}` });
    expect(xml.body).toContain("<conductor>Juan</conductor>");
    await call("admin", "POST", `/api/v1/informes/lectores/${lector.id}/revocar`);
    expect((await app.inject({ url: `/api/informes/v1/clientes?token=${lector.token}` })).statusCode).toBe(401);
  });

  it("documentos: arma los datos del albarán y de la hoja de ruta; sin Report Server lo dice", async () => {
    const alb = (await call("admin", "GET", `/api/v1/documentos/albaran/${pedido}/datos`)).body;
    expect(alb).toMatchObject({ pedido: expect.stringMatching(/^PV/), cliente: { nombre: "Ferretería Norte SL" }, comercial: "Carla" });
    expect(alb.lineas[0]).toMatchObject({ referencia: "SOP-01", cantidad: 6 });
    expect((await call("admin", "GET", "/api/v1/documentos")).body).toEqual({ report_server: false, plantillas: [] });
    expect((await call("admin", "GET", `/api/v1/documentos/pedido/${pedido}/pdf`)).status).toBe(501);
  });
});
