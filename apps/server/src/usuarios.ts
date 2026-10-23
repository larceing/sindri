/**
 * Usuarios, roles, departamentos y empresa en uso.
 *
 * Quién entra lo decide Keycloak (o el modo local). Dentro de Sindri cada persona tiene una
 * ficha (app_user) con su rol, que dice qué módulos ve y en cuáles puede cambiar cosas, su
 * departamento, las empresas en las que trabaja y su menú. Un administrador de Keycloak
 * (grupo …/Admin o IT) lo puede todo.
 *
 * Empresa en uso: cookie de sesión «sindri_empresa». Con una sola empresa posible se elige
 * sola; con varias, la web pregunta al entrar.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db, Queryable } from "./db.js";
import { BusinessError, createCompany, listCompanies, log, notFound, type Ctx } from "./services.js";
import { readCookie, setCookie, sign, verify } from "./sso.js";

export const MODULES = [
  { id: "inicio", label: "Inicio" },
  { id: "relaciones", label: "Relaciones" },
  { id: "crm", label: "Oportunidades" },
  { id: "presupuestos", label: "Presupuestos" },
  { id: "pedidos", label: "Pedidos" },
  { id: "rutas", label: "Hojas de ruta" },
  { id: "facturas", label: "Facturas" },
  { id: "clientes", label: "Clientes" },
  { id: "comerciales", label: "Comerciales" },
  { id: "productos", label: "Productos" },
  { id: "almacen", label: "Almacén" },
  { id: "planta", label: "Planta" },
  { id: "verifactu", label: "VERI*FACTU" },
  { id: "informes", label: "Informes" },
  { id: "empresa", label: "Empresa" },
  { id: "usuarios", label: "Usuarios" },
] as const;
export type ModuleId = (typeof MODULES)[number]["id"];
export type Level = "ver" | "editar";
const MODULE_IDS = MODULES.map((m) => m.id) as string[];

/** Qué módulo protege cada ruta de la API. Lo que no está aquí, solo lo usa un administrador. */
const ROUTE_MODULE: [string, ModuleId][] = [
  ["/api/v1/partners", "clientes"],
  ["/api/v1/sales-reps", "comerciales"],
  ["/api/v1/opportunities", "crm"],
  ["/api/v1/crm", "crm"],
  ["/api/v1/quotations", "presupuestos"],
  ["/api/v1/quotation-templates", "presupuestos"],
  ["/api/v1/sales-orders", "pedidos"],
  ["/api/v1/por-facturar", "pedidos"],
  ["/api/v1/routes", "rutas"],
  ["/api/v1/invoices", "facturas"],
  ["/api/v1/products", "productos"],
  ["/api/v1/stock", "almacen"],
  ["/api/v1/locations", "almacen"],
  ["/api/v1/planta", "planta"],
  ["/api/v1/verifactu", "verifactu"],
  ["/api/v1/informes", "informes"],
  ["/api/v1/company", "empresa"],
  ["/api/v1/users", "usuarios"],
  ["/api/v1/roles", "usuarios"],
  ["/api/v1/departments", "usuarios"],
  ["/api/v1/events", "usuarios"],
  // Relaciones: todos la ven; cada nodo mira el permiso de su módulo (grafo.ts).
  ["/api/v1/grafo", "relaciones"],
];

/** Rutas de la API que no dependen de permisos ni de empresa. */
const FREE = new Set(["/api/v1/me", "/api/v1/me/menu", "/api/v1/session/company", "/api/v1/modules", "/api/v1/health", "/api/v1/compat"]);
/** Rutas con permiso pero que funcionan sin empresa elegida. */
const NO_COMPANY = new Set(["/api/v1/company", "/api/v1/companies", "/api/v1/users", "/api/v1/roles", "/api/v1/departments"]);

export interface Person {
  user: string;
  name?: string;
  email?: string;
  admin: boolean;
  /** Subgrupos de Keycloak bajo el de la app («Empresa/002», «Rol/Comercial»). Ver keycloakAccess. */
  groups?: string[];
}

