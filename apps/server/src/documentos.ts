/**
 * Documentos en PDF con el Report Server del servidor (larceing/report-server).
 *
 * Sindri arma los datos (factura, pedido, albarán, hoja de ruta, presupuesto) y se los manda al Report
 * Server con su llave; este los pinta con la plantilla «sindri-…» y devuelve el PDF.
 * La conexión (dirección y llave creada en Report Server → Llaves) se pone en Sindri →
 * Informes, y queda guardada en la base de Sindri. Si el app.env trae REPORT_URL y
 * REPORT_LLAVE, mandan esas variables y la pantalla solo las enseña.
 * Las plantillas de partida van dentro (plantillas/, se generan con docs/report-server/): Sindri
 * las instala él solo en el Report Server al conectar. En Informes se elige qué plantilla usa cada
 * documento (las de Sindri u otras del Report Server). Sin Report Server, la web imprime con el
 * navegador.
 */
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db, Queryable } from "./db.js";
import { getRoute } from "./comercial.js";
import { getQuotation } from "./crm.js";
import { BusinessError, getCompany, getInvoice, getSalesOrder, log, type Ctx } from "./services.js";
import { ctxOf, requireAdmin, type Session } from "./usuarios.js";

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
  presupuesto: { plantilla: "sindri-presupuesto", modulo: "presupuestos", titulo: "Presupuesto" },
} as const;
export type TipoDocumento = keyof typeof DOCUMENTOS;

const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const lleno = (p: unknown) => p !== null && p !== undefined && String(p).trim() !== "";
const join = (...parts: unknown[]) => parts.filter(lleno).join(" ");
/** «Calle 1 · 20800 Zarautz», sin separadores sueltos si falta algo. */
const lineaDir = (dir: unknown, cp: unknown, pob: unknown) => [dir, join(cp, pob)].filter(lleno).join(" · ");
/** Fecha como día (AAAA-MM-DD), venga como texto o como Date. */
const dia = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : lleno(v) ? String(v).slice(0, 10) : "");

function empresa(c: Record<string, any>) {
  return { nombre: c.name, nombre_comercial: c.trade_name ?? "", nif: c.tax_id, direccion: c.address ?? "", cp: c.postal_code ?? "", poblacion: c.city ?? "", linea_direccion: lineaDir(c.address, c.postal_code, c.city) };
}

