/**
 * Datos de una empresa en un fichero: exportar (DEV → fichero) e importar (fichero → PRO, o desde
 * otra app que genere el mismo formato, como el Gestor de incidencias).
 *
 * Formato «sindri-datos» versión 1: { formato, version, empresa?, clientes, productos, modelos }.
 * Importar nunca borra: crea lo que falta y actualiza lo que ya hay. Los clientes se reconocen por
 * NIF (o por nombre si no lo tienen), los productos por referencia y los modelos de presupuesto por
 * nombre. Con «probar» no se guarda nada: dice qué haría.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isValidSpanishTaxId } from "@sindri/core";
import type { Db, Queryable } from "./db.js";
import { BusinessError, getCompany, log, type Ctx } from "./services.js";
import { ctxOf, requireAdmin } from "./usuarios.js";

export const FORMATO = "sindri-datos";

const texto = z.string().trim().nullish().transform((v) => (v === undefined ? undefined : v ? v : null));
const numero = z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/)]).nullish().transform((v) => (v === undefined ? undefined : v === null || v === "" ? null : String(v)));

const ContactoSchema = z.object({ name: z.string().trim().min(1), position: texto, email: texto, phone: texto, notes: texto });
const DireccionSchema = z.object({
  label: z.string().trim().min(1), address: texto, city: texto, postal_code: texto, province: texto,
  country: z.string().length(2).optional(), phone: texto, schedule: texto, is_default: z.boolean().optional(),
});
const ClienteSchema = z.object({
  kind: z.enum(["customer", "supplier", "both"]).optional(),
  code: texto,
  name: z.string().trim().min(1),
  trade_name: texto,
  tax_id: texto,
  email: texto,
  phone: texto,
  mobile: texto,
  website: texto,
  address: texto,
  city: texto,
  postal_code: texto,
  province: texto,
  country: z.string().length(2).optional(),
  surcharge_regime: z.boolean().optional(),
  withholding_rate: numero,
  payment_method: texto,
  payment_days: z.number().int().min(0).max(365).nullish(),
  credit_limit: numero,
  discount_pct: numero,
  iban: texto,
  route_zone: texto,
  delivery_notes: texto,
  notes: texto,
  archived: z.boolean().optional(),
  contactos: z.array(ContactoSchema).optional(),
  direcciones: z.array(DireccionSchema).optional(),
});
const ProductoSchema = z.object({
  sku: z.string().trim().min(1),
  name: z.string().trim().min(1),
  kind: z.enum(["stockable", "consumable", "service"]).optional(),
  uom: z.string().trim().min(1).optional(),
  gtin: texto,
  sale_price: numero,
  cost_price: numero,
  vat_rate: numero,
  track_lots: z.boolean().optional(),
  archived: z.boolean().optional(),
});
const ModeloSchema = z.object({
  name: z.string().trim().min(1),
  title: z.string().trim().min(1),
  intro: texto,
  conditions: texto,
  validity_days: z.number().int().min(1).max(3650).optional(),
  active: z.boolean().optional(),
});
const EmpresaSchema = z.object({
  name: z.string().trim().min(1), trade_name: texto, tax_id: z.string().trim().min(1),
  address: texto, city: texto, postal_code: texto,
});
export const DatosSchema = z.object({
  formato: z.literal(FORMATO, { error: `No es un fichero de datos de Sindri (formato «${FORMATO}»)` }),
  version: z.literal(1, { error: "Versión del fichero no admitida (se admite la 1)" }),
  origen: z.string().optional(),
  empresa: EmpresaSchema.optional(),
  clientes: z.array(ClienteSchema).default([]),
  productos: z.array(ProductoSchema).default([]),
  modelos: z.array(ModeloSchema).default([]),
});
export type Datos = z.infer<typeof DatosSchema>;

const CLIENTE_CAMPOS = [
  "kind", "code", "name", "trade_name", "tax_id", "email", "phone", "mobile", "website", "address", "city", "postal_code",
  "province", "country", "surcharge_regime", "withholding_rate", "payment_method", "payment_days", "credit_limit",
  "discount_pct", "iban", "route_zone", "delivery_notes", "notes", "archived",
] as const;
const PRODUCTO_CAMPOS = ["sku", "name", "kind", "uom", "gtin", "sale_price", "cost_price", "vat_rate", "track_lots", "archived"] as const;
const MODELO_CAMPOS = ["name", "title", "intro", "conditions", "validity_days", "active"] as const;

/** Columnas que la base no deja vacías: un null en el fichero se ignora. */
const NO_NULOS = new Set(["kind", "country", "uom", "withholding_rate", "sale_price", "cost_price", "vat_rate", "surcharge_regime", "track_lots", "archived", "validity_days", "active", "title"]);