export interface Session {
  person: Person;
  userId: string;
  /** Administra: grupo de administración de Keycloak o rol con «usuarios: editar». */
  admin: boolean;
  perms: Record<string, Level>;
  companies: {
    id: string;
    name: string;
    trade_name: string | null;
    tax_id: string;
    code: string | null;
    demo: boolean;
    restricted: boolean;
    master_company_id: string | null;
    /** Pide contraseña al elegirla (ver «Contraseña de la empresa» abajo). */
    has_password: boolean;
  }[];
  company: string | null;
  needsCompany: boolean;
  /**
   * Administra solo sus empresas: tiene grupos «Empresa/…» en Keycloak y un rol con todo. Ve y
   * cambia todo dentro de ellas, pero no usuarios, roles ni otras empresas (eso es global).
   */
  companyAdmin: boolean;
  /** Su rol: el de Keycloak («Rol/<nombre>») si lo tiene; si no, el de Usuarios. */
  roleId: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    sindri?: Session;
  }
}

const COOKIE = "sindri_empresa";
const UNLOCK = "sindri_llave";
const UNLOCK_HOURS = 12;

// Contraseña de la empresa ----------------------------------------------------------------
// Una empresa puede pedir contraseña al elegirla, además del login de Keycloak. La pone quien la
// administra y la puede cambiar sabiendo la actual. Al cambiarla, quien la tenía abierta la vuelve
// a pedir. Se guarda con scrypt en company_access, nunca en la ficha de la empresa.

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
/** Firma de la cookie que dice «ya ha escrito la contraseña». */
let unlockKey = randomBytes(32).toString("hex");

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `s1$${salt.toString("base64url")}$${(await scryptAsync(pw, salt, 32)).toString("base64url")}`;
}

export async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [v, salt, hash] = stored.split("$");
  if (v !== "s1" || !salt || !hash) return false;
  const good = Buffer.from(hash, "base64url");
  const given = await scryptAsync(pw, Buffer.from(salt, "base64url"), good.length);
  return timingSafeEqual(given, good);
}

async function companyAccess(q: Queryable) {
  const rows = await q.query<{ company_id: string; password_hash: string; changed_at: Date | string }>("select * from company_access");
  return new Map(rows.map((r) => [r.company_id, { hash: r.password_hash, stamp: new Date(r.changed_at).getTime() }]));
}

type Unlock = { u: string; c: string; t: number; exp: number };
const unlocked = (req: FastifyRequest, userId: string, companyId: string, stamp: number) => {
  const v = verify<Unlock>(readCookie(req, UNLOCK), unlockKey);
  return !!v && v.u === userId && v.c === companyId && v.t === stamp;
};
const setUnlock = (reply: FastifyReply, req: FastifyRequest, userId: string, companyId: string, stamp: number) =>
  setCookie(reply, req, UNLOCK, sign({ u: userId, c: companyId, t: stamp, exp: Date.now() + UNLOCK_HOURS * 3600_000 }, unlockKey), null);
/** Un fallo de contraseña tarda un poco: frena a quien prueba a ciegas. */
const pause = () => new Promise((r) => setTimeout(r, 400));

export function moduleFor(path: string): ModuleId | null {
  for (const [p, m] of ROUTE_MODULE) if (path === p || path.startsWith(p + "/") || path.startsWith(p + "?")) return m;
  return null;
}

const ALL: Record<string, Level> = Object.fromEntries(MODULE_IDS.map((m) => [m, "editar" as Level]));

