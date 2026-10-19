/**
 * Lógica de negocio. Cada operación que cambia datos va dentro de una transacción y
 * deja rastro en event_log. Las reglas de estados vienen de @sindri/core.
 */
import { D, Dec, computeTotals, isValidSpanishTaxId, InvoiceMachine, SalesOrderMachine, SURCHARGE_FOR_VAT } from "@sindri/core";
import type { InvoiceState, SalesOrderState } from "@sindri/core";
import { altaHash, isoWithOffset, qrUrl, verifyChain } from "@sindri/core/verifactu";
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

export const notFound = (what: string) => new BusinessError(`${what} no encontrado`, 404);

/** Con qué empresa y quién: lo resuelve app.ts en cada petición (usuarios.ts). */
export interface Ctx {
  company: string;
  actor: string;
}

export async function log(q: Queryable, ctx: Ctx | null, entity: string, entityId: string | null, action: string, data?: unknown) {
  await q.query("insert into event_log (entity, entity_id, action, data, actor, company_id) values ($1, $2, $3, $4, $5, $6)", [
    entity,
    entityId,
    action,
    data === undefined ? null : JSON.stringify(data),
    ctx?.actor ?? "system",
    ctx?.company ?? null,
  ]);
}

/** La primera empresa conserva las series y códigos de antes (compatibilidad con la versión anterior). */
export async function firstCompanyId(q: Queryable): Promise<string | null> {
  const [c] = await q.query<{ id: string }>("select id from company order by created_at, id limit 1");
  return c?.id ?? null;
}

/**
 * Siguiente número de una serie de la empresa, sin huecos: si la transacción falla, el
 * número no se consume. Cada empresa lleva sus propias series.
 */
