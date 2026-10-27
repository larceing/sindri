/**
 * Datos para el report server (o Excel, Power BI, Metabase...), en solo lectura.
 *
 *  - /api/v1/informes/...      la web: crear y revocar lectores (permiso «informes»).
 *  - /api/informes/v1/...      la herramienta de informes, con el token de su lector.
 *
 * Cada lector es de una empresa y solo ve los datos de esa empresa. Si la empresa comparte los
 * maestros con otra, los clientes son los comunes; pedidos, facturas, stock… siguen siendo suyos. El token va en
 * «Authorization: Bearer …» o, para herramientas que no dejan poner cabeceras, en «?token=».
 * Formatos: JSON (por defecto), CSV (separado por punto y coma) y XML.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Db } from "./db.js";
import { BusinessError, OWN_LOCATION, log, notFound, type Ctx } from "./services.js";
import { ctxOf } from "./usuarios.js";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** Conjuntos de datos. $1 = empresa, $2 = desde, $3 = hasta (fechas opcionales). */
export const DATASETS: Record<string, { label: string; sql: string }> = {
  clientes: {
    label: "Clientes con su comercial y condiciones",
    sql: `select p.code as codigo, p.name as nombre, p.trade_name as nombre_comercial, p.tax_id as nif, p.kind as tipo,
            p.address as direccion, p.postal_code as cp, p.city as poblacion, p.province as provincia, p.country as pais,
            p.phone as telefono, p.mobile as movil, p.email, r.code as comercial_codigo, r.name as comercial,
            p.payment_method as forma_pago, p.payment_days as dias_pago, p.credit_limit as limite_credito,
            p.discount_pct as descuento, p.route_zone as zona_reparto, p.created_at::date as alta
          from partner p left join sales_rep r on r.id = p.sales_rep_id and r.company_id = $1
          where p.company_id = maestro($1) and not p.archived and ($2::date is null or true) and ($3::date is null or true) order by p.name`,
  },
  pedidos: {
    label: "Pedidos de venta (cabecera)",
    sql: `select o.number as pedido, o.order_date as fecha, o.delivery_date as fecha_entrega, o.state as estado,
            p.name as cliente, p.tax_id as nif, r.name as comercial, coalesce(a.city, p.city) as poblacion_entrega,
            s.number as separado_de,
            (select coalesce(sum(round(l.quantity * l.unit_price * (1 - l.discount_pct/100), 2)), 0) from sales_order_line l where l.order_id = o.id) as base
          from sales_order o join partner p on p.id = o.partner_id left join sales_rep r on r.id = o.sales_rep_id
          left join partner_address a on a.id = o.delivery_address_id left join sales_order s on s.id = o.split_from_id
          where o.company_id = $1 and ($2::date is null or o.order_date >= $2) and ($3::date is null or o.order_date <= $3)
          order by o.order_date, o.number`,
  },
  lineas_pedido: {
    label: "Líneas de pedido",
    sql: `select o.number as pedido, o.order_date as fecha, o.state as estado, p.name as cliente, r.name as comercial,
            pr.sku as referencia, l.description as descripcion, l.quantity as cantidad, pr.uom as unidad,
            l.unit_price as precio, l.discount_pct as descuento, l.vat_rate as iva,
            round(l.quantity * l.unit_price * (1 - l.discount_pct/100), 2) as base
          from sales_order_line l join sales_order o on o.id = l.order_id join partner p on p.id = o.partner_id
          join product pr on pr.id = l.product_id left join sales_rep r on r.id = o.sales_rep_id
          where o.company_id = $1 and ($2::date is null or o.order_date >= $2) and ($3::date is null or o.order_date <= $3)
          order by o.order_date, o.number, l.position`,
  },
  facturas: {
    label: "Facturas emitidas con lo cobrado",
    sql: `select i.number as factura, i.issue_date as fecha, i.state as estado, p.name as cliente, p.tax_id as nif,
            r.name as comercial, i.untaxed as base, i.vat_total as iva, i.surcharge_total as recargo,
            i.withholding as retencion, i.total, coalesce((select sum(amount) from payment where invoice_id = i.id), 0) as cobrado,
            case when i.state = 'rectified' then 0 else i.amount_due - coalesce((select sum(amount) from payment where invoice_id = i.id), 0) end as pendiente
          from invoice i join partner p on p.id = i.partner_id left join sales_order o on o.id = i.order_id
          left join sales_rep r on r.id = o.sales_rep_id
          where i.company_id = $1 and i.state in ('issued', 'paid', 'rectified')
            and ($2::date is null or i.issue_date >= $2) and ($3::date is null or i.issue_date <= $3)
          order by i.issue_date, i.number`,
  },
  cobros: {
    label: "Cobros recibidos (por fecha de cobro)",
    sql: `select c.paid_on as fecha, i.number as factura, i.issue_date as fecha_factura, p.name as cliente, p.tax_id as nif,
            c.method as forma_pago, c.amount as importe, i.total as total_factura, i.state as estado_factura
          from payment c join invoice i on i.id = c.invoice_id join partner p on p.id = i.partner_id
          where i.company_id = $1 and ($2::date is null or c.paid_on >= $2) and ($3::date is null or c.paid_on <= $3)
          order by c.paid_on, i.number`,
  },
  comerciales: {
    label: "Ventas facturadas y comisión por comercial",
    sql: `select r.code as codigo, r.name as comercial, r.kind as tipo, r.zone as zona, r.commission_pct as comision_pct,
            coalesce(sum(i.untaxed), 0) as base_facturada,
            round(coalesce(sum(i.untaxed), 0) * r.commission_pct / 100, 2) as comision
          from sales_rep r left join sales_order o on o.sales_rep_id = r.id
          left join invoice i on i.order_id = o.id and i.state in ('issued', 'paid', 'rectified')
            and ($2::date is null or i.issue_date >= $2) and ($3::date is null or i.issue_date <= $3)
          where r.company_id = $1 group by r.id order by r.name`,
  },
  hojas_ruta: {
    label: "Hojas de ruta y sus paradas",
    sql: `select dr.number as hoja, dr.route_date as fecha, dr.state as estado, dr.driver as conductor, dr.vehicle as vehiculo,
            dr.zone as zona, s.position as orden, o.number as pedido, p.name as cliente,
            coalesce(a.city, p.city) as poblacion, s.state as estado_parada, s.note as nota, s.done_at as hora
          from delivery_route dr join delivery_route_stop s on s.route_id = dr.id join sales_order o on o.id = s.order_id
          join partner p on p.id = o.partner_id left join partner_address a on a.id = o.delivery_address_id
          where dr.company_id = $1 and ($2::date is null or dr.route_date >= $2) and ($3::date is null or dr.route_date <= $3)
          order by dr.route_date, dr.number, s.position`,
  },
  stock: {
    label: "Existencias por producto y lote",
    sql: `select p.sku as referencia, p.name as producto, p.uom as unidad, lot.code as lote, lot.expiry_date as caducidad,
            l.code as ubicacion, b.quantity as cantidad, p.cost_price as coste, round(b.quantity * p.cost_price, 2) as valor
          from stock_balance b join product p on p.id = b.product_id join location l on l.id = b.location_id
          left join lot on lot.id = b.lot_id
          where ${OWN_LOCATION("l", "$1")} and ($2::date is null or true) and ($3::date is null or true) order by p.sku, lot.code`,
  },
};

