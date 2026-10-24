/**
 * Almacén con PDA (fase 2, docs/PDA.md §9): ubicaciones, traspasos y recuentos a ciegas.
 *
 * Todo sigue saliendo del libro de movimientos (`stock_move`), que nunca se modifica: un traspaso
 * es un movimiento entre dos ubicaciones internas y un ajuste de recuento, un movimiento desde o
 * hacia «Ajustes de inventario».
 */
import { D, Dec } from "@sindri/core";
import type { Db, Queryable } from "./db.js";
import { BusinessError, OWN_LOCATION, internalLocationId, locationId, lockProduct, log, nextNumber, notFound, type Ctx } from "./services.js";

// Ubicaciones -------------------------------------------------------------------------

export interface LocationInput {
  code: string;
  name?: string;
  /** Código de la ubicación de la que cuelga. Por defecto, el almacén principal (WH/STOCK). */
  parent_code?: string;
}

/** Ubicación interna nueva (estantería, hueco…). El código es lo que lleva su etiqueta. */
export async function createLocation(db: Db, ctx: Ctx, input: LocationInput) {
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9./_-]{0,39}$/.test(code)) throw new BusinessError("Código de ubicación: letras, números y . / - _ (hasta 40)");
  return db.tx(async (q) => {
    const parent = input.parent_code ? await internalLocationId(q, ctx, input.parent_code) : await locationId(q, ctx, "WH/STOCK");
    const [ya] = await q.query("select 1 from location l where upper(l.code) = $1 and " + OWN_LOCATION("l", "$2"), [code, ctx.company]);
    if (ya) throw new BusinessError(`Ya hay una ubicación ${code}`, 409);
    const [l] = await q.query<{ id: string }>(
      "insert into location (code, name, kind, parent_id, company_id) values ($1, $2, 'internal', $3, $4) returning *",
      [code, input.name?.trim() || code, parent, ctx.company],
    );
    await log(q, ctx, "location", l!.id, "create", input);
    return l;
  });
}

/** La ubicación y todas las que cuelgan de ella. */
async function underLocation(q: Queryable, rootId: string): Promise<string[]> {
  const rows = await q.query<{ id: string }>(
    `with recursive t as (select id from location where id = $1
                          union all select l.id from location l join t on l.parent_id = t.id)
     select id from t`,
    [rootId],
  );
  return rows.map((r) => r.id);
}

/** Lote de un producto por su código. Con `crear`, si no existe se da de alta (un recuento encuentra un lote nuevo). */
async function lotFor(q: Queryable, product: { id: string; track_lots: boolean; sku: string }, code: string | undefined, crear = false) {
  if (!product.track_lots) return null;
  if (!code) throw new BusinessError(`${product.sku} lleva lote: hay que leerlo`);
  const [lot] = crear
    ? await q.query<{ id: string }>(
        "insert into lot (product_id, code) values ($1, $2) on conflict (product_id, code) do update set code = excluded.code returning id",
        [product.id, code],
      )
    : await q.query<{ id: string }>("select id from lot where product_id = $1 and code = $2", [product.id, code]);
  if (!lot) throw new BusinessError(`${product.sku}: el lote ${code} no existe en Sindri`);
  return lot.id;
}

async function productFor(q: Queryable, ctx: Ctx, id: string) {
  const [p] = await q.query<{ id: string; track_lots: boolean; sku: string; kind: string; cost_price: string }>(
    "select id, track_lots, sku, kind, cost_price from product where id = $1 and company_id = maestro($2)",
    [id, ctx.company],
  );
  if (!p) throw notFound("Producto");
  if (p.kind === "service") throw new BusinessError("Los servicios no tienen stock");
  return p;
}

async function balance(q: Queryable, productId: string, lotId: string | null, locId: string): Promise<Dec> {
  const [r] = await q.query<{ qty: string | null }>(
    "select sum(quantity) as qty from stock_balance where product_id = $1 and location_id = $2 and lot_id is not distinct from $3",
    [productId, locId, lotId],
  );
  return D(r?.qty ?? "0");
}

// Traspasos ---------------------------------------------------------------------------

