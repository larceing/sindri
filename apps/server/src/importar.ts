/**
 * Datos de una empresa en un fichero: exportar (DEV → fichero) e importar (fichero → PRO, o desde
 * otra app que genere el mismo formato, como el Gestor de incidencias).
 *
 * Formato «sindri-datos» versión 1: { formato, version, origen?, origen_app?, empresa?, clientes
 * (con sus tarifas propias), productos, modelos, por_facturar? }.
 * Importar nunca borra: crea lo que falta y actualiza lo que ya hay. Los clientes se reconocen por
 * NIF (o por nombre si no lo tienen), los productos por referencia, los modelos de presupuesto por
 * nombre y lo por facturar por su referencia en la app de origen (lo que ya está en un pedido no se
 * toca). Con «probar» no se guarda nada: dice qué haría.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { D, isValidSpanishTaxId } from "@sindri/core";
import type { Db, Queryable } from "./db.js";
import { BusinessError, getCompany, log, priceFor, type Ctx } from "./services.js";
import { ctxOf, requireAdmin } from "./usuarios.js";

export const FORMATO = "sindri-datos";

const texto = z.string().trim().nullish().transform((v) => (v === undefined ? undefined : v ? v : null));
const numero = z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/)]).nullish().transform((v) => (v === undefined ? undefined : v === null || v === "" ? null : String(v)));

const ContactoSchema = z.object({ name: z.string().trim().min(1), position: texto, email: texto, phone: texto, notes: texto });
const DireccionSchema = z.object({
  label: z.string().trim().min(1), address: texto, city: texto, postal_code: texto, province: texto,
  country: z.string().length(2).optional(), phone: texto, schedule: texto, is_default: z.boolean().optional(),
});
const TarifaSchema = z.object({ sku: z.string().trim().min(1), precio: z.union([z.number(), z.string().trim().regex(/^\d+(\.\d+)?$/)]).transform(String) });
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
  tarifas: z.array(TarifaSchema).optional(),
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
const PorFacturarSchema = z.object({
  ref: z.string().trim().min(1).max(200),
  cliente: z.object({ tax_id: texto, name: z.string().trim().min(1) }),
  sku: z.string().trim().min(1),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cantidad: z.union([z.number(), z.string().trim().regex(/^\d+(\.\d+)?$/)]).transform(String),
  precio: numero,
  descripcion: z.string().trim().min(1).max(1000),
});
const EmpresaSchema = z.object({
  name: z.string().trim().min(1), trade_name: texto, tax_id: z.string().trim().min(1),
  address: texto, city: texto, postal_code: texto,
});
export const DatosSchema = z.object({
  formato: z.literal(FORMATO, { error: `No es un fichero de datos de Sindri (formato «${FORMATO}»)` }),
  version: z.literal(1, { error: "Versión del fichero no admitida (se admite la 1)" }),
  origen: z.string().optional(),
  /** Nombre corto de la app de origen (incidencias, tareas…): es el origen de lo por facturar. */
  origen_app: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/).optional(),
  empresa: EmpresaSchema.optional(),
  clientes: z.array(ClienteSchema).default([]),
  productos: z.array(ProductoSchema).default([]),
  modelos: z.array(ModeloSchema).default([]),
  por_facturar: z.array(PorFacturarSchema).max(5000).default([]),
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
  tarifas: number;
  por_facturar: { creados: number; actualizados: number; sin_tocar: number };
  /** Lo por facturar agrupado por cliente y servicio, para enseñarlo antes de importar. */
  tabla: { cliente: string; sku: string; servicio: string; uom: string; cantidad: string; precio: string | null; importe: string; elementos: number }[];
  avisos: string[];
}

