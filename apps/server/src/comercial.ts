/**
 * Comerciales y representantes, y hojas de ruta de reparto.
 * Todo es de la empresa en uso (Ctx).
 */
import { D } from "@sindri/core";
import type { Db, Queryable } from "./db.js";
import { BusinessError, getSalesOrder, log, nextNumber, notFound, type Ctx } from "./services.js";

// Comerciales y representantes ---------------------------------------------------

export interface SalesRepInput {
  code: string;
  name: string;
  kind?: "internal" | "agent";
  user_id?: string | null;
  email?: string | null;
  phone?: string | null;
  zone?: string | null;
  commission_pct?: string;
  tax_id?: string | null;
  active?: boolean;
}
const REP_FIELDS = ["code", "name", "kind", "user_id", "email", "phone", "zone", "commission_pct", "tax_id", "active"] as const;

/** Comerciales con lo que llevan este mes y este año: pedidos, base facturada y comisión. */
export async function listSalesReps(q: Queryable, ctx: Ctx, opts: { all?: boolean } = {}) {
  return q.query(
    `select r.*, u.username,
       (select count(*) from partner p where p.sales_rep_id = r.id and not p.archived)::text as customers,
       (select count(*) from sales_order o where o.sales_rep_id = r.id and o.state in ('draft', 'confirmed'))::text as open_orders,
       (select coalesce(sum(i.untaxed), 0) from invoice i join sales_order o on o.id = i.order_id
          where o.sales_rep_id = r.id and i.state in ('issued', 'paid') and i.issue_date >= date_trunc('month', current_date))::text as billed_month,
       (select coalesce(sum(i.untaxed), 0) from invoice i join sales_order o on o.id = i.order_id
          where o.sales_rep_id = r.id and i.state in ('issued', 'paid') and i.issue_date >= date_trunc('year', current_date))::text as billed_year
     from sales_rep r left join app_user u on u.id = r.user_id
     where r.company_id = $1 and ($2 or r.active) order by r.name`,
    [ctx.company, !!opts.all],
  ).then((rows) =>
    rows.map((r) => ({
      ...r,
      commission_month: D(r.billed_month as string).mul(r.commission_pct as string).div(100).toFixed(2),
      commission_year: D(r.billed_year as string).mul(r.commission_pct as string).div(100).toFixed(2),
    })),
  );
}

export async function createSalesRep(db: Db, ctx: Ctx, r: SalesRepInput) {
  return db.tx(async (q) => {
    const cols = REP_FIELDS.filter((f) => r[f] !== undefined);
    const [row] = await q.query(
      `insert into sales_rep (company_id, ${cols.join(",")}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(",")}) returning *`,
      [ctx.company, ...cols.map((f) => r[f])],
    );
    await log(q, ctx, "sales_rep", row!.id as string, "create", r);
    return row;
  });
}

export async function updateSalesRep(db: Db, ctx: Ctx, id: string, r: Partial<SalesRepInput>) {
  return db.tx(async (q) => {
    const cols = REP_FIELDS.filter((f) => r[f] !== undefined);
    if (!cols.length) throw new BusinessError("Nada que actualizar", 400);
    const [row] = await q.query(
      `update sales_rep set ${cols.map((c, i) => `${c} = $${i + 3}`).join(", ")} where id = $1 and company_id = $2 returning *`,
      [id, ctx.company, ...cols.map((f) => r[f])],
    );
    if (!row) throw notFound("Comercial");
    await log(q, ctx, "sales_rep", id, "update", r);
    return row;
  });
}

// Hojas de ruta --------------------------------------------------------------------

export interface RouteInput {
  route_date?: string;
  driver?: string | null;
  vehicle?: string | null;
  zone?: string | null;
  notes?: string | null;
}

export async function listRoutes(q: Queryable, ctx: Ctx) {
  return q.query(
    `select r.*,
       (select count(*) from delivery_route_stop s where s.route_id = r.id)::text as stops,
       (select count(*) from delivery_route_stop s where s.route_id = r.id and s.state = 'delivered')::text as delivered,
       (select count(*) from delivery_route_stop s where s.route_id = r.id and s.state = 'incident')::text as incidents
     from delivery_route r where r.company_id = $1 order by r.route_date desc, r.number desc limit 300`,
    [ctx.company],
  );
}

