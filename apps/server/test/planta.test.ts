import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, migrate, openEmbedded, type Db } from "../src/index.js";
import { seedDemoPlanta } from "../src/demo.js";
import { cleanup } from "../src/planta.js";
import { sign, type SsoConfig } from "../src/sso.js";

describe("Conexión con planta", () => {
  let db: Db;
  let app: FastifyInstance;
  const basic = "Basic " + Buffer.from("prueba:clave").toString("base64");
  let token = "";
  let agentId = "";
  const bearer = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    db = await openEmbedded();
    await migrate(db);
    await seedDemoPlanta(db);
    app = await buildApp({ db, auth: { user: "prueba", password: "clave" }, entorno: "dev" });
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it("crea un agente y enseña su token una sola vez", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/planta/agentes", headers: { authorization: basic }, payload: { name: "planta-dev" } });
    expect(r.statusCode).toBe(201);
    const a = JSON.parse(r.body);
    token = a.token;
    agentId = a.id;
    expect(token).toMatch(/^sdp_/);
    const list = JSON.parse((await app.inject({ url: "/api/v1/planta/agentes", headers: { authorization: basic } })).body);
    expect(list[0].token).toBeUndefined();
    expect(list[0].token_hint).toBe(token.slice(-4));
    expect(list[0].callado).toBe(true);
    const [row] = await db.query<{ token_hash: string }>("select token_hash from plant_agent");
    expect(row!.token_hash).not.toContain(token);
  });

  it("el token solo sirve para la API de planta", async () => {
    expect((await app.inject({ url: "/api/planta/v1/config" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/planta/v1/config", headers: { authorization: "Bearer sdp_falso" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/v1/invoices", headers: bearer() })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/planta/v1/config", headers: bearer() })).statusCode).toBe(200);
  });

  it("descarga la configuración de sus máquinas", async () => {
    let cfg = JSON.parse((await app.inject({ url: "/api/planta/v1/config", headers: bearer() })).body);
    expect(cfg.maquinas).toEqual([]);
    expect(cfg.entorno).toBe("dev");
    expect(cfg.escritura).toBe(false);
    const [m] = JSON.parse((await app.inject({ url: "/api/v1/planta/maquinas", headers: { authorization: basic } })).body);
    await app.inject({ method: "PUT", url: "/api/v1/planta/maquinas", headers: { authorization: basic }, payload: { ...m, agent_id: agentId } });
    cfg = JSON.parse((await app.inject({ url: "/api/planta/v1/config", headers: bearer() })).body);
    expect(cfg.maquinas[0].codigo).toBe("LINEA1");
    expect(cfg.maquinas[0].tags).toHaveLength(7);
  });

  it("guarda lecturas sin contarlas dos veces", async () => {
    const ts = new Date().toISOString();
    const lecturas = [
      { id: `LINEA1:Estado:cambio:${ts}`, maquina: "LINEA1", tag: "Estado", tipo: "cambio", ts, valor: 1 },
      { id: `LINEA1:PiezasBuenas:minuto:${ts}`, maquina: "LINEA1", tag: "PiezasBuenas", tipo: "minuto", ts, valor: 120, min: 60, max: 120, media: 90, n: 60 },
      { id: "futuro", maquina: "LINEA1", tag: "Estado", tipo: "cambio", ts: new Date(Date.now() + 3 * 86_400_000).toISOString(), valor: 0 },
    ];
    const send = async () => JSON.parse((await app.inject({ method: "POST", url: "/api/planta/v1/lecturas", headers: bearer(), payload: { lecturas } })).body);
    expect(await send()).toEqual({ recibidas: 3, nuevas: 2, rechazadas: ["futuro"] });
    expect((await send()).nuevas).toBe(0);
    const status = JSON.parse((await app.inject({ url: "/api/v1/planta", headers: { authorization: basic } })).body);
    expect(status[0].ultimos.Estado.value).toBe(1);
    expect(status[0].ultimos.PiezasBuenas.max_value).toBe(120);
  });

  it("apunta el latido y borra el detalle viejo", async () => {
    const r = await app.inject({ method: "POST", url: "/api/planta/v1/latido", headers: bearer(), payload: { version: "0.1.0", pendientes: 3, fuente_ok: true } });
    expect(JSON.parse(r.body).planta_minima).toBe("0.1.0");
    const [a] = JSON.parse((await app.inject({ url: "/api/v1/planta/agentes", headers: { authorization: basic } })).body);
    expect(a.callado).toBe(false);
    expect(a.last_status.pendientes).toBe(3);
    await db.query(
      "insert into plant_reading (agent_id, reading_id, machine_code, tag_key, kind, ts, value) values ($1, 'viejo', 'LINEA1', 'Estado', 'change', now() - interval '120 days', 0), ($1, 'viejo-min', 'LINEA1', 'PiezasBuenas', 'minute', now() - interval '120 days', 5)",
      [agentId],
    );
    expect(await cleanup(db, true)).toBe(1);
  });

  it("manda la fuente y los ajustes de cada tag a Efesto y guarda cómo va cada fuente", async () => {
    const r = await app.inject({
      method: "PUT",
      url: "/api/v1/planta/maquinas",
      headers: { authorization: basic },
      payload: {
        code: "PRENSA1",
        name: "Prensa por Modbus",
        agent_id: agentId,
        source_name: "prensa",
        tags: [
          { key: "Temperatura", source: "hr:20:int16", kind: "value", settings: { escala: 0.1 } },
          { key: "Estado", source: "hr:0", kind: "state", settings: { mapa: { "3": 2 }, defecto_mapa: 1 } },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
    // Un ajuste desconocido no pasa: el agente no sabría qué hacer con él.
    const mal = await app.inject({
      method: "PUT",
      url: "/api/v1/planta/maquinas",
      headers: { authorization: basic },
      payload: { code: "PRENSA2", name: "x", tags: [{ key: "A", source: "hr:1", kind: "value", settings: { formula: "rm -rf" } }] },
    });
    expect(mal.statusCode).toBe(400);
    const cfg = JSON.parse((await app.inject({ url: "/api/planta/v1/config", headers: bearer() })).body);
    const prensa = cfg.maquinas.find((m: any) => m.codigo === "PRENSA1");
    expect(prensa.fuente).toBe("prensa");
    expect(prensa.tags.find((t: any) => t.clave === "Temperatura").ajustes).toEqual({ escala: 0.1 });
    // LINEA1 no tiene fuente ni ajustes: sale como para un agente 0.1.
    const linea = cfg.maquinas.find((m: any) => m.codigo === "LINEA1");
    expect(linea.fuente).toBeUndefined();
    expect(linea.tags[0].ajustes).toBeUndefined();

    await app.inject({
      method: "POST",
      url: "/api/planta/v1/latido",
      headers: bearer(),
      payload: { version: "0.2.0", fuente_ok: false, fuentes: { prensa: { driver: "modbus", ok: false, tags: 2, fallan: 2, error: "no responde" } } },
    });
    const [a] = JSON.parse((await app.inject({ url: "/api/v1/planta/agentes", headers: { authorization: basic } })).body);
    expect(a.last_status.fuentes.prensa).toMatchObject({ driver: "modbus", ok: false, error: "no responde" });
  });

  it("un agente revocado ya no entra", async () => {
    await app.inject({ method: "POST", url: `/api/v1/planta/agentes/${agentId}/revocar`, headers: { authorization: basic } });
    expect((await app.inject({ url: "/api/planta/v1/config", headers: bearer() })).statusCode).toBe(401);
  });
});

describe("Planta con Keycloak", () => {
  it("solo un administrador crea agentes", async () => {
    const db = await openEmbedded();
    await migrate(db);
    const sso: SsoConfig = { issuer: "http://kc.invalid/realms/general", clientId: "sindri-dev", clientSecret: "x", appGroup: "DEV/Sindri", sessionKey: "k" };
    const app = await buildApp({ db, sso });
    const cookie = (admin: boolean) => `sindri_sesion=${encodeURIComponent(sign({ user: "u", name: "U", email: "", admin, exp: Date.now() + 60_000 }, "k"))}`;
    const create = (admin: boolean) =>
      app.inject({ method: "POST", url: "/api/v1/planta/agentes", headers: { cookie: cookie(admin) }, payload: { name: "a" + admin } });
    expect((await create(false)).statusCode).toBe(403);
    expect((await create(true)).statusCode).toBe(201);
    // Sin sesión, la API del agente no redirige a Keycloak: pide su token.
    expect((await app.inject({ url: "/api/planta/v1/config" })).statusCode).toBe(401);
    await app.close();
    await db.close();
  });
});
