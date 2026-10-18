/** API HTTP (REST + JSON). La misma API la usan la web, el escritorio, las PDA y el gateway de planta. */
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import { TransitionError } from "@sindri/core";
import type { Db } from "./db.js";
import * as s from "./services.js";
import { registerSso, type SsoConfig } from "./sso.js";

const dec = z.union([z.string(), z.number()]).transform(String).refine((v) => /^-?\d+([.,]\d+)?$/.test(v.trim()), "Número no válido");
const optText = z.string().trim().min(1).nullish();

const PartnerSchema = z.object({
  kind: z.enum(["customer", "supplier", "both"]).optional(),
  name: z.string().trim().min(1),
  tax_id: optText,
  email: optText,
  phone: optText,
  address: optText,
  city: optText,
  postal_code: optText,
  country: z.string().length(2).optional(),
  surcharge_regime: z.boolean().optional(),
  withholding_rate: dec.optional(),
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
  tax_id: z.string().trim().min(1),
  address: z.string().optional(),
  city: z.string().optional(),
  postal_code: z.string().optional(),
  gs1_prefix: z.string().regex(/^\d{6,12}$/).optional(),
});
const ReceiptSchema = z.object({
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
const PaymentSchema = z.object({ amount: dec, paid_on: z.iso.date().optional(), method: z.string().optional() });

/** Versión más vieja del escritorio que esta API sigue sirviendo. Subirla obliga a actualizar. */
export const ESCRITORIO_MINIMA = "0.1.0";
/** Ídem para el agente de planta. */
export const PLANTA_MINIMA = "0.1.0";

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
}

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function buildApp({ db, webDir, logger = false, auth, sso, version = "dev", trustProxy = false }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger, trustProxy });

  // Página de versión que lee el servidor DEV/PRO (punto verde, «Pasar a PRO»).
  const versionBody = async () => ({ version, escritorio_minima: ESCRITORIO_MINIMA });
  app.get("/version", versionBody);
  app.get("/version/", versionBody);

  if (sso) registerSso(app, sso);

  // Acceso con usuario y clave (autenticación básica de HTTP). Pensado para el sistema
  // de prueba: hasta que existan usuarios y permisos, impide que entre cualquiera.
  if (auth && !sso) {
    app.addHook("onRequest", async (req, reply) => {
      if (["/api/health", "/api/v1/health", "/version", "/version/"].includes(req.url.split("?")[0]!)) return;
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
    if (err instanceof s.BusinessError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof TransitionError) return reply.status(409).send({ error: err.message });
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

  app.get("/api/v1/company", async () => s.getCompany(db));
  app.put("/api/v1/company", async (req) => s.setupCompany(db, CompanySchema.parse(req.body)));

  app.get<{ Querystring: { q?: string } }>("/api/v1/partners", async (req) => s.listPartners(db, req.query.q));
  app.post("/api/v1/partners", async (req, reply) => reply.status(201).send(await s.createPartner(db, PartnerSchema.parse(req.body))));
  app.patch<IdParams>("/api/v1/partners/:id", async (req) => s.updatePartner(db, req.params.id, PartnerSchema.partial().parse(req.body)));

  app.get<{ Querystring: { q?: string } }>("/api/v1/products", async (req) => s.listProducts(db, req.query.q));
  app.post("/api/v1/products", async (req, reply) => reply.status(201).send(await s.createProduct(db, ProductSchema.parse(req.body))));
  app.patch<IdParams>("/api/v1/products/:id", async (req) => s.updateProduct(db, req.params.id, ProductSchema.partial().parse(req.body)));

  app.get("/api/v1/locations", async () => s.listLocations(db));
  app.get("/api/v1/stock", async () => s.stockBalances(db));
  app.get<{ Querystring: { product_id?: string } }>("/api/v1/stock/moves", async (req) => s.listMoves(db, req.query.product_id));
  app.post("/api/v1/stock/receipts", async (req, reply) => reply.status(201).send(await s.receiveStock(db, ReceiptSchema.parse(req.body))));

  app.get("/api/v1/sales-orders", async () => s.listSalesOrders(db));
  app.post("/api/v1/sales-orders", async (req, reply) => reply.status(201).send(await s.createSalesOrder(db, OrderSchema.parse(req.body))));
  app.get<IdParams>("/api/v1/sales-orders/:id", async (req) => s.getSalesOrder(db, req.params.id));
  app.post<IdParams>("/api/v1/sales-orders/:id/confirm", async (req) => s.confirmSalesOrder(db, req.params.id));
  app.post<IdParams>("/api/v1/sales-orders/:id/deliver", async (req) => s.deliverSalesOrder(db, req.params.id));
  app.post<IdParams>("/api/v1/sales-orders/:id/invoice", async (req) => s.invoiceSalesOrder(db, req.params.id));
  app.post<IdParams>("/api/v1/sales-orders/:id/cancel", async (req) => s.cancelSalesOrder(db, req.params.id));

  app.get("/api/v1/invoices", async () => s.listInvoices(db));
  app.get<IdParams>("/api/v1/invoices/:id", async (req) => s.getInvoice(db, req.params.id));
  app.post<IdParams>("/api/v1/invoices/:id/issue", async (req) => s.issueInvoice(db, req.params.id));
  app.post<IdParams>("/api/v1/invoices/:id/payments", async (req) => s.registerPayment(db, req.params.id, PaymentSchema.parse(req.body)));

  app.get("/api/v1/verifactu/records", async () => s.listVerifactu(db));
  app.get("/api/v1/verifactu/verify", async () => s.verifyVerifactuChain(db));
  app.get("/api/v1/events", async () => s.listEvents(db));

  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false });
    // Aplicación de una sola página: cualquier ruta que no sea /api devuelve index.html.
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") ? reply.status(404).send({ error: "No existe" }) : reply.sendFile("index.html"),
    );
  }
  return app;
}