/** La hoja de ruta con cada parada: cliente, dirección de entrega, teléfono, horario y mercancía. */
export async function getRoute(q: Queryable, ctx: Ctx, id: string) {
  const [r] = await q.query("select * from delivery_route where id = $1 and company_id = $2", [id, ctx.company]);
  if (!r) throw notFound("Hoja de ruta");
  const stops = await q.query(
    `select s.*, o.number as order_number, o.state as order_state, o.notes as order_notes, o.delivery_date,
       p.name as partner_name, p.trade_name, p.delivery_notes,
       coalesce(a.address, p.address) as address, coalesce(a.city, p.city) as city,
       coalesce(a.postal_code, p.postal_code) as postal_code, coalesce(a.province, p.province) as province,
       coalesce(a.phone, p.phone, p.mobile) as phone, a.schedule, a.label as address_label,
       (select d.number from delivery d where d.order_id = o.id order by d.done_at desc limit 1) as delivery_number,
       (select coalesce(sum(round(l.quantity * l.unit_price * (1 - l.discount_pct/100), 2)), 0) from sales_order_line l where l.order_id = o.id)::text as untaxed
     from delivery_route_stop s join sales_order o on o.id = s.order_id join partner p on p.id = o.partner_id
     left join partner_address a on a.id = o.delivery_address_id
     where s.route_id = $1 order by s.position`,
    [id],
  );
  for (const s of stops)
    s.lines = await q.query(
      `select l.description, l.quantity, pr.uom, pr.sku from sales_order_line l join product pr on pr.id = l.product_id
       where l.order_id = $1 and pr.kind <> 'service' order by l.position`,
      [s.order_id],
    );
  return { ...r, stops } as Record<string, any>;
}

export async function createRoute(db: Db, ctx: Ctx, input: RouteInput & { order_ids?: string[] }) {
  return db.tx(async (q) => {
    const number = await nextNumber(q, ctx, "delivery_route", "HR");
    const [r] = await q.query<{ id: string }>(
      "insert into delivery_route (company_id, number, route_date, driver, vehicle, zone, notes) values ($1,$2,coalesce($3::date, current_date),$4,$5,$6,$7) returning id",
      [ctx.company, number, input.route_date ?? null, input.driver ?? null, input.vehicle ?? null, input.zone ?? null, input.notes ?? null],
    );
    await log(q, ctx, "delivery_route", r!.id, "create", { number });
    for (const o of input.order_ids ?? []) await addStopTx(q, ctx, r!.id, o);
    return getRoute(q, ctx, r!.id);
  });
}

async function openRoute(q: Queryable, ctx: Ctx, id: string, states = ["draft"]) {
  const [r] = await q.query<{ state: string }>("select state from delivery_route where id = $1 and company_id = $2 for update", [id, ctx.company]);
  if (!r) throw notFound("Hoja de ruta");
  if (!states.includes(r.state))
    throw new BusinessError(r.state === "closed" ? "La hoja de ruta está cerrada" : "La hoja de ruta ya ha salido: no se cambian sus paradas", 409);
  return r;
}

export async function updateRoute(db: Db, ctx: Ctx, id: string, input: RouteInput) {
  return db.tx(async (q) => {
    await openRoute(q, ctx, id, ["draft", "on_route"]);
    const fields = (["route_date", "driver", "vehicle", "zone", "notes"] as const).filter((f) => input[f] !== undefined);
    if (fields.length)
      await q.query(`update delivery_route set ${fields.map((f, i) => `${f} = $${i + 2}`).join(", ")} where id = $1`, [id, ...fields.map((f) => input[f])]);
    await log(q, ctx, "delivery_route", id, "update", input);
    return getRoute(q, ctx, id);
  });
}

async function addStopTx(q: Queryable, ctx: Ctx, routeId: string, orderId: string) {
  const o = await getSalesOrder(q, ctx, orderId);
  if (!["confirmed", "delivered"].includes(o.state)) throw new BusinessError(`El pedido ${o.number} no está listo para repartir (tiene que estar confirmado o entregado)`);
  const [busy] = await q.query<{ number: string }>(
    `select r.number from delivery_route_stop s join delivery_route r on r.id = s.route_id
     where s.order_id = $1 and r.state <> 'closed' and r.id <> $2 limit 1`,
    [orderId, routeId],
  );
  if (busy) throw new BusinessError(`El pedido ${o.number} ya va en la hoja de ruta ${busy.number}`, 409);
  const [{ n }] = (await q.query<{ n: number }>("select coalesce(max(position), 0) + 1 as n from delivery_route_stop where route_id = $1", [routeId])) as [{ n: number }];
  await q.query("insert into delivery_route_stop (route_id, position, order_id) values ($1,$2,$3) on conflict (route_id, order_id) do nothing", [routeId, n, orderId]);
}

export async function addStops(db: Db, ctx: Ctx, routeId: string, orderIds: string[]) {
  return db.tx(async (q) => {
    await openRoute(q, ctx, routeId);
    for (const o of orderIds) await addStopTx(q, ctx, routeId, o);
    await log(q, ctx, "delivery_route", routeId, "stops.add", { orders: orderIds });
    return getRoute(q, ctx, routeId);
  });
}

