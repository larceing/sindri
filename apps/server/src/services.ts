/**
 * Lógica de negocio. Cada operación que cambia datos va dentro de una transacción y
 * deja rastro en event_log. Las reglas de estados vienen de @ergane/core.
 */
import { D, Dec, computeTotals, isValidSpanishTaxId, InvoiceMachine, SalesOrderMachine, SURCHARGE_FOR_VAT } from "@ergane/core";
import type { InvoiceState, SalesOrderState } from "@ergane/core";
import { altaHash, isoWithOffset, qrUrl, verifyChain } from "@ergane/core/verifactu";
import type { Db, Queryable } from "./db.js";

export class BusinessError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = "BusinessError";
  }
}

const notFound = (what: string) => new BusinessError(`${what} no encontrado`, 404);

async function log(q: Queryable, entity: string, entityId: string | null, action: string, data?: unknown) {
  await q.query("insert into event_log (entity, entity_id, action, data) values ($1, $2, $3, $4)", [
    entity,
    entityId,
    action,
    data === undefined ? null : JSON.stringify(data),
  ]);
}

/** Siguiente número de una serie, sin huecos: si la transacción falla, el número no se consume. */
export async function nextNumber(q: Queryable, code: string, prefix: string, date = new Date()): Promise<string> {
  const year = date.getFullYear();
  await q.query(
    "insert into sequence (code, year, prefix) values ($1, $2, $3) on conflict (code, year) do nothing",
    [code, year, prefix],
  );
  const [row] = await q.query<{ n: number; prefix: string; padding: number }>(
    "update sequence set next_number = next_number + 1 where code = $1 and year = $2 returning next_number - 1 as n, prefix, padding",
    [code, year],
  );
  return `${row!.prefix}${year}-${String(row!.n).padStart(row!.padding, "0")}`;
}

// Empresa ----------------------------------------------------------------------

export interface CompanyInput {
  name: string;
  tax_id: string;
  address?: string;
  city?: string;
  postal_code?: string;
  gs1_prefix?: string;
}

export async function getCompany(q: Queryable) {
  const [c] = await q.query("select * from company order by created_at limit 1");
  return c ?? null;
}

export async function setupCompany(db: Db, input: CompanyInput) {
  if (!isValidSpanishTaxId(input.tax_id)) throw new BusinessError("NIF de la empresa no válido");
  return db.tx(async (q) => {
    const existing = await getCompany(q);
    if (existing) {
      const [c] = await q.query(
        "update company set name=$2, address=$3, city=$4, postal_code=$5, gs1_prefix=$6 where id=$1 returning *",
        [existing.id, input.name, input.address ?? null, input.city ?? null, input.postal_code ?? null, input.gs1_prefix ?? null],
      );
      if ((existing as { tax_id: string }).tax_id !== input.tax_id.toUpperCase())
        throw new BusinessError("El NIF de la empresa no se puede cambiar una vez creada");
      await log(q, "company", existing.id as string, "update", input);
      return c;
    }
    const [c] = await q.query(
      "insert into company (name, tax_id, address, city, postal_code, gs1_prefix) values ($1,$2,$3,$4,$5,$6) returning *",
      [input.name, input.tax_id.toUpperCase(), input.address ?? null, input.city ?? null, input.postal_code ?? null, input.gs1_prefix ?? null],
    );
    await log(q, "company", c!.id as string, "create", input);
    return c;
  });
}

// Terceros ---------------------------------------------------------------------

export interface PartnerInput {
  kind?: "customer" | "supplier" | "both";
  name: string;
  tax_id?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  postal_code?: string | null;
  country?: string;
  surcharge_regime?: boolean;
  withholding_rate?: string;
  notes?: string | null;
}

const PARTNER_FIELDS = [
  "kind", "name", "tax_id", "email", "phone", "address", "city", "postal_code", "country",
  "surcharge_regime", "withholding_rate", "notes",
] as const;