export interface TransferInput {
  /** Id del movimiento, puesto por la PDA: repetirlo no duplica. */
  id?: string;
  product_id: string;
  quantity: string;
  lot_code?: string;
  from_location_code: string;
  to_location_code: string;
  note?: string;
}

/** Mover existencias entre dos ubicaciones del almacén (ubicar, reponer, reordenar). */
export async function transferStock(db: Db, ctx: Ctx, t: TransferInput) {
  const cantidad = D(t.quantity);
  if (cantidad.cmp(0) <= 0) throw new BusinessError("La cantidad debe ser mayor que cero");
  return db.tx(async (q) => {
    if (t.id) {
      const [ya] = await q.query<{ product_id: string; reference_type: string; created_by: string }>("select * from stock_move where id = $1", [t.id]);
      if (ya) {
        if (ya.product_id !== t.product_id || ya.reference_type !== "transfer") throw new BusinessError("Ese id de movimiento ya se usó para otra cosa", 409);
        return { ...ya, repetido: true };
      }
    }
    const p = await productFor(q, ctx, t.product_id);
    const from = await internalLocationId(q, ctx, t.from_location_code);
    const to = await internalLocationId(q, ctx, t.to_location_code);
    if (from === to) throw new BusinessError("El origen y el destino son la misma ubicación");
    await lockProduct(q, p.id);
    const lotId = await lotFor(q, p, t.lot_code);
    const hay = await balance(q, p.id, lotId, from);
    if (hay.cmp(cantidad) < 0)
      throw new BusinessError(`En ${t.from_location_code.toUpperCase()} hay ${hay.toFixed()} de ${p.sku}${t.lot_code ? ` lote ${t.lot_code}` : ""} y se quieren mover ${cantidad.toFixed()}`);
    const [m] = await q.query(
      `insert into stock_move (id, product_id, lot_id, from_location_id, to_location_id, quantity, reference_type, note, created_by)
       values (coalesce($8::uuid, gen_random_uuid()), $1,$2,$3,$4,$5,'transfer',$6,$7) returning *`,
      [p.id, lotId, from, to, cantidad.toFixed(), t.note ?? null, ctx.actor, t.id ?? null],
    );
    await log(q, ctx, "stock_move", m!.id as string, "transfer", t);
    return m;
  });
}

// Recuentos ---------------------------------------------------------------------------

export async function listCounts(q: Queryable, ctx: Ctx, state?: string) {
  return q.query(
    `select c.*, l.code as location_code,
            (select count(*) from stock_count_entry e where e.count_id = c.id)::int as entries
       from stock_count c left join location l on l.id = c.location_id
      where c.company_id = $1 and ($2::text is null or c.state = $2 or ($2 = 'activos' and c.state in ('open', 'counted')))
      order by c.created_at desc limit 200`,
    [ctx.company, state ?? null],
  );
}

export async function createCount(db: Db, ctx: Ctx, input: { location_code?: string; note?: string }) {
  return db.tx(async (q) => {
    const loc = input.location_code ? await internalLocationId(q, ctx, input.location_code) : null;
    const number = await nextNumber(q, ctx, "stock_count", "INV");
    const [c] = await q.query<{ id: string }>(
      "insert into stock_count (company_id, number, location_id, note, created_by) values ($1,$2,$3,$4,$5) returning id",
      [ctx.company, number, loc, input.note ?? null, ctx.actor],
    );
    await log(q, ctx, "stock_count", c!.id, "create", input);
    return getCount(q, ctx, c!.id);
  });
}

interface Fila {
  product_id: string;
  sku: string;
  product_name: string;
  uom: string;
  lot_id: string | null;
  lot_code: string | null;
  location_id: string;
  location_code: string;
  expected?: string;
  counted: string;
  difference?: string;
}

