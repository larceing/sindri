/**
 * Integraciones: otras apps hablan con Sindri con una llave de una empresa.
 *
 *  - /api/integracion/v1/...  la usa la otra app con su llave (Authorization: Bearer sdi_…).
 *    Ve los clientes y productos de esa empresa y le manda lo que hay que facturar
 *    (horas de una incidencia, de una tarea…). Con esa llave no se ve nada más.
 *  - /api/v1/integraciones/... administración crea y revoca las llaves (empresa en uso).
 *  - /api/v1/por-facturar/...  la web: lo pendiente, pasarlo a un pedido o descartarlo.
 *
 * Lo que manda una app queda pendiente; nadie factura nada sin pasar por un pedido de Sindri.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { D } from "@sindri/core";
import type { Db, Queryable } from "./db.js";
import { BusinessError, cancelSalesOrder, createSalesOrder, log, notFound, type Ctx } from "./services.js";
import { ctxOf, requireAdmin } from "./usuarios.js";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export function newIntegrationKey() {
  const key = `sdi_${randomBytes(32).toString("base64url")}`;
  return { key, hash: hash(key), end: key.slice(-4) };
}

interface Llave {
  id: string;
  company_id: string;
  name: string;
}

// Llaves (administración) -------------------------------------------------------------

export async function listKeys(q: Queryable, ctx: Ctx) {
  return q.query(
    `select id, name, key_end, created_by, created_at, last_used_at, revoked_at,
       (select count(*) from billable_item b where b.key_id = k.id)::int as items
     from integration_key k where company_id = $1 order by revoked_at nulls first, created_at desc`,
    [ctx.company],
  );
}

export async function createKey(db: Db, ctx: Ctx, name: string) {
  const k = newIntegrationKey();
  const [row] = await db.query<{ id: string }>(
    "insert into integration_key (company_id, name, key_hash, key_end, created_by) values ($1,$2,$3,$4,$5) returning id, name, key_end, created_at",
    [ctx.company, name, k.hash, k.end, ctx.actor],
  );
  await log(db, ctx, "integration_key", row!.id, "create", { name });
  // La llave entera solo se enseña ahora: en la base queda su huella.
  return { ...row, key: k.key };
}

export async function revokeKey(db: Db, ctx: Ctx, id: string) {
  const [row] = await db.query("update integration_key set revoked_at = now() where id = $1 and company_id = $2 and revoked_at is null returning id", [id, ctx.company]);
  if (!row) throw notFound("Llave");
  await log(db, ctx, "integration_key", id, "revoke");
  return { ok: true };
}

// Lo que mandan las apps --------------------------------------------------------------

export interface ItemInput {
  ref: string;
  cliente: string;
  producto: string;
  fecha: string;
  cantidad: string;
  precio?: string | null;
  descripcion: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Alta o cambio de lo que hay que facturar. Mandar otra vez la misma referencia actualiza lo
 * pendiente; lo que ya está en un pedido o descartado no se toca y se dice.
 */