function checkPartner(p: Partial<PartnerInput>) {
  if (p.tax_id && (p.country ?? "ES") === "ES" && !isValidSpanishTaxId(p.tax_id))
    throw new BusinessError(`NIF no válido: ${p.tax_id}`);
}

export async function listPartners(q: Queryable, search?: string) {
  return q.query(
    "select * from partner where not archived and ($1::text is null or lower(name) like '%' || lower($1) || '%' or tax_id ilike $1) order by name limit 500",
    [search ?? null],
  );
}

export async function createPartner(db: Db, p: PartnerInput) {
  checkPartner(p);
  return db.tx(async (q) => {
    const cols = PARTNER_FIELDS.filter((f) => p[f] !== undefined);
    const vals = cols.map((f) => (f === "tax_id" && p.tax_id ? p.tax_id.toUpperCase() : p[f]));
    const [row] = await q.query(
      `insert into partner (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
      vals,
    );
    await log(q, "partner", row!.id as string, "create", p);
    return row;
  });
}

export async function updatePartner(db: Db, id: string, p: Partial<PartnerInput>) {
  checkPartner(p);
  return db.tx(async (q) => {
    const cols = PARTNER_FIELDS.filter((f) => p[f] !== undefined);
    if (!cols.length) throw new BusinessError("Nada que actualizar", 400);
    const [row] = await q.query(
      `update partner set ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} where id = $1 returning *`,
      [id, ...cols.map((f) => p[f])],
    );
    if (!row) throw notFound("Tercero");
    await log(q, "partner", id, "update", p);
    return row;
  });
}

// Productos --------------------------------------------------------------------

export interface ProductInput {
  sku: string;
  name: string;
  kind?: "stockable" | "consumable" | "service";
  uom?: string;
  gtin?: string | null;
  sale_price?: string;
  cost_price?: string;
  vat_rate?: string;
  track_lots?: boolean;
}
const PRODUCT_FIELDS = ["sku", "name", "kind", "uom", "gtin", "sale_price", "cost_price", "vat_rate", "track_lots"] as const;

export async function listProducts(q: Queryable, search?: string) {
  return q.query(
    `select p.*, coalesce((select sum(b.quantity) from stock_balance b where b.product_id = p.id), 0)::text as on_hand
     from product p where not archived and ($1::text is null or p.sku ilike '%'||$1||'%' or lower(p.name) like '%'||lower($1)||'%')
     order by p.sku limit 500`,
    [search ?? null],
  );
}

export async function createProduct(db: Db, p: ProductInput) {
  return db.tx(async (q) => {
    const cols = PRODUCT_FIELDS.filter((f) => p[f] !== undefined);
    const [row] = await q.query(
      `insert into product (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
      cols.map((f) => p[f]),
    );
    await log(q, "product", row!.id as string, "create", p);
    return row;
  });
}

export async function updateProduct(db: Db, id: string, p: Partial<ProductInput>) {
  return db.tx(async (q) => {
    const cols = PRODUCT_FIELDS.filter((f) => p[f] !== undefined);
    if (!cols.length) throw new BusinessError("Nada que actualizar", 400);
    const [row] = await q.query(
      `update product set ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} where id = $1 returning *`,
      [id, ...cols.map((f) => p[f])],
    );
    if (!row) throw notFound("Producto");
    await log(q, "product", id, "update", p);
    return row;
  });
}

// Stock ------------------------------------------------------------------------

async function locationId(q: Queryable, code: string): Promise<string> {
  const [l] = await q.query<{ id: string }>("select id from location where code = $1", [code]);
  if (!l) throw notFound(`Ubicación ${code}`);
  return l.id;
}

async function lockProduct(q: Queryable, productId: string) {
  // Bloqueo por producto mientras dure la transacción: evita vender dos veces la misma unidad.
  // Clave de 64 bits derivada del UUID (hashtext es de 32 bits y podría colisionar entre productos).
  await q.query("select pg_advisory_xact_lock(('x' || substr(md5($1), 1, 16))::bit(64)::bigint)", [productId]);
}