/** Lo esperado (según Sindri) frente a lo contado, en las ubicaciones del recuento. */
async function differences(q: Queryable, ctx: Ctx, c: { id: string; location_id: string | null }): Promise<Fila[]> {
  const ambito = c.location_id
    ? await underLocation(q, c.location_id)
    : (await q.query<{ id: string }>(`select l.id from location l where ${OWN_LOCATION("l", "$1")}`, [ctx.company])).map((r) => r.id);
  return q.query<Fila>(
    `with esperado as (
       select product_id, lot_id, location_id, quantity from stock_balance where location_id = any($2::uuid[])
     ), contado as (
       select product_id, lot_id, location_id, sum(quantity) as quantity from stock_count_entry where count_id = $1
       group by product_id, lot_id, location_id
     )
     select coalesce(e.product_id, k.product_id) as product_id, p.sku, p.name as product_name, p.uom,
            coalesce(e.lot_id, k.lot_id) as lot_id, lot.code as lot_code,
            coalesce(e.location_id, k.location_id) as location_id, l.code as location_code,
            coalesce(e.quantity, 0)::text as expected, coalesce(k.quantity, 0)::text as counted,
            (coalesce(k.quantity, 0) - coalesce(e.quantity, 0))::text as difference
       from esperado e
       full join contado k on k.product_id = e.product_id and k.lot_id is not distinct from e.lot_id and k.location_id = e.location_id
       join product p on p.id = coalesce(e.product_id, k.product_id)
       join location l on l.id = coalesce(e.location_id, k.location_id)
       left join lot on lot.id = coalesce(e.lot_id, k.lot_id)
      order by l.code, p.sku, lot.code`,
    [c.id, ambito],
  );
}

/**
 * El recuento con sus líneas. Mientras está abierto es **a ciegas**: solo se ve lo contado, no lo
 * que dice Sindri (si no, se tiende a «contar» lo que pone la pantalla).
 */
export async function getCount(q: Queryable, ctx: Ctx, id: string) {
  const [c] = await q.query<{ id: string; state: string; location_id: string | null }>(
    "select c.*, l.code as location_code from stock_count c left join location l on l.id = c.location_id where c.id = $1 and c.company_id = $2",
    [id, ctx.company],
  );
  if (!c) throw notFound("Recuento");
  let lines: Fila[];
  if (c.state === "approved")
    lines = await q.query<Fila>(
      `select s.product_id, p.sku, p.name as product_name, p.uom, s.lot_id, lot.code as lot_code, s.location_id, l.code as location_code,
              s.expected::text, s.counted::text, s.difference::text
         from stock_count_line s join product p on p.id = s.product_id join location l on l.id = s.location_id left join lot on lot.id = s.lot_id
        where s.count_id = $1 order by l.code, p.sku, lot.code`,
      [id],
    );
  else if (c.state === "counted") lines = await differences(q, ctx, c);
  else
    lines = await q.query<Fila>(
      `select e.product_id, p.sku, p.name as product_name, p.uom, e.lot_id, lot.code as lot_code, e.location_id, l.code as location_code,
              sum(e.quantity)::text as counted
         from stock_count_entry e join product p on p.id = e.product_id join location l on l.id = e.location_id left join lot on lot.id = e.lot_id
        where e.count_id = $1 group by e.product_id, p.sku, p.name, p.uom, e.lot_id, lot.code, e.location_id, l.code
        order by l.code, p.sku, lot.code`,
      [id],
    );
  return { ...c, lines };
}

async function countFor(q: Queryable, ctx: Ctx, id: string, estados: string[]) {
  const [c] = await q.query<{ id: string; state: string; location_id: string | null; number: string }>(
    "select * from stock_count where id = $1 and company_id = $2 for update",
    [id, ctx.company],
  );
  if (!c) throw notFound("Recuento");
  if (!estados.includes(c.state))
    throw new BusinessError(
      { open: "El recuento sigue abierto", counted: "El recuento ya está terminado", approved: "El recuento ya está aprobado", cancelled: "El recuento está anulado" }[c.state] ?? "Estado no válido",
      409,
    );
  return c;
}

export interface CountEntryInput {
  /** Id de la lectura, puesto por la PDA: reenviarla no la cuenta dos veces. */
  id: string;
  product_id: string;
  quantity: string;
  lot_code?: string;
  location_code: string;
}

