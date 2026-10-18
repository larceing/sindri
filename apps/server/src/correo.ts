/**
 * Correo con el Mail del servidor (larceing/mail): confirmación de pedidos con el PDF adjunto.
 *
 * La conexión (dirección y llave creada en Mail → Llaves para la app sindri) llega por
 * MAIL_URL y MAIL_LLAVE en el app.env o se guarda desde Empresa → Correo. Cada empresa decide
 * si al confirmar un pedido se manda solo la confirmación al correo del cliente.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "./db.js";
import { generarPdf, type ReportServerConfig } from "./documentos.js";
import { BusinessError, getCompany, getSalesOrder, log, type Ctx } from "./services.js";
import { ctxOf, requireAdmin } from "./usuarios.js";

export interface MailConfig {
  url: string;
  key: string;
}

const AJUSTE = "mail";

export function mailFromEnv(env: NodeJS.ProcessEnv = process.env): MailConfig | undefined {
  if (!env.MAIL_URL || !env.MAIL_LLAVE) return undefined;
  return { url: env.MAIL_URL.replace(/\/+$/, ""), key: env.MAIL_LLAVE };
}

async function conexion(db: Db, fromEnv: MailConfig | undefined) {
  if (fromEnv) return { ...fromEnv, origen: "variables" as const };
  const [row] = await db.query<{ value: MailConfig }>("select value from app_setting where key = $1", [AJUSTE]);
  return row?.value?.url && row.value.key ? { url: row.value.url, key: row.value.key, origen: "sindri" as const } : undefined;
}

const fechaEs = (d: unknown) => String(d ?? "").slice(0, 10).split("-").reverse().join("/");
const euros = (v: unknown) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", useGrouping: "always" } as Intl.NumberFormatOptions).format(Number(v ?? 0));
const correoValido = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export interface Opciones {
  mail?: MailConfig;
  reportServer?: ReportServerConfig;
}

/** Manda la confirmación del pedido. Sin PDF si el Report Server no está: se dice en la respuesta. */
export async function enviarConfirmacion(db: Db, opts: Opciones, ctx: Ctx, orderId: string, para?: string[]) {
  const mail = await conexion(db, opts.mail);
  if (!mail) throw new BusinessError("Sindri no está conectado al Mail: conéctalo en Empresa → Correo", 501);
  const o = (await getSalesOrder(db, ctx, orderId)) as Record<string, any>;
  if (o.state === "draft") throw new BusinessError("Un pedido en borrador no se confirma por correo: confírmalo primero", 409);
  if (o.state === "cancelled") throw new BusinessError("El pedido está anulado", 409);
  const [cli] = await db.query<{ email: string | null; name: string; trade_name: string | null }>("select email, name, trade_name from partner where id = $1", [o.partner_id]);
  const destinos = (para?.length ? para : cli?.email ? cli.email.split(/[;,]/) : []).map((e) => e.trim()).filter(Boolean);
  if (!destinos.length) throw new BusinessError("El cliente no tiene correo: ponlo en su ficha o indica a quién mandarlo", 422);
  const malos = destinos.filter((e) => !correoValido(e));
  if (malos.length) throw new BusinessError(`Correo no válido: ${malos.join(", ")}`, 422);
  const empresa = (await getCompany(db, ctx.company)) as Record<string, any>;
  const nombreEmpresa = empresa.trade_name || empresa.name;

  let adjunto: { nombre: string; contenido: string } | undefined;
  let aviso: string | undefined;
  try {
    const pdf = await generarPdf(db, opts.reportServer, ctx, "pedido", orderId);
    adjunto = { nombre: pdf.nombre, contenido: pdf.contenido.toString("base64") };
  } catch (e) {
    aviso = `Sin PDF: ${e instanceof Error ? e.message : String(e)}`;
  }

  const filas: [string, string][] = o.lines.map((l: any, i: number) => [`${Number(l.quantity).toLocaleString("es-ES")} × ${l.description}`, euros(o.totals.lines[i]?.base)]);
  filas.push(["Base imponible", euros(o.totals.untaxed)], ["Total", euros(o.totals.amountDue ?? o.totals.total)]);
  const cuerpo = {
    para: destinos,
    asunto: `${nombreEmpresa} · Pedido ${o.number} confirmado`,
    bloques: [
      { tipo: "titulo", texto: `Pedido ${o.number} confirmado` },
      {
        tipo: "texto",
        texto: `Hola,\n\nHemos confirmado tu pedido ${o.number} del ${fechaEs(o.order_date)}${o.delivery_date ? `, con entrega prevista el ${fechaEs(o.delivery_date)}` : ""}.${adjunto ? " Te lo adjuntamos en PDF." : ""}\n\nGracias por confiar en nosotros.`,
      },
      { tipo: "tabla", titulo: "Resumen", filas },
      { tipo: "nota", texto: [empresa.name, empresa.tax_id && `NIF ${empresa.tax_id}`, [empresa.address, empresa.postal_code, empresa.city].filter(Boolean).join(" ")].filter(Boolean).join(" · ") },
    ],
    ...(adjunto ? { adjuntos: [adjunto] } : {}),
  };
  const r = await fetch(`${mail.url}/api/enviar`, {
    method: "POST",
    headers: { authorization: `Bearer ${mail.key}`, "content-type": "application/json" },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!r) throw new BusinessError("No se llega al Mail", 502);
  const res = (await r.json().catch(() => null)) as { error?: string; adjuntos?: number } | null;
  if (!r.ok) throw new BusinessError(`Mail: ${res?.error ?? `error ${r.status}`}`, 502);
  // Un Mail antiguo, sin adjuntos, manda el correo sin el PDF: se avisa.
  if (adjunto && res?.adjuntos === undefined) aviso = "El Mail no admite adjuntos todavía: el correo ha salido sin el PDF";
  await db.query("update sales_order set mailed_at = now() where id = $1", [orderId]);
  await log(db, ctx, "sales_order", orderId, "mail", { para: destinos, pdf: !!adjunto && !aviso });
  return { enviado: true, para: destinos, pdf: !!adjunto && !aviso, ...(aviso ? { aviso } : {}) };
}

/**
 * Tras confirmar un pedido: si la empresa lo tiene activado, se manda solo. Nunca hace fallar la
 * confirmación; lo que pase queda en el registro de eventos.
 */
export function confirmacionAutomatica(db: Db, opts: Opciones, ctx: Ctx, orderId: string) {
  void (async () => {
    const [c] = await db.query<{ order_mail: boolean }>("select order_mail from company where id = $1", [ctx.company]);
    if (!c?.order_mail || !(await conexion(db, opts.mail))) return;
    const [cli] = await db.query<{ email: string | null }>("select p.email from sales_order o join partner p on p.id = o.partner_id where o.id = $1", [orderId]);
    if (!cli?.email) {
      await log(db, ctx, "sales_order", orderId, "mail_skipped", { motivo: "El cliente no tiene correo" });
      return;
    }
    await enviarConfirmacion(db, opts, ctx, orderId);
  })().catch((e) => log(db, ctx, "sales_order", orderId, "mail_error", { error: e instanceof Error ? e.message : String(e) }).catch(() => {}));
}

const ConexionSchema = z.object({ url: z.url().transform((u) => u.replace(/\/+$/, "")), llave: z.string().trim().optional() });

export function registerCorreo(app: FastifyInstance, db: Db, opts: Opciones) {
  app.get("/api/v1/correo", async (req) => {
    const ctx = ctxOf(req);
    const m = await conexion(db, opts.mail);
    const [c] = await db.query<{ order_mail: boolean }>("select order_mail from company where id = $1", [ctx.company]);
    return { origen: m?.origen ?? null, url: m?.url ?? "", llave_fin: m ? m.key.slice(-4) : null, pedidos: !!c?.order_mail };
  });
  app.put("/api/v1/correo/conexion", async (req) => {
    requireAdmin(req);
    if (opts.mail) throw new BusinessError("La conexión viene de MAIL_URL y MAIL_LLAVE en el app.env: se cambia ahí", 409);
    const c = ConexionSchema.parse(req.body);
    const key = c.llave || (await conexion(db, undefined))?.key;
    if (!key) throw new BusinessError("Falta la llave: créala en Mail → Llaves para la app sindri", 400);
    // Prueba: la vista previa pide la llave y no envía nada.
    const r = await fetch(`${c.url}/api/vista`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ para: ["prueba@example.com"], asunto: "Prueba", mensaje: "Prueba de conexión" }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!r) throw new BusinessError("No se llega al Mail en esa dirección", 422);
    if (r.status === 401) throw new BusinessError("El Mail no acepta esa llave", 422);
    if (!r.ok) throw new BusinessError(`El Mail responde con error ${r.status}`, 422);
    await db.query(
      `insert into app_setting (key, value, updated_by) values ($1, $2, $3)
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [AJUSTE, JSON.stringify({ url: c.url, key }), req.sindri!.person.user],
    );
    await log(db, { company: null as never, actor: req.sindri!.person.user }, "app_setting", null, "update", { ajuste: AJUSTE, url: c.url, llave_cambiada: !!c.llave });
    return { origen: "sindri", url: c.url, llave_fin: key.slice(-4) };
  });
  app.delete("/api/v1/correo/conexion", async (req) => {
    requireAdmin(req);
    if (opts.mail) throw new BusinessError("La conexión viene del app.env: se quita ahí", 409);
    await db.query("delete from app_setting where key = $1", [AJUSTE]);
    await log(db, { company: null as never, actor: req.sindri!.person.user }, "app_setting", null, "delete", { ajuste: AJUSTE });
    return { ok: true };
  });
  app.put("/api/v1/correo/pedidos", async (req) => {
    requireAdmin(req);
    const ctx = ctxOf(req);
    const { activo } = z.object({ activo: z.boolean() }).parse(req.body);
    await db.query("update company set order_mail = $2 where id = $1", [ctx.company, activo]);
    await log(db, ctx, "company", ctx.company, "update", { order_mail: activo });
    return { pedidos: activo };
  });
  app.post<{ Params: { id: string } }>("/api/v1/sales-orders/:id/correo", async (req) => {
    const b = z.object({ para: z.array(z.string().trim().min(3)).max(5).optional() }).parse(req.body ?? {});
    return enviarConfirmacion(db, opts, ctxOf(req), req.params.id, b.para);
  });
}