export async function available(q: Queryable, productId: string, locId: string, lotId: string | null = null): Promise<Dec> {
  const [r] = await q.query<{ qty: string | null }>(
    "select sum(quantity) as qty from stock_balance where product_id = $1 and location_id = $2 and ($3::uuid is null or lot_id = $3)",
    [productId, locId, lotId],
  );
  return D(r?.qty ?? "0");
}

export async function listLocations(q: Queryable) {
  return q.query("select * from location order by kind, code");
}

export async function stockBalances(q: Queryable) {
  return q.query(
    `select b.product_id, p.sku, p.name as product_name, p.uom, b.lot_id, lot.code as lot_code, lot.expiry_date,
            l.code as location_code, b.quantity
     from stock_balance b join product p on p.id = b.product_id join location l on l.id = b.location_id
     left join lot on lot.id = b.lot_id order by p.sku, lot.code`,
  );
}

export async function listMoves(q: Queryable, productId?: string) {
  return q.query(
    `select m.*, p.sku, f.code as from_code, t.code as to_code, lot.code as lot_code
     from stock_move m join product p on p.id = m.product_id join location f on f.id = m.from_location_id
     join location t on t.id = m.to_location_id left join lot on lot.id = m.lot_id
     where ($1::uuid is null or m.product_id = $1) order by m.done_at desc limit 500`,
    [productId ?? null],
  );
}

export interface ReceiptInput {
  product_id: string;
  quantity: string;
  unit_cost?: string;
  lot_code?: string;
  expiry_date?: string;
  /** "receipt" (de proveedor) o "adjustment" (regularización de inventario). */
  origin?: "receipt" | "adjustment";
  location_code?: string;
  note?: string;
}

