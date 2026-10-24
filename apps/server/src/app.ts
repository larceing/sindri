/** API HTTP (REST + JSON). La misma API la usan la web, el escritorio, las PDA y el gateway de planta. */
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import { TransitionError } from "@sindri/core";
import type { Db } from "./db.js";
import * as s from "./services.js";
import { currentPerson, registerSso, type SsoConfig } from "./sso.js";
import { PLANTA_MINIMA, registerPlanta } from "./planta.js";
import * as c from "./comercial.js";
import { registerCrm } from "./crm-rutas.js";
import { ctxOf, keycloakAccess, maybeCtx, registerUsuarios, requireAdmin } from "./usuarios.js";
import { registerInformes } from "./informes.js";
import { registerDocumentos, type ReportServerConfig } from "./documentos.js";
import { registerIntegracion, releaseOrderItems } from "./integracion.js";
import { confirmacionAutomatica, registerCorreo, type MailConfig } from "./correo.js";
import { registerGrafo } from "./grafo.js";
import { registerImportar } from "./importar.js";

const dec = z.union([z.string(), z.number()]).transform(String).refine((v) => /^-?\d+([.,]\d+)?$/.test(v.trim()), "Número no válido");
const optText = z.string().trim().min(1).nullish();

const optDec = dec.nullish();
const PartnerSchema = z.object({
  kind: z.enum(["customer", "supplier", "both"]).optional(),
  code: optText,
  name: z.string().trim().min(1),
  trade_name: optText,
  tax_id: optText,
  email: optText,
  phone: optText,
  mobile: optText,
  website: optText,
  address: optText,
  city: optText,
  postal_code: optText,
  province: optText,
  country: z.string().length(2).optional(),
  surcharge_regime: z.boolean().optional(),
  withholding_rate: dec.optional(),
  sales_rep_id: z.uuid().nullish(),
  payment_method: optText,
  payment_days: z.number().int().min(0).max(365).nullish(),
  credit_limit: optDec,
  discount_pct: optDec,
  iban: optText,
  route_zone: optText,
  delivery_notes: optText,
  notes: optText,
});
const ContactSchema = z.object({ name: z.string().trim().min(1), position: optText, email: optText, phone: optText, notes: optText });
const AddressSchema = z.object({
  label: z.string().trim().min(1),
  address: optText,
  city: optText,
  postal_code: optText,
  province: optText,
  country: z.string().length(2).optional(),
  phone: optText,
  schedule: optText,
  is_default: z.boolean().optional(),
});
const SalesRepSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1),
  kind: z.enum(["internal", "agent"]).optional(),
  user_id: z.uuid().nullish(),
  email: optText,
  phone: optText,
  zone: optText,
  commission_pct: dec.optional(),
  tax_id: optText,
  active: z.boolean().optional(),
});
const RouteSchema = z.object({
  route_date: z.iso.date().optional(),
  driver: optText,
  vehicle: optText,
  zone: optText,
  notes: optText,
});
const ProductSchema = z.object({
  sku: z.string().trim().min(1),
  name: z.string().trim().min(1),
  kind: z.enum(["stockable", "consumable", "service"]).optional(),
  uom: z.string().trim().min(1).optional(),
  gtin: optText,
  sale_price: dec.optional(),
  cost_price: dec.optional(),
  vat_rate: dec.optional(),
  track_lots: z.boolean().optional(),
});
const CompanySchema = z.object({
  name: z.string().trim().min(1),
  trade_name: z.string().optional(),
  tax_id: z.string().trim().min(1),
  address: z.string().optional(),
  city: z.string().optional(),
  postal_code: z.string().optional(),
  gs1_prefix: z.string().regex(/^\d{6,12}$/).optional(),
  code: z.string().trim().min(1).max(10).optional(),
  demo: z.boolean().optional(),
});
const ReceiptSchema = z.object({
  /** Lo pone la PDA al leer: si la entrada llega dos veces (sin conexión, reintentos), cuenta una. */
  id: z.uuid().optional(),
  product_id: z.uuid(),
  quantity: dec,
  unit_cost: dec.optional(),
  lot_code: z.string().trim().min(1).optional(),
  expiry_date: z.iso.date().optional(),
  origin: z.enum(["receipt", "adjustment"]).optional(),
  location_code: z.string().optional(),
  note: z.string().optional(),
});
const OrderSchema = z.object({
  partner_id: z.uuid(),
  order_date: z.iso.date().optional(),
  delivery_date: z.iso.date().optional(),
  sales_rep_id: z.uuid().nullish(),
  delivery_address_id: z.uuid().nullish(),
  notes: z.string().optional(),
  lines: z
    .array(
      z.object({
        product_id: z.uuid(),
        quantity: dec,
        unit_price: dec.optional(),
        discount_pct: dec.optional(),
        description: z.string().optional(),
      }),
    )
    .min(1),
});
const OrderHeaderSchema = z.object({
  sales_rep_id: z.uuid().nullish(),
  delivery_address_id: z.uuid().nullish(),
  delivery_date: z.iso.date().nullish(),
  notes: z.string().nullish(),
});
const SplitSchema = z.object({
  lines: z.array(z.object({ line_id: z.uuid(), quantity: dec })).min(1),
  delivery_date: z.iso.date().optional(),
  notes: z.string().optional(),
});
const PaymentSchema = z.object({ amount: dec, paid_on: z.iso.date().optional(), method: z.string().optional() });