export async function upsertItems(db: Db, llave: Llave, items: ItemInput[]) {
  const ctx: Ctx = { company: llave.company_id, actor: `integracion:${llave.name}` };
  return db.tx(async (q) => {
    const out: { ref: string; estado: string; id?: string; pedido?: string | null; error?: string }[] = [];
    for (const it of items) {
      const [cli] = UUID.test(it.cliente)
        ? await q.query<{ id: string }>("select id from partner where id = $1 and company_id = $2 and not archived", [it.cliente, ctx.company])
        : await q.query<{ id: string }>("select id from partner where upper(tax_id) = upper($1) and company_id = $2 and not archived limit 1", [it.cliente, ctx.company]);
      if (!cli) {
        out.push({ ref: it.ref, estado: "error", error: `No hay cliente ${it.cliente} en Sindri` });
        continue;
      }
      const [prod] = UUID.test(it.producto)
        ? await q.query<{ id: string }>("select id from product where id = $1 and company_id = $2", [it.producto, ctx.company])
        : await q.query<{ id: string }>("select id from product where sku = $1 and company_id = $2", [it.producto, ctx.company]);
      if (!prod) {
        out.push({ ref: it.ref, estado: "error", error: `No hay producto ${it.producto} en Sindri` });
        continue;
      }
      if (D(it.cantidad).cmp(0) <= 0) {
        out.push({ ref: it.ref, estado: "error", error: "Cantidad no válida" });
        continue;
      }
      const [cur] = await q.query<{ id: string; state: string; order_number: string | null }>(
        `select b.id, b.state, o.number as order_number from billable_item b left join sales_order o on o.id = b.order_id
         where b.company_id = $1 and b.source = $2 and b.external_ref = $3 for update of b`,
        [ctx.company, llave.name, it.ref],
      );
      const vals = [cli.id, prod.id, it.descripcion, it.fecha, it.cantidad, it.precio ?? null];
      if (!cur) {
        const [row] = await q.query<{ id: string }>(
          `insert into billable_item (company_id, source, external_ref, key_id, partner_id, product_id, description, item_date, quantity, unit_price)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
          [ctx.company, llave.name, it.ref, llave.id, ...vals],
        );
        out.push({ ref: it.ref, estado: "creado", id: row!.id });
      } else if (cur.state === "pending") {
        await q.query(
          `update billable_item set partner_id = $2, product_id = $3, description = $4, item_date = $5, quantity = $6, unit_price = $7, updated_at = now() where id = $1`,
          [cur.id, ...vals],
        );
        out.push({ ref: it.ref, estado: "actualizado", id: cur.id });
      } else {
        out.push({ ref: it.ref, estado: cur.state === "ordered" ? "en_pedido" : "descartado", id: cur.id, pedido: cur.order_number });
      }
    }
    const hechos = out.filter((o) => o.estado === "creado" || o.estado === "actualizado").length;
    if (hechos) await log(q, ctx, "billable_item", null, "upsert", { origen: llave.name, elementos: hechos });
    return out;
  });
}

/** Quitar algo que la app ya no quiere facturar (solo si sigue pendiente). */
export async function withdrawItem(db: Db, llave: Llave, ref: string) {
  const [row] = await db.query<{ state: string }>(
    "select state from billable_item where company_id = $1 and source = $2 and external_ref = $3",
    [llave.company_id, llave.name, ref],
  );
  if (!row) throw notFound("Elemento");
  if (row.state !== "pending") throw new BusinessError("Ya está en un pedido o descartado: se quita desde Sindri", 409);
  await db.query("delete from billable_item where company_id = $1 and source = $2 and external_ref = $3", [llave.company_id, llave.name, ref]);
  return { ok: true };
}

export async function itemStates(q: Queryable, llave: Llave, refs?: string[]) {
  return q.query(
    `select b.external_ref as ref, case b.state when 'pending' then 'pendiente' when 'ordered' then 'en_pedido' else 'descartado' end as estado,
       o.number as pedido, o.state as estado_pedido, b.updated_at
     from billable_item b left join sales_order o on o.id = b.order_id
     where b.company_id = $1 and b.source = $2 and ($3::text[] is null or b.external_ref = any($3))
     order by b.item_date desc limit 2000`,
    [llave.company_id, llave.name, refs?.length ? refs : null],
  );
}

// Por facturar (web) --------------------------------------------------------------------

export async function listPending(q: Queryable, ctx: Ctx, f: { state?: string } = {}) {
  return q.query(
    `select b.*, coalesce(p.trade_name, p.name) as partner_name, pr.sku, pr.name as product_name, pr.uom,
       coalesce(b.unit_price, pp.unit_price, pr.sale_price)::text as price, o.number as order_number,
       round(b.quantity * coalesce(b.unit_price, pp.unit_price, pr.sale_price), 2)::text as amount
     from billable_item b join partner p on p.id = b.partner_id join product pr on pr.id = b.product_id
     left join partner_price pp on pp.partner_id = b.partner_id and pp.product_id = b.product_id
     left join sales_order o on o.id = b.order_id
     where b.company_id = $1 and b.state = $2
     order by partner_name, b.item_date, b.created_at limit 2000`,
    [ctx.company, f.state || "pending"],
  );
}

/** Pasa lo elegido (de un mismo cliente) a un pedido en borrador, una línea por elemento. */
export async function itemsToOrder(db: Db, ctx: Ctx, ids: string[]) {
  const items = await db.query<{ id: string; partner_id: string; product_id: string; quantity: string; unit_price: string | null; description: string; item_date: string; state: string }>(
    "select * from billable_item where company_id = $1 and id = any($2::uuid[]) order by item_date, created_at",
    [ctx.company, ids],
  );
  if (items.length !== ids.length) throw notFound("Elemento por facturar");
  if (items.some((i) => i.state !== "pending")) throw new BusinessError("Alguno ya está en un pedido o descartado", 409);
  const partners = new Set(items.map((i) => i.partner_id));
  if (partners.size !== 1) throw new BusinessError("Elige elementos de un solo cliente: cada pedido es de un cliente", 400);
  const fecha = (d: string) => d.slice(0, 10).split("-").reverse().join("/");
  const order = (await createSalesOrder(db, ctx, {
    partner_id: items[0]!.partner_id,
    notes: "Desde Por facturar",
    lines: items.map((i) => ({
      product_id: i.product_id,
      quantity: i.quantity,
      ...(i.unit_price !== null ? { unit_price: i.unit_price } : {}),
      description: `${fecha(i.item_date)} · ${i.description}`,
    })),
  })) as { id: string; number: string };
  // Si mientras tanto otra persona ya los ha pasado a otro pedido, este se anula.
  const marcados = await db.tx(async (q) => {
    const rows = await q.query(
      "update billable_item set state = 'ordered', order_id = $3, updated_at = now() where company_id = $1 and id = any($2::uuid[]) and state = 'pending' returning id",
      [ctx.company, ids, order.id],
    );
    if (rows.length === ids.length) await log(q, ctx, "billable_item", null, "order", { order: order.number, elementos: ids.length });
    return rows.length;
  });
  if (marcados !== ids.length) {
    await db.query("update billable_item set state = 'pending', order_id = null where order_id = $1", [order.id]);
    await cancelSalesOrder(db, ctx, order.id);
    throw new BusinessError("Alguien acaba de pasar parte de esto a otro pedido: vuelve a cargar la lista", 409);
  }
  return order;
}

export async function discardItems(db: Db, ctx: Ctx, ids: string[], discard: boolean) {
  return db.tx(async (q) => {
    const rows = await q.query(
      `update billable_item set state = $3, updated_at = now() where company_id = $1 and id = any($2::uuid[]) and state = $4 returning id`,
      [ctx.company, ids, discard ? "discarded" : "pending", discard ? "pending" : "discarded"],
    );
    await log(q, ctx, "billable_item", null, discard ? "discard" : "restore", { elementos: rows.length });
    return { cambiados: rows.length };
  });
}

/** Al anular un pedido, lo que venía de Por facturar vuelve a quedar pendiente. */
export async function releaseOrderItems(q: Queryable, orderId: string) {
  await q.query("update billable_item set state = 'pending', order_id = null, updated_at = now() where order_id = $1 and state = 'ordered'", [orderId]);
}

// Rutas ----------------------------------------------------------------------------------

const ItemSchema = z.object({
  ref: z.string().trim().min(1).max(120),
  cliente: z.string().trim().min(1),
  producto: z.string().trim().min(1),
  fecha: z.iso.date(),
  cantidad: z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d+([.,]\d+)?$/.test(v.trim()), "Cantidad no válida").transform((v) => v.replace(",", ".")),
  precio: z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d+([.,]\d+)?$/.test(v.trim()), "Precio no válido").transform((v) => v.replace(",", ".")).nullish(),
  descripcion: z.string().trim().min(1).max(1000),
});
const Ids = z.object({ ids: z.array(z.uuid()).min(1).max(500) });

export function registerIntegracion(app: FastifyInstance, db: Db) {
  // La otra app, con su llave. Solo ve esta parte de la empresa de la llave.
  app.register(
    async (api) => {
      api.addHook("onRequest", async (req, reply) => {
        const h = req.headers.authorization ?? "";
        const key = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
        const [llave] = key
          ? await db.query<Llave>("select id, company_id, name from integration_key where key_hash = $1 and revoked_at is null", [hash(key)])
          : [];
        if (!llave) return reply.status(401).send({ error: "Llave de integración no válida o revocada" });
        (req as FastifyRequest & { llave: Llave }).llave = llave;
        await db.query("update integration_key set last_used_at = now() where id = $1", [llave.id]);
      });
      const llaveDe = (req: FastifyRequest) => (req as FastifyRequest & { llave: Llave }).llave;

      api.get("/yo", async (req) => {
        const l = llaveDe(req);
        const [c] = await db.query("select id, code, name, trade_name, tax_id, demo from company where id = $1", [l.company_id]);
        return { app: l.name, empresa: c };
      });
      api.get<{ Querystring: { q?: string } }>("/clientes", async (req) =>
        db.query(
          `select id, code, name, trade_name, tax_id, email, phone, address, city, postal_code, province, country
           from partner where company_id = $1 and not archived and kind <> 'supplier'
             and ($2::text is null or lower(name) like '%' || lower($2) || '%' or lower(coalesce(trade_name, '')) like '%' || lower($2) || '%' or tax_id ilike $2)
           order by name limit 2000`,
          [llaveDe(req).company_id, req.query.q?.trim() || null],
        ),
      );
      api.get("/productos", async (req) =>
        db.query("select id, sku, name, kind, uom, sale_price, vat_rate from product where company_id = $1 and not archived order by sku", [llaveDe(req).company_id]),
      );
      api.post("/por-facturar", async (req) => {
        const b = z.object({ elementos: z.array(ItemSchema).min(1).max(500) }).parse(req.body);
        return { elementos: await upsertItems(db, llaveDe(req), b.elementos) };
      });
      api.get<{ Querystring: { refs?: string } }>("/por-facturar", async (req) =>
        itemStates(db, llaveDe(req), req.query.refs?.split(",").map((r) => r.trim()).filter(Boolean)),
      );
      api.delete<{ Params: { ref: string } }>("/por-facturar/:ref", async (req) => withdrawItem(db, llaveDe(req), req.params.ref));
    },
    { prefix: "/api/integracion/v1" },
  );

  // Administración: las llaves de la empresa en uso.
  app.get("/api/v1/integraciones/llaves", async (req) => {
    requireAdmin(req);
    return listKeys(db, ctxOf(req));
  });
  app.post("/api/v1/integraciones/llaves", async (req, reply) => {
    requireAdmin(req);
    const b = z.object({ name: z.string().trim().min(2).max(40).regex(/^[a-z0-9][a-z0-9_-]*$/, "Nombre en minúsculas, sin espacios (p. ej. incidencias)") }).parse(req.body);
    return reply.status(201).send(await createKey(db, ctxOf(req), b.name));
  });
  app.delete<{ Params: { id: string } }>("/api/v1/integraciones/llaves/:id", async (req) => {
    requireAdmin(req);
    return revokeKey(db, ctxOf(req), z.uuid().parse(req.params.id));
  });

  // Por facturar (permiso de Pedidos).
  app.get<{ Querystring: { state?: string } }>("/api/v1/por-facturar", async (req) => listPending(db, ctxOf(req), req.query));
  app.post("/api/v1/por-facturar/pedido", async (req, reply) => reply.status(201).send(await itemsToOrder(db, ctxOf(req), Ids.parse(req.body).ids)));
  app.post("/api/v1/por-facturar/descartar", async (req) => discardItems(db, ctxOf(req), Ids.parse(req.body).ids, true));
  app.post("/api/v1/por-facturar/recuperar", async (req) => discardItems(db, ctxOf(req), Ids.parse(req.body).ids, false));
}