/** Entrada de mercancía o ajuste positivo de inventario. */
export async function receiveStock(db: Db, r: ReceiptInput) {
  if (D(r.quantity).cmp(0) <= 0) throw new BusinessError("La cantidad debe ser mayor que cero");
  return db.tx(async (q) => {
    const [p] = await q.query<{ id: string; track_lots: boolean; kind: string }>("select * from product where id = $1", [r.product_id]);
    if (!p) throw notFound("Producto");
    if (p.kind === "service") throw new BusinessError("Los servicios no tienen stock");
    let lotId: string | null = null;
    if (p.track_lots) {
      if (!r.lot_code) throw new BusinessError("Este producto exige lote");
      const [lot] = await q.query<{ id: string }>(
        `insert into lot (product_id, code, expiry_date) values ($1, $2, $3)
         on conflict (product_id, code) do update set expiry_date = coalesce(excluded.expiry_date, lot.expiry_date) returning id`,
        [p.id, r.lot_code, r.expiry_date ?? null],
      );
      lotId = lot!.id;
    }
    const from = await locationId(q, r.origin === "adjustment" ? "VIRTUAL/ADJUST" : "PARTNER/SUPPLIER");
    const to = await locationId(q, r.location_code ?? "WH/STOCK");
    const [m] = await q.query(
      `insert into stock_move (product_id, lot_id, from_location_id, to_location_id, quantity, unit_cost, reference_type, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [p.id, lotId, from, to, D(r.quantity).toFixed(), r.unit_cost ?? null, r.origin ?? "receipt", r.note ?? null],
    );
    await log(q, "stock_move", m!.id as string, "receive", r);
    return m;
  });
}

// Pedidos de venta -------------------------------------------------------------

export interface SalesLineInput {
  product_id: string;
  quantity: string;
  unit_price?: string;
  discount_pct?: string;
  description?: string;
}

export async function listSalesOrders(q: Queryable) {
  return q.query(
    `select o.*, p.name as partner_name,
       (select coalesce(sum(round(l.quantity * l.unit_price * (1 - l.discount_pct/100), 2)), 0) from sales_order_line l where l.order_id = o.id)::text as untaxed
     from sales_order o join partner p on p.id = o.partner_id order by o.created_at desc limit 500`,
  );
}

export async function getSalesOrder(q: Queryable, id: string) {
  const [o] = await q.query("select o.*, p.name as partner_name from sales_order o join partner p on p.id = o.partner_id where o.id = $1", [id]);
  if (!o) throw notFound("Pedido");
  const lines = await q.query(
    "select l.*, pr.sku, pr.uom from sales_order_line l join product pr on pr.id = l.product_id where order_id = $1 order by position",
    [id],
  );
  const [partner] = await q.query<{ surcharge_regime: boolean; withholding_rate: string }>("select * from partner where id = $1", [o.partner_id]);
  const totals = computeTotals(
    lines.map((l) => ({
      quantity: l.quantity as string,
      unitPrice: l.unit_price as string,
      discountPct: l.discount_pct as string,
      vatRate: l.vat_rate as string,
      surchargeRate: partner?.surcharge_regime ? SURCHARGE_FOR_VAT[D(l.vat_rate as string).toFixed()] ?? "0" : "0",
    })),
    partner?.withholding_rate ?? "0",
  );
  const actions = SalesOrderMachine.actions(o.state as SalesOrderState);
  return { ...o, lines, totals, actions } as Record<string, any>;
}

export async function createSalesOrder(db: Db, input: { partner_id: string; order_date?: string; notes?: string; lines: SalesLineInput[] }) {
  if (!input.lines.length) throw new BusinessError("El pedido necesita al menos una línea");
  return db.tx(async (q) => {
    const [partner] = await q.query("select * from partner where id = $1", [input.partner_id]);
    if (!partner) throw notFound("Cliente");
    const number = await nextNumber(q, "sales_order", "PV");
    const [o] = await q.query<{ id: string }>(
      "insert into sales_order (number, partner_id, order_date, notes) values ($1,$2,coalesce($3::date, current_date),$4) returning id",
      [number, input.partner_id, input.order_date ?? null, input.notes ?? null],
    );
    let pos = 1;
    for (const l of input.lines) {
      const [p] = await q.query<{ name: string; sale_price: string; vat_rate: string }>("select * from product where id = $1", [l.product_id]);
      if (!p) throw notFound("Producto");
      if (D(l.quantity).cmp(0) <= 0) throw new BusinessError("Cantidad no válida");
      await q.query(
        `insert into sales_order_line (order_id, position, product_id, description, quantity, unit_price, discount_pct, vat_rate)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [o!.id, pos++, l.product_id, l.description ?? p.name, l.quantity, l.unit_price ?? p.sale_price, l.discount_pct ?? "0", p.vat_rate],
      );
    }
    await log(q, "sales_order", o!.id, "create", { number });
    return getSalesOrder(q, o!.id);
  });
}

async function transitionOrder(q: Queryable, id: string, action: "confirm" | "deliver" | "invoice" | "cancel") {
  const [o] = await q.query<{ state: SalesOrderState }>("select state from sales_order where id = $1 for update", [id]);
  if (!o) throw notFound("Pedido");
  const next = SalesOrderMachine.next(o.state, action);
  await q.query("update sales_order set state = $2 where id = $1", [id, next]);
  await log(q, "sales_order", id, action, { from: o.state, to: next });
}

export async function confirmSalesOrder(db: Db, id: string) {
  return db.tx(async (q) => {
    await transitionOrder(q, id, "confirm");
    return getSalesOrder(q, id);
  });
}

export async function cancelSalesOrder(db: Db, id: string) {
  return db.tx(async (q) => {
    await transitionOrder(q, id, "cancel");
    return getSalesOrder(q, id);
  });
}

/**
 * Entrega completa del pedido: genera el albarán y los movimientos de stock.
 * Consume lotes por FEFO (primero el que caduca antes) y, a igualdad, por antigüedad.
 */
