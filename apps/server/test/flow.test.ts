import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, migrate, openEmbedded, openPostgres, type Db } from "../src/index.js";

const engines: [string, () => Promise<Db>][] = [["embebida (PGlite)", () => openEmbedded()]];
if (process.env.TEST_DATABASE_URL) engines.push(["PostgreSQL", async () => openPostgres(process.env.TEST_DATABASE_URL!)]);

describe.each(engines)("Ciclo pedido → albarán → factura → cobro con base %s", (_name, open) => {
  let db: Db;
  let app: FastifyInstance;
  const call = async (method: string, url: string, body?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, payload: body as object });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };

  beforeAll(async () => {
    db = await open();
    if (db.kind === "postgres") {
      await db.exec("drop schema public cascade; create schema public;");
    }
    await migrate(db);
    app = await buildApp({ db });
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  let customer: string, steel: string, service: string, order: string, invoice: string;

  it("configura la empresa y valida el NIF", async () => {
    expect((await call("PUT", "/api/v1/company", { name: "Metal Demo SL", tax_id: "B12345674" })).status).toBe(200);
    expect((await call("PUT", "/api/v1/company", { name: "Otra", tax_id: "B00000000" })).status).toBe(422);
  });

  it("crea cliente y productos", async () => {
    expect((await call("POST", "/api/v1/partners", { name: "Cliente malo", tax_id: "12345678A" })).status).toBe(422);
    customer = (await call("POST", "/api/v1/partners", { name: "Ferretería Norte SL", tax_id: "A58818501", surcharge_regime: true })).body.id;
    steel = (await call("POST", "/api/v1/products", { sku: "SOP-01", name: "Soporte acero", sale_price: "12.50", track_lots: true })).body.id;
    service = (await call("POST", "/api/v1/products", { sku: "MONT", name: "Montaje", kind: "service", sale_price: "40", vat_rate: "21" })).body.id;
    expect((await call("POST", "/api/v1/products", { sku: "SOP-01", name: "Duplicado" })).status).toBe(409);
  });

  it("recibe stock en dos lotes", async () => {
    expect((await call("POST", "/api/v1/stock/receipts", { product_id: steel, quantity: "10" })).status).toBe(422); // exige lote
    await call("POST", "/api/v1/stock/receipts", { product_id: steel, quantity: "6", lot_code: "L-B", expiry_date: "2027-06-30" });
    await call("POST", "/api/v1/stock/receipts", { product_id: steel, quantity: "10", lot_code: "L-A", expiry_date: "2027-01-31" });
    const prods = (await call("GET", "/api/v1/products?q=SOP")).body;
    expect(prods[0].on_hand).toBe("16.0000");
  });

  it("crea y confirma el pedido; no deja facturar antes de entregar", async () => {
    const r = await call("POST", "/api/v1/sales-orders", {
      partner_id: customer,
      lines: [
        { product_id: steel, quantity: "12" },
        { product_id: service, quantity: "1", discount_pct: "10" },
      ],
    });
    expect(r.status).toBe(201);
    order = r.body.id;
    expect(r.body.number).toMatch(/^PV\d{4}-00001$/);
    expect(r.body.totals.untaxed).toBe("186.00");
    expect((await call("POST", `/api/v1/sales-orders/${order}/invoice`)).status).toBe(409);
    expect((await call("POST", `/api/v1/sales-orders/${order}/confirm`)).body.state).toBe("confirmed");
  });

  it("entrega consumiendo primero el lote que caduca antes (FEFO)", async () => {
    const r = await call("POST", `/api/v1/sales-orders/${order}/deliver`);
    expect(r.status).toBe(200);
    const stock = (await call("GET", "/api/v1/stock")).body;
    expect(stock).toHaveLength(1);
    expect(stock[0].lot_code).toBe("L-B");
    expect(stock[0].quantity).toBe("4.0000");
  });

  it("no permite modificar el libro de stock", async () => {
    await expect(db.query("delete from stock_move")).rejects.toThrow(/inmutable/);
  });

  it("factura con IVA + recargo de equivalencia y emite con VERI*FACTU", async () => {
    const draft = (await call("POST", `/api/v1/sales-orders/${order}/invoice`)).body;
    invoice = draft.id;
    expect(draft.number).toBeNull();
    expect(draft.untaxed).toBe("186.00");
    expect(draft.vat_total).toBe("39.06");
    expect(draft.surcharge_total).toBe("9.67");
    expect(draft.total).toBe("234.73");
    const issued = (await call("POST", `/api/v1/invoices/${invoice}/issue`)).body;
    expect(issued.state).toBe("issued");
    expect(issued.number).toMatch(/^F\d{4}-00001$/);
    expect(issued.verifactu.hash).toMatch(/^[0-9A-F]{64}$/);
    expect(issued.verifactu.previous_hash).toBe("");
    expect(issued.verifactu.qr_url).toContain("numserie=F");
    expect((await call("POST", `/api/v1/invoices/${invoice}/issue`)).status).toBe(409);
  });

  it("protege la factura emitida en la propia base de datos", async () => {
    await expect(db.query("update invoice set total = 1 where id = $1", [invoice])).rejects.toThrow(/inmutable/);
    await expect(db.query("delete from invoice where id = $1", [invoice])).rejects.toThrow(/no se puede borrar/);
    await expect(db.query("update verifactu_record set hash = 'X'")).rejects.toThrow(/inmutable/);
  });

  it("cobra en dos pagos y marca la factura como pagada", async () => {
    expect((await call("POST", `/api/v1/invoices/${invoice}/payments`, { amount: "500" })).status).toBe(422);
    expect((await call("POST", `/api/v1/invoices/${invoice}/payments`, { amount: "100" })).body.pending).toBe("134.73");
    const listed = (await call("GET", "/api/v1/invoices")).body.find((i: { id: string }) => i.id === invoice);
    expect(listed.pending).toBe("134.73");
    const paid = (await call("POST", `/api/v1/invoices/${invoice}/payments`, { amount: "134.73" })).body;
    expect(paid.state).toBe("paid");
  });

  it("encadena la segunda factura y verifica la cadena", async () => {
    const o2 = (await call("POST", "/api/v1/sales-orders", { partner_id: customer, lines: [{ product_id: steel, quantity: "2" }] })).body.id;
    await call("POST", `/api/v1/sales-orders/${o2}/confirm`);
    await call("POST", `/api/v1/sales-orders/${o2}/deliver`);
    const inv2 = (await call("POST", `/api/v1/sales-orders/${o2}/invoice`)).body.id;
    const issued = (await call("POST", `/api/v1/invoices/${inv2}/issue`)).body;
    const first = (await call("GET", `/api/v1/invoices/${invoice}`)).body;
    expect(issued.verifactu.previous_hash).toBe(first.verifactu.hash);
    expect((await call("GET", "/api/v1/verifactu/verify")).body).toEqual({ records: 2, ok: true, firstBrokenSeq: null });
    const pending = (await call("GET", "/api/v1/verifactu/records")).body;
    expect(pending.every((r: { send_state: string }) => r.send_state === "pending")).toBe(true);
  });

  it("rechaza vender más stock del que hay", async () => {
    const o3 = (await call("POST", "/api/v1/sales-orders", { partner_id: customer, lines: [{ product_id: steel, quantity: "50" }] })).body.id;
    await call("POST", `/api/v1/sales-orders/${o3}/confirm`);
    const r = await call("POST", `/api/v1/sales-orders/${o3}/deliver`);
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/Stock insuficiente/);
    // la transacción se deshizo: el pedido sigue confirmado y el número de albarán no se gastó
    expect((await call("GET", `/api/v1/sales-orders/${o3}`)).body.state).toBe("confirmed");
  });

  it("deja auditoría de todo", async () => {
    const ev = (await call("GET", "/api/v1/events")).body;
    expect(ev.some((e: { action: string }) => e.action === "issue")).toBe(true);
  });
});