/** Los datos que recibe cada plantilla. Los importes van como números: la plantilla les da formato. */
export async function datosDocumento(q: Queryable, ctx: Ctx, tipo: TipoDocumento, id: string) {
  const company = (await getCompany(q, ctx.company))!;
  if (tipo === "factura") {
    const f = await getInvoice(q, ctx, id);
    if (f.state === "draft") throw new BusinessError("Una factura en borrador no se imprime: emítela primero", 409);
    const cli = f.partner_snapshot ?? {};
    const [orden] = f.order_id ? await q.query<{ number: string }>("select number from sales_order where id = $1", [f.order_id]) : [];
    const [pago] = await q.query<{ payment_method: string | null; payment_days: number | null }>("select payment_method, payment_days from partner where id = $1", [f.partner_id]);
    return {
      empresa: empresa(company),
      numero: f.number,
      fecha: dia(f.issue_date),
      pedido: orden?.number ?? "",
      forma_pago: [pago?.payment_method, pago?.payment_days ? `${pago.payment_days} días` : null].filter(lleno).join(", "),
      cliente: { nombre: cli.name, nif: cli.tax_id, direccion: cli.address ?? "", cp: cli.postal_code ?? "", poblacion: cli.city ?? "", linea_direccion: lineaDir(cli.address, cli.postal_code, cli.city) },
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
      fecha: dia(tipo === "albaran" ? alb!.done_at : o.order_date),
      fecha_entrega: dia(o.delivery_date),
      comercial: o.sales_rep_name ?? "",
      cliente: { nombre: cli!.name, nif: cli!.tax_id ?? "", telefono: cli!.phone ?? "", linea_direccion: lineaDir(cli!.address, cli!.postal_code, cli!.city) },
      entrega: {
        nombre: a?.label ?? cli!.name,
        linea_direccion: a ? lineaDir(a.address, a.postal_code, a.city) : lineaDir(cli!.address, cli!.postal_code, cli!.city),
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
  if (tipo === "presupuesto") {
    const p = await getQuotation(q, ctx, id);
    const [cli] = await q.query<Record<string, string>>("select * from partner where id = $1", [p.partner_id]);
    const t = p.totals as { lines: { base: string }[]; breakdown: Record<string, string>[]; untaxed: string; vatTotal: string; surchargeTotal: string; withholding: string; total: string; amountDue: string };
    // Presentación y condiciones van por párrafos: en la plantilla son tablas de una columna, así empujan lo de debajo.
    const parrafos = (v: unknown) => String(v ?? "").split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean).map((texto) => ({ texto }));
    return {
      empresa: empresa(company),
      numero: p.number,
      titulo: p.title,
      fecha: dia(p.quote_date),
      valido_hasta: dia(p.valid_until),
      comercial: p.sales_rep_name ?? "",
      cliente: { nombre: cli!.name, nif: cli!.tax_id ?? "", telefono: cli!.phone ?? "", linea_direccion: lineaDir(cli!.address, cli!.postal_code, cli!.city) },
      presentacion: parrafos(p.intro),
      lineas: (p.lines as Record<string, string>[]).map((l, i) => ({
        referencia: l.sku, descripcion: l.description, cantidad: n(l.quantity), unidad: l.uom, precio: n(l.unit_price), descuento: n(l.discount_pct), iva: n(l.vat_rate), base: n(t.lines[i]?.base),
      })),
      desglose: t.breakdown.map((b) => ({ iva: n(b.vatRate), base: n(b.base), cuota: n(b.vatAmount), recargo_pct: n(b.surchargeRate), recargo: n(b.surchargeAmount) })),
      base: n(t.untaxed), iva: n(t.vatTotal), recargo: n(t.surchargeTotal), retencion: n(t.withholding), total: n(t.total), a_pagar: n(t.amountDue),
      condiciones: parrafos(p.conditions),
    };
  }
  const r = await getRoute(q, ctx, id);
  return {
    empresa: empresa(company),
    numero: r.number,
    fecha: dia(r.route_date),
    conductor: r.driver ?? "",
    vehiculo: r.vehicle ?? "",
    zona: r.zone ?? "",
    notas: r.notes ?? "",
    paradas: r.stops.map((s: Record<string, any>) => ({
      orden: s.position,
      cliente: s.partner_name,
      direccion: lineaDir(s.address, s.postal_code, s.city),
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

const AJUSTE = "report_server";
/** Dirección del Report Server tal como se abre en el navegador, para enlazar al diseñador. */
const AJUSTE_EDITAR = "documentos_editar";
const AJUSTE_PLANTILLAS = "documentos_plantillas";
const ConfigSchema = z.object({
  url: z
    .string()
    .trim()
    .regex(/^https?:\/\/[^\s/]+(\/[^\s]*)?$/, "La dirección tiene que empezar por http:// o https://")
    .transform((u) => u.replace(/\/+$/, "")),
  // Vacía o sin mandar: se queda la llave que ya había.
  llave: z.string().trim().regex(/^rs_[A-Za-z0-9_-]{20,}$/, "La llave del Report Server empieza por rs_").or(z.literal("")).optional(),
});
const TIPOS = Object.keys(DOCUMENTOS) as [TipoDocumento, ...TipoDocumento[]];
/** Por documento, el nombre de la plantilla del Report Server, o "" para imprimir con el navegador. */
const EleccionSchema = z.object(Object.fromEntries(TIPOS.map((t) => [t, z.string().trim().max(40).optional()])) as Record<TipoDocumento, z.ZodOptional<z.ZodString>>);

type PlantillaRS = { nombre: string; titulo: string; grupo: string };

/** Las plantillas de partida que lleva Sindri dentro (plantillas/*.json). */
const PARTIDA_DIR = new URL("../plantillas/", import.meta.url);
export const plantillaDePartida = (tipo: TipoDocumento) =>
  JSON.parse(readFileSync(new URL(`${DOCUMENTOS[tipo].plantilla}.json`, PARTIDA_DIR), "utf8")) as Record<string, unknown> & { nombre: string };

/** Prueba la conexión: la lista de plantillas con esa llave. */
async function plantillasDe(rs: ReportServerConfig): Promise<{ error?: string; plantillas: PlantillaRS[] }> {
  try {
    const r = await fetch(`${rs.url}/api/plantillas`, { headers: { authorization: `Bearer ${rs.key}` }, signal: AbortSignal.timeout(5000) });
    if (r.status === 401) return { error: "El Report Server no acepta la llave (no válida o revocada)", plantillas: [] };
    if (!r.ok) return { error: `El Report Server responde ${r.status}: revisa la dirección`, plantillas: [] };
    const list = (await r.json()) as PlantillaRS[];
    if (!Array.isArray(list)) return { error: "Esa dirección no es la de un Report Server", plantillas: [] };
    return { plantillas: list.map((p) => ({ nombre: String(p.nombre), titulo: String(p.titulo ?? p.nombre), grupo: String(p.grupo ?? "") })) };
  } catch {
    return { error: "No se llega al Report Server con esa dirección", plantillas: [] };
  }
}

/**
 * Instala en el Report Server las plantillas de partida de Sindri. Las que ya están no se tocan
 * (pueden estar retocadas en el diseñador) salvo con «sustituir».
 */
async function instalar(rs: ReportServerConfig, tipos: TipoDocumento[], sustituir: boolean) {
  const hechas: { tipo: TipoDocumento; plantilla: string; estado: string }[] = [];
  for (const tipo of tipos) {
    const r = await fetch(`${rs.url}/api/plantillas`, {
      method: "POST",
      headers: { authorization: `Bearer ${rs.key}`, "content-type": "application/json" },
      body: JSON.stringify({ ...plantillaDePartida(tipo), sustituir }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!r) throw new BusinessError("No se llega al Report Server", 502);
    if (r.status === 404) throw new BusinessError("Este Report Server todavía no deja que Sindri instale sus plantillas: actualízalo, o descarga las plantillas e impórtalas a mano", 422);
    const b = (await r.json().catch(() => null)) as { estado?: string; error?: string } | null;
    if (!r.ok) throw new BusinessError(`Report Server: ${b?.error ?? `error ${r.status}`}`, 502);
    hechas.push({ tipo, plantilla: DOCUMENTOS[tipo].plantilla, estado: b?.estado ?? "instalada" });
  }
  return hechas;
}

export function registerDocumentos(app: FastifyInstance, db: Db, fromEnv: ReportServerConfig | undefined) {
  /** La conexión en uso: la de las variables si las hay; si no, la guardada desde la pantalla. */
  const actual = async (): Promise<(ReportServerConfig & { origen: "variables" | "sindri" }) | undefined> => {
    if (fromEnv) return { ...fromEnv, origen: "variables" };
    const [row] = await db.query<{ value: ReportServerConfig }>("select value from app_setting where key = $1", [AJUSTE]);
    return row?.value?.url && row.value.key ? { url: row.value.url, key: row.value.key, origen: "sindri" } : undefined;
  };
  /** Qué plantilla usa cada documento: la elegida en Informes o, si no se ha elegido, la de Sindri. */
  const elegidas = async (): Promise<Record<TipoDocumento, string>> => {
    const [row] = await db.query<{ value: Partial<Record<TipoDocumento, string>> }>("select value from app_setting where key = $1", [AJUSTE_PLANTILLAS]);
    return Object.fromEntries(TIPOS.map((t) => [t, row?.value?.[t] ?? DOCUMENTOS[t].plantilla])) as Record<TipoDocumento, string>;
  };
  const guardarAjuste = async (key: string, value: unknown, user: string) =>
    db.query(
      `insert into app_setting (key, value, updated_by) values ($1, $2, $3)
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), user],
    );
  const conectado = async () => {
    const rs = await actual();
    if (!rs) throw new BusinessError("Sindri no está conectado al Report Server: conéctalo en Informes", 501);
    return rs;
  };

  /**
   * Qué hay: si el Report Server está conectado, sus plantillas y, por documento, la plantilla
   * que se usa y si está en el Report Server («lista»).
   */
  app.get("/api/v1/documentos", async () => {
    const rs = await actual();
    const elegida = await elegidas();
    const { error, plantillas } = rs ? await plantillasDe(rs) : { error: undefined, plantillas: [] as PlantillaRS[] };
    const nombres = plantillas.map((p) => p.nombre);
    const [ed] = await db.query<{ value: string }>("select value from app_setting where key = $1", [AJUSTE_EDITAR]);
    return {
      report_server: !!rs,
      editar: ed?.value ?? null,
      ...(error ? { error } : {}),
      plantillas: nombres,
      disponibles: plantillas,
      documentos: Object.fromEntries(
        TIPOS.map((t) => [t, { plantilla: elegida[t], de_sindri: DOCUMENTOS[t].plantilla, lista: !!elegida[t] && nombres.includes(elegida[t]) }]),
      ),
    };
  });

  // Conexión desde la pantalla (solo administración). La llave no se vuelve a enseñar: solo su final.
  app.get("/api/v1/documentos/conexion", async (req) => {
    requireAdmin(req);
    const rs = await actual();
    return rs ? { origen: rs.origen, url: rs.url, llave_fin: rs.key.slice(-4) } : { origen: null, url: "", llave_fin: null };
  });
  app.put("/api/v1/documentos/conexion", async (req) => {
    requireAdmin(req);
    if (fromEnv) throw new BusinessError("La conexión viene de REPORT_URL y REPORT_LLAVE en el app.env: se cambia ahí", 409);
    const c = ConfigSchema.parse(req.body);
    const key = c.llave || (await actual())?.key;
    if (!key) throw new BusinessError("Falta la llave: créala en Report Server → Llaves para la app sindri", 400);
    const prueba = await plantillasDe({ url: c.url, key });
    if (prueba.error) throw new BusinessError(prueba.error, 422);
    await guardarAjuste(AJUSTE, { url: c.url, key }, req.sindri!.person.user);
    await log(db, { company: null as never, actor: req.sindri!.person.user }, "app_setting", null, "update", { ajuste: AJUSTE, url: c.url, llave_cambiada: !!c.llave });
    // Las plantillas de Sindri que falten se instalan solas; si este Report Server aún no sabe, se dice.
    let instaladas: Awaited<ReturnType<typeof instalar>> = [];
    let aviso: string | undefined;
    try {
      instaladas = await instalar({ url: c.url, key }, TIPOS, false);
    } catch (e) {
      aviso = e instanceof Error ? e.message : String(e);
    }
    const despues = await plantillasDe({ url: c.url, key });
    return { origen: "sindri", url: c.url, llave_fin: key.slice(-4), plantillas: despues.plantillas.map((p) => p.nombre), instaladas, ...(aviso ? { aviso } : {}) };
  });
  app.delete("/api/v1/documentos/conexion", async (req) => {
    requireAdmin(req);
    if (fromEnv) throw new BusinessError("La conexión viene del app.env: se quita ahí", 409);
    await db.query("delete from app_setting where key = $1", [AJUSTE]);
    await log(db, { company: null as never, actor: req.sindri!.person.user }, "app_setting", null, "delete", { ajuste: AJUSTE });
    return { ok: true };
  });

  /** Instalar las plantillas de Sindri (las que falten) o dejarlas como las de partida («sustituir»). */
  app.post("/api/v1/documentos/plantillas/instalar", async (req) => {
    requireAdmin(req);
    const b = z.object({ sustituir: z.boolean().default(false), tipos: z.array(z.enum(TIPOS)).optional() }).parse(req.body ?? {});
    const instaladas = await instalar(await conectado(), b.tipos ?? TIPOS, b.sustituir);
    await log(db, { company: null as never, actor: req.sindri!.person.user }, "app_setting", null, "update", { ajuste: "plantillas_instaladas", instaladas });
    return { instaladas };
  });

  /** Qué plantilla usa cada documento ("" = imprimir con el navegador). */
  app.put("/api/v1/documentos/plantillas", async (req) => {
    requireAdmin(req);
    const cambios = EleccionSchema.parse(req.body);
    const rs = await conectado();
    const { error, plantillas } = await plantillasDe(rs);
    if (error) throw new BusinessError(error, 422);
    for (const [t, nombre] of Object.entries(cambios))
      if (nombre && !plantillas.some((p) => p.nombre === nombre)) throw new BusinessError(`El Report Server no tiene la plantilla «${nombre}» (${DOCUMENTOS[t as TipoDocumento].titulo})`, 422);
    const nuevas = { ...(await elegidas()), ...Object.fromEntries(Object.entries(cambios).filter(([, v]) => v !== undefined)) };
    await guardarAjuste(AJUSTE_PLANTILLAS, nuevas, req.sindri!.person.user);
    await log(db, { company: null as never, actor: req.sindri!.person.user }, "app_setting", null, "update", { ajuste: AJUSTE_PLANTILLAS, ...nuevas });
    return nuevas;
  });

  /** Las plantillas de partida en un fichero, para guardarlas o importarlas a mano (Importar .json). */
  app.get("/api/v1/documentos/plantillas/partida.json", async (req, reply) => {
    requireAdmin(req);
    return reply
      .header("content-disposition", 'attachment; filename="sindri-plantillas.json"')
      .send({ plantillas: TIPOS.map(plantillaDePartida) });
  });

  /** Dónde se editan las plantillas (la dirección pública del Report Server). */
  app.put("/api/v1/documentos/editar", async (req) => {
    requireAdmin(req);
    const { url } = z.object({ url: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]) }).parse(req.body ?? {});
    const limpia = url.replace(/[#?].*$/, "").replace(/\/+$/, "");
    if (limpia) await guardarAjuste(AJUSTE_EDITAR, limpia, req.sindri!.person.user);
    else await db.query("delete from app_setting where key = $1", [AJUSTE_EDITAR]);
    return { editar: limpia || null };
  });

  /** El último documento de ese tipo en la empresa en uso, para probar una plantilla con datos de verdad. */
  app.get<{ Params: { tipo: string } }>("/api/v1/documentos/:tipo/ultimo", async (req) => {
    const tipo = z.enum(Object.keys(DOCUMENTOS) as [TipoDocumento]).parse(req.params.tipo);
    permiso(req.sindri, tipo);
    const ctx = ctxOf(req);
    const sql: Record<TipoDocumento, string> = {
      factura: "select id, number from invoice where company_id = $1 and state <> 'draft' order by created_at desc limit 1",
      pedido: "select id, number from sales_order where company_id = $1 order by created_at desc limit 1",
      // El albarán se imprime desde su pedido: se devuelve el id del pedido.
      albaran: "select order_id as id, number from delivery where company_id = $1 order by done_at desc limit 1",
      hoja_ruta: "select id, number from delivery_route where company_id = $1 order by created_at desc limit 1",
      presupuesto: "select id, number from quotation where company_id = $1 order by created_at desc limit 1",
    };
    const [row] = await db.query<{ id: string; number: string | null }>(sql[tipo], [ctx.company]);
    if (!row) throw new BusinessError(`Todavía no hay ningún documento de tipo ${DOCUMENTOS[tipo].titulo.toLowerCase()} en esta empresa para probar`, 404);
    return { id: row.id, numero: row.number };
  });

  app.get<{ Params: { tipo: string; id: string } }>("/api/v1/documentos/:tipo/:id/datos", async (req) => {
    const tipo = z.enum(Object.keys(DOCUMENTOS) as [TipoDocumento]).parse(req.params.tipo);
    permiso(req.sindri, tipo);
    return datosDocumento(db, ctxOf(req), tipo, req.params.id);
  });

  app.get<{ Params: { tipo: string; id: string } }>("/api/v1/documentos/:tipo/:id/pdf", async (req, reply) => {
    const tipo = z.enum(Object.keys(DOCUMENTOS) as [TipoDocumento]).parse(req.params.tipo);
    permiso(req.sindri, tipo);
    const pdf = await generarPdf(db, fromEnv, ctxOf(req), tipo, req.params.id);
    return reply.type("application/pdf").header("content-disposition", pdf.disposicion).send(pdf.contenido);
  });
}

/**
 * El PDF de un documento con el Report Server, para descargarlo o adjuntarlo a un correo
 * (confirmación de pedido). Sin Report Server, o si el documento se imprime con el navegador, falla.
 */
export async function generarPdf(db: Db, fromEnv: ReportServerConfig | undefined, ctx: Ctx, tipo: TipoDocumento, id: string) {
  const rs = fromEnv ?? (await guardada(db));
  if (!rs) throw new BusinessError("Sindri no está conectado al Report Server: conéctalo en Informes", 501);
  const [row] = await db.query<{ value: Partial<Record<TipoDocumento, string>> }>("select value from app_setting where key = $1", [AJUSTE_PLANTILLAS]);
  const plantilla = row?.value?.[tipo] ?? DOCUMENTOS[tipo].plantilla;
  if (!plantilla) throw new BusinessError(`${DOCUMENTOS[tipo].titulo}: se imprime con el navegador (así está elegido en Informes)`, 501);
  const datos = await datosDocumento(db, ctx, tipo, id);
  const doc = DOCUMENTOS[tipo];
  const r = await fetch(`${rs.url}/api/generar`, {
    method: "POST",
    headers: { authorization: `Bearer ${rs.key}`, "content-type": "application/json" },
    body: JSON.stringify({ plantilla, nombre: `${doc.titulo} ${datos.numero}`, datos }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!r) throw new BusinessError("No se llega al Report Server", 502);
  if (!r.ok) {
    const e = (await r.json().catch(() => null)) as { error?: string } | null;
    throw new BusinessError(`Report Server: ${e?.error ?? `error ${r.status}`}`, r.status === 404 ? 404 : 502);
  }
  return {
    nombre: `${doc.titulo} ${datos.numero}.pdf`,
    disposicion: r.headers.get("content-disposition") ?? `inline; filename="${doc.titulo} ${datos.numero}.pdf"`,
    contenido: Buffer.from(await r.arrayBuffer()),
  };
}

/** La conexión guardada desde la pantalla (Informes), si la hay. */
async function guardada(db: Db): Promise<ReportServerConfig | undefined> {
  const [row] = await db.query<{ value: ReportServerConfig }>("select value from app_setting where key = $1", [AJUSTE]);
  return row?.value?.url && row.value.key ? { url: row.value.url, key: row.value.key } : undefined;
}

/** El documento se rige por el permiso de su módulo (factura → facturas…). */
function permiso(s: Session | undefined, tipo: TipoDocumento) {
  const mod = DOCUMENTOS[tipo].modulo;
  if (!s?.perms[mod]) throw new BusinessError("Tu rol no da acceso a esta parte de Sindri", 403);
}