/** Versión más vieja del escritorio que esta API sigue sirviendo. Subirla obliga a actualizar. */
export const ESCRITORIO_MINIMA = "0.1.0";
export { PLANTA_MINIMA };

type IdParams = { Params: { id: string } };

export interface AppOptions {
  db: Db;
  /** Carpeta con la web compilada (apps/web/dist) para servirla en la misma dirección. */
  webDir?: string;
  logger?: boolean;
  /** Usuario y clave de acceso. Si se indican, todo salvo /api/health pide identificarse. */
  auth?: { user: string; password: string };
  /** Entrada con Keycloak (servidor DEV/PRO). Si está, sustituye a `auth`. */
  sso?: SsoConfig;
  /** Versión que corre (la etiqueta de la imagen, p. ej. sha-1a2b3c4). Se publica en /version/. */
  version?: string;
  /** Detrás de un proxy: fiarse de X-Forwarded-Proto y X-Forwarded-Host. */
  trustProxy?: boolean;
  /** dev, pro o local (SERVIDOR_ENTORNO). El agente de planta lo usa para no tocar la planta real desde DEV. */
  entorno?: string;
  /** Report Server (REPORT_URL y REPORT_LLAVE) para sacar facturas, pedidos y hojas de ruta en PDF. */
  reportServer?: ReportServerConfig;
  /**
   * HTTPS propio, para el servidor de la fábrica (sin proxy delante). Las PDA lo necesitan para
   * trabajar sin conexión: Chrome solo deja usar service worker y almacenamiento seguro en HTTPS.
   */
  https?: { key: Buffer; cert: Buffer };
  /** Mail del servidor (MAIL_URL y MAIL_LLAVE) para mandar la confirmación de los pedidos. */
  mail?: MailConfig;
}

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function buildApp({ db, webDir, logger = false, auth, sso, version = "dev", trustProxy = false, entorno = "local", reportServer, mail, https }: AppOptions): Promise<FastifyInstance> {
  // Fastify tipa distinto el servidor HTTPS; las rutas son las mismas.
  const app = (https ? Fastify({ logger, trustProxy, https }) : Fastify({ logger, trustProxy })) as unknown as FastifyInstance;

  // Página de versión que lee el servidor DEV/PRO (punto verde, «Pasar a PRO»).
  const versionBody = async () => ({ version, escritorio_minima: ESCRITORIO_MINIMA });
  app.get("/version", versionBody);
  app.get("/version/", versionBody);

  if (sso) registerSso(app, sso);

  // Acceso con usuario y clave (autenticación básica de HTTP). Pensado para el sistema
  // de prueba: hasta que existan usuarios y permisos, impide que entre cualquiera.
  if (auth && !sso) {
    app.addHook("onRequest", async (req, reply) => {
      const path = req.url.split("?")[0]!;
      if (["/api/health", "/api/v1/health", "/version", "/version/"].includes(path) || path.startsWith("/api/planta/") || path.startsWith("/api/informes/") || path.startsWith("/api/integracion/")) return;
      const header = req.headers.authorization ?? "";
      const [user = "", password = ""] = header.startsWith("Basic ")
        ? Buffer.from(header.slice(6), "base64").toString("utf8").split(/:(.*)/s)
        : [];
      if (sameText(user, auth.user) && sameText(password, auth.password)) return;
      return reply
        .status(401)
        .header("www-authenticate", 'Basic realm="Sindri", charset="UTF-8"')
        .send({ error: "Hace falta usuario y clave" });
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: "Datos no válidos", details: err.issues });
    if (err instanceof s.BusinessError) return reply.status(err.status).send({ error: err.message, code: (err as { code?: string }).code });
    if (err instanceof TransitionError) return reply.status(409).send({ error: err.message });
    // Un número fuera de rango en las reglas de negocio (p. ej. un descuento de más del 100 %) es un dato no válido, no un fallo.
    if (err instanceof RangeError) return reply.status(422).send({ error: err.message });
    const pgCode = (err as { code?: string }).code;
    if (pgCode === "23505") return reply.status(409).send({ error: "Ya existe un registro con ese código" });
    if (pgCode === "P0001") return reply.status(409).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ error: "Error interno" });
  });

  const health = async () => ({ ok: true, db: db.kind, version });
  app.get("/api/health", health);
  app.get("/api/v1/health", health);
  // Compatibilidad: el escritorio y los agentes de planta van por detrás de la web.
  app.get("/api/v1/compat", async () => ({ api: "v1", escritorio_minima: ESCRITORIO_MINIMA, planta_minima: PLANTA_MINIMA }));

  // Quién es la persona: Keycloak, usuario y clave, o el puesto local (administra).
  const person = (req: import("fastify").FastifyRequest) =>
    sso ? currentPerson(req, sso) : { user: auth?.user ?? "local", name: auth?.user ?? "Puesto local", admin: true };
  registerUsuarios(app, db, person, sso ? "logout" : null, sso?.sessionKey);

  // Sin empresa elegida no se enseña ninguna: antes salía la primera de la base, aunque fuese de otro.
  app.get("/api/v1/company", async (req) => {
    const id = req.sindri?.company ?? req.sindri?.companies[0]?.id ?? null;
    if (!id) return null;
    const c = await s.getCompany(db, id);
    return c && { ...c, has_password: !!req.sindri?.companies.find((x) => x.id === id)?.has_password };
  });
  app.put("/api/v1/company", async (req) => {
    const ctx = maybeCtx(req);
    // Sin empresa elegida, guardar es crear una nueva: solo administración.
    if (!ctx) requireAdmin(req);
    return s.setupCompany(db, ctx, CompanySchema.parse(req.body));
  });
  // Maestros compartidos y empresa reservada: solo administración.
  app.put("/api/v1/company/sharing", async (req) => {
    requireAdmin(req);
    const input = z.object({ master_company_id: z.uuid().nullable().optional(), restricted: z.boolean().optional(), aun_sin_verla: z.boolean().optional() }).parse(req.body);
    const kc = keycloakAccess(req.sindri!.person.groups);
    return s.setCompanySharing(db, ctxOf(req), input, (code) => !!code && kc.companies.has(code.toUpperCase()));
  });

  app.get<{ Querystring: { q?: string } }>("/api/v1/partners", async (req) => s.listPartners(db, ctxOf(req), req.query.q));
  app.post("/api/v1/partners", async (req, reply) => reply.status(201).send(await s.createPartner(db, ctxOf(req), PartnerSchema.parse(req.body))));
  app.get<IdParams>("/api/v1/partners/:id", async (req) => s.getPartner(db, ctxOf(req), req.params.id));
  app.patch<IdParams>("/api/v1/partners/:id", async (req) => s.updatePartner(db, ctxOf(req), req.params.id, PartnerSchema.partial().parse(req.body)));
  app.post<IdParams>("/api/v1/partners/:id/archive", async (req) => s.archivePartner(db, ctxOf(req), req.params.id));
  app.post<IdParams>("/api/v1/partners/:id/contacts", async (req, reply) => reply.status(201).send(await s.saveContact(db, ctxOf(req), req.params.id, ContactSchema.parse(req.body))));
  app.patch<{ Params: { id: string; sub: string } }>("/api/v1/partners/:id/contacts/:sub", async (req) => s.saveContact(db, ctxOf(req), req.params.id, ContactSchema.parse(req.body), req.params.sub));
  app.delete<{ Params: { id: string; sub: string } }>("/api/v1/partners/:id/contacts/:sub", async (req) => s.deleteContact(db, ctxOf(req), req.params.id, req.params.sub));
  app.put<{ Params: { id: string; sub: string } }>("/api/v1/partners/:id/prices/:sub", async (req) =>
    s.savePartnerPrice(db, ctxOf(req), req.params.id, req.params.sub, z.object({ unit_price: dec }).parse(req.body).unit_price));
  app.delete<{ Params: { id: string; sub: string } }>("/api/v1/partners/:id/prices/:sub", async (req) => s.savePartnerPrice(db, ctxOf(req), req.params.id, req.params.sub, null));
  app.post<IdParams>("/api/v1/partners/:id/addresses", async (req, reply) => reply.status(201).send(await s.saveAddress(db, ctxOf(req), req.params.id, AddressSchema.parse(req.body))));
  app.patch<{ Params: { id: string; sub: string } }>("/api/v1/partners/:id/addresses/:sub", async (req) => s.saveAddress(db, ctxOf(req), req.params.id, AddressSchema.parse(req.body), req.params.sub));
  app.delete<{ Params: { id: string; sub: string } }>("/api/v1/partners/:id/addresses/:sub", async (req) => s.deleteAddress(db, ctxOf(req), req.params.id, req.params.sub));

  app.get<{ Querystring: { todos?: string } }>("/api/v1/sales-reps", async (req) => c.listSalesReps(db, ctxOf(req), { all: req.query.todos === "1" }));
  app.post("/api/v1/sales-reps", async (req, reply) => reply.status(201).send(await c.createSalesRep(db, ctxOf(req), SalesRepSchema.parse(req.body))));
  app.patch<IdParams>("/api/v1/sales-reps/:id", async (req) => c.updateSalesRep(db, ctxOf(req), req.params.id, SalesRepSchema.partial().parse(req.body)));

  app.get<{ Querystring: { q?: string } }>("/api/v1/products", async (req) => s.listProducts(db, ctxOf(req), req.query.q));
  app.post("/api/v1/products", async (req, reply) => reply.status(201).send(await s.createProduct(db, ctxOf(req), ProductSchema.parse(req.body))));
  app.patch<IdParams>("/api/v1/products/:id", async (req) => s.updateProduct(db, ctxOf(req), req.params.id, ProductSchema.partial().parse(req.body)));

  app.get("/api/v1/locations", async (req) => s.listLocations(db, ctxOf(req)));
  app.get("/api/v1/stock", async (req) => s.stockBalances(db, ctxOf(req)));
  app.get<{ Querystring: { product_id?: string } }>("/api/v1/stock/moves", async (req) => s.listMoves(db, ctxOf(req), req.query.product_id));
  app.post("/api/v1/stock/receipts", async (req, reply) => reply.status(201).send(await s.receiveStock(db, ctxOf(req), ReceiptSchema.parse(req.body))));

  app.get<{ Querystring: { state?: string; sales_rep_id?: string } }>("/api/v1/sales-orders", async (req) => s.listSalesOrders(db, ctxOf(req), req.query));
  app.post("/api/v1/sales-orders", async (req, reply) => reply.status(201).send(await s.createSalesOrder(db, ctxOf(req), OrderSchema.parse(req.body))));
  app.get<IdParams>("/api/v1/sales-orders/:id", async (req) => s.getSalesOrder(db, ctxOf(req), req.params.id));
  app.patch<IdParams>("/api/v1/sales-orders/:id", async (req) => s.updateSalesOrderHeader(db, ctxOf(req), req.params.id, OrderHeaderSchema.parse(req.body)));
  app.post<IdParams>("/api/v1/sales-orders/:id/confirm", async (req) => {
    const o = await s.confirmSalesOrder(db, ctxOf(req), req.params.id);
    confirmacionAutomatica(db, { mail, reportServer }, ctxOf(req), req.params.id);
    return o;
  });
  app.post<IdParams>("/api/v1/sales-orders/:id/deliver", async (req) => s.deliverSalesOrder(db, ctxOf(req), req.params.id));
  app.post<IdParams>("/api/v1/sales-orders/:id/invoice", async (req) => s.invoiceSalesOrder(db, ctxOf(req), req.params.id));
  app.post<IdParams>("/api/v1/sales-orders/:id/cancel", async (req) => {
    const o = await s.cancelSalesOrder(db, ctxOf(req), req.params.id);
    // Lo que venía de Por facturar vuelve a quedar pendiente.
    await releaseOrderItems(db, req.params.id);
    return o;
  });
  app.post<IdParams>("/api/v1/sales-orders/:id/split", async (req, reply) => reply.status(201).send(await s.splitSalesOrder(db, ctxOf(req), req.params.id, SplitSchema.parse(req.body))));

  registerCrm(app, db, { mail, reportServer });

  app.get("/api/v1/routes", async (req) => c.listRoutes(db, ctxOf(req)));
  app.get("/api/v1/routes/candidates", async (req) => c.routeCandidates(db, ctxOf(req)));
  app.post("/api/v1/routes", async (req, reply) =>
    reply.status(201).send(await c.createRoute(db, ctxOf(req), RouteSchema.extend({ order_ids: z.array(z.uuid()).optional() }).parse(req.body))),
  );
  app.get<IdParams>("/api/v1/routes/:id", async (req) => c.getRoute(db, ctxOf(req), req.params.id));
  app.patch<IdParams>("/api/v1/routes/:id", async (req) => c.updateRoute(db, ctxOf(req), req.params.id, RouteSchema.parse(req.body)));
  app.post<IdParams>("/api/v1/routes/:id/stops", async (req) => c.addStops(db, ctxOf(req), req.params.id, z.object({ order_ids: z.array(z.uuid()).min(1) }).parse(req.body).order_ids));
  app.delete<{ Params: { id: string; sub: string } }>("/api/v1/routes/:id/stops/:sub", async (req) => c.removeStop(db, ctxOf(req), req.params.id, req.params.sub));
  app.put<IdParams>("/api/v1/routes/:id/order", async (req) => c.reorderStops(db, ctxOf(req), req.params.id, z.object({ stop_ids: z.array(z.uuid()) }).parse(req.body).stop_ids));
  app.post<{ Params: { id: string; sub: string } }>("/api/v1/routes/:id/stops/:sub/state", async (req) =>
    c.setStopState(db, ctxOf(req), req.params.id, req.params.sub, z.object({ state: z.enum(["pending", "delivered", "incident"]), note: optText }).parse(req.body)),
  );
  app.post<IdParams>("/api/v1/routes/:id/start", async (req) => c.startRoute(db, ctxOf(req), req.params.id));
  app.post<IdParams>("/api/v1/routes/:id/close", async (req) => c.closeRoute(db, ctxOf(req), req.params.id));

  app.get("/api/v1/invoices", async (req) => s.listInvoices(db, ctxOf(req)));
  app.get<IdParams>("/api/v1/invoices/:id", async (req) => s.getInvoice(db, ctxOf(req), req.params.id));
  app.post<IdParams>("/api/v1/invoices/:id/issue", async (req) => s.issueInvoice(db, ctxOf(req), req.params.id));
  app.post<IdParams>("/api/v1/invoices/:id/rectify", async (req) =>
    s.rectifyInvoice(db, ctxOf(req), req.params.id, z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body).reason),
  );
  app.post<IdParams>("/api/v1/invoices/:id/payments", async (req) => s.registerPayment(db, ctxOf(req), req.params.id, PaymentSchema.parse(req.body)));

  app.get("/api/v1/verifactu/records", async (req) => s.listVerifactu(db, ctxOf(req)));
  app.get("/api/v1/verifactu/verify", async (req) => s.verifyVerifactuChain(db, ctxOf(req)));
  app.get("/api/v1/events", async (req) => s.listEvents(db, ctxOf(req)));

  registerInformes(app, db);
  registerDocumentos(app, db, reportServer);
  registerIntegracion(app, db);
  registerCorreo(app, db, { mail, reportServer });
  registerGrafo(app, db);
  registerImportar(app, db);

  registerPlanta(app, db, {
    entorno,
    // Administra la planta quien administra Sindri o tiene «planta: editar» en su rol.
    person: (req) => {
      const se = req.sindri;
      return se ? { user: se.person.user, admin: se.admin || se.perms.planta === "editar" } : null;
    },
  });

  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false });
    // Aplicación de una sola página: cualquier ruta que no sea /api devuelve index.html.
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") ? reply.status(404).send({ error: "No existe" }) : reply.sendFile("index.html"),
    );
  }
  return app;
}
