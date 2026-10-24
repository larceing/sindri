/**
 * Conexión con planta (docs/INSTRUCCIONES.md, parte C).
 *
 * Dos APIs:
 *  - /api/planta/v1/...  la usa el agente de planta con su token (Authorization: Bearer).
 *    Solo sirve para esto: con ese token no se ve nada más del ERP.
 *  - /api/v1/planta/...  la usan la web y el escritorio con la sesión de la persona.
 *    Crear o revocar agentes y cambiar máquinas solo lo hace un administrador.
 *
 * El ERP no escribe en la planta: solo recibe lecturas.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "./db.js";
import { BusinessError } from "./services.js";

/** Versión más vieja del agente que esta API sigue sirviendo. */
export const PLANTA_MINIMA = "0.1.0";
/** Días que se guarda el detalle (cambios). Los resúmenes por minuto se guardan siempre. */
export const DIAS_DETALLE = 90;
/** Minutos sin latido para dar un agente por callado. */
export const MINUTOS_CALLADO = 5;

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export function newToken() {
  const token = `sdp_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token), hint: token.slice(-4) };
}

// Esquemas ---------------------------------------------------------------------------

const code = z.string().trim().regex(/^[A-Za-z0-9_.-]{1,40}$/, "Solo letras, números, punto, guion y guion bajo");

/** Ajustes de un tag que aplica el agente al leer (drivers/base.py, transformar). */
const SettingsSchema = z
  .object({
    escala: z.number().finite().optional(),
    desplazamiento: z.number().finite().optional(),
    bit: z.number().int().min(0).max(63).optional(),
    mapa: z.record(z.string().max(60), z.union([z.number().finite(), z.string().max(120)])).optional(),
    defecto_mapa: z.union([z.number().finite(), z.string().max(120)]).optional(),
    hex: z
      .object({
        inicio: z.number().int().min(0).max(255).optional(),
        bytes: z.number().int().min(1).max(8).optional(),
        signo: z.boolean().optional(),
        desplazar: z.number().int().min(0).max(63).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const TagSchema = z.object({
  key: code,
  // La dirección en la sintaxis del driver: Planta/Linea1/Estado, hr:100:uint32, DB10:4:REAL…
  source: z.string().trim().min(1).max(500),
  kind: z.enum(["state", "counter", "value", "text"]),
  label: z.string().trim().max(80).nullish(),
  unit: z.string().trim().max(20).nullish(),
  settings: SettingsSchema.nullish(),
});

const MachineSchema = z.object({
  code,
  name: z.string().trim().min(1).max(120),
  agent_id: z.uuid().nullish(),
  namespace_uri: z.string().trim().max(300).nullish(),
  // Nombre de la fuente en fuentes.json del agente (p. ej. "prensa"). Sin él, la única que tenga.
  source_name: code.nullish(),
  active: z.boolean().optional(),
  tags: z.array(TagSchema).max(200).optional(),
});

const iso = z.iso.datetime({ offset: true });
const num = z.number().finite().nullish();

const ReadingSchema = z.object({
  id: z.string().min(1).max(200),
  maquina: code,
  tag: code,
  tipo: z.enum(["cambio", "minuto"]),
  ts: iso,
  valor: num,
  texto: z.string().max(500).nullish(),
  min: num,
  max: num,
  media: num,
  n: z.number().int().nonnegative().nullish(),
});
const ReadingsSchema = z.object({ lecturas: z.array(ReadingSchema).max(1000) });

const HeartbeatSchema = z.object({
  version: z.string().max(40),
  pendientes: z.number().int().nonnegative().optional(),
  fuente_ok: z.boolean().optional(),
  error: z.string().max(500).nullish(),
  ts: iso.optional(),
  // Cómo va cada fuente (desde Efesto 0.2): {"prensa": {"driver": "modbus", "ok": true, ...}}
  fuentes: z
    .record(
      code,
      z.object({
        driver: z.string().max(40),
        ok: z.boolean(),
        tags: z.number().int().nonnegative().optional(),
        fallan: z.number().int().nonnegative().optional(),
        error: z.string().max(300).nullish(),
      }),
    )
    .refine((f) => Object.keys(f).length <= 100, "Demasiadas fuentes")
    .optional(),
});

// Servicios --------------------------------------------------------------------------

type Agent = { id: string; name: string; revoked_at: string | null };

export async function agentFromToken(db: Db, token: string): Promise<Agent | null> {
  if (!token.startsWith("sdp_")) return null;
  const [a] = await db.query<Agent>("select id, name, revoked_at from plant_agent where token_hash = $1", [hashToken(token)]);
  return a && !a.revoked_at ? a : null;
}

export async function createAgent(db: Db, name: string, by: string | null) {
  const t = newToken();
  const [a] = await db.query(
    "insert into plant_agent (name, token_hash, token_hint, created_by) values ($1, $2, $3, $4) returning id, name, token_hint, created_at",
    [name, t.hash, t.hint, by],
  );
  // El token se enseña esta vez y no se puede volver a ver.
  return { ...a, token: t.token };
}

export async function revokeAgent(db: Db, id: string) {
  const [a] = await db.query("update plant_agent set revoked_at = coalesce(revoked_at, now()) where id = $1 returning id, name, revoked_at", [id]);
  if (!a) throw new BusinessError("Agente no encontrado", 404);
  return a;
}

export async function listAgents(db: Db) {
  return db.query(
    `select id, name, token_hint, created_at, created_by, revoked_at, last_seen_at, last_version, last_status,
            (revoked_at is null and (last_seen_at is null or last_seen_at < now() - make_interval(mins => $1))) as callado
       from plant_agent order by revoked_at nulls first, name`,
    [MINUTOS_CALLADO],
  );
}

export async function listMachines(db: Db) {
  const machines = await db.query<{ id: string }>(
    `select m.id, m.code, m.name, m.agent_id, a.name as agent_name, m.namespace_uri, m.source_name, m.active
       from plant_machine m left join plant_agent a on a.id = m.agent_id order by m.code`,
  );
  const tags = await db.query<{ machine_id: string }>("select machine_id, key, source, kind, label, unit, settings from plant_tag order by key");
  return machines.map((m) => ({ ...m, tags: tags.filter((t) => t.machine_id === m.id).map(({ machine_id: _, ...t }) => t) }));
}

export async function saveMachine(db: Db, input: z.infer<typeof MachineSchema>) {
  return db.tx(async (q) => {
    const [m] = await q.query<{ id: string }>(
      `insert into plant_machine (code, name, agent_id, namespace_uri, source_name, active) values ($1, $2, $3, $4, $5, coalesce($6, true))
       on conflict (code) do update set name = excluded.name, agent_id = excluded.agent_id,
         namespace_uri = excluded.namespace_uri, source_name = excluded.source_name, active = excluded.active
       returning id`,
      [input.code, input.name, input.agent_id ?? null, input.namespace_uri ?? null, input.source_name ?? null, input.active ?? null],
    );
    if (input.tags) {
      await q.query("delete from plant_tag where machine_id = $1", [m!.id]);
      for (const t of input.tags)
        await q.query("insert into plant_tag (machine_id, key, source, kind, label, unit, settings) values ($1, $2, $3, $4, $5, $6, $7)", [
          m!.id, t.key, t.source, t.kind, t.label ?? null, t.unit ?? null, t.settings ? JSON.stringify(t.settings) : null,
        ]);
    }
    return m;
  });
}

/** Lo que descarga el agente: qué máquinas lee y qué tags, y cada cuánto. */
export async function agentConfig(db: Db, agent: Agent, entorno: string) {
  const machines = (await listMachines(db)).filter((m: any) => m.agent_id === agent.id && m.active);
  return {
    agente: agent.name,
    entorno,
    planta_minima: PLANTA_MINIMA,
    lectura_s: 1,
    envio_s: 5,
    latido_s: 30,
    config_s: 300,
    // Escribir en la planta está desactivado (parte C, punto 5).
    escritura: false,
    maquinas: machines.map((m: any) => ({
      codigo: m.code,
      nombre: m.name,
      espacio: m.namespace_uri,
      // Un agente 0.1 no conoce fuente ni ajustes y los ignora: solo lee OPC UA.
      ...(m.source_name ? { fuente: m.source_name } : {}),
      tags: m.tags.map((t: any) => ({ clave: t.key, origen: t.source, tipo: t.kind, ...(t.settings ? { ajustes: t.settings } : {}) })),
    })),
  };
}

export async function heartbeat(db: Db, agent: Agent, body: z.infer<typeof HeartbeatSchema>) {
  await db.query("update plant_agent set last_seen_at = now(), last_version = $2, last_status = $3 where id = $1", [
    agent.id,
    body.version,
    JSON.stringify({
      pendientes: body.pendientes ?? 0,
      fuente_ok: body.fuente_ok ?? null,
      error: body.error ?? null,
      ts: body.ts ?? null,
      ...(body.fuentes ? { fuentes: body.fuentes } : {}),
    }),
  ]);
}

let lastCleanup = 0;

/** Borra el detalle viejo. Va como mucho una vez por hora, al llegar lecturas. */
export async function cleanup(db: Db, force = false) {
  if (!force && Date.now() - lastCleanup < 3600_000) return 0;
  lastCleanup = Date.now();
  const rows = await db.query("delete from plant_reading where kind = 'change' and ts < now() - make_interval(days => $1) returning 1", [DIAS_DETALLE]);
  return rows.length;
}

export async function saveReadings(db: Db, agent: Agent, lecturas: z.infer<typeof ReadingSchema>[]) {
  // No se aceptan horas de más de un día en el futuro: casi seguro es un reloj mal puesto.
  const limit = Date.now() + 86_400_000;
  let nuevas = 0;
  const rechazadas: string[] = [];
  await db.tx(async (q) => {
    for (const l of lecturas) {
      if (Date.parse(l.ts) > limit) {
        rechazadas.push(l.id);
        continue;
      }
      const r = await q.query(
        `insert into plant_reading (agent_id, reading_id, machine_code, tag_key, kind, ts, value, text_value, min_value, max_value, avg_value, samples)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict do nothing returning 1`,
        [agent.id, l.id, l.maquina, l.tag, l.tipo === "cambio" ? "change" : "minute", l.ts, l.valor ?? null, l.texto ?? null, l.min ?? null, l.max ?? null, l.media ?? null, l.n ?? null],
      );
      nuevas += r.length;
    }
    await q.query("update plant_agent set last_seen_at = now() where id = $1", [agent.id]);
  });
  await cleanup(db);
  return { recibidas: lecturas.length, nuevas, rechazadas };
}

/** Último valor de cada tag de cada máquina, para la pantalla de planta. */
export async function plantStatus(db: Db) {
  const machines = await listMachines(db);
  const last = await db.query<{ machine_code: string; tag_key: string }>(
    `select distinct on (machine_code, tag_key) machine_code, tag_key, kind, ts, value, text_value, min_value, max_value, avg_value
       from plant_reading order by machine_code, tag_key, ts desc`,
  );
  return machines.map((m: any) => ({
    ...m,
    ultimos: Object.fromEntries(last.filter((r) => r.machine_code === m.code).map(({ machine_code: _, ...r }) => [r.tag_key, r])),
  }));
}

export async function machineReadings(db: Db, machineCode: string, tag: string | undefined, hours: number) {
  return db.query(
    `select tag_key, kind, ts, value, text_value, min_value, max_value, avg_value, samples from plant_reading
      where machine_code = $1 and ($2::text is null or tag_key = $2) and ts > now() - make_interval(hours => $3)
      order by ts desc limit 2000`,
    [machineCode, tag ?? null, hours],
  );
}

// Rutas ------------------------------------------------------------------------------

export interface PlantaOptions {
  /** Quién es la persona y si administra. Sin entrada con Keycloak, quien entra administra. */
  person: (req: FastifyRequest) => { user: string; admin: boolean } | null;
  entorno: string;
}

declare module "fastify" {
  interface FastifyRequest {
    plantAgent?: Agent;
  }
}

export function registerPlanta(app: FastifyInstance, db: Db, opts: PlantaOptions) {
  // API del agente: su token y nada más.
  app.register(async (agentApi) => {
    agentApi.addHook("onRequest", async (req, reply) => {
      const h = req.headers.authorization ?? "";
      const agent = h.startsWith("Bearer ") ? await agentFromToken(db, h.slice(7).trim()) : null;
      if (!agent) return reply.status(401).send({ error: "Token de agente no válido o revocado" });
      req.plantAgent = agent;
    });
    agentApi.get("/config", async (req) => agentConfig(db, req.plantAgent!, opts.entorno));
    agentApi.post("/latido", async (req) => {
      await heartbeat(db, req.plantAgent!, HeartbeatSchema.parse(req.body));
      return { ok: true, planta_minima: PLANTA_MINIMA, hora: new Date().toISOString() };
    });
    agentApi.post("/lecturas", async (req) => saveReadings(db, req.plantAgent!, ReadingsSchema.parse(req.body).lecturas));
  }, { prefix: "/api/planta/v1" });

  const admin = (req: FastifyRequest) => {
    const p = opts.person(req);
    if (!p?.admin) throw new BusinessError("Solo un administrador puede hacer esto", 403);
    return p;
  };

  app.get("/api/v1/planta", async () => plantStatus(db));
  app.get<{ Params: { code: string }; Querystring: { tag?: string; horas?: string } }>("/api/v1/planta/maquinas/:code/lecturas", async (req) =>
    machineReadings(db, req.params.code, req.query.tag, Math.min(Math.max(Number(req.query.horas) || 24, 1), 24 * 90)),
  );
  app.get("/api/v1/planta/maquinas", async () => listMachines(db));
  app.put("/api/v1/planta/maquinas", async (req) => {
    admin(req);
    return saveMachine(db, MachineSchema.parse(req.body));
  });
  app.get("/api/v1/planta/agentes", async () => listAgents(db));
  app.post("/api/v1/planta/agentes", async (req, reply) => {
    const p = admin(req);
    const { name } = z.object({ name: code }).parse(req.body);
    return reply.status(201).send(await createAgent(db, name, p.user));
  });
  app.post<{ Params: { id: string } }>("/api/v1/planta/agentes/:id/revocar", async (req) => {
    admin(req);
    return revokeAgent(db, z.uuid().parse(req.params.id));
  });
}