/** Ficha de la persona: se crea la primera vez que entra, con el rol «Consulta». */
export async function ensureUser(db: Db, p: Person) {
  const [u] = await db.query<{ id: string; active: boolean; role_id: string | null }>("select * from app_user where username = $1", [p.user]);
  if (u) return u;
  const [consulta] = await db.query<{ id: string }>("select id from role where name = 'Consulta'");
  const [created] = await db.query<{ id: string; active: boolean; role_id: string | null }>(
    `insert into app_user (username, name, email, role_id) values ($1, $2, $3, $4)
     on conflict (username) do update set name = coalesce(app_user.name, excluded.name) returning *`,
    [p.user, p.name ?? p.user, p.email ?? null, p.admin ? null : consulta?.id ?? null],
  );
  return created!;
}

/**
 * Lo que dicen los grupos de Keycloak dentro de Sindri (debajo del grupo de la app):
 *  - «Empresa/<código>»: trabaja en esa empresa. Las empresas reservadas solo las ve quien
 *    tenga su grupo, también los administradores.
 *  - «Rol/<nombre>»: su rol en Sindri es ese (manda sobre el que tenga puesto en Usuarios).
 */
export function keycloakAccess(groups: string[] | undefined) {
  const companies = new Set<string>();
  let role: string | null = null;
  for (const g of groups ?? []) {
    const [kind, value, ...rest] = g.split("/");
    if (!value || rest.length) continue;
    if (kind === "Empresa") companies.add(value.toUpperCase());
    else if (kind === "Rol" && !role) role = value;
  }
  return { companies, role };
}

export async function loadSession(db: Db, req: FastifyRequest, person: Person): Promise<Session> {
  const u = await ensureUser(db, person);
  if (!u.active && !person.admin) throw new BusinessError("Tu usuario está desactivado en Sindri. Habla con administración.", 403);
  const kc = keycloakAccess(person.groups);
  const [kcRole] = kc.role ? await db.query<{ id: string }>("select id from role where lower(name) = lower($1)", [kc.role]) : [];
  const roleId = kcRole?.id ?? u.role_id;
  const [role] = roleId ? await db.query<{ permissions: Record<string, Level> }>("select permissions from role where id = $1", [roleId]) : [];
  const rolePerms = role?.permissions ?? {};
  // Quien tiene grupos de empresa en Keycloak administra, como mucho, esas empresas: usuarios y
  // roles son de todo Sindri y se quedan para administración general.
  const scoped = !person.admin && kc.companies.size > 0;
  const admin = person.admin || (!scoped && rolePerms.usuarios === "editar");
  const companyAdmin = scoped && rolePerms.usuarios === "editar";
  // Inicio y Relaciones los tiene todo el mundo (Relaciones solo enseña lo de los módulos que ve).
  const perms: Record<string, Level> = admin ? { ...ALL } : { ...rolePerms, inicio: "ver", relaciones: "ver" };
  if (scoped) delete perms.usuarios;

  const access = await companyAccess(db);
  const all = ((await listCompanies(db)) as Session["companies"]).map((c) => ({ ...c, has_password: access.has(c.id) }));
  const assigned = new Set((await db.query<{ company_id: string }>("select company_id from user_company where user_id = $1", [u.id])).map((r) => r.company_id));
  const inKc = (c: Session["companies"][number]) => !!c.code && kc.companies.has(c.code.toUpperCase());
  // Sin empresas asignadas (ni en Sindri ni en Keycloak), trabaja en todas; en cuanto se le asigna
  // alguna, solo en esas. Las de demostración están abiertas a todos; las reales, a quien se le asignen.
  // Las reservadas, solo a quien tenga su grupo en Keycloak, aunque administre.
  const open = all.filter((c) => !c.restricted || inKc(c));
  const free = admin || (assigned.size === 0 && kc.companies.size === 0);
  const companies = free ? open : open.filter((c) => assigned.has(c.id) || inKc(c) || c.demo);
  const chosen = readCookie(req, COOKIE);
  let company = companies.find((c) => c.id === chosen)?.id ?? (companies.length === 1 ? companies[0]!.id : null);
  // Con contraseña, solo vale si ya la ha escrito en esta sesión (y no ha cambiado desde entonces).
  const lock = company ? access.get(company) : undefined;
  if (company && lock && !unlocked(req, u.id, company, lock.stamp)) company = null;
  const needsCompany = !company && (companies.length > 1 || companies.some((c) => c.has_password));
  return { person, userId: u.id, admin, companyAdmin, perms, companies, company, needsCompany, roleId: roleId ?? null };
}