export async function importar(db: Db, ctx: Ctx, datos: Datos, probar = false): Promise<Resultado> {
  const r: Resultado = {
    probar,
    clientes: { creados: 0, actualizados: 0 },
    productos: { creados: 0, actualizados: 0 },
    modelos: { creados: 0, actualizados: 0 },
    tarifas: 0,
    por_facturar: { creados: 0, actualizados: 0, sin_tocar: 0 },
    tabla: [],
    avisos: [],
  };
  const empresa = (await getCompany(db, ctx.company)) as { tax_id: string; name: string } | null;
  if (!empresa) throw new BusinessError("Configura primero los datos de tu empresa", 409);
  if (datos.empresa && datos.empresa.tax_id.toUpperCase() !== empresa.tax_id.toUpperCase())
    r.avisos.push(`El fichero es de ${datos.empresa.name} (${datos.empresa.tax_id}) y lo estás metiendo en ${empresa.name} (${empresa.tax_id}).`);

  const tarifasPendientes: { id: string; name: string; tarifas: { sku: string; precio: string }[] }[] = [];
  const trabajo = async (q: Queryable) => {
    tarifasPendientes.length = 0;
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
      const { contactos = [], direcciones = [], tarifas = [], ...ficha } = c;
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
      if (tarifas.length) tarifasPendientes.push({ id, name: c.name, tarifas });
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
    // Las tarifas, cuando ya están los productos del fichero.
    const productoPorSku = async (sku: string) =>
      (await q.query<{ id: string; name: string; uom: string; sale_price: string }>("select id, name, uom, sale_price::text from product where company_id = $1 and sku = $2", [ctx.company, sku]))[0];
    for (const t of tarifasPendientes) {
      for (const tf of t.tarifas) {
        const pr = await productoPorSku(tf.sku);
        if (!pr) {
          r.avisos.push(`${t.name}: tarifa de ${tf.sku}, que no existe; no se guarda.`);
          continue;
        }
        await q.query(
          `insert into partner_price (partner_id, product_id, unit_price) values ($1,$2,$3)
           on conflict (partner_id, product_id) do update set unit_price = excluded.unit_price, updated_at = now()`,
          [t.id, pr.id, tf.precio],
        );
        r.tarifas++;
      }
    }
    // Lo por facturar: queda pendiente en Pedidos → Por facturar.
    const origen = datos.origen_app ?? "importado";
    const grupos = new Map<string, Resultado["tabla"][number]>();
    for (const it of datos.por_facturar) {
      const nif = it.cliente.tax_id?.toUpperCase() ?? null;
      const [cli] = (nif ? await q.query<{ id: string; name: string }>("select id, coalesce(trade_name, name) as name from partner where company_id = $1 and upper(tax_id) = $2 and not archived limit 1", [ctx.company, nif]) : [])
        .concat(await q.query<{ id: string; name: string }>("select id, coalesce(trade_name, name) as name from partner where company_id = $1 and lower(name) = lower($2) and not archived limit 1", [ctx.company, it.cliente.name]));
      if (!cli) {
        r.avisos.push(`${it.ref}: no hay cliente ${it.cliente.name}; no se mete.`);
        continue;
      }
      const pr = await productoPorSku(it.sku);
      if (!pr) {
        r.avisos.push(`${it.ref}: no hay producto ${it.sku}; no se mete.`);
        continue;
      }
      if (D(it.cantidad).cmp(0) <= 0) {
        r.avisos.push(`${it.ref}: cantidad ${it.cantidad} no válida; no se mete.`);
        continue;
      }
      const [cur] = await q.query<{ id: string; state: string }>(
        "select id, state from billable_item where company_id = $1 and source = $2 and external_ref = $3 for update",
        [ctx.company, origen, it.ref],
      );
      const vals = [cli.id, pr.id, it.descripcion, it.fecha, it.cantidad, it.precio ?? null];
      if (!cur) {
        await q.query(
          `insert into billable_item (company_id, source, external_ref, partner_id, product_id, description, item_date, quantity, unit_price)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [ctx.company, origen, it.ref, ...vals],
        );
        r.por_facturar.creados++;
      } else if (cur.state === "pending") {
        await q.query(
          "update billable_item set partner_id = $2, product_id = $3, description = $4, item_date = $5, quantity = $6, unit_price = $7, updated_at = now() where id = $1",
          [cur.id, ...vals],
        );
        r.por_facturar.actualizados++;
      } else {
        r.por_facturar.sin_tocar++;
        continue;
      }
      const precio = D(it.precio ?? (await priceFor(q, cli.id, pr.id, pr.sale_price))).toFixed();
      const clave = `${cli.id}|${pr.id}`;
      const g = grupos.get(clave) ?? { cliente: cli.name, sku: it.sku, servicio: pr.name, uom: pr.uom, cantidad: "0", precio, importe: "0", elementos: 0 };
      if (g.precio !== null && D(g.precio).cmp(D(precio)) !== 0) g.precio = null;
      g.cantidad = D(g.cantidad).add(D(it.cantidad)).toFixed();
      g.importe = D(g.importe).add(D(it.cantidad).mul(D(precio)).round(2)).toFixed(2);
      g.elementos++;
      grupos.set(clave, g);
    }
    r.tabla = [...grupos.values()].sort((a, b) => a.cliente.localeCompare(b.cliente) || a.sku.localeCompare(b.sku));
    await log(q, ctx, "company", ctx.company, probar ? "import.test" : "import", {
      origen: datos.origen ?? null, clientes: r.clientes, productos: r.productos, modelos: r.modelos, tarifas: r.tarifas, por_facturar: r.por_facturar,
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
  const tarifas = await q.query<{ partner_id: string; sku: string; precio: string }>(
    "select pp.partner_id, pr.sku, trim_scale(pp.unit_price)::text as precio from partner_price pp join product pr on pr.id = pp.product_id where pr.company_id = $1 order by pr.sku", [ctx.company]);
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
      tarifas: tarifas.filter((t) => t.partner_id === c.id).map((t) => ({ sku: t.sku, precio: t.precio })),
    })),
    productos: productos.map((p) => limpio(p, PRODUCTO_CAMPOS) as Datos["productos"][number]),
    modelos: modelos.map((m) => limpio(m, MODELO_CAMPOS) as Datos["modelos"][number]),
    por_facturar: [],
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
