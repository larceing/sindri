import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, migrate, openEmbedded, type Db } from "../src/index.js";
import { releaseSalesOrder, takeSalesOrder } from "../src/services.js";

/** Fase 2 de la PDA: ubicaciones, traspasos, salida con el lote leído, reserva y recuentos. */
describe("Almacén con ubicaciones (PDA fase 2)", () => {
  let db: Db;
  let app: FastifyInstance;
  let bonito: string;
  let caja: string;
  let cliente: string;
  const call = async (method: string, url: string, body?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, payload: body as object });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  const stockDe = async (sku: string) =>
    ((await call("GET", "/api/v1/stock")).body as { sku: string; lot_code: string | null; location_code: string; quantity: string }[])
      .filter((s) => s.sku === sku)
      .map((s) => `${s.location_code}:${s.lot_code ?? "-"}:${Number(s.quantity)}`)
      .sort();
  const uuid = () => crypto.randomUUID();

  beforeAll(async () => {
    db = await openEmbedded();
    await migrate(db);
    app = await buildApp({ db });
    await call("PUT", "/api/v1/company", { name: "Conservas Prueba SL", tax_id: "B12345674" });
    bonito = (await call("POST", "/api/v1/products", { sku: "BON", name: "Bonito", track_lots: true })).body.id;
    caja = (await call("POST", "/api/v1/products", { sku: "CAJ", name: "Caja" })).body.id;
    cliente = (await call("POST", "/api/v1/partners", { kind: "customer", name: "Cliente SA", tax_id: "A59144956" })).body.id;
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it("crea ubicaciones bajo el almacén y no repite código", async () => {
    expect((await call("POST", "/api/v1/locations", { code: "a-01", name: "Estantería A, hueco 1" })).status).toBe(201);
    expect((await call("POST", "/api/v1/locations", { code: "A-02" })).status).toBe(201);
    expect((await call("POST", "/api/v1/locations", { code: "A-02-1", parent_code: "a-02" })).status).toBe(201);
    expect((await call("POST", "/api/v1/locations", { code: "A-01" })).status).toBe(409);
    expect((await call("POST", "/api/v1/locations", { code: "mal código" })).status).toBe(422);
    const locs = (await call("GET", "/api/v1/locations")).body as { code: string; parent_id: string | null }[];
    expect(locs.map((l) => l.code)).toEqual(expect.arrayContaining(["WH/STOCK", "A-01", "A-02", "A-02-1"]));
  });

  it("ubica al recibir y traspasa sin duplicar", async () => {
    await call("POST", "/api/v1/stock/receipts", { product_id: bonito, quantity: "30", lot_code: "L-NUEVO", expiry_date: "2028-06-30", location_code: "A-01" });
    await call("POST", "/api/v1/stock/receipts", { product_id: bonito, quantity: "10", lot_code: "L-VIEJO", expiry_date: "2027-01-31", location_code: "a-02" });
    await call("POST", "/api/v1/stock/receipts", { product_id: caja, quantity: "100" });
    expect(await stockDe("BON")).toEqual(["A-01:L-NUEVO:30", "A-02:L-VIEJO:10"]);

    const id = uuid();
    const t = { id, product_id: bonito, quantity: "5", lot_code: "L-NUEVO", from_location_code: "A-01", to_location_code: "A-02-1" };
    expect((await call("POST", "/api/v1/stock/transfers", t)).status).toBe(201);
    expect((await call("POST", "/api/v1/stock/transfers", t)).body.repetido).toBe(true);
    expect(await stockDe("BON")).toEqual(["A-01:L-NUEVO:25", "A-02-1:L-NUEVO:5", "A-02:L-VIEJO:10"]);

    const demasiado = await call("POST", "/api/v1/stock/transfers", { ...t, id: uuid(), quantity: "26", to_location_code: "A-02" });
    expect(demasiado.status).toBe(422);
    expect(demasiado.body.error).toContain("hay 25");
    expect((await call("POST", "/api/v1/stock/transfers", { ...t, id: uuid(), lot_code: undefined })).body.error).toContain("lleva lote");
    expect((await call("POST", "/api/v1/stock/transfers", { ...t, id: uuid(), to_location_code: "NO-EXISTE" })).status).toBe(404);
  });

  const pedido = async (cantidadBonito: string) => {
    const o = (await call("POST", "/api/v1/sales-orders", { partner_id: cliente, lines: [{ product_id: bonito, quantity: cantidadBonito }, { product_id: caja, quantity: "2" }] })).body;
    await call("POST", `/api/v1/sales-orders/${o.id}/confirm`);
    return o.id as string;
  };

  it("da salida exactamente del lote y la ubicación leídos", async () => {
    const id = await pedido("6");
    // No coincide con lo pedido: se rechaza y no cambia nada.
    const mal = await call("POST", `/api/v1/sales-orders/${id}/deliver`, { picks: [{ product_id: bonito, quantity: "5", lot_code: "L-NUEVO", location_code: "A-01" }, { product_id: caja, quantity: "2" }] });
    expect(mal.status).toBe(422);
    expect(mal.body.error).toContain("se han leído 5");
    const r = await call("POST", `/api/v1/sales-orders/${id}/deliver`, {
      picks: [
        { product_id: bonito, quantity: "4", lot_code: "L-NUEVO", location_code: "A-02-1" },
        { product_id: bonito, quantity: "2", lot_code: "L-NUEVO", location_code: "A-01" },
        { product_id: caja, quantity: "2" },
      ],
    });
    expect(r.body.error ?? r.status).toBe(200);
    // El lote viejo (FEFO) no se ha tocado porque se leyó el nuevo.
    expect(await stockDe("BON")).toEqual(["A-01:L-NUEVO:23", "A-02-1:L-NUEVO:1", "A-02:L-VIEJO:10"]);
    expect(await stockDe("CAJ")).toEqual(["WH/STOCK:-:98"]);
  });

  it("sin lecturas sale por FEFO en cualquier ubicación", async () => {
    const id = await pedido("12");
    expect((await call("POST", `/api/v1/sales-orders/${id}/deliver`)).status).toBe(200);
    // 10 del lote viejo (A-02) y 2 del nuevo, primero A-01 por orden de ubicación.
    expect(await stockDe("BON")).toEqual(["A-01:L-NUEVO:21", "A-02-1:L-NUEVO:1"]);
  });

  it("el pedido queda reservado a quien lo prepara", async () => {
    const id = await pedido("1");
    const [{ id: company }] = await db.query<{ id: string }>("select id from company limit 1");
    const ana = { company, actor: "ana" };
    const luis = { company, actor: "luis" };
    expect((await takeSalesOrder(db, ana, id)).picked_by).toBe("ana");
    await expect(takeSalesOrder(db, luis, id)).rejects.toThrow("Lo está preparando ana");
    expect((await takeSalesOrder(db, luis, id, true)).picked_by).toBe("luis");
    expect((await releaseSalesOrder(db, ana, id)).picked_by).toBe("luis");
    expect((await releaseSalesOrder(db, luis, id)).picked_by).toBeNull();
    // Por la API, con el usuario de la sesión.
    expect((await call("POST", `/api/v1/sales-orders/${id}/take`, {})).status).toBe(200);
  });

  it("recuento a ciegas: solo lo contado hasta terminar; al aprobar, ajusta las diferencias", async () => {
    const c = (await call("POST", "/api/v1/stock/counts", { location_code: "A-01" })).body;
    expect(c.number).toMatch(/^INV\d{4}-/);
    const e1 = { id: uuid(), product_id: bonito, quantity: "15", lot_code: "L-NUEVO", location_code: "A-01" };
    expect((await call("POST", `/api/v1/stock/counts/${c.id}/entries`, e1)).status).toBe(201);
    expect((await call("POST", `/api/v1/stock/counts/${c.id}/entries`, e1)).body.repetido).toBe(true);
    await call("POST", `/api/v1/stock/counts/${c.id}/entries`, { id: uuid(), product_id: bonito, quantity: "4", lot_code: "L-NUEVO", location_code: "A-01" });
    // Un lote que Sindri no conocía.
    await call("POST", `/api/v1/stock/counts/${c.id}/entries`, { id: uuid(), product_id: bonito, quantity: "3", lot_code: "L-RARO", location_code: "A-01" });
    // Fuera del ámbito del recuento.
    expect((await call("POST", `/api/v1/stock/counts/${c.id}/entries`, { ...e1, id: uuid(), location_code: "A-02" })).body.error).toContain("no entra");

    const abierto = (await call("GET", `/api/v1/stock/counts/${c.id}`)).body;
    expect(abierto.lines.map((l: { lot_code: string; counted: string; expected?: string }) => [l.lot_code, Number(l.counted), l.expected])).toEqual([
      ["L-NUEVO", 19, undefined],
      ["L-RARO", 3, undefined],
    ]);

    expect((await call("POST", `/api/v1/stock/counts/${c.id}/approve`)).status).toBe(409); // antes hay que terminar
    const terminado = (await call("POST", `/api/v1/stock/counts/${c.id}/finish`)).body;
    expect(terminado.lines.map((l: { lot_code: string; expected: string; counted: string; difference: string }) => [l.lot_code, Number(l.expected), Number(l.counted), Number(l.difference)])).toEqual([
      ["L-NUEVO", 21, 19, -2],
      ["L-RARO", 0, 3, 3],
    ]);
    expect((await call("POST", `/api/v1/stock/counts/${c.id}/entries`, { ...e1, id: uuid() })).status).toBe(409);

    const aprobado = (await call("POST", `/api/v1/stock/counts/${c.id}/approve`)).body;
    expect(aprobado.state).toBe("approved");
    expect(aprobado.lines).toHaveLength(2);
    expect(await stockDe("BON")).toEqual(["A-01:L-NUEVO:19", "A-01:L-RARO:3", "A-02-1:L-NUEVO:1"]);
    const movs = (await call("GET", "/api/v1/stock/moves")).body.filter((m: { reference_type: string }) => m.reference_type === "stock_count");
    expect(movs).toHaveLength(2);
  });

  it("un recuento de todo el almacén pone a cero lo que no se cuenta", async () => {
    const c = (await call("POST", "/api/v1/stock/counts", {})).body;
    await call("POST", `/api/v1/stock/counts/${c.id}/entries`, { id: uuid(), product_id: caja, quantity: "90", location_code: "WH/STOCK" });
    await call("POST", `/api/v1/stock/counts/${c.id}/finish`);
    expect((await call("POST", `/api/v1/stock/counts/${c.id}/reopen`)).body.state).toBe("open");
    await call("POST", `/api/v1/stock/counts/${c.id}/finish`);
    await call("POST", `/api/v1/stock/counts/${c.id}/approve`);
    expect(await stockDe("CAJ")).toEqual(["WH/STOCK:-:90"]);
    expect(await stockDe("BON")).toEqual([]);
    expect((await call("GET", "/api/v1/stock/counts?state=activos")).body).toHaveLength(0);
  });
});
