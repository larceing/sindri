import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, migrate, openEmbedded, type Db } from "../src/index.js";

/** La PDA reenvía lo que hizo sin conexión: la misma entrada, mandada dos veces, cuenta una. */
describe("Entrada de mercancía desde la PDA (sin duplicados)", () => {
  let db: Db;
  let app: FastifyInstance;
  const call = async (method: string, url: string, body?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, payload: body as object });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  beforeAll(async () => {
    db = await openEmbedded();
    await migrate(db);
    app = await buildApp({ db });
    await call("PUT", "/api/v1/company", { name: "Metal Demo SL", tax_id: "B12345674" });
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  const ID = "0f6c1b7e-3f1a-4c55-9d63-6a1f0f1e2a01";

  it("repetir la misma entrada con su id no suma dos veces", async () => {
    const tornillo = (await call("POST", "/api/v1/products", { sku: "TOR-8", name: "Tornillo M8", gtin: "08412345678905", track_lots: true })).body.id;
    const r1 = await call("POST", "/api/v1/stock/receipts", { id: ID, product_id: tornillo, quantity: "50", lot_code: "L1", expiry_date: "2027-12-31" });
    expect(r1.status).toBe(201);
    expect(r1.body.id).toBe(ID);
    const r2 = await call("POST", "/api/v1/stock/receipts", { id: ID, product_id: tornillo, quantity: "50", lot_code: "L1", expiry_date: "2027-12-31" });
    expect(r2.status).toBe(201);
    expect(r2.body.repetido).toBe(true);
    const [p] = (await call("GET", "/api/v1/products?q=TOR-8")).body;
    expect(p.on_hand).toBe("50.0000");
  });

  it("no deja reutilizar el id para otro producto", async () => {
    const otro = (await call("POST", "/api/v1/products", { sku: "ARA-8", name: "Arandela M8" })).body.id;
    expect((await call("POST", "/api/v1/stock/receipts", { id: ID, product_id: otro, quantity: "1" })).status).toBe(409);
  });

  it("sin id sigue funcionando como siempre", async () => {
    const r = await call("POST", "/api/v1/stock/receipts", { product_id: (await call("GET", "/api/v1/products?q=ARA-8")).body[0].id, quantity: "3" });
    expect(r.status).toBe(201);
    expect(r.body.repetido).toBeUndefined();
  });
});