export const ctxOf = (req: FastifyRequest): Ctx => {
  const s = req.sindri;
  if (!s?.company) {
    if (s && s.companies.length === 0) throw new BusinessError("Configura primero los datos de tu empresa", 409);
    throw Object.assign(new BusinessError("Elige con qué empresa vas a trabajar", 409), { code: "elegir_empresa" });
  }
  return { company: s.company, actor: s.person.user };
};

/** Ctx si hay empresa elegida; null si todavía no hay ninguna empresa (primer arranque). */
export const maybeCtx = (req: FastifyRequest): Ctx | null => (req.sindri?.company ? ctxOf(req) : null);

export function requireAdmin(req: FastifyRequest) {
  if (!req.sindri?.admin) throw new BusinessError("Solo administración puede hacer esto", 403);
}

// Esquemas ---------------------------------------------------------------------------

const optText = z.string().trim().min(1).nullish();
const PermsSchema = z.record(z.enum(MODULE_IDS as [string, ...string[]]), z.enum(["ver", "editar"]));
const RoleSchema = z.object({ name: z.string().trim().min(1).max(60), description: optText, permissions: PermsSchema });
const DepartmentSchema = z.object({ name: z.string().trim().min(1).max(60) });
const UserSchema = z.object({
  username: z.string().trim().min(1).max(64),
  name: optText,
  email: optText,
  role_id: z.uuid().nullish(),
  department_id: z.uuid().nullish(),
  active: z.boolean().optional(),
  company_ids: z.array(z.uuid()).optional(),
});
const MenuSchema = z.object({
  posicion: z.enum(["lateral", "superior", "inferior"]),
  orden: z.array(z.enum(MODULE_IDS as [string, ...string[]])).max(40),
  ocultos: z.array(z.enum(MODULE_IDS as [string, ...string[]])).max(40),
});
const CompanySchema = z.object({
  name: z.string().trim().min(1),
  tax_id: z.string().trim().min(1),
  trade_name: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  postal_code: z.string().optional(),
  gs1_prefix: z.string().regex(/^\d{6,12}$/).optional(),
  code: z.string().trim().min(1).max(10).optional(),
  demo: z.boolean().optional(),
});

// Servicios --------------------------------------------------------------------------

export async function listUsers(q: Queryable) {
  return q.query(
    `select u.*, r.name as role_name, d.name as department_name,
       coalesce((select json_agg(uc.company_id) from user_company uc where uc.user_id = u.id), '[]'::json) as company_ids
     from app_user u left join role r on r.id = u.role_id left join department d on d.id = u.department_id
     order by u.active desc, coalesce(u.name, u.username)`,
  );
}

async function saveUserCompanies(q: Queryable, userId: string, ids: string[] | undefined) {
  if (ids === undefined) return;
  await q.query("delete from user_company where user_id = $1", [userId]);
  for (const c of ids) await q.query("insert into user_company (user_id, company_id) values ($1, $2) on conflict do nothing", [userId, c]);
}

export async function createUser(db: Db, actor: string, input: z.infer<typeof UserSchema>) {
  return db.tx(async (q) => {
    const [u] = await q.query<{ id: string }>(
      "insert into app_user (username, name, email, role_id, department_id, active) values ($1,$2,$3,$4,$5,coalesce($6, true)) returning id",
      [input.username, input.name ?? null, input.email ?? null, input.role_id ?? null, input.department_id ?? null, input.active ?? null],
    );
    await saveUserCompanies(q, u!.id, input.company_ids);
    await log(q, { company: null as never, actor }, "app_user", u!.id, "create", input);
    return u;
  });
}

