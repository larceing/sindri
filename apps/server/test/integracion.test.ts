import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { buildApp, migrate, openEmbedded, type Db } from "../src/index.js";

/** Mail y Report Server de mentira: guardan lo que reciben. */
async function fakes() {
  const recibidos: any[] = [];
  const srv = Fastify({ bodyLimit: 20 * 1024 * 1024 });
  srv.post("/api/enviar", async (req, reply) => {
    if (req.headers.authorization !== "Bearer ml_prueba") return reply.status(401).send({ error: "Llave" });
    recibidos.push(req.body);
    return { id: recibidos.length, enviado: true, adjuntos: ((req.body as any).adjuntos ?? []).length };
  });
  srv.post("/api/vista", async (req, reply) => (req.headers.authorization === "Bearer ml_prueba" ? { asunto: "x", html: "", texto: "" } : reply.status(401).send({})));
  srv.post("/api/generar", async (_req, reply) => reply.type("application/pdf").send(Buffer.from("%PDF-1.4 prueba")));
  await srv.listen({ port: 0, host: "127.0.0.1" });
  return { srv, recibidos, url: `http://127.0.0.1:${(srv.server.address() as { port: number }).port}` };
}

const esperar = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 30));
};

describe("Integraciones: llaves, por facturar y confirmación de pedidos por correo", () => {
  let db: Db;
  let app: FastifyInstance;
  let fake: Awaited<ReturnType<typeof fakes>>;
  const call = async (method: string, url: string, body?: unknown, key?: string) => {
    const r = await app.inject({ method: method as "GET", url, payload: body as object, headers: key ? { authorization: `Bearer ${key}` } : {} });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };

  beforeAll(async () => {
    fake = await fakes();
    db = await openEmbedded();
    await migrate(db);
    app = await buildApp({ db, mail: { url: fake.url, key: "ml_prueba" }, reportServer: { url: fake.url, key: "rs" } });
    await call("PUT", "/api/v1/company", { name: "Servicios Demo SL", tax_id: "B12345674" });
  });
  afterAll(async () => {
    await app.close();
    await fake.srv.close();
    await db.close();
  });

  let key: string, keyId: string, cliente: string, horas: string, pedido: string;

  it("administración crea una llave; sin ella o revocada no se entra", async () => {
    cliente = (await call("POST", "/api/v1/partners", { name: "Taller Sur SL", tax_id: "A58818501", email: "compras@example.test" })).body.id;
    horas = (await call("POST", "/api/v1/products", { sku: "HORA", name: "Hora de soporte", kind: "service", sale_price: "40", vat_rate: "21" })).body.id;
    expect((await call("POST", "/api/v1/integraciones/llaves", { name: "Con Espacios" })).status).toBe(400);
    const r = await call("POST", "/api/v1/integraciones/llaves", { name: "incidencias" });
    expect(r.status).toBe(201);
    key = r.body.key;
    keyId = r.body.id;
    expect(key).toMatch(/^sdi_/);
    expect((await call("GET", "/api/v1/integraciones/llaves")).body[0]).not.toHaveProperty("key");
    expect((await call("GET", "/api/integracion/v1/yo")).status).toBe(401);
    expect((await call("GET", "/api/integracion/v1/yo", undefined, "sdi_mala")).status).toBe(401);
    expect((await call("GET", "/api/integracion/v1/yo", undefined, key)).body).toMatchObject({ app: "incidencias", empresa: { code: "001" } });
  });

  it("la app lee clientes y productos de su empresa", async () => {
    const clientes = (await call("GET", "/api/integracion/v1/clientes", undefined, key)).body;
    expect(clientes).toEqual([expect.objectContaining({ id: cliente, tax_id: "A58818501", email: "compras@example.test" })]);
    expect((await call("GET", "/api/integracion/v1/productos", undefined, key)).body[0]).toMatchObject({ sku: "HORA" });
  });

  it("manda horas: se crean, se actualizan con la misma referencia y lo que no cuadra se dice", async () => {
    const r = await call(
      "POST",
      "/api/integracion/v1/por-facturar",
      {
        elementos: [
          { ref: "T-1", cliente, producto: "HORA", fecha: "2026-10-01", cantidad: "1,5", descripcion: "Incidencia 12: impresora" },
          { ref: "T-2", cliente: "A58818501", producto: "HORA", fecha: "2026-10-02", cantidad: 2, precio: "45", descripcion: "Incidencia 13" },
          { ref: "T-3", cliente: "B00000000", producto: "HORA", fecha: "2026-10-02", cantidad: 1, descripcion: "Sin cliente" },
        ],
      },
      key,
    );
    expect(r.body.elementos.map((e: { estado: string }) => e.estado)).toEqual(["creado", "creado", "error"]);
    const again = await call("POST", "/api/integracion/v1/por-facturar", { elementos: [{ ref: "T-1", cliente, producto: "HORA", fecha: "2026-10-01", cantidad: "2", descripcion: "Incidencia 12: impresora" }] }, key);
    expect(again.body.elementos[0].estado).toBe("actualizado");
    const pend = (await call("GET", "/api/v1/por-facturar")).body;
    expect(pend.map((p: { amount: string }) => p.amount)).toEqual(["80.00", "90.00"]);
    // La misma referencia con otra llave no se mete otra vez (se cobraría dos veces).
    const otra = (await call("POST", "/api/v1/integraciones/llaves", { name: "soporte" })).body.key;
    const dup = await call("POST", "/api/integracion/v1/por-facturar", { elementos: [{ ref: "T-1", cliente, producto: "HORA", fecha: "2026-10-01", cantidad: "2", descripcion: "x" }] }, otra);
    expect(dup.body.elementos[0]).toMatchObject({ estado: "error", error: expect.stringContaining("incidencias") });
    expect((await call("GET", "/api/v1/por-facturar")).body).toHaveLength(2);
  });

  it("se pasa a un pedido; anular el pedido lo devuelve a pendiente", async () => {
    const pend = (await call("GET", "/api/v1/por-facturar")).body as { id: string }[];
    const o = await call("POST", "/api/v1/por-facturar/pedido", { ids: pend.map((p) => p.id) });
    expect(o.status).toBe(201);
    pedido = o.body.id;
    expect(o.body.state).toBe("draft");
    expect(o.body.totals.untaxed).toBe("170.00");
    expect((await call("GET", "/api/integracion/v1/por-facturar?refs=T-1,T-2", undefined, key)).body.map((e: { estado: string }) => e.estado)).toEqual(["en_pedido", "en_pedido"]);
    expect((await call("POST", "/api/integracion/v1/por-facturar", { elementos: [{ ref: "T-1", cliente, producto: "HORA", fecha: "2026-10-01", cantidad: "9", descripcion: "x" }] }, key)).body.elementos[0].estado).toBe("en_pedido");
    expect((await call("DELETE", "/api/integracion/v1/por-facturar/T-1", undefined, key)).status).toBe(409);
    await call("POST", `/api/v1/sales-orders/${pedido}/cancel`);
    expect((await call("GET", "/api/v1/por-facturar")).body).toHaveLength(2);
  });

  it("descartar y recuperar", async () => {
    const pend = (await call("GET", "/api/v1/por-facturar")).body as { id: string }[];
    expect((await call("POST", "/api/v1/por-facturar/descartar", { ids: [pend[0]!.id] })).body.cambiados).toBe(1);
    expect((await call("GET", "/api/v1/por-facturar?state=discarded")).body).toHaveLength(1);
    await call("POST", "/api/v1/por-facturar/recuperar", { ids: [pend[0]!.id] });
    expect((await call("GET", "/api/v1/por-facturar")).body).toHaveLength(2);
  });

  it("confirmar un pedido manda la confirmación con el PDF si la empresa lo tiene activado", async () => {
    const pend = (await call("GET", "/api/v1/por-facturar")).body as { id: string }[];
    pedido = (await call("POST", "/api/v1/por-facturar/pedido", { ids: pend.map((p) => p.id) })).body.id;
    // En borrador no se manda.
    expect((await call("POST", `/api/v1/sales-orders/${pedido}/correo`)).status).toBe(409);
    expect((await call("PUT", "/api/v1/correo/pedidos", { activo: true })).body.pedidos).toBe(true);
    await call("POST", `/api/v1/sales-orders/${pedido}/confirm`);
    await esperar(() => fake.recibidos.length > 0);
    expect(fake.recibidos).toHaveLength(1);
    const m = fake.recibidos[0];
    expect(m.para).toEqual(["compras@example.test"]);
    expect(m.asunto).toMatch(/Pedido PV\d{4}-00002 confirmado/);
    expect(m.adjuntos[0].nombre).toMatch(/^Pedido PV/);
    expect(Buffer.from(m.adjuntos[0].contenido, "base64").toString()).toBe("%PDF-1.4 prueba");
  });

  it("a mano, a otro correo; un correo mal escrito no sale", async () => {
    expect((await call("POST", `/api/v1/sales-orders/${pedido}/correo`, { para: ["no-es-correo"] })).status).toBe(422);
    const r = await call("POST", `/api/v1/sales-orders/${pedido}/correo`, { para: ["otro@example.test"] });
    expect(r.body).toMatchObject({ enviado: true, para: ["otro@example.test"], pdf: true });
    expect((await call("GET", `/api/v1/sales-orders/${pedido}`)).body.mailed_at).toBeTruthy();
  });

  it("revocar la llave corta el acceso", async () => {
    await call("DELETE", `/api/v1/integraciones/llaves/${keyId}`);
    expect((await call("GET", "/api/integracion/v1/clientes", undefined, key)).status).toBe(401);
  });
});
