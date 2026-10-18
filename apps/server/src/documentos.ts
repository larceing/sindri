/**
 * Documentos en PDF con el Report Server del servidor (larceing/report-server).
 *
 * Sindri arma los datos (factura, pedido, albarán, hoja de ruta) y se los manda al Report
 * Server con su llave; este los pinta con la plantilla «sindri-…» y devuelve el PDF.
 * Variables (en el app.env de Sindri, a mano mientras Ajustes no tenga secretos por app):
 *   REPORT_URL    p. ej. http://report-server-dev:3000 (por la red interna)
 *   REPORT_LLAVE  la llave creada en Report Server → Llaves
 * Las plantillas de partida están en docs/report-server/ (Importar .json en Report Server).
 * Sin Report Server, la web imprime con el navegador.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db, Queryable } from "./db.js";
import { getRoute } from "./comercial.js";
import { BusinessError, getCompany, getInvoice, getSalesOrder, type Ctx } from "./services.js";
import { ctxOf, type Session } from "./usuarios.js";

export interface ReportServerConfig {
  url: string;
  key: string;
}

export function reportServerFromEnv(env: NodeJS.ProcessEnv = process.env): ReportServerConfig | undefined {
  if (!env.REPORT_URL || !env.REPORT_LLAVE) return undefined;
  return { url: env.REPORT_URL.replace(/\/+$/, ""), key: env.REPORT_LLAVE };
}

export const DOCUMENTOS = {
  factura: { plantilla: "sindri-factura", modulo: "facturas", titulo: "Factura" },
  pedido: { plantilla: "sindri-pedido", modulo: "pedidos", titulo: "Pedido" },
  albaran: { plantilla: "sindri-albaran", modulo: "pedidos", titulo: "Albarán" },
  hoja_ruta: { plantilla: "sindri-hoja-ruta", modulo: "rutas", titulo: "Hoja de ruta" },
} as const;
export type TipoDocumento = keyof typeof DOCUMENTOS;

const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const join = (...parts: unknown[]) => parts.filter((p) => p !== null && p !== undefined && String(p).trim() !== "").join(" ");

function empresa(c: Record<string, any>) {
  return { nombre: c.name, nombre_comercial: c.trade_name ?? "", nif: c.tax_id, direccion: c.address ?? "", cp: c.postal_code ?? "", poblacion: c.city ?? "", linea_direccion: join(c.address, "·", c.postal_code, c.city) };
}

/** Los datos que recibe cada plantilla. Los importes van como números: la plantilla les da formato. */
export async function datosDocumento(q: Queryable, ctx: Ctx, tipo: TipoDocumento, id: string) {
  const company = (await getCompany(q, ctx.company))!;
  if (tipo === "factura") {
    const f = await getInvoice(q, ctx, id);
    if (f.state === "draft") throw new BusinessError("Una factura en borrador no se imprime: emítela primero", 409);
    const cli = f.partner_snapshot ?? {};
    const [orden] = f.order_id ? await q.query<{ number: string }>("select number from sales_order where id = $1", [f.order_id]) : [];
    return {
      empresa: empresa(company),
      numero: f.number,
      fecha: f.issue_date,
      pedido: orden?.number ?? "",
      cliente: { nombre: cli.name, nif: cli.tax_id, direccion: cli.address ?? "", cp: cli.postal_code ?? "", poblacion: cli.city ?? "", linea_direccion: join(cli.address, "·", cli.postal_code, cli.city) },
      lineas: f.lines.map((l: Record<string, string>) => ({
        descripcion: l.description, cantidad: n(l.quantity), precio: n(l.unit_price), descuento: n(l.discount_pct), iva: n(l.vat_rate), base: n(l.base),
      })),
      desglose: (f.tax_breakdown as Record<string, string>[]).map((t) => ({
        iva: n(t.vatRate), base: n(t.base), cuota: n(t.vatAmount), recargo_pct: n(t.surchargeRate), recargo: n(t.surchargeAmount),
      })),
      base: n(f.untaxed), iva: n(f.vat_total), recargo: n(f.surcharge_total), retencion: n(f.withholding), total: n(f.total),
      cobrado: n(f.paid), pendiente: n(f.pending),
      qr: f.verifactu?.qr_url ?? "",
      verifactu: f.verifactu ? "Factura verificable en la sede electrónica de la AEAT · VERI*FACTU" : "",
    };
  }
  if (tipo === "pedido" || tipo === "albaran") {
    const o = await getSalesOrder(q, ctx, id);
    const [cli] = await q.query<Record<string, string>>("select * from partner where id = $1", [o.partner_id]);
    const a = o.delivery_address as Record<string, string> | null;
    const [alb] = await q.query<{ number: string; done_at: string }>("select number, done_at from delivery where order_id = $1 order by done_at desc limit 1", [id]);
    if (tipo === "albaran" && !alb) throw new BusinessError("El pedido todavía no se ha entregado: no tiene albarán", 409);
    return {
      empresa: empresa(company),
      numero: tipo === "albaran" ? alb!.number : o.number,
      pedido: o.number,
      fecha: tipo === "albaran" ? String(alb!.done_at).slice(0, 10) : o.order_date,
      fecha_entrega: o.delivery_date ?? "",
      comercial: o.sales_rep_name ?? "",
      cliente: { nombre: cli!.name, nif: cli!.tax_id ?? "", telefono: cli!.phone ?? "", linea_direccion: join(cli!.address, "·", cli!.postal_code, cli!.city) },
      entrega: {
        nombre: a?.label ?? cli!.name,
        linea_direccion: a ? join(a.address, "·", a.postal_code, a.city) : join(cli!.address, "·", cli!.postal_code, cli!.city),
        horario: a?.schedule ?? "",
        telefono: a?.phone ?? cli!.phone ?? "",
      },
      lineas: o.lines.map((l: Record<string, string>) => ({
        referencia: l.sku, descripcion: l.description, cantidad: n(l.quantity), unidad: l.uom, precio: n(l.unit_price), descuento: n(l.discount_pct), base: n(D2(l)),
      })),
      base: n(o.totals.untaxed), iva: n(o.totals.vatTotal), total: n(o.totals.total),
      notas: o.notes ?? "",
    };
  }
  const r = await getRoute(q, ctx, id);
  return {
    empresa: empresa(company),
    numero: r.number,
    fecha: r.route_date,
    conductor: r.driver ?? "",
    vehiculo: r.vehicle ?? "",
    zona: r.zone ?? "",
    notas: r.notes ?? "",
    paradas: r.stops.map((s: Record<string, any>) => ({
      orden: s.position,
      cliente: s.partner_name,
      direccion: join(s.address, "·", s.postal_code, s.city),
      telefono: s.phone ?? "",
      horario: s.schedule ?? "",
      pedido: s.delivery_number ? `${s.order_number} / ${s.delivery_number}` : s.order_number,
      mercancia: (s.lines as Record<string, string>[]).map((l) => `${Number(l.quantity)} ${l.uom} ${l.sku}`).join(", "),
      notas: join(s.delivery_notes, s.order_notes),
    })),
    total_paradas: r.stops.length,
  };
}

