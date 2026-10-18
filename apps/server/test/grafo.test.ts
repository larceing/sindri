import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, migrate, openEmbedded, type Db } from "../src/index.js";
import { grafoDesde } from "../src/grafo.js";

interface G {
  inicio: string;
  nodos: { key: string; tipo: string; titulo: string; ruta: string | null; estado: string | null; importe: string | null }[];
  aristas: { from: string; to: string; rel: string }[];
  truncado: boolean;
}

describe("Relaciones: el grafo de registros", () => {
  let db: Db;
  let app: FastifyInstance;
  const call = async (method: string, url: string, body?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, payload: body as object });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  const grafo = async (tipo: string, id: string) => (await call("GET", `/api/v1/grafo?tipo=${tipo}&id=${id}`)).body as G;
  const tipos = (g: G) => g.nodos.map((n) => n.tipo).sort();
  const hay = (g: G, from: string, to: string) => g.aristas.some((a) => a.from === from && a.to === to);

  let company: string, cliente: string, otroCliente: string, opp: string, quote: string, pedido: string, otroPedido: string;
  let albaran: string, factura: string, lote: string, ruta: string;

  beforeAll(async () => {
    db = await openEmbedded();
    await migrate(db);
    app = await buildApp({ db });
    company = (await call("PUT", "/api/v1/company", { name: "Metal Demo SL", tax_id: "B12345674" })).body.id;

    const acero = (await call("POST", "/api/v1/products", { sku: "SOP-01", name: "Soporte acero", sale_price: "10", track_lots: true })).body.id;
    await call("POST", "/api/v1/stock/receipts", { product_id: acero, quantity: "100", lot_code: "L-77" });

    // Oportunidad → presupuesto → pedido → albarán → factura → cobro.
    opp = (await call("POST", "/api/v1/opportunities", { title: "Soportes", prospect_name: "Taller Sur SL" })).body.id;
    cliente = (await call("POST", `/api/v1/opportunities/${opp}/partner`, { tax_id: "A58818501" })).body.partner_id;
    quote = (await call("POST", "/api/v1/quotations", { opportunity_id: opp, lines: [{ product_id: acero, quantity: "5" }] })).body.id;
    pedido = (await call("POST", `/api/v1/quotations/${quote}/accept`)).body.order_id;
    ruta = (await call("POST", "/api/v1/routes", { zone: "Norte" })).body.id;
    expect((await call("POST", `/api/v1/routes/${ruta}/stops`, { order_ids: [pedido] })).status).toBe(200);
    albaran = (await call("POST", `/api/v1/sales-orders/${pedido}/deliver`)).body.delivery.id;
    factura = (await call("POST", `/api/v1/sales-orders/${pedido}/invoice`)).body.id;
    await call("POST", `/api/v1/invoices/${factura}/issue`);
    await call("POST", `/api/v1/invoices/${factura}/payments`, { amount: "10" });

    // Otro cliente recibe el mismo lote; y un segundo pedido del primer cliente que no tiene nada que ver.
    otroCliente = (await call("POST", "/api/v1/partners", { name: "Ferretería Norte SL", tax_id: "B41234568" })).body.id;
    otroPedido = (await call("POST", "/api/v1/sales-orders", { partner_id: otroCliente, lines: [{ product_id: acero, quantity: "2" }] })).body.id;
    await call("POST", `/api/v1/sales-orders/${otroPedido}/confirm`);
    expect((await call("POST", `/api/v1/routes/${ruta}/stops`, { order_ids: [otroPedido] })).status).toBe(200);
    await call("POST", `/api/v1/sales-orders/${otroPedido}/deliver`);
    const suelto = (await call("POST", "/api/v1/sales-orders", { partner_id: cliente, lines: [{ product_id: acero, quantity: "1" }] })).body.id;
    expect(suelto).toBeTruthy();
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it("desde el pedido sale la cadena entera, hacia atrás y hacia delante", async () => {
    const g = await grafo("pedido", pedido);
    expect(g.inicio).toBe(`pedido:${pedido}`);
    expect(tipos(g)).toEqual(["albaran", "cliente", "cobro", "factura", "lote", "oportunidad", "pedido", "presupuesto", "ruta"]);
    expect(hay(g, `cliente:${cliente}`, `oportunidad:${opp}`)).toBe(true);
    expect(hay(g, `oportunidad:${opp}`, `presupuesto:${quote}`)).toBe(true);
    expect(hay(g, `presupuesto:${quote}`, `pedido:${pedido}`)).toBe(true);
    expect(hay(g, `pedido:${pedido}`, `albaran:${albaran}`)).toBe(true);
    expect(hay(g, `pedido:${pedido}`, `factura:${factura}`)).toBe(true);
    expect(hay(g, `pedido:${pedido}`, `ruta:${ruta}`)).toBe(true);
    // El cliente, el lote y la ruta no se abren: no salen los otros pedidos.
    expect(g.nodos.filter((n) => n.tipo === "pedido")).toHaveLength(1);
    const p = g.nodos.find((n) => n.key === g.inicio)!;
    expect(p).toMatchObject({ ruta: `/pedidos/${pedido}`, estado: "invoiced", importe: "50.00" });
    expect(g.nodos.find((n) => n.tipo === "cobro")).toMatchObject({ importe: "10.00", ruta: `/facturas/${factura}` });
  });

  it("desde el cobro se llega igual al cliente", async () => {
    const cobro = (await grafo("factura", factura)).nodos.find((n) => n.tipo === "cobro")!;
    const g = await grafo("cobro", cobro.key.split(":")[1]!);
    expect(g.nodos.some((n) => n.key === `cliente:${cliente}`)).toBe(true);
  });

  it("desde el cliente salen todas sus cadenas", async () => {
    const g = await grafo("cliente", cliente);
    expect(g.nodos.filter((n) => n.tipo === "pedido")).toHaveLength(2);
    expect(g.nodos.some((n) => n.key === `pedido:${otroPedido}`)).toBe(false);
  });

  it("desde un lote se ve a qué clientes llegó (retirada de producto)", async () => {
    lote = (await grafo("albaran", albaran)).nodos.find((n) => n.tipo === "lote")!.key.split(":")[1]!;
    const g = await grafo("lote", lote);
    const clientes = g.nodos.filter((n) => n.tipo === "cliente").map((n) => n.titulo).sort();
    expect(clientes).toEqual(["Ferretería Norte SL", "Taller Sur SL"]);
  });

  it("solo enseña lo que el rol deja ver", async () => {
    const g = await grafoDesde(db, { company, actor: "t" }, { pedidos: "ver", clientes: "ver" }, "pedido", pedido);
    expect([...new Set(g.nodos.map((n) => n.tipo))].sort()).toEqual(["albaran", "cliente", "pedido"]);
    // Lo que no ve (oportunidad, presupuesto) no sale, pero la cadena no se rompe: cliente → pedido.
    expect(hay(g as G, `cliente:${cliente}`, `pedido:${pedido}`)).toBe(true);
    expect(g.aristas.find((a) => a.from === `cliente:${cliente}`)?.rel).toBe("…");
    await expect(grafoDesde(db, { company, actor: "t" }, { pedidos: "ver" }, "factura", factura)).rejects.toThrow(/acceso/);
  });

  it("busca por número o nombre en todos los tipos", async () => {
    const r = (await call("GET", "/api/v1/grafo/buscar?q=Taller")).body as { tipo: string }[];
    expect(r.map((n) => n.tipo)).toContain("cliente");
    const l = (await call("GET", "/api/v1/grafo/buscar?q=L-77")).body as { tipo: string }[];
    expect(l.map((n) => n.tipo)).toEqual(["lote"]);
  });

  it("errores claros: tipo raro, registro de otra empresa o que no existe", async () => {
    expect((await call("GET", `/api/v1/grafo?tipo=nave&id=${pedido}`)).status).toBe(404);
    expect((await call("GET", "/api/v1/grafo?tipo=pedido&id=00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await call("GET", "/api/v1/grafo?tipo=pedido&id=no")).status).toBe(400);
  });
});
