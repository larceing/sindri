import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { buildApp, migrate, openEmbedded } from "../src/index.js";

/** Report Server de mentira: comprueba la llave y devuelve un «PDF» con lo que ha recibido. */
async function fakeReportServer() {
  const rs = Fastify();
  const recibido: { plantilla?: string; nombre?: string; datos?: Record<string, any> }[] = [];
  rs.addHook("onRequest", async (req, reply) => {
    if (req.headers.authorization !== "Bearer llave-de-prueba") return reply.status(401).send({ error: "Llave no válida." });
  });
  rs.get("/api/plantillas", async () => [{ nombre: "sindri-pedido" }, { nombre: "sindri-factura" }, { nombre: "otra-app" }]);
  rs.post("/api/generar", async (req, reply) => {
    const b = req.body as (typeof recibido)[number];
    recibido.push(b);
    if (b.plantilla === "sindri-factura") return reply.status(404).send({ error: "No existe la plantilla «sindri-factura»." });
    return reply.type("application/pdf").header("content-disposition", `attachment; filename="${b.nombre}.pdf"`).send(Buffer.from("%PDF-1.7 prueba"));
  });
  await rs.listen({ port: 0, host: "127.0.0.1" });
  return { rs, recibido, url: `http://127.0.0.1:${(rs.server.address() as { port: number }).port}/` };
}

describe("Documentos en PDF con el Report Server", () => {
  let app: FastifyInstance;
  let fake: Awaited<ReturnType<typeof fakeReportServer>>;
  let pedido: string;

  beforeAll(async () => {
    fake = await fakeReportServer();
    const db = await openEmbedded();
    await migrate(db);
    app = await buildApp({ db, reportServer: { url: fake.url.replace(/\/$/, ""), key: "llave-de-prueba" } });
    const ok = async (method: "POST" | "PUT", url: string, payload: object) => {
      const r = await app.inject({ method, url, payload });
      expect(r.statusCode, r.body).toBeLessThan(300);
      return r.json();
    };
    await ok("PUT", "/api/v1/company", { name: "Empresa Prueba SL", tax_id: "B12345674", address: "Calle 1", city: "Zarautz", postal_code: "20800" });
    const cli = await ok("POST", "/api/v1/partners", { name: "Cliente Sin Calle SL", tax_id: "B91234567", city: "Soria", postal_code: "42002" });
    const prod = await ok("POST", "/api/v1/products", { sku: "P-1", name: "Producto", sale_price: "10", kind: "service" });
    pedido = (await ok("POST", "/api/v1/sales-orders", { partner_id: cli.id, delivery_date: "2026-11-02", lines: [{ product_id: prod.id, quantity: "3" }] })).id;
  });
  afterAll(async () => {
    await app.close();
    await fake.rs.close();
  });

  it("dice qué plantillas de Sindri tiene el Report Server", async () => {
    expect((await app.inject("/api/v1/documentos")).json()).toEqual({ report_server: true, plantillas: ["sindri-pedido", "sindri-factura"] });
  });

  it("manda los datos con la llave y devuelve el PDF", async () => {
    const r = await app.inject(`/api/v1/documentos/pedido/${pedido}/pdf`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("application/pdf");
    expect(r.body).toBe("%PDF-1.7 prueba");
    const enviado = fake.recibido.at(-1)!;
    expect(enviado.plantilla).toBe("sindri-pedido");
    expect(enviado.nombre).toMatch(/^Pedido PV/);
    // Fechas como día y direcciones sin separadores sueltos cuando falta la calle.
    expect(enviado.datos).toMatchObject({ fecha: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), fecha_entrega: "2026-11-02", total: 36.3 });
    expect(enviado.datos!.cliente.linea_direccion).toBe("42002 Soria");
    expect(enviado.datos!.empresa.linea_direccion).toBe("Calle 1 · 20800 Zarautz");
  });

  it("si al Report Server le falta la plantilla, lo dice con su mensaje", async () => {
    for (const a of ["confirm", "deliver"]) expect((await app.inject({ method: "POST", url: `/api/v1/sales-orders/${pedido}/${a}` })).statusCode).toBe(200);
    const inv = (await app.inject({ method: "POST", url: `/api/v1/sales-orders/${pedido}/invoice` })).json();
    expect((await app.inject({ method: "POST", url: `/api/v1/invoices/${inv.id}/issue` })).statusCode).toBe(200);
    const r = await app.inject(`/api/v1/documentos/factura/${inv.id}/pdf`);
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe("Report Server: No existe la plantilla «sindri-factura».");
    expect(fake.recibido.at(-1)!.datos).toMatchObject({ numero: expect.stringMatching(/^F/), qr: expect.stringContaining("ValidarQR") });
  });
});