const D2 = (l: Record<string, string>) => (Number(l.quantity) * Number(l.unit_price) * (1 - Number(l.discount_pct) / 100)).toFixed(2);

export function registerDocumentos(app: FastifyInstance, db: Db, rs: ReportServerConfig | undefined) {
  /** Qué hay: si el Report Server está configurado y qué plantillas de Sindri tiene. */
  app.get("/api/v1/documentos", async () => {
    if (!rs) return { report_server: false, plantillas: [] };
    try {
      const r = await fetch(`${rs.url}/api/plantillas`, { headers: { authorization: `Bearer ${rs.key}` }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) return { report_server: true, error: `El Report Server responde ${r.status}`, plantillas: [] };
      const list = (await r.json()) as { nombre: string }[];
      return { report_server: true, plantillas: list.map((p) => p.nombre).filter((p) => p.startsWith("sindri-")) };
    } catch {
      return { report_server: true, error: "No se llega al Report Server", plantillas: [] };
    }
  });

  app.get<{ Params: { tipo: string; id: string } }>("/api/v1/documentos/:tipo/:id/datos", async (req) => {
    const tipo = z.enum(Object.keys(DOCUMENTOS) as [TipoDocumento]).parse(req.params.tipo);
    permiso(req.sindri, tipo);
    return datosDocumento(db, ctxOf(req), tipo, req.params.id);
  });

  app.get<{ Params: { tipo: string; id: string } }>("/api/v1/documentos/:tipo/:id/pdf", async (req, reply) => {
    const tipo = z.enum(Object.keys(DOCUMENTOS) as [TipoDocumento]).parse(req.params.tipo);
    permiso(req.sindri, tipo);
    if (!rs) throw new BusinessError("Sindri no tiene Report Server configurado (REPORT_URL y REPORT_LLAVE)", 501);
    const datos = await datosDocumento(db, ctxOf(req), tipo, req.params.id);
    const doc = DOCUMENTOS[tipo];
    const r = await fetch(`${rs.url}/api/generar`, {
      method: "POST",
      headers: { authorization: `Bearer ${rs.key}`, "content-type": "application/json" },
      body: JSON.stringify({ plantilla: doc.plantilla, nombre: `${doc.titulo} ${datos.numero}`, datos }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!r) throw new BusinessError("No se llega al Report Server", 502);
    if (!r.ok) {
      const e = (await r.json().catch(() => null)) as { error?: string } | null;
      throw new BusinessError(`Report Server: ${e?.error ?? `error ${r.status}`}`, r.status === 404 ? 404 : 502);
    }
    return reply
      .type("application/pdf")
      .header("content-disposition", r.headers.get("content-disposition") ?? `inline; filename="${doc.titulo} ${datos.numero}.pdf"`)
      .send(Buffer.from(await r.arrayBuffer()));
  });
}

/** El documento se rige por el permiso de su módulo (factura → facturas…). */
function permiso(s: Session | undefined, tipo: TipoDocumento) {
  const mod = DOCUMENTOS[tipo].modulo;
  if (!s?.perms[mod]) throw new BusinessError("Tu rol no da acceso a esta parte de Sindri", 403);
}