export async function updateUser(db: Db, actor: string, id: string, input: Partial<z.infer<typeof UserSchema>>) {
  return db.tx(async (q) => {
    const fields = (["name", "email", "role_id", "department_id", "active"] as const).filter((f) => input[f] !== undefined);
    if (fields.length) {
      const [u] = await q.query(`update app_user set ${fields.map((f, i) => `${f} = $${i + 2}`).join(", ")} where id = $1 returning id`, [id, ...fields.map((f) => input[f])]);
      if (!u) throw notFound("Usuario");
    }
    await saveUserCompanies(q, id, input.company_ids);
    await log(q, { company: null as never, actor }, "app_user", id, "update", input);
    return { ok: true };
  });
}

export async function listRoles(q: Queryable) {
  return q.query("select r.*, (select count(*) from app_user u where u.role_id = r.id)::text as users from role r order by r.name");
}

export async function listDepartments(q: Queryable) {
  return q.query("select d.*, (select count(*) from app_user u where u.department_id = d.id)::text as users from department d order by d.name");
}

// Rutas ------------------------------------------------------------------------------

type IdParams = { Params: { id: string } };

/**
 * `person` devuelve quién ha entrado (Keycloak, usuario y clave, o el puesto local).
 * Se registra después de la entrada (sso.ts), que ya ha rechazado a quien no tiene sesión.
 */