/** Una lectura del recuento: «en esta ubicación hay N de este producto y lote». Se suman. */
export async function addCountEntry(db: Db, ctx: Ctx, countId: string, e: CountEntryInput) {
  if (D(e.quantity).cmp(0) < 0) throw new BusinessError("La cantidad no puede ser negativa");
  return db.tx(async (q) => {
    const [ya] = await q.query<{ count_id: string; product_id: string }>("select * from stock_count_entry where id = $1", [e.id]);
    if (ya) {
      if (ya.count_id !== countId || ya.product_id !== e.product_id) throw new BusinessError("Ese id de lectura ya se usó para otra cosa", 409);
      return { ...ya, repetido: true };
    }
    const c = await countFor(q, ctx, countId, ["open"]);
    const p = await productFor(q, ctx, e.product_id);
    const loc = await internalLocationId(q, ctx, e.location_code);
    if (c.location_id && !(await underLocation(q, c.location_id)).includes(loc))
      throw new BusinessError(`${e.location_code.toUpperCase()} no entra en este recuento`);
    const lotId = await lotFor(q, p, e.lot_code, true);
    const [r] = await q.query(
      "insert into stock_count_entry (id, count_id, product_id, lot_id, location_id, quantity, counted_by) values ($1,$2,$3,$4,$5,$6,$7) returning *",
      [e.id, countId, p.id, lotId, loc, D(e.quantity).toFixed(), ctx.actor],
    );
    return r;
  });
}

/** Terminar de contar: a partir de aquí se ven las diferencias y ya no se admiten lecturas. */
export async function finishCount(db: Db, ctx: Ctx, id: string) {
  return db.tx(async (q) => {
    await countFor(q, ctx, id, ["open"]);
    await q.query("update stock_count set state = 'counted', counted_at = now() where id = $1", [id]);
    await log(q, ctx, "stock_count", id, "finish", {});
    return getCount(q, ctx, id);
  });
}

/** Volver a abrir un recuento terminado (falta contar algo). */
export async function reopenCount(db: Db, ctx: Ctx, id: string) {
  return db.tx(async (q) => {
    await countFor(q, ctx, id, ["counted"]);
    await q.query("update stock_count set state = 'open', counted_at = null where id = $1", [id]);
    await log(q, ctx, "stock_count", id, "reopen", {});
    return getCount(q, ctx, id);
  });
}

/**
 * Aprobar: se guardan las diferencias y cada una se convierte en un movimiento de ajuste. Lo que
 * Sindri tenía en esas ubicaciones y no se ha contado, se da por cero: un recuento de una ubicación
 * es de todo lo que hay en ella.
 */
export async function approveCount(db: Db, ctx: Ctx, id: string) {
  return db.tx(async (q) => {
    const c = await countFor(q, ctx, id, ["counted"]);
    const adjust = await locationId(q, ctx, "VIRTUAL/ADJUST");
    const filas = await differences(q, ctx, c);
    for (const f of filas) await lockProduct(q, f.product_id);
    let ajustes = 0;
    for (const f of filas) {
      await q.query(
        "insert into stock_count_line (count_id, product_id, lot_id, location_id, expected, counted, difference) values ($1,$2,$3,$4,$5,$6,$7)",
        [id, f.product_id, f.lot_id, f.location_id, f.expected, f.counted, f.difference],
      );
      const d = D(f.difference!);
      if (d.isZero()) continue;
      const sobra = d.cmp(0) > 0;
      await q.query(
        `insert into stock_move (product_id, lot_id, from_location_id, to_location_id, quantity, unit_cost, reference_type, reference_id, note, created_by)
         values ($1,$2,$3,$4,$5,(select cost_price from product where id = $1),'stock_count',$6,$7,$8)`,
        [f.product_id, f.lot_id, sobra ? adjust : f.location_id, sobra ? f.location_id : adjust, d.abs().toFixed(), id, `Recuento ${c.number}`, ctx.actor],
      );
      ajustes++;
    }
    await q.query("update stock_count set state = 'approved', approved_by = $2, approved_at = now() where id = $1", [id, ctx.actor]);
    await log(q, ctx, "stock_count", id, "approve", { ajustes });
    return getCount(q, ctx, id);
  });
}

export async function cancelCount(db: Db, ctx: Ctx, id: string) {
  return db.tx(async (q) => {
    await countFor(q, ctx, id, ["open", "counted"]);
    await q.query("update stock_count set state = 'cancelled' where id = $1", [id]);
    await log(q, ctx, "stock_count", id, "cancel", {});
    return getCount(q, ctx, id);
  });
}
