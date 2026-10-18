import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { buildApp, migrate, openEmbedded } from "../src/index.js";

/**
 * Report Server de mentira: comprueba la llave, deja instalar plantillas «sindri-…» (sin pisar
 * las que hay salvo con «sustituir») y devuelve un «PDF» con lo que ha recibido.
 */
async function fakeReportServer(llave = "llave-de-prueba", { instala = true } = {}) {
  const rs = Fastify({ bodyLimit: 20 * 1024 * 1024 });
  const recibido: { plantilla?: string; nombre?: string; datos?: Record<string, any> }[] = [];
  const plantillas = new Map<string, { nombre: string; titulo: string; grupo: string; retocada?: boolean }>([
    ["sindri-pedido", { nombre: "sindri-pedido", titulo: "Sindri · Pedido", grupo: "pedido" }],
    ["sindri-factura", { nombre: "sindri-factura", titulo: "Sindri · Factura", grupo: "factura" }],
    ["otra-app", { nombre: "otra-app", titulo: "Otra", grupo: "" }],
  ]);
  rs.addHook("onRequest", async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${llave}`) return reply.status(401).send({ error: "Llave no válida." });
  });
  rs.get("/api/plantillas", async () => [...plantillas.values()].map(({ nombre, titulo, grupo }) => ({ nombre, titulo, grupo, formatos: ["pdf"], parametros: [] })));
  if (instala)
    rs.post("/api/plantillas", async (req, reply) => {
      const b = req.body as { nombre: string; titulo: string; grupo: string; plantilla: unknown; sustituir?: boolean };
      if (!b.nombre.startsWith("sindri-")) return reply.status(403).send({ error: "Solo sindri-…" });
      if (!b.plantilla) return reply.status(400).send({ error: "Falta la plantilla." });
      const antes = plantillas.get(b.nombre);
      if (antes && !b.sustituir) return { nombre: b.nombre, estado: "ya estaba" };
      plantillas.set(b.nombre, { nombre: b.nombre, titulo: b.titulo, grupo: b.grupo });
      return { nombre: b.nombre, estado: antes ? "sustituida" : "instalada" };
    });
  rs.post("/api/generar", async (req, reply) => {
    const b = req.body as (typeof recibido)[number];
    recibido.push(b);
    if (!plantillas.has(b.plantilla!) || b.plantilla === "sindri-factura") return reply.status(404).send({ error: `No existe la plantilla «${b.plantilla}».` });
    return reply.type("application/pdf").header("content-disposition", `attachment; filename="${b.nombre}.pdf"`).send(Buffer.from("%PDF-1.7 prueba"));
  });
  await rs.listen({ port: 0, host: "127.0.0.1" });
  return { rs, recibido, plantillas, url: `http://127.0.0.1:${(rs.server.address() as { port: number }).port}/` };
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
    const d = (await app.inject("/api/v1/documentos")).json();
    expect(d).toMatchObject({ report_server: true, plantillas: ["sindri-pedido", "sindri-factura", "otra-app"] });
    expect(d.documentos.pedido).toEqual({ plantilla: "sindri-pedido", de_sindri: "sindri-pedido", lista: true });
    expect(d.documentos.albaran).toMatchObject({ plantilla: "sindri-albaran", lista: false });
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

describe("Conectar el Report Server desde la pantalla (sin tocar app.env)", () => {
  const LLAVE = "rs_" + "a".repeat(32);
  let app: FastifyInstance;
  let fake: Awaited<ReturnType<typeof fakeReportServer>>;
  const put = (payload: object) => app.inject({ method: "PUT", url: "/api/v1/documentos/conexion", payload });

  beforeAll(async () => {
    fake = await fakeReportServer(LLAVE);
    const db = await openEmbedded();
    await migrate(db);
    app = await buildApp({ db });
    await app.inject({ method: "PUT", url: "/api/v1/company", payload: { name: "Empresa Prueba SL", tax_id: "B12345674" } });
  });
  afterAll(async () => {
    await app.close();
    await fake.rs.close();
  });

  it("sin conectar, lo dice y los PDF piden conectarlo", async () => {
    expect((await app.inject("/api/v1/documentos/conexion")).json()).toEqual({ origen: null, url: "", llave_fin: null });
    expect((await app.inject("/api/v1/documentos")).json()).toMatchObject({ report_server: false, plantillas: [] });
  });

  it("no guarda una llave que el Report Server no acepta, ni una dirección mala", async () => {
    const mala = await put({ url: fake.url, llave: "rs_" + "b".repeat(32) });
    expect(mala.statusCode).toBe(422);
    expect(mala.json().error).toMatch(/no acepta la llave/);
    expect((await put({ url: "report-server", llave: LLAVE })).statusCode).toBe(400);
    expect((await put({ url: fake.url, llave: "otra" })).statusCode).toBe(400);
    expect((await app.inject("/api/v1/documentos/conexion")).json().origen).toBeNull();
  });

  it("guarda la conexión probada; la llave no se vuelve a enseñar", async () => {
    const ok = await put({ url: fake.url, llave: LLAVE });
    expect(ok.statusCode, ok.body).toBe(200);
    // Al conectar instala las de Sindri que faltan y deja las que ya estaban.
    expect(ok.json()).toMatchObject({ origen: "sindri", llave_fin: "aaaa" });
    expect(ok.json().instaladas.map((i: any) => `${i.plantilla}: ${i.estado}`)).toEqual([
      "sindri-factura: ya estaba", "sindri-pedido: ya estaba", "sindri-albaran: instalada", "sindri-hoja-ruta: instalada",
    ]);
    expect(fake.plantillas.get("sindri-hoja-ruta")).toMatchObject({ titulo: "Sindri · Hoja de ruta", grupo: "hoja-ruta" });
    const conexion = await app.inject("/api/v1/documentos/conexion");
    expect(conexion.body).not.toContain(LLAVE);
    const d = (await app.inject("/api/v1/documentos")).json();
    expect(d.report_server).toBe(true);
    expect(Object.values(d.documentos).every((x: any) => x.lista)).toBe(true);
    // Cambiar solo la dirección deja la llave que había.
    expect((await put({ url: fake.url + "/" })).statusCode).toBe(200);
  });

  it("se elige qué plantilla usa cada documento, o imprimir con el navegador", async () => {
    const elegir = (payload: object) => app.inject({ method: "PUT", url: "/api/v1/documentos/plantillas", payload });
    expect((await elegir({ pedido: "no-existe" })).statusCode).toBe(422);
    expect((await elegir({ pedido: "otra-app", albaran: "" })).json()).toMatchObject({ pedido: "otra-app", albaran: "", factura: "sindri-factura" });
    const d = (await app.inject("/api/v1/documentos")).json();
    expect(d.documentos.pedido).toMatchObject({ plantilla: "otra-app", lista: true });
    expect(d.documentos.albaran).toMatchObject({ plantilla: "", lista: false });
    expect(d.disponibles).toContainEqual({ nombre: "otra-app", titulo: "Otra", grupo: "" });
    // Lo elegido se queda al cambiar otro documento.
    expect((await elegir({ factura: "sindri-factura" })).json().pedido).toBe("otra-app");
    expect((await elegir({ pedido: "sindri-pedido", albaran: "sindri-albaran" })).statusCode).toBe(200);
  });

  it("vuelve a dejar las plantillas como las de partida, y se pueden descargar", async () => {
    fake.plantillas.get("sindri-pedido")!.titulo = "Retocada";
    const r = await app.inject({ method: "POST", url: "/api/v1/documentos/plantillas/instalar", payload: { sustituir: true, tipos: ["pedido"] } });
    expect(r.json().instaladas).toEqual([{ tipo: "pedido", plantilla: "sindri-pedido", estado: "sustituida" }]);
    expect(fake.plantillas.get("sindri-pedido")!.titulo).toBe("Sindri · Pedido");
    const f = await app.inject("/api/v1/documentos/plantillas/partida.json");
    expect(f.headers["content-disposition"]).toContain("sindri-plantillas.json");
    expect(f.json().plantillas.map((p: any) => [p.nombre, p.grupo, Array.isArray(p.plantilla.schemas)])).toEqual([
      ["sindri-factura", "factura", true], ["sindri-pedido", "pedido", true], ["sindri-albaran", "albaran", true], ["sindri-hoja-ruta", "hoja-ruta", true],
    ]);
  });

  it("con un Report Server que aún no instala plantillas, conecta igual y lo avisa", async () => {
    const viejo = await fakeReportServer(LLAVE, { instala: false });
    const r = await put({ url: viejo.url, llave: LLAVE });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().aviso).toMatch(/todavía no deja que Sindri instale/);
    expect((await app.inject({ method: "POST", url: "/api/v1/documentos/plantillas/instalar", payload: {} })).statusCode).toBe(422);
    expect((await put({ url: fake.url, llave: LLAVE })).statusCode).toBe(200);
    await viejo.rs.close();
  });

  it("se puede desconectar", async () => {
    expect((await app.inject({ method: "DELETE", url: "/api/v1/documentos/conexion" })).statusCode).toBe(200);
    expect((await app.inject("/api/v1/documentos")).json().report_server).toBe(false);
  });

  it("si la conexión viene del app.env, la pantalla no la cambia", async () => {
    const db = await openEmbedded();
    await migrate(db);
    const conEnv = await buildApp({ db, reportServer: { url: fake.url.replace(/\/$/, ""), key: LLAVE } });
    await conEnv.inject({ method: "PUT", url: "/api/v1/company", payload: { name: "Empresa Prueba SL", tax_id: "B12345674" } });
    expect((await conEnv.inject("/api/v1/documentos/conexion")).json()).toMatchObject({ origen: "variables", llave_fin: "aaaa" });
    expect((await conEnv.inject({ method: "PUT", url: "/api/v1/documentos/conexion", payload: { url: fake.url, llave: LLAVE } })).statusCode).toBe(409);
    await conEnv.close();
  });
});