export async function deliverSalesOrder(db: Db, id: string) {
  return db.tx(async (q) => {
    await transitionOrder(q, id, "deliver");
    const stockLoc = await locationId(q, "WH/STOCK");
    const customerLoc = await locationId(q, "PARTNER/CUSTOMER");
    const number = await nextNumber(q, "delivery", "ALB");
    const [del] = await q.query<{ id: string }>(
      "insert into delivery (number, order_id, from_location_id) values ($1,$2,$3) returning id",
      [number, id, stockLoc],
    );
    const lines = await q.query<{ product_id: string; quantity: string; kind: string; track_lots: boolean; sku: string; cost_price: string }>(
      "select l.product_id, l.quantity, p.kind, p.track_lots, p.sku, p.cost_price from sales_order_line l join product p on p.id = l.product_id where l.order_id = $1 order by position",
      [id],
    );
    for (const l of lines) {
      if (l.kind === "service") continue;
      await lockProduct(q, l.product_id);
      let pending = D(l.quantity);
      if (l.kind === "stockable") {
        const total = await available(q, l.product_id, stockLoc);
        if (total.cmp(pending) < 0)
          throw new BusinessError(`Stock insuficiente de ${l.sku}: hay ${total.toFixed()} y se piden ${pending.toFixed()}`);
      }
      const buckets = l.track_lots
        ? await q.query<{ lot_id: string; quantity: string }>(
            `select b.lot_id, b.quantity from stock_balance b join lot on lot.id = b.lot_id
             where b.product_id = $1 and b.location_id = $2 and b.quantity > 0
             order by lot.expiry_date nulls last, lot.created_at`,
            [l.product_id, stockLoc],
          )
        : [{ lot_id: null as unknown as string, quantity: pending.toFixed() }];
      for (const b of buckets) {
        if (pending.isZero()) break;
        const take = D(b.quantity).cmp(pending) < 0 ? D(b.quantity) : pending;
        await q.query(
          `insert into stock_move (product_id, lot_id, from_location_id, to_location_id, quantity, unit_cost, reference_type, reference_id)
           values ($1,$2,$3,$4,$5,$6,'delivery',$7)`,
          [l.product_id, b.lot_id, stockLoc, customerLoc, take.toFixed(), l.cost_price, del!.id],
        );
        pending = pending.sub(take);
      }
      if (!pending.isZero()) throw new BusinessError(`No hay lotes suficientes de ${l.sku}`);
    }
    await log(q, "delivery", del!.id, "create", { number, order_id: id });
    return { delivery: { id: del!.id, number }, order: await getSalesOrder(q, id) };
  });
}

// Facturas ---------------------------------------------------------------------

export async function listInvoices(q: Queryable) {
  return q.query(
    "select i.*, p.name as partner_name from invoice i join partner p on p.id = i.partner_id order by i.created_at desc limit 500",
  );
}

export async function getInvoice(q: Queryable, id: string) {
  const [inv] = await q.query("select i.*, p.name as partner_name from invoice i join partner p on p.id = i.partner_id where i.id = $1", [id]);
  if (!inv) throw notFound("Factura");
  const lines = await q.query("select * from invoice_line where invoice_id = $1 order by position", [id]);
  const payments = await q.query("select * from payment where invoice_id = $1 order by paid_on", [id]);
  const [record] = await q.query("select seq, hash, previous_hash, qr_url, fields from verifactu_record where invoice_id = $1 and kind = 'alta'", [id]);
  const paid = Dec.sum(payments.map((p) => p.amount as string));
  return {
    ...inv,
    lines,
    payments,
    paid: paid.toFixed(2),
    pending: D(inv.amount_due as string).sub(paid).toFixed(2),
    verifactu: record ?? null,
    actions: InvoiceMachine.actions(inv.state as InvoiceState),
  } as Record<string, any>;
}