/** Solo los campos que trae el fichero (lo que no trae no se toca al actualizar). */
function campos<T extends Record<string, unknown>>(obj: T, lista: readonly string[]) {
  return lista.filter((c) => obj[c] !== undefined && !(obj[c] === null && NO_NULOS.has(c)));
}

async function guardar(q: Queryable, tabla: string, ctx: Ctx, id: string | null, obj: Record<string, unknown>, lista: readonly string[]) {
  const cols = campos(obj, lista);
  if (id) {
    if (!cols.length) return id;
    await q.query(`update ${tabla} set ${cols.map((c, i) => `${c} = $${i + 3}`).join(", ")} where id = $1 and company_id = $2`, [id, ctx.company, ...cols.map((c) => obj[c])]);
    return id;
  }
  const [row] = await q.query<{ id: string }>(
    `insert into ${tabla} (company_id, ${cols.join(",")}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(",")}) returning id`,
    [ctx.company, ...cols.map((c) => obj[c])],
  );
  return row!.id;
}

export interface Resultado {
  probar: boolean;
  clientes: { creados: number; actualizados: number };
  productos: { creados: number; actualizados: number };
  modelos: { creados: number; actualizados: number };
  avisos: string[];
}

export async function importar(db: Db, ctx: Ctx, datos: Datos, probar = false): Promise<Resultado> {
  const r: Resultado = {
    probar,
    clientes: { creados: 0, actualizados: 0 },
    productos: { creados: 0, actualizados: 0 },
    modelos: { creados: 0, actualizados: 0 },
    avisos: [],
  };
  const empresa = (await getCompany(db, ctx.company)) as { tax_id: string; name: string } | null;
  if (!empresa) throw new BusinessError("Configura primero los datos de tu empresa", 409);
  if (datos.empresa && datos.empresa.tax_id.toUpperCase() !== empresa.tax_id.toUpperCase())
    r.avisos.push(`El fichero es de ${datos.empresa.name} (${datos.empresa.tax_id}) y lo estás metiendo en ${empresa.name} (${empresa.tax_id}).`);

  const trabajo = async (q: Queryable) => {
    for (const c of datos.clientes) {
      const nif = c.tax_id?.toUpperCase() ?? null;
      if (nif && (c.country ?? "ES") === "ES" && !isValidSpanishTaxId(nif)) {
        r.avisos.push(`${c.name}: NIF ${nif} no válido; se guarda sin NIF.`);
        c.tax_id = null;
      } else c.tax_id = nif;
      if (c.iban) c.iban = c.iban.replace(/\s/g, "").toUpperCase();
      const [hay] = c.tax_id
        ? await q.query<{ id: string }>("select id from partner where company_id = $1 and upper(tax_id) = $2 order by archived, created_at limit 1", [ctx.company, c.tax_id])
        : await q.query<{ id: string }>("select id from partner where company_id = $1 and lower(name) = lower($2) order by archived, created_at limit 1", [ctx.company, c.name]);
      const { contactos = [], direcciones = [], ...ficha } = c;
      const id = await guardar(q, "partner", ctx, hay?.id ?? null, ficha, CLIENTE_CAMPOS);
      hay ? r.clientes.actualizados++ : r.clientes.creados++;
      for (const k of contactos) {
        const [ya] = await q.query("select 1 from partner_contact where partner_id = $1 and lower(name) = lower($2)", [id, k.name]);
        if (!ya) await q.query("insert into partner_contact (partner_id, name, position, email, phone, notes) values ($1,$2,$3,$4,$5,$6)", [id, k.name, k.position, k.email, k.phone, k.notes]);
      }
      for (const d of direcciones) {
        const [ya] = await q.query("select 1 from partner_address where partner_id = $1 and lower(label) = lower($2)", [id, d.label]);
        if (!ya)
          await q.query(
            "insert into partner_address (partner_id, label, address, city, postal_code, province, country, phone, schedule, is_default) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
            [id, d.label, d.address, d.city, d.postal_code, d.province, d.country ?? "ES", d.phone, d.schedule, d.is_default ?? false],
          );
      }
    }
    for (const p of datos.productos) {
      const [hay] = await q.query<{ id: string }>("select id from product where company_id = $1 and sku = $2", [ctx.company, p.sku]);
      await guardar(q, "product", ctx, hay?.id ?? null, p, PRODUCTO_CAMPOS);
      hay ? r.productos.actualizados++ : r.productos.creados++;
    }
    for (const m of datos.modelos) {
      const [hay] = await q.query<{ id: string }>("select id from quotation_template where company_id = $1 and lower(name) = lower($2)", [ctx.company, m.name]);
      await guardar(q, "quotation_template", ctx, hay?.id ?? null, m, MODELO_CAMPOS);
      hay ? r.modelos.actualizados++ : r.modelos.creados++;
    }
    await log(q, ctx, "company", ctx.company, probar ? "import.test" : "import", {
      origen: datos.origen ?? null, clientes: r.clientes, productos: r.productos, modelos: r.modelos,
    });
    // Probar = hacerlo todo dentro de la transacción y deshacerlo al final.
    if (probar) throw new Deshacer();
  };
  try {
    await db.tx(trabajo);
  } catch (e) {
    if (!(e instanceof Deshacer)) throw e;
  }
  return r;
}

