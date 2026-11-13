/**
 * Llaves de agente (sda_…): un programa, por ejemplo un hilo de Claude, trabaja en UNA empresa con
 * la misma API que la web (/api/v1/…), sin Keycloak y sin la contraseña de la empresa.
 *
 *  - Se crea en Empresa → Integraciones → Llaves de agente (quien administra la empresa) y se
 *    enseña una sola vez; en la base solo queda su sha256.
 *  - Lleva la empresa ya abierta y un nivel: «consultar» (solo GET) o «cambiar» (lo de un rol con
 *    todo, menos Empresa, Planta y VERI*FACTU, que se quedan en consultar).
 *  - Nunca toca usuarios, roles, invitaciones, contraseñas, llaves, correo ni la elección de empresa.
 *  - Lo que hace queda en el registro con «agente:<nombre>». Se revoca y deja de valer al momento.
 *
 * Además de la API de siempre, /api/agente/v1/ tiene:
 *  - GET  traspaso  instrucciones en Markdown para quien vaya a usar la llave (rutas incluidas).
 *  - GET  rutas     las rutas de /api/v1 y si esta llave puede usarlas.
 *  - POST mcp       servidor MCP (JSON-RPC por HTTP, sin estado) con las herramientas
 *                   sindri_yo, sindri_rutas, sindri_consultar y sindri_cambiar.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db, Queryable } from "./db.js";
import { BusinessError, listCompanies, log, notFound, type Ctx } from "./services.js";
import { ctxOf, ensureUser, MODULES, requireCompanyAdmin, type Level, type Session } from "./usuarios.js";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
export const AGENT_PREFIX = "sda_";

export function newAgentKey() {
  const key = `${AGENT_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hash(key), end: key.slice(-4) };
}

export type AgentLevel = "consultar" | "cambiar";
interface AgentKey {
  id: string;
  company_id: string;
  name: string;
  level: AgentLevel;
}

/** Módulos que una llave de agente nunca cambia, aunque sea de «cambiar». */
const SOLO_CONSULTA = new Set(["empresa", "planta", "verifactu"]);

/**
 * Lo que una llave de agente no puede hacer nunca (método y ruta de /api/v1). El resto lo decide
 * su nivel y los permisos de módulo de siempre (usuarios.ts).
 */