async function recomputeInvoice(q: Queryable, id: string) {
  const [inv] = await q.query<{ partner_id: string }>("select partner_id from invoice where id = $1", [id]);
  const [partner] = await q.query<{ withholding_rate: string }>("select withholding_rate from partner where id = $1", [inv!.partner_id]);
  const lines = await q.query<Record<string, string>>("select * from invoice_line where invoice_id = $1 order by position", [id]);
  const t = computeTotals(
    lines.map((l) => ({ quantity: l.quantity!, unitPrice: l.unit_price!, discountPct: l.discount_pct, vatRate: l.vat_rate!, surchargeRate: l.surcharge_rate })),
    partner?.withholding_rate ?? "0",
  );
  for (let i = 0; i < lines.length; i++) await q.query("update invoice_line set base = $2 where id = $1", [lines[i]!.id, t.lines[i]!.base]);
  await q.query(
    `update invoice set tax_breakdown=$2, untaxed=$3, vat_total=$4, surcharge_total=$5, withholding=$6, total=$7, amount_due=$8 where id=$1`,
    [id, JSON.stringify(t.breakdown), t.untaxed, t.vatTotal, t.surchargeTotal, t.withholding, t.total, t.amountDue],
  );
}

/** Crea la factura en borrador a partir de un pedido entregado. */
export async function invoiceSalesOrder(db: Db, orderId: string) {
  return db.tx(async (q) => {
    await transitionOrder(q, orderId, "invoice");
    const order = await getSalesOrder(q, orderId);
    const [partner] = await q.query<{ surcharge_regime: boolean }>("select * from partner where id = $1", [order.partner_id]);
    const [inv] = await q.query<{ id: string }>("insert into invoice (partner_id, order_id) values ($1,$2) returning id", [order.partner_id, orderId]);
    let pos = 1;
    for (const l of order.lines as Record<string, string>[]) {
      const sur = partner?.surcharge_regime ? SURCHARGE_FOR_VAT[D(l.vat_rate!).toFixed()] ?? "0" : "0";
      await q.query(
        `insert into invoice_line (invoice_id, position, product_id, description, quantity, unit_price, discount_pct, vat_rate, surcharge_rate, base)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,0)`,
        [inv!.id, pos++, l.product_id, l.description, l.quantity, l.unit_price, l.discount_pct, l.vat_rate, sur],
      );
    }
    await recomputeInvoice(q, inv!.id);
    await log(q, "invoice", inv!.id, "create", { order_id: orderId });
    return getInvoice(q, inv!.id);
  });
}

/**
 * Emitir factura: asigna número de la serie, congela los datos del cliente y genera
 * en la MISMA transacción el registro VERI*FACTU encadenado. No necesita internet:
 * el envío a la AEAT queda en la bandeja de salida (outbox) y se hace cuando haya red.
 */
