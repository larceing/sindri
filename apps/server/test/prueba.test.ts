import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, migrate, openEmbedded, type Db } from "../src/index.js";
import { seedDemo } from "../src/demo.js";

describe("Sistema de prueba: datos de demostración y acceso con clave", () => {
  let db: Db;
  let app: FastifyInstance;
  const basic = (u: string, p: string) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

  beforeAll(async () => {
    db = await openEmbedded();
    await migrate(db);
    app = await buildApp({ db, auth: { user: "prueba", password: "una:clave" } });
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it("carga los datos de demostración una sola vez", async () => {
    expect(await seedDemo(db)).toBe(true);
    expect(await seedDemo(db)).toBe(false);
    const [first] = await db.query<{ id: string }>("select id from company order by created_at, id limit 1");
    const orders = await db.query<{ state: string }>("select state from sales_order where company_id = $1", [first!.id]);
    expect(orders.map((o) => o.state).sort()).toEqual(["confirmed", "delivered", "draft", "invoiced", "invoiced"]);
    expect(await db.query("select 1 from company")).toHaveLength(2);
    const chain = await db.query("select * from verifactu_record");
    expect(chain).toHaveLength(2);
  });

  it("pide usuario y clave salvo para la comprobación de salud", async () => {
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
    const sin = await app.inject({ url: "/api/v1/invoices" });
    expect(sin.statusCode).toBe(401);
    expect(sin.headers["www-authenticate"]).toContain("Basic");
    expect((await app.inject({ url: "/api/v1/invoices", headers: { authorization: basic("prueba", "mala") } })).statusCode).toBe(401);
    const auth = { authorization: basic("prueba", "una:clave") };
    // Con dos empresas, primero se elige con cuál se trabaja.
    const elegir = await app.inject({ url: "/api/v1/invoices", headers: auth });
    expect(elegir.statusCode).toBe(409);
    expect(JSON.parse(elegir.body).code).toBe("elegir_empresa");
    const me = JSON.parse((await app.inject({ url: "/api/v1/me", headers: auth })).body);
    expect(me.needs_company).toBe(true);
    const sel = await app.inject({ method: "POST", url: "/api/v1/session/company", headers: auth, payload: { company_id: me.companies[0].id } });
    const cookie = String(sel.headers["set-cookie"]).split(";")[0]!;
    const ok = await app.inject({ url: "/api/v1/invoices", headers: { ...auth, cookie } });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toHaveLength(2);
  });
});