class Deshacer extends Error {}

/** Los datos de la empresa en uso, en el formato que lee `importar`. */
export async function exportar(q: Queryable, ctx: Ctx): Promise<Datos> {
  const e = (await getCompany(q, ctx.company)) as Record<string, string | null> | null;
  if (!e) throw new BusinessError("Configura primero los datos de tu empresa", 409);
  const limpio = (o: Record<string, unknown>, lista: readonly string[]) =>
    Object.fromEntries(lista.filter((c) => o[c] !== null && o[c] !== undefined).map((c) => [c, o[c]]));
  const clientes = await q.query<Record<string, unknown> & { id: string }>("select * from partner where company_id = $1 order by name", [ctx.company]);
  const contactos = await q.query<Record<string, unknown> & { partner_id: string }>(
    "select c.* from partner_contact c join partner p on p.id = c.partner_id where p.company_id = $1 order by c.created_at", [ctx.company]);
  const direcciones = await q.query<Record<string, unknown> & { partner_id: string }>(
    "select d.* from partner_address d join partner p on p.id = d.partner_id where p.company_id = $1 order by d.created_at", [ctx.company]);
  const productos = await q.query<Record<string, unknown>>("select * from product where company_id = $1 order by sku", [ctx.company]);
  const modelos = await q.query<Record<string, unknown>>("select * from quotation_template where company_id = $1 order by name", [ctx.company]);
  return {
    formato: FORMATO,
    version: 1,
    origen: `Sindri ${e.code ?? ""} ${e.name}`.replace(/\s+/g, " ").trim(),
    empresa: limpio(e, ["name", "trade_name", "tax_id", "address", "city", "postal_code"]) as Datos["empresa"],
    clientes: clientes.map((c) => ({
      ...(limpio(c, CLIENTE_CAMPOS) as Datos["clientes"][number]),
      contactos: contactos.filter((k) => k.partner_id === c.id).map((k) => limpio(k, ["name", "position", "email", "phone", "notes"]) as never),
      direcciones: direcciones.filter((d) => d.partner_id === c.id)
        .map((d) => limpio(d, ["label", "address", "city", "postal_code", "province", "country", "phone", "schedule", "is_default"]) as never),
    })),
    productos: productos.map((p) => limpio(p, PRODUCTO_CAMPOS) as Datos["productos"][number]),
    modelos: modelos.map((m) => limpio(m, MODELO_CAMPOS) as Datos["modelos"][number]),
  };
}

export function registerImportar(app: FastifyInstance, db: Db) {
  app.get("/api/v1/datos/exportar", async (req, reply) => {
    requireAdmin(req);
    const ctx = ctxOf(req);
    const datos = await exportar(db, ctx);
    const empresa = (await getCompany(db, ctx.company)) as { code?: string | null } | null;
    const fecha = new Date().toISOString().slice(0, 10);
    reply.header("content-disposition", `attachment; filename="sindri-${empresa?.code ?? "empresa"}-${fecha}.json"`);
    return datos;
  });
  app.post<{ Querystring: { probar?: string } }>("/api/v1/datos/importar", { bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    requireAdmin(req);
    const parsed = DatosSchema.safeParse(req.body);
    if (!parsed.success) {
      const i = parsed.error.issues[0]!;
      throw new BusinessError(`${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`, 400);
    }
    const probar = req.query.probar === "1" || req.query.probar === "true";
    return importar(db, ctxOf(req), parsed.data, probar);
  });
}