export async function issueInvoice(db: Db, id: string, opts: { now?: Date; aeatEnv?: "test" | "production" } = {}) {
  return db.tx(async (q) => {
    const company = await getCompany(q);
    if (!company) throw new BusinessError("Configure primero los datos de la empresa");
    const [inv] = await q.query<Record<string, string>>("select * from invoice where id = $1 for update", [id]);
    if (!inv) throw notFound("Factura");
    InvoiceMachine.next(inv.state as InvoiceState, "issue");
    const [partner] = await q.query<Record<string, string>>("select * from partner where id = $1", [inv.partner_id]);
    if (!partner!.tax_id) throw new BusinessError("El cliente necesita NIF para emitir factura completa (F1)");
    if (D(inv.total!).isZero()) throw new BusinessError("La factura no tiene importe");

    const now = opts.now ?? new Date();
    const issueDate = isoWithOffset(now).slice(0, 10);
    const number = await nextNumber(q, `invoice_${inv.series}`, inv.series!, now);
    const snapshot = {
      name: partner!.name, tax_id: partner!.tax_id, address: partner!.address, city: partner!.city,
      postal_code: partner!.postal_code, country: partner!.country,
    };
    await q.query(
      "update invoice set state='issued', number=$2, issue_date=$3, partner_snapshot=$4, issued_at=now() where id=$1",
      [id, number, issueDate, JSON.stringify(snapshot)],
    );

    // Registro VERI*FACTU encadenado al anterior de la empresa.
    await q.query("select pg_advisory_xact_lock(('x' || substr(md5('verifactu:' || $1), 1, 16))::bit(64)::bigint)", [company.id]);
    const [last] = await q.query<{ seq: string; hash: string }>(
      "select seq, hash from verifactu_record where company_id = $1 order by seq desc limit 1",
      [company.id],
    );
    const fields = {
      issuerTaxId: company.tax_id as string,
      seriesNumber: number,
      issueDate,
      invoiceType: inv.invoice_type!,
      taxTotal: D(inv.vat_total!).add(inv.surcharge_total!).toFixed(2),
      amountTotal: D(inv.total!).toFixed(2),
      previousHash: last?.hash ?? "",
      generatedAt: isoWithOffset(now),
    };
    const hash = altaHash(fields);
    const qr = qrUrl({ issuerTaxId: fields.issuerTaxId, seriesNumber: number, issueDate, amountTotal: fields.amountTotal }, opts.aeatEnv ?? "test");
    const seq = last ? BigInt(last.seq) + 1n : 1n;
    const [rec] = await q.query<{ id: string }>(
      `insert into verifactu_record (company_id, seq, kind, invoice_id, fields, previous_hash, hash, qr_url)
       values ($1,$2,'alta',$3,$4,$5,$6,$7) returning id`,
      [company.id, seq.toString(), id, JSON.stringify(fields), fields.previousHash, hash, qr],
    );
    await q.query("insert into outbox (topic, aggregate_id, payload) values ('aeat.verifactu', $1, $2)", [
      rec!.id,
      JSON.stringify({ record_id: rec!.id, invoice_id: id }),
    ]);
    await log(q, "invoice", id, "issue", { number, hash });
    return getInvoice(q, id);
  });
}

export async function registerPayment(db: Db, id: string, input: { amount: string; paid_on?: string; method?: string }) {
  return db.tx(async (q) => {
    const inv = await getInvoice(q, id);
    if (inv.state !== "issued") throw new BusinessError("Solo se cobran facturas emitidas pendientes");
    const amount = D(input.amount);
    if (amount.cmp(0) <= 0) throw new BusinessError("Importe no válido");
    if (amount.cmp(inv.pending) > 0) throw new BusinessError(`El cobro supera lo pendiente (${inv.pending})`);
    await q.query("insert into payment (invoice_id, amount, paid_on, method) values ($1,$2,coalesce($3::date,current_date),$4)", [
      id, amount.toFixed(2), input.paid_on ?? null, input.method ?? "transfer",
    ]);
    if (amount.eq(inv.pending)) await q.query("update invoice set state = $2 where id = $1", [id, InvoiceMachine.next("issued", "pay")]);
    await log(q, "invoice", id, "payment", input);
    return getInvoice(q, id);
  });
}

// VERI*FACTU -------------------------------------------------------------------

export async function listVerifactu(q: Queryable) {
  return q.query(
    `select r.seq, r.kind, r.hash, r.previous_hash, r.qr_url, r.created_at, i.number, o.state as send_state, o.attempts
     from verifactu_record r join invoice i on i.id = r.invoice_id left join outbox o on o.aggregate_id = r.id
     order by r.seq desc limit 500`,
  );
}

/** Recalcula toda la cadena y dice si alguien la ha manipulado. */
export async function verifyVerifactuChain(q: Queryable) {
  const rows = await q.query<{ seq: string; fields: Parameters<typeof altaHash>[0]; hash: string }>(
    "select seq, fields, hash from verifactu_record where kind = 'alta' order by seq",
  );
  const broken = verifyChain(rows.map((r) => ({ ...r.fields, hash: r.hash })));
  return { records: rows.length, ok: broken === -1, firstBrokenSeq: broken === -1 ? null : rows[broken]!.seq };
}

export async function listEvents(q: Queryable, limit = 200) {
  return q.query("select * from event_log order by id desc limit $1", [limit]);
}