export async function nextNumber(q: Queryable, ctx: Ctx, baseCode: string, prefix: string, date = new Date()): Promise<string> {
  const code = (await firstCompanyId(q)) === ctx.company ? baseCode : `${baseCode}@${ctx.company}`;
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

// Empresas ---------------------------------------------------------------------

export interface CompanyInput {
  name: string;
  tax_id: string;
  trade_name?: string;
  address?: string;
  city?: string;
  postal_code?: string;
  gs1_prefix?: string;
  /** Código corto (001, 002…). Si no se indica, el siguiente libre. */
  code?: string;
  /** Empresa de demostración: abierta a todos y con su marca en pantalla. */
  demo?: boolean;
}

export async function getCompany(q: Queryable, id?: string | null) {
  const [c] = id
    ? await q.query("select * from company where id = $1", [id])
    : await q.query("select * from company order by created_at, id limit 1");
  return c ?? null;
}

export async function listCompanies(q: Queryable) {
  return q.query("select * from company where not archived order by code nulls last, created_at, id");
}

/** El siguiente código libre: 001, 002… */
async function nextCompanyCode(q: Queryable) {
  const [r] = await q.query<{ n: number }>("select coalesce(max(case when code ~ '^[0-9]+$' then code::int end), 0)::int + 1 as n from company");
  return String(r?.n ?? 1).padStart(3, "0");
}

async function checkCompanyCode(q: Queryable, code: string, id: string | null) {
  if (!/^[A-Za-z0-9-]{1,10}$/.test(code)) throw new BusinessError("El código de empresa son hasta 10 letras o números (p. ej. 001)");
  const [dup] = await q.query("select 1 from company where code = $1 and not archived and ($2::uuid is null or id <> $2)", [code, id]);
  if (dup) throw new BusinessError(`Ya hay una empresa con el código ${code}`, 409);
}

/** Empresa nueva con su almacén. Las ubicaciones virtuales (clientes, proveedores...) son comunes. */
export async function createCompany(db: Db, input: CompanyInput, actor = "system") {
  if (!isValidSpanishTaxId(input.tax_id)) throw new BusinessError("NIF de la empresa no válido");
  return db.tx(async (q) => {
    const [dup] = await q.query("select 1 from company where tax_id = $1 and not archived", [input.tax_id.toUpperCase()]);
    if (dup) throw new BusinessError("Ya hay una empresa con ese NIF", 409);
    const code = input.code ?? (await nextCompanyCode(q));
    await checkCompanyCode(q, code, null);
    const [c] = await q.query<{ id: string }>(
      "insert into company (name, trade_name, tax_id, address, city, postal_code, gs1_prefix, code, demo) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *",
      [input.name, input.trade_name ?? null, input.tax_id.toUpperCase(), input.address ?? null, input.city ?? null, input.postal_code ?? null, input.gs1_prefix ?? null, code, input.demo ?? false],
    );
    const first = await firstCompanyId(q);
    // La primera empresa ya tiene el almacén de siempre (WH/STOCK sin empresa de antes de 0004).
    const [own] = await q.query("select 1 from location where code = 'WH/STOCK' and (company_id = $1 or ($1 = $2 and company_id is null))", [c!.id, first]);
    if (!own) await q.query("insert into location (code, name, kind, company_id) values ('WH/STOCK', 'Almacén principal', 'internal', $1)", [c!.id]);
    await log(q, { company: c!.id, actor }, "company", c!.id, "create", input);
    return c;
  });
}

export async function updateCompany(db: Db, ctx: Ctx, input: CompanyInput) {
  if (!isValidSpanishTaxId(input.tax_id)) throw new BusinessError("NIF de la empresa no válido");
  return db.tx(async (q) => {
    const existing = await getCompany(q, ctx.company);
    if (!existing) throw notFound("Empresa");
    if ((existing as { tax_id: string }).tax_id !== input.tax_id.toUpperCase())
      throw new BusinessError("El NIF de la empresa no se puede cambiar una vez creada");
    if (input.code !== undefined) await checkCompanyCode(q, input.code, ctx.company);
    const [c] = await q.query(
      `update company set name=$2, trade_name=$3, address=$4, city=$5, postal_code=$6, gs1_prefix=$7,
         code = coalesce($8, code), demo = coalesce($9, demo) where id=$1 returning *`,
      [ctx.company, input.name, input.trade_name ?? null, input.address ?? null, input.city ?? null, input.postal_code ?? null, input.gs1_prefix ?? null, input.code ?? null, input.demo ?? null],
    );
    await log(q, ctx, "company", ctx.company, "update", input);
    return c;
  });
}

/** PUT /company: crea la primera empresa o actualiza la que está en uso. */
export async function setupCompany(db: Db, ctx: Ctx | null, input: CompanyInput) {
  if (ctx) return updateCompany(db, ctx, input);
  return createCompany(db, input);
}

// Terceros (ficha de cliente) ----------------------------------------------------

export interface PartnerInput {
  kind?: "customer" | "supplier" | "both";
  code?: string | null;
  name: string;
  trade_name?: string | null;
  tax_id?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  website?: string | null;
  address?: string | null;
  city?: string | null;
  postal_code?: string | null;
  province?: string | null;
  country?: string;
  surcharge_regime?: boolean;
  withholding_rate?: string;
  sales_rep_id?: string | null;
  payment_method?: string | null;
  payment_days?: number | null;
  credit_limit?: string | null;
  discount_pct?: string | null;
  iban?: string | null;
  route_zone?: string | null;
  delivery_notes?: string | null;
  notes?: string | null;
}

const PARTNER_FIELDS = [
  "kind", "code", "name", "trade_name", "tax_id", "email", "phone", "mobile", "website", "address", "city",
  "postal_code", "province", "country", "surcharge_regime", "withholding_rate", "sales_rep_id", "payment_method",
  "payment_days", "credit_limit", "discount_pct", "iban", "route_zone", "delivery_notes", "notes",
] as const;

function checkPartner(p: Partial<PartnerInput>) {
  if (p.tax_id && (p.country ?? "ES") === "ES" && !isValidSpanishTaxId(p.tax_id))
    throw new BusinessError(`NIF no válido: ${p.tax_id}`);
  if (p.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(p.iban.replace(/\s/g, "").toUpperCase()))
    throw new BusinessError("IBAN no válido");
}

const cleanPartner = (p: Partial<PartnerInput>, f: (typeof PARTNER_FIELDS)[number]) =>
  f === "tax_id" && p.tax_id ? p.tax_id.toUpperCase() : f === "iban" && p.iban ? p.iban.replace(/\s/g, "").toUpperCase() : p[f];

async function checkRep(q: Queryable, ctx: Ctx, repId: string | null | undefined) {
  if (!repId) return;
  const [r] = await q.query("select 1 from sales_rep where id = $1 and company_id = $2", [repId, ctx.company]);
  if (!r) throw notFound("Comercial");
}

export async function listPartners(q: Queryable, ctx: Ctx, search?: string) {
  return q.query(
    `select p.*, r.name as sales_rep_name from partner p left join sales_rep r on r.id = p.sales_rep_id
     where p.company_id = $2 and not p.archived
       and ($1::text is null or lower(p.name) like '%' || lower($1) || '%' or lower(coalesce(p.trade_name, '')) like '%' || lower($1) || '%'
            or p.tax_id ilike $1 or p.code ilike $1)
     order by p.name limit 500`,
    [search ?? null, ctx.company],
  );
}

/** Ficha completa: datos, contactos, direcciones de entrega y resumen de pedidos y facturas. */
export async function getPartner(q: Queryable, ctx: Ctx, id: string) {
  const [p] = await q.query(
    "select p.*, r.name as sales_rep_name from partner p left join sales_rep r on r.id = p.sales_rep_id where p.id = $1 and p.company_id = $2",
    [id, ctx.company],
  );
  if (!p) throw notFound("Cliente");
  const contacts = await q.query("select * from partner_contact where partner_id = $1 order by name", [id]);
  const addresses = await q.query("select * from partner_address where partner_id = $1 order by is_default desc, label", [id]);
  const orders = await q.query(
    `select o.id, o.number, o.state, o.order_date,
       (select coalesce(sum(round(l.quantity * l.unit_price * (1 - l.discount_pct/100), 2)), 0) from sales_order_line l where l.order_id = o.id)::text as untaxed
     from sales_order o where o.partner_id = $1 order by o.created_at desc limit 20`,
    [id],
  );
  const invoices = await q.query(
    "select id, number, state, issue_date, total, amount_due from invoice where partner_id = $1 order by created_at desc limit 20",
    [id],
  );
  const [stats] = await q.query<Record<string, string>>(
    `select
       (select count(*) from sales_order where partner_id = $1 and state <> 'cancelled')::text as orders,
       (select coalesce(sum(untaxed), 0) from invoice where partner_id = $1 and state in ('issued', 'paid') and issue_date >= date_trunc('year', current_date))::text as billed_year,
       (select coalesce(sum(i.amount_due - coalesce((select sum(amount) from payment where invoice_id = i.id), 0)), 0)
          from invoice i where i.partner_id = $1 and i.state = 'issued')::text as pending`,
    [id],
  );
  const prices = await q.query(
    `select pp.product_id, pr.sku, pr.name, pr.uom, pr.sale_price::text, pp.unit_price::text
     from partner_price pp join product pr on pr.id = pp.product_id where pp.partner_id = $1 order by pr.sku`,
    [id],
  );
  return { ...p, contacts, addresses, orders, invoices, stats, prices } as Record<string, any>;
}

/** Tarifa propia del cliente para un producto: alta o cambio (null la quita). */
export async function savePartnerPrice(db: Db, ctx: Ctx, partnerId: string, productId: string, unitPrice: string | null) {
  return db.tx(async (q) => {
    await ownPartner(q, ctx, partnerId);
    const [pr] = await q.query("select 1 from product where id = $1 and company_id = $2", [productId, ctx.company]);
    if (!pr) throw notFound("Producto");
    if (unitPrice !== null) unitPrice = unitPrice.trim().replace(",", ".");
    if (unitPrice === null) await q.query("delete from partner_price where partner_id = $1 and product_id = $2", [partnerId, productId]);
    else {
      if (D(unitPrice).cmp(0) < 0) throw new BusinessError("El precio no puede ser negativo");
      await q.query(
        `insert into partner_price (partner_id, product_id, unit_price) values ($1,$2,$3)
         on conflict (partner_id, product_id) do update set unit_price = excluded.unit_price, updated_at = now()`,
        [partnerId, productId, unitPrice],
      );
    }
    await log(q, ctx, "partner", partnerId, "price", { product: productId, unit_price: unitPrice });
    return { ok: true };
  });
}

export async function createPartner(db: Db, ctx: Ctx, p: PartnerInput) {
  checkPartner(p);
  return db.tx(async (q) => {
    await checkRep(q, ctx, p.sales_rep_id);
    const cols = PARTNER_FIELDS.filter((f) => p[f] !== undefined);
    const vals = cols.map((f) => cleanPartner(p, f));
    const [row] = await q.query(
      `insert into partner (company_id, ${cols.join(",")}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(",")}) returning *`,
      [ctx.company, ...vals],
    );
    await log(q, ctx, "partner", row!.id as string, "create", p);
    return row;
  });
}

export async function updatePartner(db: Db, ctx: Ctx, id: string, p: Partial<PartnerInput>) {
  checkPartner(p);
  return db.tx(async (q) => {
    await checkRep(q, ctx, p.sales_rep_id);
    const cols = PARTNER_FIELDS.filter((f) => p[f] !== undefined);
    if (!cols.length) throw new BusinessError("Nada que actualizar", 400);
    const [row] = await q.query(
      `update partner set ${cols.map((c, i) => `${c} = $${i + 3}`).join(", ")} where id = $1 and company_id = $2 returning *`,
      [id, ctx.company, ...cols.map((f) => cleanPartner(p, f))],
    );
    if (!row) throw notFound("Cliente");
    await log(q, ctx, "partner", id, "update", p);
    return row;
  });
}

export async function archivePartner(db: Db, ctx: Ctx, id: string) {
  return db.tx(async (q) => {
    const [row] = await q.query("update partner set archived = true where id = $1 and company_id = $2 returning id", [id, ctx.company]);
    if (!row) throw notFound("Cliente");
    await log(q, ctx, "partner", id, "archive");
    return { ok: true };
  });
}

async function ownPartner(q: Queryable, ctx: Ctx, partnerId: string) {
  const [p] = await q.query("select id from partner where id = $1 and company_id = $2", [partnerId, ctx.company]);
  if (!p) throw notFound("Cliente");
}

export interface ContactInput {
  name: string;
  position?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
}

export async function saveContact(db: Db, ctx: Ctx, partnerId: string, c: ContactInput, contactId?: string) {
  return db.tx(async (q) => {
    await ownPartner(q, ctx, partnerId);
    const vals = [c.name, c.position ?? null, c.email ?? null, c.phone ?? null, c.notes ?? null];
    const [row] = contactId
      ? await q.query("update partner_contact set name=$3, position=$4, email=$5, phone=$6, notes=$7 where id=$1 and partner_id=$2 returning *", [contactId, partnerId, ...vals])
      : await q.query("insert into partner_contact (partner_id, name, position, email, phone, notes) values ($1,$2,$3,$4,$5,$6) returning *", [partnerId, ...vals]);
    if (!row) throw notFound("Contacto");
    await log(q, ctx, "partner", partnerId, contactId ? "contact.update" : "contact.create", c);
    return row;
  });
}

export async function deleteContact(db: Db, ctx: Ctx, partnerId: string, contactId: string) {
  return db.tx(async (q) => {
    await ownPartner(q, ctx, partnerId);
    await q.query("delete from partner_contact where id = $1 and partner_id = $2", [contactId, partnerId]);
    await log(q, ctx, "partner", partnerId, "contact.delete", { id: contactId });
    return { ok: true };
  });
}

export interface AddressInput {
  label: string;
  address?: string | null;
  city?: string | null;
  postal_code?: string | null;
  province?: string | null;
  country?: string;
  phone?: string | null;
  schedule?: string | null;
  is_default?: boolean;
}

export async function saveAddress(db: Db, ctx: Ctx, partnerId: string, a: AddressInput, addressId?: string) {
  return db.tx(async (q) => {
    await ownPartner(q, ctx, partnerId);
    if (a.is_default) await q.query("update partner_address set is_default = false where partner_id = $1", [partnerId]);
    const vals = [a.label, a.address ?? null, a.city ?? null, a.postal_code ?? null, a.province ?? null, a.country ?? "ES", a.phone ?? null, a.schedule ?? null, !!a.is_default];
    const [row] = addressId
      ? await q.query(
          "update partner_address set label=$3, address=$4, city=$5, postal_code=$6, province=$7, country=$8, phone=$9, schedule=$10, is_default=$11 where id=$1 and partner_id=$2 returning *",
          [addressId, partnerId, ...vals],
        )
      : await q.query(
          "insert into partner_address (partner_id, label, address, city, postal_code, province, country, phone, schedule, is_default) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *",
          [partnerId, ...vals],
        );
    if (!row) throw notFound("Dirección");
    await log(q, ctx, "partner", partnerId, addressId ? "address.update" : "address.create", a);
    return row;
  });
}

export async function deleteAddress(db: Db, ctx: Ctx, partnerId: string, addressId: string) {
  return db.tx(async (q) => {
    await ownPartner(q, ctx, partnerId);
    const [used] = await q.query("select 1 from sales_order where delivery_address_id = $1 limit 1", [addressId]);
    if (used) throw new BusinessError("Esa dirección ya se usa en pedidos: no se puede borrar", 409);
    await q.query("delete from partner_address where id = $1 and partner_id = $2", [addressId, partnerId]);
    await log(q, ctx, "partner", partnerId, "address.delete", { id: addressId });
    return { ok: true };
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

export async function listProducts(q: Queryable, ctx: Ctx, search?: string) {
  return q.query(
    `select p.*, coalesce((select sum(b.quantity) from stock_balance b where b.product_id = p.id), 0)::text as on_hand
     from product p where p.company_id = $2 and not archived and ($1::text is null or p.sku ilike '%'||$1||'%' or lower(p.name) like '%'||lower($1)||'%')
     order by p.sku limit 500`,
    [search ?? null, ctx.company],
  );
}

export async function createProduct(db: Db, ctx: Ctx, p: ProductInput) {
  return db.tx(async (q) => {
    const cols = PRODUCT_FIELDS.filter((f) => p[f] !== undefined);
    const [row] = await q.query(
      `insert into product (company_id, ${cols.join(",")}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(",")}) returning *`,
      [ctx.company, ...cols.map((f) => p[f])],
    );
    await log(q, ctx, "product", row!.id as string, "create", p);
    return row;
  });
}

export async function updateProduct(db: Db, ctx: Ctx, id: string, p: Partial<ProductInput>) {
  return db.tx(async (q) => {
    const cols = PRODUCT_FIELDS.filter((f) => p[f] !== undefined);
    if (!cols.length) throw new BusinessError("Nada que actualizar", 400);
    const [row] = await q.query(
      `update product set ${cols.map((c, i) => `${c} = $${i + 3}`).join(", ")} where id = $1 and company_id = $2 returning *`,
      [id, ctx.company, ...cols.map((f) => p[f])],
    );
    if (!row) throw notFound("Producto");
    await log(q, ctx, "product", id, "update", p);
    return row;
  });
}

// Stock ------------------------------------------------------------------------

/**
 * Ubicación por código. Las internas (WH/STOCK...) son de cada empresa; la primera usa las de
 * antes de tener varias empresas. Las virtuales (clientes, proveedores, ajustes) son comunes.
 */
async function locationId(q: Queryable, ctx: Ctx, code: string): Promise<string> {
  const [l] = await q.query<{ id: string }>(
    `select id from location where code = $1
       and (company_id = $2 or (company_id is null and (kind <> 'internal' or $2 = $3)))
     order by company_id nulls last limit 1`,
    [code, ctx.company, await firstCompanyId(q)],
  );
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

export async function listLocations(q: Queryable, ctx: Ctx) {
  return q.query(
    `select * from location where company_id = $1 or (company_id is null and (kind <> 'internal' or $1 = $2)) order by kind, code`,
    [ctx.company, await firstCompanyId(q)],
  );
}

export async function stockBalances(q: Queryable, ctx: Ctx) {
  return q.query(
    `select b.product_id, p.sku, p.name as product_name, p.uom, b.lot_id, lot.code as lot_code, lot.expiry_date,
            l.code as location_code, b.quantity
     from stock_balance b join product p on p.id = b.product_id join location l on l.id = b.location_id
     left join lot on lot.id = b.lot_id where p.company_id = $1 order by p.sku, lot.code`,
    [ctx.company],
  );
}

export async function listMoves(q: Queryable, ctx: Ctx, productId?: string) {
  return q.query(
    `select m.*, p.sku, f.code as from_code, t.code as to_code, lot.code as lot_code
     from stock_move m join product p on p.id = m.product_id join location f on f.id = m.from_location_id
     join location t on t.id = m.to_location_id left join lot on lot.id = m.lot_id
     where p.company_id = $2 and ($1::uuid is null or m.product_id = $1) order by m.done_at desc limit 500`,
    [productId ?? null, ctx.company],
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
export async function receiveStock(db: Db, ctx: Ctx, r: ReceiptInput) {
  if (D(r.quantity).cmp(0) <= 0) throw new BusinessError("La cantidad debe ser mayor que cero");
  return db.tx(async (q) => {
    const [p] = await q.query<{ id: string; track_lots: boolean; kind: string }>("select * from product where id = $1 and company_id = $2", [r.product_id, ctx.company]);
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
    const from = await locationId(q, ctx, r.origin === "adjustment" ? "VIRTUAL/ADJUST" : "PARTNER/SUPPLIER");
    const to = await locationId(q, ctx, r.location_code ?? "WH/STOCK");
    const [m] = await q.query(
      `insert into stock_move (product_id, lot_id, from_location_id, to_location_id, quantity, unit_cost, reference_type, note, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [p.id, lotId, from, to, D(r.quantity).toFixed(), r.unit_cost ?? null, r.origin ?? "receipt", r.note ?? null, ctx.actor],
    );
    await log(q, ctx, "stock_move", m!.id as string, "receive", r);
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

export interface SalesOrderInput {
  partner_id: string;
  order_date?: string;
  delivery_date?: string;
  sales_rep_id?: string | null;
  delivery_address_id?: string | null;
  notes?: string;
  lines: SalesLineInput[];
}

const LINE_TOTAL = "round(l.quantity * l.unit_price * (1 - l.discount_pct/100), 2)";

export async function listSalesOrders(q: Queryable, ctx: Ctx, f: { state?: string; sales_rep_id?: string } = {}) {
  return q.query(
    `select o.*, p.name as partner_name, r.name as sales_rep_name, a.label as delivery_label, coalesce(a.city, p.city) as delivery_city,
       (select coalesce(sum(${LINE_TOTAL}), 0) from sales_order_line l where l.order_id = o.id)::text as untaxed,
       (select dr.number from delivery_route_stop s join delivery_route dr on dr.id = s.route_id
         where s.order_id = o.id and dr.state <> 'closed' order by dr.route_date desc limit 1) as route_number
     from sales_order o join partner p on p.id = o.partner_id
     left join sales_rep r on r.id = o.sales_rep_id left join partner_address a on a.id = o.delivery_address_id
     where o.company_id = $1 and ($2::text is null or o.state = $2) and ($3::uuid is null or o.sales_rep_id = $3)
     order by o.created_at desc limit 500`,
    [ctx.company, f.state ?? null, f.sales_rep_id ?? null],
  );
}

export async function getSalesOrder(q: Queryable, ctx: Ctx, id: string) {
  const [o] = await q.query(
    `select o.*, p.name as partner_name, r.name as sales_rep_name, s.number as split_from_number
     from sales_order o join partner p on p.id = o.partner_id left join sales_rep r on r.id = o.sales_rep_id
     left join sales_order s on s.id = o.split_from_id
     where o.id = $1 and o.company_id = $2`,
    [id, ctx.company],
  );
  if (!o) throw notFound("Pedido");
  const lines = await q.query(
    "select l.*, pr.sku, pr.uom from sales_order_line l join product pr on pr.id = l.product_id where order_id = $1 order by position",
    [id],
  );
  const [partner] = await q.query<{ surcharge_regime: boolean; withholding_rate: string }>("select * from partner where id = $1", [o.partner_id]);
  const [address] = o.delivery_address_id ? await q.query("select * from partner_address where id = $1", [o.delivery_address_id]) : [null];
  const splits = await q.query("select id, number, state from sales_order where split_from_id = $1 order by created_at", [id]);
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
  const actions: string[] = SalesOrderMachine.actions(o.state as SalesOrderState);
  if ((o.state === "draft" || o.state === "confirmed") && (lines.length > 1 || lines.some((l) => D(l.quantity as string).cmp(1) > 0))) actions.push("split");
  return { ...o, lines, totals, actions, delivery_address: address, splits } as Record<string, any>;
}

/** El precio de un producto para un cliente: su tarifa propia si la tiene, si no la general. */
export async function priceFor(q: Queryable, partnerId: string, productId: string, salePrice: string) {
  const [pp] = await q.query<{ unit_price: string }>("select unit_price from partner_price where partner_id = $1 and product_id = $2", [partnerId, productId]);
  return pp?.unit_price ?? salePrice;
}

async function insertLines(q: Queryable, ctx: Ctx, orderId: string, lines: SalesLineInput[], discountDefault: string | null) {
  let pos = 1;
  const [o] = await q.query<{ partner_id: string }>("select partner_id from sales_order where id = $1", [orderId]);
  for (const l of lines) {
    const [p] = await q.query<{ name: string; sale_price: string; vat_rate: string }>("select * from product where id = $1 and company_id = $2", [l.product_id, ctx.company]);
    if (!p) throw notFound("Producto");
    if (D(l.quantity).cmp(0) <= 0) throw new BusinessError("Cantidad no válida");
    await q.query(
      `insert into sales_order_line (order_id, position, product_id, description, quantity, unit_price, discount_pct, vat_rate)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [orderId, pos++, l.product_id, l.description ?? p.name, l.quantity, l.unit_price ?? (await priceFor(q, o!.partner_id, l.product_id, p.sale_price)), l.discount_pct ?? discountDefault ?? "0", p.vat_rate],
    );
  }
}

export async function createSalesOrder(db: Db, ctx: Ctx, input: SalesOrderInput) {
  if (!input.lines.length) throw new BusinessError("El pedido necesita al menos una línea");
  return db.tx(async (q) => {
    const [partner] = await q.query<{ sales_rep_id: string | null; discount_pct: string | null }>(
      "select * from partner where id = $1 and company_id = $2",
      [input.partner_id, ctx.company],
    );
    if (!partner) throw notFound("Cliente");
    const rep = input.sales_rep_id === undefined ? partner.sales_rep_id : input.sales_rep_id;
    await checkRep(q, ctx, rep);
    let addressId = input.delivery_address_id;
    if (addressId) {
      const [a] = await q.query("select 1 from partner_address where id = $1 and partner_id = $2", [addressId, input.partner_id]);
      if (!a) throw notFound("Dirección de entrega");
    } else if (addressId === undefined) {
      const [a] = await q.query<{ id: string }>("select id from partner_address where partner_id = $1 and is_default limit 1", [input.partner_id]);
      addressId = a?.id ?? null;
    }
    const number = await nextNumber(q, ctx, "sales_order", "PV");
    const [o] = await q.query<{ id: string }>(
      `insert into sales_order (company_id, number, partner_id, order_date, delivery_date, sales_rep_id, delivery_address_id, notes)
       values ($1,$2,$3,coalesce($4::date, current_date),$5,$6,$7,$8) returning id`,
      [ctx.company, number, input.partner_id, input.order_date ?? null, input.delivery_date ?? null, rep ?? null, addressId ?? null, input.notes ?? null],
    );
    await insertLines(q, ctx, o!.id, input.lines, partner.discount_pct);
    await log(q, ctx, "sales_order", o!.id, "create", { number });
    return getSalesOrder(q, ctx, o!.id);
  });
}

export async function updateSalesOrderHeader(
  db: Db,
  ctx: Ctx,
  id: string,
  input: { sales_rep_id?: string | null; delivery_address_id?: string | null; delivery_date?: string | null; notes?: string | null },
) {
  return db.tx(async (q) => {
    const o = await getSalesOrder(q, ctx, id);
    if (!["draft", "confirmed"].includes(o.state)) throw new BusinessError("Solo se cambia un pedido sin entregar", 409);
    if (input.sales_rep_id !== undefined) await checkRep(q, ctx, input.sales_rep_id);
    if (input.delivery_address_id) {
      const [a] = await q.query("select 1 from partner_address where id = $1 and partner_id = $2", [input.delivery_address_id, o.partner_id]);
      if (!a) throw notFound("Dirección de entrega");
    }
    const fields = (["sales_rep_id", "delivery_address_id", "delivery_date", "notes"] as const).filter((f) => input[f] !== undefined);
    if (fields.length)
      await q.query(`update sales_order set ${fields.map((f, i) => `${f} = $${i + 2}`).join(", ")} where id = $1`, [id, ...fields.map((f) => input[f])]);
    await log(q, ctx, "sales_order", id, "update", input);
    return getSalesOrder(q, ctx, id);
  });
}

async function transitionOrder(q: Queryable, ctx: Ctx, id: string, action: "confirm" | "deliver" | "invoice" | "cancel") {
  const [o] = await q.query<{ state: SalesOrderState }>("select state from sales_order where id = $1 and company_id = $2 for update", [id, ctx.company]);
  if (!o) throw notFound("Pedido");
  const next = SalesOrderMachine.next(o.state, action);
  await q.query("update sales_order set state = $2 where id = $1", [id, next]);
  await log(q, ctx, "sales_order", id, action, { from: o.state, to: next });
}

export async function confirmSalesOrder(db: Db, ctx: Ctx, id: string) {
  return db.tx(async (q) => {
    await transitionOrder(q, ctx, id, "confirm");
    return getSalesOrder(q, ctx, id);
  });
}

export async function cancelSalesOrder(db: Db, ctx: Ctx, id: string) {
  return db.tx(async (q) => {
    await transitionOrder(q, ctx, id, "cancel");
    return getSalesOrder(q, ctx, id);
  });
}

/**
 * Separar un pedido: lo indicado pasa a un pedido nuevo del mismo cliente, en el mismo estado
 * (borrador o confirmado) y con su propio número. Sirve para entregar o facturar por partes.
 * El pedido de origen tiene que quedarse con algo.
 */
export async function splitSalesOrder(db: Db, ctx: Ctx, id: string, input: { lines: { line_id: string; quantity: string }[]; delivery_date?: string; notes?: string }) {
  if (!input.lines.length) throw new BusinessError("Indica qué pasa al pedido nuevo");
  return db.tx(async (q) => {
    const [o] = await q.query<Record<string, string>>("select * from sales_order where id = $1 and company_id = $2 for update", [id, ctx.company]);
    if (!o) throw notFound("Pedido");
    if (!["draft", "confirmed"].includes(o.state!)) throw new BusinessError("Solo se separa un pedido en borrador o confirmado", 409);
    const lines = await q.query<Record<string, string>>("select * from sales_order_line where order_id = $1 order by position", [id]);
    const byId = new Map(lines.map((l) => [l.id!, l]));
    const moving = new Map<string, Dec>();
    for (const m of input.lines) {
      const l = byId.get(m.line_id);
      if (!l) throw notFound("Línea");
      const qn = D(m.quantity);
      if (qn.cmp(0) < 0) throw new BusinessError("Cantidad no válida");
      if (qn.isZero()) continue;
      const total = (moving.get(m.line_id) ?? D(0)).add(qn);
      if (total.cmp(l.quantity!) > 0) throw new BusinessError(`No se pueden pasar ${total.toFixed()} de ${l.description}: el pedido tiene ${D(l.quantity!).toFixed()}`);
      moving.set(m.line_id, total);
    }
    if (!moving.size) throw new BusinessError("Indica qué pasa al pedido nuevo");
    const stays = lines.some((l) => D(l.quantity!).sub(moving.get(l.id!) ?? D(0)).cmp(0) > 0);
    if (!stays) throw new BusinessError("El pedido de origen no puede quedarse vacío: eso es cambiar el pedido entero");

    const number = await nextNumber(q, ctx, "sales_order", "PV");
    const [n] = await q.query<{ id: string }>(
      `insert into sales_order (company_id, number, partner_id, state, order_date, delivery_date, sales_rep_id, delivery_address_id, notes, split_from_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [ctx.company, number, o.partner_id, o.state, o.order_date, input.delivery_date ?? o.delivery_date ?? null, o.sales_rep_id ?? null, o.delivery_address_id ?? null, input.notes ?? o.notes ?? null, id],
    );
    let pos = 1;
    for (const l of lines) {
      const mv = moving.get(l.id!);
      if (!mv) continue;
      await q.query(
        `insert into sales_order_line (order_id, position, product_id, description, quantity, unit_price, discount_pct, vat_rate)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [n!.id, pos++, l.product_id, l.description, mv.toFixed(), l.unit_price, l.discount_pct, l.vat_rate],
      );
      const rest = D(l.quantity!).sub(mv);
      if (rest.isZero()) await q.query("delete from sales_order_line where id = $1", [l.id]);
      else await q.query("update sales_order_line set quantity = $2 where id = $1", [l.id, rest.toFixed()]);
    }
    await log(q, ctx, "sales_order", id, "split", { new_order: n!.id, number, lines: input.lines });
    await log(q, ctx, "sales_order", n!.id, "create", { number, split_from: id });
    return { order: await getSalesOrder(q, ctx, id), new_order: await getSalesOrder(q, ctx, n!.id) };
  });
}

/**
 * Entrega completa del pedido: genera el albarán y los movimientos de stock.
 * Consume lotes por FEFO (primero el que caduca antes) y, a igualdad, por antigüedad.
 */
export async function deliverSalesOrder(db: Db, ctx: Ctx, id: string) {
  return db.tx(async (q) => {
    await transitionOrder(q, ctx, id, "deliver");
    const stockLoc = await locationId(q, ctx, "WH/STOCK");
    const customerLoc = await locationId(q, ctx, "PARTNER/CUSTOMER");
    const number = await nextNumber(q, ctx, "delivery", "ALB");
    const [del] = await q.query<{ id: string }>(
      "insert into delivery (company_id, number, order_id, from_location_id) values ($1,$2,$3,$4) returning id",
      [ctx.company, number, id, stockLoc],
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
          `insert into stock_move (product_id, lot_id, from_location_id, to_location_id, quantity, unit_cost, reference_type, reference_id, created_by)
           values ($1,$2,$3,$4,$5,$6,'delivery',$7,$8)`,
          [l.product_id, b.lot_id, stockLoc, customerLoc, take.toFixed(), l.cost_price, del!.id, ctx.actor],
        );
        pending = pending.sub(take);
      }
      if (!pending.isZero()) throw new BusinessError(`No hay lotes suficientes de ${l.sku}`);
    }
    await log(q, ctx, "delivery", del!.id, "create", { number, order_id: id });
    return { delivery: { id: del!.id, number }, order: await getSalesOrder(q, ctx, id) };
  });
}

// Facturas ---------------------------------------------------------------------

export async function listInvoices(q: Queryable, ctx: Ctx) {
  return q.query(
    "select i.*, p.name as partner_name from invoice i join partner p on p.id = i.partner_id where i.company_id = $1 order by i.created_at desc limit 500",
    [ctx.company],
  );
}

export async function getInvoice(q: Queryable, ctx: Ctx, id: string) {
  const [inv] = await q.query("select i.*, p.name as partner_name from invoice i join partner p on p.id = i.partner_id where i.id = $1 and i.company_id = $2", [id, ctx.company]);
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
export async function invoiceSalesOrder(db: Db, ctx: Ctx, orderId: string) {
  return db.tx(async (q) => {
    await transitionOrder(q, ctx, orderId, "invoice");
    const order = await getSalesOrder(q, ctx, orderId);
    const [partner] = await q.query<{ surcharge_regime: boolean }>("select * from partner where id = $1", [order.partner_id]);
    const [inv] = await q.query<{ id: string }>("insert into invoice (company_id, partner_id, order_id) values ($1,$2,$3) returning id", [
      ctx.company,
      order.partner_id,
      orderId,
    ]);
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
    await log(q, ctx, "invoice", inv!.id, "create", { order_id: orderId });
    return getInvoice(q, ctx, inv!.id);
  });
}

/**
 * Emitir factura: asigna número de la serie, congela los datos del cliente y genera
 * en la MISMA transacción el registro VERI*FACTU encadenado. No necesita internet:
 * el envío a la AEAT queda en la bandeja de salida (outbox) y se hace cuando haya red.
 * Cada empresa tiene su propia cadena.
 */
export async function issueInvoice(db: Db, ctx: Ctx, id: string, opts: { now?: Date; aeatEnv?: "test" | "production" } = {}) {
  return db.tx(async (q) => {
    const company = await getCompany(q, ctx.company);
    if (!company) throw new BusinessError("Configure primero los datos de la empresa");
    const [inv] = await q.query<Record<string, string>>("select * from invoice where id = $1 and company_id = $2 for update", [id, ctx.company]);
    if (!inv) throw notFound("Factura");
    InvoiceMachine.next(inv.state as InvoiceState, "issue");
    const [partner] = await q.query<Record<string, string>>("select * from partner where id = $1", [inv.partner_id]);
    if (!partner!.tax_id) throw new BusinessError("El cliente necesita NIF para emitir factura completa (F1)");
    if (D(inv.total!).isZero()) throw new BusinessError("La factura no tiene importe");

    const now = opts.now ?? new Date();
    const issueDate = isoWithOffset(now).slice(0, 10);
    const number = await nextNumber(q, ctx, `invoice_${inv.series}`, inv.series!, now);
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
    await log(q, ctx, "invoice", id, "issue", { number, hash });
    return getInvoice(q, ctx, id);
  });
}

export async function registerPayment(db: Db, ctx: Ctx, id: string, input: { amount: string; paid_on?: string; method?: string }) {
  return db.tx(async (q) => {
    const inv = await getInvoice(q, ctx, id);
    if (inv.state !== "issued") throw new BusinessError("Solo se cobran facturas emitidas pendientes");
    const amount = D(input.amount);
    if (amount.cmp(0) <= 0) throw new BusinessError("Importe no válido");
    if (amount.cmp(inv.pending) > 0) throw new BusinessError(`El cobro supera lo pendiente (${inv.pending})`);
    await q.query("insert into payment (invoice_id, amount, paid_on, method) values ($1,$2,coalesce($3::date,current_date),$4)", [
      id, amount.toFixed(2), input.paid_on ?? null, input.method ?? "transfer",
    ]);
    if (amount.eq(inv.pending)) await q.query("update invoice set state = $2 where id = $1", [id, InvoiceMachine.next("issued", "pay")]);
    await log(q, ctx, "invoice", id, "payment", input);
    return getInvoice(q, ctx, id);
  });
}

// VERI*FACTU -------------------------------------------------------------------

export async function listVerifactu(q: Queryable, ctx: Ctx) {
  return q.query(
    `select r.seq, r.kind, r.hash, r.previous_hash, r.qr_url, r.created_at, i.number, o.state as send_state, o.attempts
     from verifactu_record r join invoice i on i.id = r.invoice_id left join outbox o on o.aggregate_id = r.id
     where r.company_id = $1 order by r.seq desc limit 500`,
    [ctx.company],
  );
}

/** Recalcula toda la cadena de la empresa y dice si alguien la ha manipulado. */
export async function verifyVerifactuChain(q: Queryable, ctx: Ctx) {
  const rows = await q.query<{ seq: string; fields: Parameters<typeof altaHash>[0]; hash: string }>(
    "select seq, fields, hash from verifactu_record where kind = 'alta' and company_id = $1 order by seq",
    [ctx.company],
  );
  const broken = verifyChain(rows.map((r) => ({ ...r.fields, hash: r.hash })));
  return { records: rows.length, ok: broken === -1, firstBrokenSeq: broken === -1 ? null : rows[broken]!.seq };
}

export async function listEvents(q: Queryable, ctx: Ctx, limit = 200) {
  return q.query("select * from event_log where company_id = $1 or company_id is null order by id desc limit $2", [ctx.company, limit]);
}

/**
 * Lo que una versión anterior haya escrito sin empresa pasa a la primera empresa.
 * Se llama al arrancar (start.ts).
 */
export async function repairCompanyColumns(db: Db) {
  const first = await firstCompanyId(db);
  if (!first) return;
  for (const t of ["partner", "product", "sales_order", "delivery", "invoice"])
    await db.query(`update ${t} set company_id = $1 where company_id is null`, [first]);
}