export function registerUsuarios(
  app: FastifyInstance,
  db: Db,
  person: (req: FastifyRequest) => Person | null,
  logoutPath: string | null,
  sessionKey?: string,
) {
  // Con SSO la llave de sesión sobrevive a un reinicio; en local basta una al azar.
  if (sessionKey) unlockKey = `${sessionKey}:empresa`;
  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (!path.startsWith("/api/v1/")) return;
    if (path === "/api/v1/health" || path === "/api/v1/compat") return;
    const p = person(req);
    if (!p) return reply.status(401).send({ error: "La sesión ha caducado. Vuelve a entrar." });
    req.sindri = await loadSession(db, req, p);
    if (FREE.has(path)) return;
    const s = req.sindri;
    const mod = moduleFor(path);
    const needed: Level = req.method === "GET" || req.method === "HEAD" ? "ver" : "editar";
    if (path.startsWith("/api/v1/documentos")) {
      // Cada documento mira el permiso de su módulo (documentos.ts).
    } else if (path === "/api/v1/companies") {
      if (needed === "editar" && !s.admin) return reply.status(403).send({ error: "Solo administración crea empresas" });
    } else if (!mod) {
      if (!s.admin) return reply.status(403).send({ error: "No tienes permiso para esto" });
    } else {
      const has = s.perms[mod];
      if (!has || (needed === "editar" && has !== "editar"))
        return reply.status(403).send({ error: needed === "editar" ? "Tu rol solo permite consultar aquí" : "Tu rol no da acceso a esta parte de Sindri", modulo: mod });
    }
    const base = "/" + path.split("/").slice(1, 4).join("/");
    if (!s.company && !NO_COMPANY.has(base) && !path.startsWith("/api/v1/planta"))
      return reply.status(409).send(
        s.companies.length === 0
          ? { error: "Configura primero los datos de tu empresa", code: "sin_empresa" }
          : { error: "Elige con qué empresa vas a trabajar", code: "elegir_empresa" },
      );
  });

  app.get("/api/v1/modules", async () => MODULES);

  app.get("/api/v1/me", async (req) => {
    const s = req.sindri!;
    const [u] = await db.query(
      `select u.*, r.name as role_name, d.name as department_name from app_user u
       left join role r on r.id = $2 left join department d on d.id = u.department_id where u.id = $1`,
      [s.userId, s.roleId],
    );
    await db.query("update app_user set last_login_at = now(), name = coalesce($2, name), email = coalesce($3, email) where id = $1", [
      s.userId,
      s.person.name ?? null,
      s.person.email ?? null,
    ]);
    return {
      user: s.person.user,
      name: u?.name ?? s.person.name ?? s.person.user,
      email: u?.email ?? s.person.email ?? "",
      admin: s.admin,
      company_admin: s.companyAdmin,
      role: u?.role_name ?? (s.person.admin ? "Administración" : null),
      department: u?.department_name ?? null,
      perms: s.perms,
      menu: u?.menu ?? null,
      companies: s.companies,
      company: s.company,
      last_company: u?.last_company_id ?? null,
      needs_company: s.needsCompany,
      logout: logoutPath,
    };
  });

  app.put("/api/v1/me/menu", async (req) => {
    const menu = MenuSchema.parse(req.body);
    await db.query("update app_user set menu = $2 where id = $1", [req.sindri!.userId, JSON.stringify(menu)]);
    return menu;
  });

  app.post("/api/v1/session/company", async (req: FastifyRequest, reply: FastifyReply) => {
    const { company_id, password } = z.object({ company_id: z.uuid(), password: z.string().max(200).optional() }).parse(req.body);
    const s = req.sindri!;
    const c = s.companies.find((x) => x.id === company_id);
    if (!c) return reply.status(403).send({ error: "No trabajas en esa empresa" });
    const lock = (await companyAccess(db)).get(company_id);
    if (lock && !unlocked(req, s.userId, company_id, lock.stamp)) {
      if (!password) return reply.status(401).send({ error: "Esta empresa pide contraseña", code: "clave_empresa" });
      if (!(await checkPassword(password, lock.hash))) {
        await pause();
        await log(db, { company: company_id, actor: s.person.user }, "company", company_id, "password_failed");
        return reply.status(401).send({ error: "La contraseña de la empresa no es correcta", code: "clave_empresa" });
      }
      setUnlock(reply, req, s.userId, company_id, lock.stamp);
    }
    // Cookie de sesión del navegador: al volver a entrar se vuelve a elegir.
    setCookie(reply, req, COOKIE, company_id, null);
    await db.query("update app_user set last_company_id = $2 where id = $1", [s.userId, company_id]);
    return { company: c };
  });

  // Las reservadas que no son suyas no salen ni a quien administra.
  app.get("/api/v1/companies", async (req) => {
    const s = req.sindri!;
    if (!s.admin) return s.companies;
    const kc = keycloakAccess(s.person.groups);
    const access = await companyAccess(db);
    return ((await listCompanies(db)) as Session["companies"])
      .filter((c) => !c.restricted || (!!c.code && kc.companies.has(c.code.toUpperCase())))
      .map((c) => ({ ...c, has_password: access.has(c.id) }));
  });
  // Contraseña de la empresa en uso: quien la administra la pone, la cambia o la quita sabiendo la actual.
  app.put("/api/v1/company/password", async (req: FastifyRequest, reply: FastifyReply) => {
    const s = req.sindri!;
    if (!s.admin && !s.companyAdmin) return reply.status(403).send({ error: "Solo quien administra la empresa cambia su contraseña" });
    const body = z
      .object({ actual: z.string().max(200).optional(), nueva: z.string().min(8, "La contraseña tiene que tener al menos 8 caracteres").max(200).nullable() })
      .parse(req.body);
    const ctx = ctxOf(req);
    const lock = (await companyAccess(db)).get(ctx.company);
    if (lock && !(body.actual && (await checkPassword(body.actual, lock.hash)))) {
      await pause();
      return reply.status(401).send({ error: "La contraseña actual no es correcta", code: "clave_empresa" });
    }
    if (body.nueva === null) {
      await db.query("delete from company_access where company_id = $1", [ctx.company]);
      await log(db, ctx, "company", ctx.company, "password_removed");
      return { has_password: false };
    }
    const [row] = await db.query<{ changed_at: Date | string }>(
      `insert into company_access (company_id, password_hash, changed_by) values ($1, $2, $3)
       on conflict (company_id) do update set password_hash = excluded.password_hash, changed_at = clock_timestamp(), changed_by = excluded.changed_by
       returning changed_at`,
      [ctx.company, await hashPassword(body.nueva), ctx.actor],
    );
    await log(db, ctx, "company", ctx.company, lock ? "password_changed" : "password_set");
    // Quien la cambia sigue dentro; el resto la vuelve a pedir.
    setUnlock(reply, req, s.userId, ctx.company, new Date(row!.changed_at).getTime());
    return { has_password: true };
  });
  // Si se olvida: administración general la quita sin saberla (queda en el registro) y se pone otra.
  app.delete<IdParams>("/api/v1/companies/:id/password", async (req) => {
    requireAdmin(req);
    const id = z.uuid().parse(req.params.id);
    await db.query("delete from company_access where company_id = $1", [id]);
    await log(db, { company: id, actor: req.sindri!.person.user }, "company", id, "password_reset");
    return { has_password: false };
  });
  app.post("/api/v1/companies", async (req, reply) => reply.status(201).send(await createCompany(db, CompanySchema.parse(req.body), req.sindri!.person.user)));

  app.get("/api/v1/users", async () => listUsers(db));
  app.post("/api/v1/users", async (req, reply) => reply.status(201).send(await createUser(db, req.sindri!.person.user, UserSchema.parse(req.body))));
  app.patch<IdParams>("/api/v1/users/:id", async (req) => updateUser(db, req.sindri!.person.user, z.uuid().parse(req.params.id), UserSchema.partial().parse(req.body)));

  app.get("/api/v1/roles", async () => listRoles(db));
  app.post("/api/v1/roles", async (req, reply) => {
    const r = RoleSchema.parse(req.body);
    const [row] = await db.query("insert into role (name, description, permissions) values ($1,$2,$3) returning *", [r.name, r.description ?? null, JSON.stringify(r.permissions)]);
    await log(db, null, "role", row!.id as string, "create", r);
    return reply.status(201).send(row);
  });
  app.patch<IdParams>("/api/v1/roles/:id", async (req) => {
    const r = RoleSchema.partial().parse(req.body);
    const [row] = await db.query(
      "update role set name = coalesce($2, name), description = coalesce($3, description), permissions = coalesce($4, permissions) where id = $1 returning *",
      [z.uuid().parse(req.params.id), r.name ?? null, r.description ?? null, r.permissions ? JSON.stringify(r.permissions) : null],
    );
    if (!row) throw notFound("Rol");
    await log(db, null, "role", row.id as string, "update", r);
    return row;
  });
  app.delete<IdParams>("/api/v1/roles/:id", async (req) => {
    const id = z.uuid().parse(req.params.id);
    const [used] = await db.query("select 1 from app_user where role_id = $1 limit 1", [id]);
    if (used) throw new BusinessError("Hay usuarios con ese rol: cámbiales el rol antes de borrarlo", 409);
    await db.query("delete from role where id = $1", [id]);
    return { ok: true };
  });

  app.get("/api/v1/departments", async () => listDepartments(db));
  app.post("/api/v1/departments", async (req, reply) => {
    const d = DepartmentSchema.parse(req.body);
    return reply.status(201).send((await db.query("insert into department (name) values ($1) returning *", [d.name]))[0]);
  });
  app.patch<IdParams>("/api/v1/departments/:id", async (req) => {
    const d = DepartmentSchema.parse(req.body);
    const [row] = await db.query("update department set name = $2 where id = $1 returning *", [z.uuid().parse(req.params.id), d.name]);
    if (!row) throw notFound("Departamento");
    return row;
  });
  app.delete<IdParams>("/api/v1/departments/:id", async (req) => {
    const id = z.uuid().parse(req.params.id);
    const [used] = await db.query("select 1 from app_user where department_id = $1 limit 1", [id]);
    if (used) throw new BusinessError("Hay usuarios en ese departamento: cámbialos antes de borrarlo", 409);
    await db.query("delete from department where id = $1", [id]);
    return { ok: true };
  });
}