export async function readDataset(db: Db, company: string, name: string, desde?: string, hasta?: string) {
  const ds = DATASETS[name];
  if (!ds) throw notFound("Conjunto de datos");
  return db.query(ds.sql, [company, desde ?? null, hasta ?? null]);
}

const xmlEsc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const str = (v: unknown) => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v));

export function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => {
    // Lo que empieza por = + - @ Excel lo tomaría como fórmula: se protege con un apóstrofo.
    const s0 = str(v);
    const s = typeof v === "string" && /^[=+\-@\t\r]/.test(s0) ? `'${s0}` : s0;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(";"), ...rows.map((r) => cols.map((c) => cell(r[c])).join(";"))].join("\r\n") + "\r\n";
}

export function toXml(name: string, rows: Record<string, unknown>[]) {
  const body = rows
    .map((r) => "  <fila>" + Object.entries(r).map(([k, v]) => (v === null || v === undefined ? `<${k}/>` : `<${k}>${xmlEsc(str(v))}</${k}>`)).join("") + "</fila>")
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${name}>\n${body}\n</${name}>\n`;
}

function send(reply: FastifyReply, name: string, rows: Record<string, unknown>[], format: string | undefined) {
  if (format === "csv") return reply.type("text/csv; charset=utf-8").header("content-disposition", `inline; filename="${name}.csv"`).send("﻿" + toCsv(rows));
  if (format === "xml") return reply.type("application/xml; charset=utf-8").send(toXml(name, rows));
  return rows;
}

const Query = z.object({
  formato: z.enum(["json", "csv", "xml"]).optional(),
  desde: z.iso.date().optional(),
  hasta: z.iso.date().optional(),
  token: z.string().optional(),
});

export function registerInformes(app: FastifyInstance, db: Db) {
  // Herramienta de informes: su token y solo lectura.
  app.register(
    async (api) => {
      api.addHook("onRequest", async (req, reply) => {
        const h = req.headers.authorization ?? "";
        const token = h.startsWith("Bearer ") ? h.slice(7).trim() : (req.query as { token?: string }).token;
        const [reader] = token
          ? await db.query<{ id: string; company_id: string }>("select id, company_id from report_reader where token_hash = $1 and revoked_at is null", [hash(token)])
          : [];
        if (!reader) return reply.status(401).send({ error: "Token de informes no válido o revocado" });
        (req as unknown as { reader: typeof reader }).reader = reader;
        await db.query("update report_reader set last_used_at = now() where id = $1", [reader.id]);
      });
      api.get("/", async () => Object.entries(DATASETS).map(([id, d]) => ({ id, label: d.label })));
      api.get<{ Params: { name: string } }>("/:name", async (req, reply) => {
        const reader = (req as unknown as { reader: { company_id: string } }).reader;
        const q = Query.parse(req.query);
        const rows = await readDataset(db, reader.company_id, req.params.name, q.desde, q.hasta);
        return send(reply, req.params.name, rows, q.formato);
      });
    },
    { prefix: "/api/informes/v1" },
  );

  // Web: lo mismo con la sesión, y la gestión de lectores.
  app.get("/api/v1/informes", async () => Object.entries(DATASETS).map(([id, d]) => ({ id, label: d.label })));
  app.get<{ Params: { name: string } }>("/api/v1/informes/datos/:name", async (req, reply) => {
    const ctx = ctxOf(req);
    const q = Query.parse(req.query);
    return send(reply, req.params.name, await readDataset(db, ctx.company, req.params.name, q.desde, q.hasta), q.formato);
  });
  app.get("/api/v1/informes/lectores", async (req) =>
    db.query("select id, name, token_hint, created_by, created_at, revoked_at, last_used_at from report_reader where company_id = $1 order by created_at desc", [ctxOf(req).company]),
  );
  app.post("/api/v1/informes/lectores", async (req, reply) => {
    const ctx: Ctx = ctxOf(req);
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const token = `sdi_${randomBytes(32).toString("base64url")}`;
    const [row] = await db.query<{ id: string }>(
      "insert into report_reader (company_id, name, token_hash, token_hint, created_by) values ($1,$2,$3,$4,$5) returning id, name, created_at",
      [ctx.company, name, hash(token), token.slice(-4), ctx.actor],
    );
    await log(db, ctx, "report_reader", row!.id, "create", { name });
    // El token se enseña una vez y no se guarda.
    return reply.status(201).send({ ...row, token });
  });
  app.post<{ Params: { id: string } }>("/api/v1/informes/lectores/:id/revocar", async (req) => {
    const ctx = ctxOf(req);
    const [row] = await db.query("update report_reader set revoked_at = now() where id = $1 and company_id = $2 and revoked_at is null returning id", [
      z.uuid().parse(req.params.id),
      ctx.company,
    ]);
    if (!row) throw new BusinessError("Ese lector no existe o ya estaba revocado", 404);
    await log(db, ctx, "report_reader", row.id as string, "revoke");
    return { ok: true };
  });
}