const PROHIBIDO: [RegExp, RegExp][] = [
  [/.*/, /^\/api\/v1\/session\//],
  [/.*/, /^\/api\/v1\/me\/menu/],
  [/.*/, /^\/api\/v1\/company\/(password|members)/],
  [/.*/, /^\/api\/v1\/companies\/[^/]+\/password/],
  [/.*/, /^\/api\/v1\/integraciones\//],
  [/.*/, /^\/api\/v1\/(users|roles|departments)(\/|$)/],
  [/.*/, /^\/api\/v1\/correo(\/|$)/],
  [/^(POST|PUT|PATCH|DELETE)$/, /^\/api\/v1\/companies(\/|$)/],
];

export function agentForbidden(method: string, path: string) {
  return PROHIBIDO.some(([m, p]) => m.test(method) && p.test(path));
}

const bearer = (req: FastifyRequest) => {
  const h = req.headers.authorization ?? "";
  return h.startsWith(`Bearer ${AGENT_PREFIX}`) ? h.slice(7).trim() : null;
};

/** Sesión de Sindri para una llave de agente: su empresa, sin elegir nada y sin contraseña. */
export async function agentSession(db: Db, k: AgentKey): Promise<Session> {
  const person = { user: `agente:${k.name}`, name: `Agente ${k.name}`, admin: false };
  const u = await ensureUser(db, person);
  const perms: Record<string, Level> = {};
  for (const m of MODULES) {
    if (m.id === "usuarios") continue;
    perms[m.id] = k.level === "cambiar" && !SOLO_CONSULTA.has(m.id) ? "editar" : "ver";
  }
  const company = ((await listCompanies(db)) as Session["companies"]).find((c) => c.id === k.company_id);
  if (!company) throw notFound("Empresa");
  return {
    person,
    userId: u.id,
    admin: false,
    companyAdmin: false,
    perms,
    companies: [{ ...company, has_password: false, guest: false }],
    company: k.company_id,
    needsCompany: false,
    roleId: null,
    guest: false,
    agent: { id: k.id, name: k.name, level: k.level },
  };
}

// Llaves (administración de la empresa en uso) ------------------------------------------------

export async function listAgentKeys(q: Queryable, ctx: Ctx) {
  return q.query(
    `select id, name, level, key_end, created_by, created_at, expires_at, last_used_at, revoked_at
     from agent_key where company_id = $1 order by revoked_at nulls first, created_at desc`,
    [ctx.company],
  );
}

export async function createAgentKey(db: Db, ctx: Ctx, b: { name: string; level: AgentLevel; days: number | null }) {
  const k = newAgentKey();
  const [row] = await db.query<{ id: string }>(
    `insert into agent_key (company_id, name, level, key_hash, key_end, created_by, expires_at)
     values ($1, $2, $3, $4, $5, $6, case when $7::int is null then null else now() + make_interval(days => $7::int) end)
     returning id, name, level, key_end, created_at, expires_at`,
    [ctx.company, b.name, b.level, k.hash, k.end, ctx.actor, b.days],
  );
  await log(db, ctx, "agent_key", row!.id, "create", { name: b.name, level: b.level, days: b.days });
  // La llave entera solo se enseña ahora.
  return { ...row, key: k.key };
}

export async function revokeAgentKey(db: Db, ctx: Ctx, id: string) {
  const [row] = await db.query("update agent_key set revoked_at = now() where id = $1 and company_id = $2 and revoked_at is null returning id", [id, ctx.company]);
  if (!row) throw notFound("Llave");
  await log(db, ctx, "agent_key", id, "revoke");
  return { ok: true };
}

// Rutas ---------------------------------------------------------------------------------------

interface Ruta {
  metodo: string;
  ruta: string;
}

/**
 * Se llama al crear la app, antes que ninguna otra entrada: así la llave de agente se resuelve
 * antes que la sesión de Keycloak (sso.ts) y la lista de rutas sale completa.
 */
export function registerAgente(app: FastifyInstance, db: Db) {
  const rutas: Ruta[] = [];
  app.addHook("onRoute", (r) => {
    if (!r.url.startsWith("/api/v1/")) return;
    for (const m of ([] as string[]).concat(r.method as string | string[])) if (m !== "HEAD" && m !== "OPTIONS") rutas.push({ metodo: m, ruta: r.url.slice(7) });
  });

  app.addHook("onRequest", async (req, reply) => {
    const token = bearer(req);
    if (!token) return;
    const path = req.url.split("?")[0]!;
    if (!path.startsWith("/api/v1/") && !path.startsWith("/api/agente/v1/"))
      return reply.status(401).send({ error: "Una llave de agente solo vale para /api/v1/ y /api/agente/v1/" });
    const [k] = await db.query<AgentKey>(
      "select id, company_id, name, level from agent_key where key_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())",
      [hash(token)],
    );
    if (!k) return reply.status(401).send({ error: "Llave de agente no válida, revocada o caducada" });
    if (path.startsWith("/api/v1/")) {
      if (agentForbidden(req.method, path)) return reply.status(403).send({ error: "Una llave de agente no puede hacer esto (usuarios, contraseñas, llaves, correo o empresas)" });
      if (k.level === "consultar" && req.method !== "GET" && req.method !== "HEAD")
        return reply.status(403).send({ error: "Esta llave de agente solo permite consultar" });
    }
    req.sindri = await agentSession(db, k);
    await db.query("update agent_key set last_used_at = now() where id = $1", [k.id]);
  });

  // Administración: las llaves de agente de la empresa en uso.
  app.get("/api/v1/integraciones/agentes", async (req) => {
    requireCompanyAdmin(req);
    return listAgentKeys(db, ctxOf(req));
  });
  app.post("/api/v1/integraciones/agentes", async (req, reply) => {
    requireCompanyAdmin(req);
    const b = z
      .object({
        name: z.string().trim().min(2).max(40).regex(/^[a-z0-9][a-z0-9_-]*$/, "Nombre en minúsculas, sin espacios (p. ej. claude)"),
        level: z.enum(["consultar", "cambiar"]),
        days: z.number().int().min(1).max(3650).nullish(),
      })
      .parse(req.body);
    return reply.status(201).send(await createAgentKey(db, ctxOf(req), { name: b.name, level: b.level, days: b.days ?? null }));
  });
  app.delete<{ Params: { id: string } }>("/api/v1/integraciones/agentes/:id", async (req) => {
    requireCompanyAdmin(req);
    return revokeAgentKey(db, ctxOf(req), z.uuid().parse(req.params.id));
  });

  // Lo propio del agente -----------------------------------------------------------------------
  const agente = (req: FastifyRequest) => {
    const s = req.sindri;
    if (!s?.agent) throw new BusinessError("Hace falta una llave de agente (Authorization: Bearer sda_…)", 401);
    return s as Session & { agent: NonNullable<Session["agent"]> };
  };
  const puede = (s: Session & { agent: NonNullable<Session["agent"]> }, r: Ruta) =>
    !agentForbidden(r.metodo, `/api/v1${r.ruta}`) && (r.metodo === "GET" || s.agent.level === "cambiar");
  const listaRutas = (s: Session & { agent: NonNullable<Session["agent"]> }) =>
    rutas
      .filter((r) => !agentForbidden(r.metodo, `/api/v1${r.ruta}`))
      .sort((a, b) => a.ruta.localeCompare(b.ruta) || a.metodo.localeCompare(b.metodo))
      .map((r) => ({ ...r, permitida: puede(s, r) }));
  const yo = (s: Session & { agent: NonNullable<Session["agent"]> }) => {
    const c = s.companies[0]!;
    return { agente: s.agent.name, nivel: s.agent.level, empresa: { id: c.id, code: c.code, name: c.name, trade_name: c.trade_name, tax_id: c.tax_id, demo: c.demo }, permisos: s.perms };
  };

  /** Llama a la API de siempre con la misma llave: pasan los mismos permisos y comprobaciones. */
  const llamar = async (req: FastifyRequest, metodo: string, ruta: string, cuerpo?: unknown) => {
    const r = ruta.startsWith("/") ? ruta : `/${ruta}`;
    if (r.includes("..") || r.startsWith("//")) throw new BusinessError("Ruta no válida", 400);
    const res = await app.inject({
      method: metodo as "GET",
      url: `/api/v1${r.replace(/^\/api\/v1(?=\/)/, "")}`,
      headers: { authorization: req.headers.authorization!, ...(cuerpo !== undefined ? { "content-type": "application/json" } : {}) },
      ...(cuerpo !== undefined ? { payload: JSON.stringify(cuerpo) } : {}),
    });
    let body: unknown = res.body;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      /* no es JSON (un PDF, un CSV…): se devuelve el texto */
    }
    return { status: res.statusCode, body };
  };

  app.get("/api/agente/v1/yo", async (req) => yo(agente(req)));
  app.get("/api/agente/v1/rutas", async (req) => listaRutas(agente(req)));
  app.get("/api/agente/v1/traspaso", async (req, reply) => {
    const s = agente(req);
    const y = yo(s);
    const lista = listaRutas(s)
      .filter((r) => r.permitida)
      .map((r) => `| ${r.metodo} | \`${r.ruta}\` |`)
      .join("\n");
    const md = `# Sindri para el agente «${y.agente}»

Empresa: **${y.empresa.trade_name ?? y.empresa.name}** (código ${y.empresa.code ?? "—"}, NIF ${y.empresa.tax_id}${y.empresa.demo ? ", demostración" : ""}).
Nivel: **${y.nivel}** (${y.nivel === "cambiar" ? "consultar y cambiar; Empresa, Planta y VERI*FACTU solo consultar" : "solo consultar"}).

La empresa ya va abierta: no hay que elegirla ni escribir su contraseña.
Nunca se tocan usuarios, roles, contraseñas, llaves ni el correo.
Todo queda en el registro de Sindri como «agente:${y.agente}».

## Cómo se llama

Con \`Authorization: Bearer sda_…\` (en la nube la pone el proxy del entorno: no hace falta escribirla).

\`\`\`bash
B="https://<dominio>/sindri"            # la misma dirección que la web
curl -fsS "$B/api/agente/v1/yo"
curl -fsS "$B/api/v1/partners?q=taller"
curl -fsS -H 'Content-Type: application/json' -d '{"name":"Cliente SL","tax_id":"B12345674"}' "$B/api/v1/partners"
\`\`\`

MCP (JSON-RPC por HTTP): \`POST $B/api/agente/v1/mcp\` con las herramientas \`sindri_yo\`, \`sindri_rutas\`, \`sindri_consultar\` y \`sindri_cambiar\`.

## Rutas que puede usar esta llave (debajo de /api/v1)

| Método | Ruta |
|---|---|
${lista}
`;
    return reply.type("text/markdown; charset=utf-8").send(md);
  });

  // MCP -----------------------------------------------------------------------------------------
  const HERRAMIENTAS = [
    { name: "sindri_yo", description: "Empresa, nivel y permisos de esta llave de agente.", inputSchema: { type: "object", properties: {} } },
    { name: "sindri_rutas", description: "Rutas de la API de Sindri (debajo de /api/v1) y si esta llave puede usarlas.", inputSchema: { type: "object", properties: {} } },
    {
      name: "sindri_consultar",
      description: "GET a la API de Sindri. ruta va debajo de /api/v1, con su ?consulta si hace falta (p. ej. /partners?q=taller).",
      inputSchema: { type: "object", properties: { ruta: { type: "string" } }, required: ["ruta"] },
    },
    {
      name: "sindri_cambiar",
      description: "POST, PUT, PATCH o DELETE a la API de Sindri (solo con una llave de nivel «cambiar»). cuerpo es el JSON que se manda.",
      inputSchema: {
        type: "object",
        properties: { metodo: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"] }, ruta: { type: "string" }, cuerpo: {} },
        required: ["metodo", "ruta"],
      },
    },
  ];
  const texto = (v: unknown, isError = false) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }], isError });

  // Sin estado: no hay canal de eventos (SSE) que abrir.
  app.get("/api/agente/v1/mcp", async (_req, reply) => reply.status(405).header("allow", "POST").send({ error: "Solo POST" }));
  app.post("/api/agente/v1/mcp", async (req, reply) => {
    const s = agente(req);
    const m = req.body as { jsonrpc?: string; id?: string | number | null; method?: string; params?: any } | undefined;
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string")
      return reply.status(400).send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Petición JSON-RPC no válida" } });
    // Las notificaciones no llevan respuesta.
    if (m.id === undefined) return reply.status(202).send();
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize":
        return ok({
          protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "sindri", version: "1" },
          instructions: "API de Sindri (ERP) para una empresa. Empieza por sindri_yo y sindri_rutas.",
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: s.agent.level === "cambiar" ? HERRAMIENTAS : HERRAMIENTAS.filter((h) => h.name !== "sindri_cambiar") });
      case "tools/call": {
        const name = m.params?.name;
        const a = m.params?.arguments ?? {};
        if (name === "sindri_yo") return ok(texto(yo(s)));
        if (name === "sindri_rutas") return ok(texto(listaRutas(s)));
        if (name === "sindri_consultar") {
          if (typeof a.ruta !== "string") return ok(texto("Falta ruta", true));
          const r = await llamar(req, "GET", a.ruta);
          return ok(texto(r, r.status >= 400));
        }
        if (name === "sindri_cambiar") {
          if (s.agent.level !== "cambiar") return ok(texto("Esta llave solo permite consultar", true));
          if (!["POST", "PUT", "PATCH", "DELETE"].includes(a.metodo) || typeof a.ruta !== "string") return ok(texto("Faltan metodo o ruta", true));
          const r = await llamar(req, a.metodo, a.ruta, a.cuerpo);
          return ok(texto(r, r.status >= 400));
        }
        return { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `Herramienta desconocida: ${name}` } };
      }
      default:
        return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Método no soportado: ${m.method}` } };
    }
  });
}
