import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, migrate, openEmbedded, type Db } from "../src/index.js";

/** Llaves de agente: la empresa ya abierta, consultar o cambiar, nunca usuarios ni contraseñas. */
describe("Llaves de agente (sda_…)", () => {
  let db: Db;
  let app: FastifyInstance;
  const call = async (method: string, url: string, body?: unknown, key?: string) => {
    const r = await app.inject({ method: method as "GET", url, payload: body as object, headers: key ? { authorization: `Bearer ${key}` } : {} });
    let b: any = r.body;
    try {
      b = r.body ? JSON.parse(r.body) : null;
    } catch {
      /* texto */
    }
    return { status: r.statusCode, body: b };
  };
  let consulta: string, cambia: string, idConsulta: string;

  beforeAll(async () => {
    db = await openEmbedded();
    await migrate(db);
    app = await buildApp({ db });
    await call("PUT", "/api/v1/company", { name: "Servicios Demo SL", tax_id: "B12345674" });
    await call("POST", "/api/v1/partners", { name: "Taller Sur SL", tax_id: "A58818501" });
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it("administración crea llaves y la entera solo se ve al crearla", async () => {
    expect((await call("POST", "/api/v1/integraciones/agentes", { name: "Con Espacios", level: "consultar" })).status).toBe(400);
    expect((await call("POST", "/api/v1/integraciones/agentes", { name: "claude", level: "todo" })).status).toBe(400);
    const a = await call("POST", "/api/v1/integraciones/agentes", { name: "claude-lee", level: "consultar" });
    expect(a.status).toBe(201);
    expect(a.body.key).toMatch(/^sda_/);
    consulta = a.body.key;
    idConsulta = a.body.id;
    cambia = (await call("POST", "/api/v1/integraciones/agentes", { name: "claude", level: "cambiar", days: 30 })).body.key;
    const lista = (await call("GET", "/api/v1/integraciones/agentes")).body;
    expect(lista).toHaveLength(2);
    expect(lista[0]).not.toHaveProperty("key");
    expect(lista[0]).not.toHaveProperty("key_hash");
  });

  it("sin llave buena no entra", async () => {
    expect((await call("GET", "/api/agente/v1/yo")).status).toBe(401);
    expect((await call("GET", "/api/v1/partners", undefined, "sda_mala")).status).toBe(401);
    expect((await call("GET", "/", undefined, consulta)).status).toBe(401);
  });

  it("consultar: lee con la empresa ya abierta y no cambia nada", async () => {
    const yo = (await call("GET", "/api/agente/v1/yo", undefined, consulta)).body;
    expect(yo).toMatchObject({ agente: "claude-lee", nivel: "consultar", empresa: { code: "001" } });
    expect(yo.permisos.usuarios).toBeUndefined();
    const p = await call("GET", "/api/v1/partners", undefined, consulta);
    expect(p.status).toBe(200);
    expect(p.body.map((x: any) => x.name)).toContain("Taller Sur SL");
    expect((await call("POST", "/api/v1/partners", { name: "Otro SL" }, consulta)).status).toBe(403);
  });

  it("cambiar: cambia lo de la empresa, nunca usuarios, contraseñas ni llaves", async () => {
    const nuevo = await call("POST", "/api/v1/partners", { name: "Bodegas Norte SL", tax_id: "B12345674" }, cambia);
    expect(nuevo.status).toBe(201);
    expect((await call("GET", "/api/v1/users", undefined, cambia)).status).toBe(403);
    expect((await call("POST", "/api/v1/roles", { name: "x", permissions: {} }, cambia)).status).toBe(403);
    expect((await call("PUT", "/api/v1/company/password", { nueva: "otraclave123" }, cambia)).status).toBe(403);
    expect((await call("POST", "/api/v1/integraciones/agentes", { name: "otra", level: "cambiar" }, cambia)).status).toBe(403);
    expect((await call("POST", "/api/v1/integraciones/llaves", { name: "otra" }, cambia)).status).toBe(403);
    expect((await call("POST", "/api/v1/session/company", { company_id: nuevo.body.id }, cambia)).status).toBe(403);
    expect((await call("PUT", "/api/v1/company", { name: "Cambiada SL", tax_id: "B12345674" }, cambia)).status).toBe(403);
    // Queda en el registro con su nombre.
    const [ev] = await db.query<{ actor: string }>("select actor from event_log where entity_id = $1", [nuevo.body.id]);
    expect(ev?.actor).toBe("agente:claude");
  });

  it("traspaso y rutas para quien use la llave", async () => {
    const t = await call("GET", "/api/agente/v1/traspaso", undefined, consulta);
    expect(t.status).toBe(200);
    expect(t.body).toContain("Servicios Demo SL");
    expect(t.body).not.toContain("/users");
    const rutas = (await call("GET", "/api/agente/v1/rutas", undefined, consulta)).body;
    expect(rutas).toContainEqual({ metodo: "GET", ruta: "/partners", permitida: true });
    expect(rutas).toContainEqual({ metodo: "POST", ruta: "/partners", permitida: false });
  });

  it("MCP: herramientas según el nivel", async () => {
    const rpc = (method: string, params: unknown, key: string) => call("POST", "/api/agente/v1/mcp", { jsonrpc: "2.0", id: 1, method, params }, key);
    expect((await rpc("initialize", { protocolVersion: "2025-06-18" }, consulta)).body.result.serverInfo.name).toBe("sindri");
    expect((await call("POST", "/api/agente/v1/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, consulta)).status).toBe(202);
    const tools = (await rpc("tools/list", {}, consulta)).body.result.tools.map((t: any) => t.name);
    expect(tools).not.toContain("sindri_cambiar");
    const r = (await rpc("tools/call", { name: "sindri_consultar", arguments: { ruta: "/partners?q=taller" } }, consulta)).body.result;
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content[0].text).body[0].name).toBe("Taller Sur SL");
    const no = (await rpc("tools/call", { name: "sindri_cambiar", arguments: { metodo: "POST", ruta: "/partners", cuerpo: { name: "X SL" } } }, consulta)).body.result;
    expect(no.isError).toBe(true);
    const si = (await rpc("tools/call", { name: "sindri_cambiar", arguments: { metodo: "POST", ruta: "/partners", cuerpo: { name: "Mcp SL" } } }, cambia)).body.result;
    expect(JSON.parse(si.content[0].text).status).toBe(201);
    const users = (await rpc("tools/call", { name: "sindri_consultar", arguments: { ruta: "/users" } }, cambia)).body.result;
    expect(JSON.parse(users.content[0].text).status).toBe(403);
  });

  it("revocada deja de valer al momento", async () => {
    expect((await call("DELETE", `/api/v1/integraciones/agentes/${idConsulta}`)).status).toBe(200);
    expect((await call("GET", "/api/v1/partners", undefined, consulta)).status).toBe(401);
  });
});