export async function removeStop(db: Db, ctx: Ctx, routeId: string, stopId: string) {
  return db.tx(async (q) => {
    await openRoute(q, ctx, routeId);
    await q.query("delete from delivery_route_stop where id = $1 and route_id = $2", [stopId, routeId]);
    await renumber(q, routeId);
    await log(q, ctx, "delivery_route", routeId, "stops.remove", { stop: stopId });
    return getRoute(q, ctx, routeId);
  });
}

async function renumber(q: Queryable, routeId: string, order?: string[]) {
  const ids = order ?? (await q.query<{ id: string }>("select id from delivery_route_stop where route_id = $1 order by position", [routeId])).map((s) => s.id);
  // Dos pasos para no chocar con posiciones repetidas a medias.
  for (let i = 0; i < ids.length; i++) await q.query("update delivery_route_stop set position = $3 where id = $1 and route_id = $2", [ids[i], routeId, 1000 + i]);
  for (let i = 0; i < ids.length; i++) await q.query("update delivery_route_stop set position = $3 where id = $1 and route_id = $2", [ids[i], routeId, i + 1]);
}

/** Orden de reparto: la lista entera de paradas en el orden nuevo. */
export async function reorderStops(db: Db, ctx: Ctx, routeId: string, stopIds: string[]) {
  return db.tx(async (q) => {
    await openRoute(q, ctx, routeId, ["draft", "on_route"]);
    const current = (await q.query<{ id: string }>("select id from delivery_route_stop where route_id = $1", [routeId])).map((s) => s.id);
    if (current.length !== stopIds.length || !current.every((id) => stopIds.includes(id)))
      throw new BusinessError("El orden tiene que incluir todas las paradas de la hoja, una vez cada una");
    await renumber(q, routeId, stopIds);
    await log(q, ctx, "delivery_route", routeId, "stops.reorder");
    return getRoute(q, ctx, routeId);
  });
}

export async function startRoute(db: Db, ctx: Ctx, id: string) {
  return db.tx(async (q) => {
    await openRoute(q, ctx, id);
    const [{ n }] = (await q.query<{ n: string }>("select count(*)::text as n from delivery_route_stop where route_id = $1", [id])) as [{ n: string }];
    if (n === "0") throw new BusinessError("La hoja de ruta no tiene paradas");
    await q.query("update delivery_route set state = 'on_route' where id = $1", [id]);
    await log(q, ctx, "delivery_route", id, "start");
    return getRoute(q, ctx, id);
  });
}

/** Lo que pasa en cada parada: entregado o incidencia, con nota (quién firma, qué faltó...). */
export async function setStopState(db: Db, ctx: Ctx, routeId: string, stopId: string, input: { state: "pending" | "delivered" | "incident"; note?: string | null }) {
  return db.tx(async (q) => {
    await openRoute(q, ctx, routeId, ["on_route"]);
    const [s] = await q.query(
      "update delivery_route_stop set state = $3, note = $4, done_at = case when $3 = 'pending' then null else now() end where id = $1 and route_id = $2 returning id",
      [stopId, routeId, input.state, input.note ?? null],
    );
    if (!s) throw notFound("Parada");
    await log(q, ctx, "delivery_route", routeId, "stop.state", { stop: stopId, ...input });
    return getRoute(q, ctx, routeId);
  });
}

export async function closeRoute(db: Db, ctx: Ctx, id: string) {
  return db.tx(async (q) => {
    await openRoute(q, ctx, id, ["on_route"]);
    const [p] = await q.query("select 1 from delivery_route_stop where route_id = $1 and state = 'pending' limit 1", [id]);
    if (p) throw new BusinessError("Quedan paradas sin marcar: pon entregado o incidencia en cada una");
    await q.query("update delivery_route set state = 'closed' where id = $1", [id]);
    await log(q, ctx, "delivery_route", id, "close");
    return getRoute(q, ctx, id);
  });
}

/** Pedidos que se pueden meter en una hoja de ruta: confirmados o entregados y sin hoja abierta. */
export async function routeCandidates(q: Queryable, ctx: Ctx) {
  return q.query(
    `select o.id, o.number, o.state, o.delivery_date, p.name as partner_name, coalesce(a.city, p.city) as city, p.route_zone
     from sales_order o join partner p on p.id = o.partner_id left join partner_address a on a.id = o.delivery_address_id
     where o.company_id = $1 and o.state in ('confirmed', 'delivered')
       and not exists (select 1 from delivery_route_stop s join delivery_route r on r.id = s.route_id where s.order_id = o.id and r.state <> 'closed')
     order by o.delivery_date nulls last, p.route_zone nulls last, o.number`,
    [ctx.company],
  );
}
