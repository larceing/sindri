/**
 * CRM y presupuestos.
 *
 * Oportunidad: alguien que puede comprar (un cliente o todavía no), con su etapa en el embudo
 * (nueva → contactada → propuesta → ganada o perdida) y sus actividades de seguimiento.
 * Presupuesto: sale de un modelo (de proyecto, de soporte…), se envía y, si el cliente lo
 * acepta, se convierte en un pedido confirmado y la oportunidad queda ganada.
 * Todo es de la empresa en uso (Ctx).
 */
import { D, computeTotals, QuotationMachine, SURCHARGE_FOR_VAT } from "@sindri/core";
import type { QuotationAction, QuotationState } from "@sindri/core";
import type { Db, Queryable } from "./db.js";
import { BusinessError, createPartner, log, nextNumber, notFound, priceFor, repFor, type Ctx } from "./services.js";

// Oportunidades ----------------------------------------------------------------------

export const STAGES = ["new", "contacted", "proposal", "won", "lost"] as const;
export type Stage = (typeof STAGES)[number];
const OPEN: Stage[] = ["new", "contacted", "proposal"];

export interface OpportunityInput {
  title: string;
  partner_id?: string | null;
  prospect_name?: string | null;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  amount?: string | null;
  probability?: number | null;
  expected_close?: string | null;
  sales_rep_id?: string | null;
  source?: string | null;
  notes?: string | null;
}
const OPP_FIELDS = [
  "title", "partner_id", "prospect_name", "contact_name", "email", "phone", "amount", "probability", "expected_close", "sales_rep_id", "source", "notes",
] as const;

async function checkRefs(q: Queryable, ctx: Ctx, refs: { partner_id?: string | null; sales_rep_id?: string | null }) {
  if (refs.partner_id) {
    const [p] = await q.query("select 1 from partner where id = $1 and company_id = maestro($2) and not archived", [refs.partner_id, ctx.company]);
    if (!p) throw notFound("Cliente");
  }
  if (refs.sales_rep_id) {
    const [r] = await q.query("select 1 from sales_rep where id = $1 and company_id = $2", [refs.sales_rep_id, ctx.company]);
    if (!r) throw notFound("Comercial");
  }
}

const OPP_SELECT = `select o.*, coalesce(p.trade_name, p.name, o.prospect_name) as customer_name, r.name as sales_rep_name,
    (select min(a.due_date) from crm_activity a where a.opportunity_id = o.id and a.done_at is null) as next_activity,
    (select count(*) from quotation qt where qt.opportunity_id = o.id and qt.state <> 'cancelled')::int as quotations
  from opportunity o left join partner p on p.id = o.partner_id left join sales_rep r on r.id = o.sales_rep_id`;

export async function listOpportunities(q: Queryable, ctx: Ctx, f: { stage?: string; sales_rep_id?: string; partner_id?: string } = {}) {
  const rows = await q.query(
    `${OPP_SELECT}
     where o.company_id = $1 and ($2::text is null or o.stage = $2) and ($3::uuid is null or o.sales_rep_id = $3) and ($4::uuid is null or o.partner_id = $4)
     order by case o.stage when 'new' then 1 when 'contacted' then 2 when 'proposal' then 3 when 'won' then 4 else 5 end, o.expected_close nulls last, o.created_at desc
     limit 500`,
    [ctx.company, f.stage || null, f.sales_rep_id || null, f.partner_id || null],
  );
  // Resumen del embudo: cuántas hay en cada etapa y cuánto suman (las abiertas, ponderadas).
  const resumen = Object.fromEntries(STAGES.map((s) => [s, { count: 0, amount: D(0) }]));
  let ponderado = D(0);
  for (const o of rows) {
    const r = resumen[o.stage as Stage]!;
    r.count++;
    const amount = D((o.amount as string | null) ?? 0);
    r.amount = r.amount.add(amount);
    if (OPEN.includes(o.stage as Stage)) ponderado = ponderado.add(amount.mul(Number(o.probability ?? 0)).div(100));
  }
  return {
    items: rows,
    funnel: Object.fromEntries(Object.entries(resumen).map(([k, v]) => [k, { count: v.count, amount: v.amount.toFixed(2) }])),
    weighted: ponderado.toFixed(2),
  };
}

export async function getOpportunity(q: Queryable, ctx: Ctx, id: string) {
  const [o] = await q.query(`${OPP_SELECT} where o.id = $1 and o.company_id = $2`, [id, ctx.company]);
  if (!o) throw notFound("Oportunidad");
  const activities = await q.query("select * from crm_activity where opportunity_id = $1 order by done_at is not null, due_date nulls last, created_at", [id]);
  const quotations = await q.query(
    `select qt.id, qt.number, qt.title, qt.state, qt.quote_date, qt.valid_until, ${QUOTE_UNTAXED} as untaxed
     from quotation qt where qt.opportunity_id = $1 order by qt.created_at desc`,
    [id],
  );
  return { ...o, activities, quotations } as Record<string, any>;
}

/** Probabilidad de partida de cada etapa, si no se ha puesto a mano. */
const PROB: Record<Stage, number> = { new: 10, contacted: 25, proposal: 50, won: 100, lost: 0 };

export async function createOpportunity(db: Db, ctx: Ctx, input: OpportunityInput) {
  if (!input.partner_id && !input.prospect_name) throw new BusinessError("Indica el cliente o, si todavía no lo es, su nombre");
  return db.tx(async (q) => {
    await checkRefs(q, ctx, input);
    let rep = input.sales_rep_id;
    if (rep === undefined && input.partner_id) {
      const [p] = await q.query<{ sales_rep_id: string | null }>("select sales_rep_id from partner where id = $1", [input.partner_id]);
      rep = await repFor(q, ctx, p?.sales_rep_id);
    }
    const number = await nextNumber(q, ctx, "opportunity", "OP");
    const data = { ...input, sales_rep_id: rep ?? null, probability: input.probability ?? PROB.new };
    const cols = OPP_FIELDS.filter((f) => data[f] !== undefined);
    const [row] = await q.query<{ id: string }>(
      `insert into opportunity (company_id, number, ${cols.join(",")}) values ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(",")}) returning id`,
      [ctx.company, number, ...cols.map((f) => data[f])],
    );
    await log(q, ctx, "opportunity", row!.id, "create", { number, ...input });
    return getOpportunity(q, ctx, row!.id);
  });
}

export async function updateOpportunity(db: Db, ctx: Ctx, id: string, input: Partial<OpportunityInput>) {
  return db.tx(async (q) => {
    const o = await getOpportunity(q, ctx, id);
    await checkRefs(q, ctx, input);
    const next = { partner_id: o.partner_id, prospect_name: o.prospect_name, ...input };
    if (!next.partner_id && !next.prospect_name) throw new BusinessError("Indica el cliente o, si todavía no lo es, su nombre");
    const cols = OPP_FIELDS.filter((f) => input[f] !== undefined);
    if (!cols.length) throw new BusinessError("Nada que actualizar", 400);
    await q.query(`update opportunity set ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`, [id, ...cols.map((f) => input[f])]);
    await log(q, ctx, "opportunity", id, "update", input);
    return getOpportunity(q, ctx, id);
  });
}

async function setStageTx(q: Queryable, ctx: Ctx, id: string, stage: Stage, lostReason?: string | null) {
  const [o] = await q.query<{ stage: Stage; probability: number | null }>("select stage, probability from opportunity where id = $1 and company_id = $2 for update", [id, ctx.company]);
  if (!o) throw notFound("Oportunidad");
  if (o.stage === stage) return;
  if (stage === "lost" && !lostReason?.trim()) throw new BusinessError("Indica por qué se ha perdido: sirve para aprender");
  const closed = stage === "won" || stage === "lost";
  // Al cambiar de etapa la probabilidad sigue a la etapa, salvo en las abiertas si ya era mayor.
  const prob = closed ? PROB[stage] : Math.max(PROB[stage], OPEN.includes(o.stage) ? (o.probability ?? 0) : 0);
  await q.query(
    `update opportunity set stage = $2, probability = $3, lost_reason = $4, closed_at = $5, updated_at = now() where id = $1`,
    [id, stage, prob, stage === "lost" ? lostReason!.trim() : null, closed ? new Date().toISOString() : null],
  );
  await log(q, ctx, "opportunity", id, "stage", { from: o.stage, to: stage, lost_reason: lostReason ?? undefined });
}

export async function setOpportunityStage(db: Db, ctx: Ctx, id: string, stage: Stage, lostReason?: string | null) {
  return db.tx(async (q) => {
    await setStageTx(q, ctx, id, stage, lostReason);
    return getOpportunity(q, ctx, id);
  });
}

/** Da de alta como cliente a quien todavía no lo era, con lo que se sabe de la oportunidad. */
export async function opportunityToPartner(db: Db, ctx: Ctx, id: string, extra: { tax_id?: string | null } = {}) {
  const o = await getOpportunity(db, ctx, id);
  if (o.partner_id) throw new BusinessError("Esta oportunidad ya es de un cliente", 409);
  const partner = await createPartner(db, ctx, {
    name: o.prospect_name,
    email: o.email ?? undefined,
    phone: o.phone ?? undefined,
    tax_id: extra.tax_id ?? undefined,
    sales_rep_id: o.sales_rep_id ?? undefined,
    notes: o.contact_name ? `Contacto: ${o.contact_name}` : undefined,
  });
  await db.tx(async (q) => {
    await q.query("update opportunity set partner_id = $2, updated_at = now() where id = $1", [id, partner!.id]);
    if (o.contact_name)
      await q.query("insert into partner_contact (partner_id, name, email, phone) values ($1, $2, $3, $4)", [partner!.id, o.contact_name, o.email, o.phone]);
    await log(q, ctx, "opportunity", id, "partner", { partner_id: partner!.id });
  });
  return getOpportunity(db, ctx, id);
}

// Actividades ------------------------------------------------------------------------

export interface ActivityInput {
  kind?: "call" | "email" | "meeting" | "task" | "note";
  subject: string;
  due_date?: string | null;
  notes?: string | null;
  done?: boolean;
}

/** Lo pendiente de la empresa (o de una oportunidad), con lo vencido primero. */
export async function listActivities(q: Queryable, ctx: Ctx, f: { pending?: boolean } = {}) {
  return q.query(
    `select a.*, o.number as opportunity_number, o.title as opportunity_title, coalesce(p.trade_name, p.name, o.prospect_name) as customer_name
     from crm_activity a left join opportunity o on o.id = a.opportunity_id left join partner p on p.id = coalesce(a.partner_id, o.partner_id)
     where a.company_id = $1 and (not $2 or a.done_at is null)
     order by a.done_at is not null, a.due_date nulls last, a.created_at limit 300`,
    [ctx.company, !!f.pending],
  );
}

export async function addActivity(db: Db, ctx: Ctx, opportunityId: string, a: ActivityInput) {
  return db.tx(async (q) => {
    const [o] = await q.query<{ partner_id: string | null }>("select partner_id from opportunity where id = $1 and company_id = $2", [opportunityId, ctx.company]);
    if (!o) throw notFound("Oportunidad");
    // Una nota es algo que ya ha pasado: nace hecha.
    const done = a.done ?? a.kind === "note";
    const [row] = await q.query<{ id: string }>(
      `insert into crm_activity (company_id, opportunity_id, partner_id, kind, subject, due_date, notes, done_at, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [ctx.company, opportunityId, o.partner_id, a.kind ?? "task", a.subject, a.due_date ?? null, a.notes ?? null, done ? new Date().toISOString() : null, ctx.actor],
    );
    // Contactar con quien estaba «nueva» la pasa a «contactada».
    if (["call", "email", "meeting"].includes(a.kind ?? "") && done) {
      const [cur] = await q.query<{ stage: Stage }>("select stage from opportunity where id = $1", [opportunityId]);
      if (cur?.stage === "new") await setStageTx(q, ctx, opportunityId, "contacted");
    }
    await q.query("update opportunity set updated_at = now() where id = $1", [opportunityId]);
    await log(q, ctx, "crm_activity", row!.id, "create", a);
    return row;
  });
}

export async function updateActivity(db: Db, ctx: Ctx, id: string, a: Partial<ActivityInput>) {
  return db.tx(async (q) => {
    const [cur] = await q.query("select * from crm_activity where id = $1 and company_id = $2", [id, ctx.company]);
    if (!cur) throw notFound("Actividad");
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const f of ["kind", "subject", "due_date", "notes"] as const)
      if (a[f] !== undefined) {
        vals.push(a[f]);
        sets.push(`${f} = $${vals.length + 1}`);
      }
    if (a.done !== undefined) {
      vals.push(a.done ? new Date().toISOString() : null);
      sets.push(`done_at = $${vals.length + 1}`);
    }
    if (!sets.length) throw new BusinessError("Nada que actualizar", 400);
    const [row] = await q.query(`update crm_activity set ${sets.join(", ")} where id = $1 returning *`, [id, ...vals]);
    await log(q, ctx, "crm_activity", id, "update", a);
    return row;
  });
}

export async function deleteActivity(db: Db, ctx: Ctx, id: string) {
  return db.tx(async (q) => {
    const [row] = await q.query("delete from crm_activity where id = $1 and company_id = $2 returning id", [id, ctx.company]);
    if (!row) throw notFound("Actividad");
    await log(q, ctx, "crm_activity", id, "delete");
    return { ok: true };
  });
}

// Modelos de presupuesto -------------------------------------------------------------

export interface TemplateInput {
  name: string;
  title: string;
  intro?: string | null;
  conditions?: string | null;
  validity_days?: number;
  active?: boolean;
}
const TEMPLATE_FIELDS = ["name", "title", "intro", "conditions", "validity_days", "active"] as const;

/** Modelos con los que empieza cada empresa. Son un punto de partida: se cambian en Presupuestos → Modelos. */
export const MODELOS_DE_PARTIDA: TemplateInput[] = [
  {
    name: "Proyecto",
    title: "Presupuesto de proyecto",
    intro: "Te presentamos el presupuesto para el proyecto que hemos hablado. Abajo tienes el detalle de las tareas, el tiempo estimado y el importe de cada una.",
    conditions: [
      "- Forma de pago: 50 % al aceptar el presupuesto y 50 % a la entrega.",
      "- Los importes no incluyen IVA, que se añade en la factura.",
      "- Lo que no figura en este presupuesto, o los cambios de alcance, se presupuestan aparte.",
      "- Para aceptarlo basta con responder por escrito o devolverlo firmado.",
    ].join("\n"),
    validity_days: 30,
  },
  {
    name: "Soporte",
    title: "Propuesta de soporte",
    intro: "Te proponemos un servicio de soporte y mantenimiento con estas condiciones.",
    conditions: [
      "- Se factura al principio de cada mes. Las horas de la bolsa que no se usan no pasan al mes siguiente.",
      "- Las horas por encima de la bolsa se facturan a la tarifa indicada.",
      "- Tiempo de respuesta: el siguiente día laborable.",
      "- Se renueva cada mes; se puede dar de baja avisando con 30 días.",
      "- Los importes no incluyen IVA.",
    ].join("\n"),
    validity_days: 30,
  },
  {
    name: "Servicios",
    title: "Presupuesto de servicios",
    intro: "Este es el presupuesto de los servicios que nos has pedido.",
    conditions: ["- Forma de pago: a la entrega del trabajo.", "- Los importes no incluyen IVA."].join("\n"),
    validity_days: 15,
  },
];

async function ensureTemplates(q: Queryable, ctx: Ctx) {
  const [any] = await q.query("select 1 from quotation_template where company_id = maestro($1) limit 1", [ctx.company]);
  if (any) return;
  for (const t of MODELOS_DE_PARTIDA)
    await q.query(
      "insert into quotation_template (company_id, name, title, intro, conditions, validity_days) values (maestro($1),$2,$3,$4,$5,$6) on conflict do nothing",
      [ctx.company, t.name, t.title, t.intro, t.conditions, t.validity_days],
    );
}

export async function listTemplates(db: Db, ctx: Ctx, opts: { all?: boolean } = {}) {
  return db.tx(async (q) => {
    await ensureTemplates(q, ctx);
    return q.query("select * from quotation_template where company_id = maestro($1) and ($2 or active) order by name", [ctx.company, !!opts.all]);
  });
}

export async function createTemplate(db: Db, ctx: Ctx, t: TemplateInput) {
  return db.tx(async (q) => {
    const cols = TEMPLATE_FIELDS.filter((f) => t[f] !== undefined);
    const [row] = await q.query(
      `insert into quotation_template (company_id, ${cols.join(",")}) values (maestro($1), ${cols.map((_, i) => `$${i + 2}`).join(",")}) returning *`,
      [ctx.company, ...cols.map((f) => t[f])],
    );
    await log(q, ctx, "quotation_template", row!.id as string, "create", t);
    return row;
  });
}

export async function updateTemplate(db: Db, ctx: Ctx, id: string, t: Partial<TemplateInput>) {
  return db.tx(async (q) => {
    const cols = TEMPLATE_FIELDS.filter((f) => t[f] !== undefined);
    if (!cols.length) throw new BusinessError("Nada que actualizar", 400);
    const [row] = await q.query(
      `update quotation_template set ${cols.map((c, i) => `${c} = $${i + 3}`).join(", ")} where id = $1 and company_id = maestro($2) returning *`,
      [id, ctx.company, ...cols.map((f) => t[f])],
    );
    if (!row) throw notFound("Modelo de presupuesto");
    await log(q, ctx, "quotation_template", id, "update", t);
    return row;
  });
}

// Presupuestos -----------------------------------------------------------------------

export interface QuotationLineInput {
  product_id: string;
  quantity: string;
  unit_price?: string;
  discount_pct?: string;
  description?: string;
}

export interface QuotationInput {
  partner_id?: string;
  opportunity_id?: string | null;
  template_id?: string | null;
  title?: string;
  intro?: string | null;
  conditions?: string | null;
  quote_date?: string;
  valid_until?: string | null;
  sales_rep_id?: string | null;
  notes?: string | null;
  lines?: QuotationLineInput[];
}

const QUOTE_UNTAXED = `(select coalesce(sum(round(l.quantity * l.unit_price * (1 - l.discount_pct/100), 2)), 0) from quotation_line l where l.quotation_id = qt.id)::text`;

export async function listQuotations(q: Queryable, ctx: Ctx, f: { state?: string; partner_id?: string } = {}) {
  return q.query(
    `select qt.*, coalesce(p.trade_name, p.name) as partner_name, r.name as sales_rep_name, o.number as order_number, op.number as opportunity_number,
       ${QUOTE_UNTAXED} as untaxed,
       (qt.state in ('draft', 'sent') and qt.valid_until < current_date) as expired
     from quotation qt join partner p on p.id = qt.partner_id left join sales_rep r on r.id = qt.sales_rep_id
     left join sales_order o on o.id = qt.order_id left join opportunity op on op.id = qt.opportunity_id
     where qt.company_id = $1 and ($2::text is null or qt.state = $2) and ($3::uuid is null or qt.partner_id = $3)
     order by qt.created_at desc limit 500`,
    [ctx.company, f.state || null, f.partner_id || null],
  );
}

export async function getQuotation(q: Queryable, ctx: Ctx, id: string) {
  const [qt] = await q.query(
    `select qt.*, coalesce(p.trade_name, p.name) as partner_name, r.name as sales_rep_name, o.number as order_number,
       op.number as opportunity_number, op.title as opportunity_title, t.name as template_name,
       (qt.state in ('draft', 'sent') and qt.valid_until < current_date) as expired
     from quotation qt join partner p on p.id = qt.partner_id left join sales_rep r on r.id = qt.sales_rep_id
     left join sales_order o on o.id = qt.order_id left join opportunity op on op.id = qt.opportunity_id
     left join quotation_template t on t.id = qt.template_id
     where qt.id = $1 and qt.company_id = $2`,
    [id, ctx.company],
  );
  if (!qt) throw notFound("Presupuesto");
  const lines = await q.query(
    "select l.*, pr.sku, pr.uom, pr.kind from quotation_line l join product pr on pr.id = l.product_id where l.quotation_id = $1 order by l.position",
    [id],
  );
  const [partner] = await q.query<{ surcharge_regime: boolean; withholding_rate: string }>("select * from partner where id = $1", [qt.partner_id]);
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
  const actions: string[] = QuotationMachine.actions(qt.state as QuotationState);
  return { ...qt, lines, totals, actions } as Record<string, any>;
}

async function writeLines(q: Queryable, ctx: Ctx, quotationId: string, lines: QuotationLineInput[], discountDefault: string | null) {
  await q.query("delete from quotation_line where quotation_id = $1", [quotationId]);
  let pos = 1;
  const [qt] = await q.query<{ partner_id: string }>("select partner_id from quotation where id = $1", [quotationId]);
  for (const l of lines) {
    const [p] = await q.query<{ name: string; sale_price: string; vat_rate: string }>("select * from product where id = $1 and company_id = maestro($2)", [l.product_id, ctx.company]);
    if (!p) throw notFound("Producto");
    if (D(l.quantity).cmp(0) <= 0) throw new BusinessError("Cantidad no válida");
    await q.query(
      `insert into quotation_line (quotation_id, position, product_id, description, quantity, unit_price, discount_pct, vat_rate)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [quotationId, pos++, l.product_id, l.description?.trim() || p.name, l.quantity, l.unit_price ?? (await priceFor(q, qt!.partner_id, l.product_id, p.sale_price)), l.discount_pct ?? discountDefault ?? "0", p.vat_rate],
    );
  }
}

const addDays = (isoDate: string, days: number) => {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);

export async function createQuotation(db: Db, ctx: Ctx, input: QuotationInput) {
  if (!input.lines?.length) throw new BusinessError("El presupuesto necesita al menos una línea");
  return db.tx(async (q) => {
    await ensureTemplates(q, ctx);
    let partnerId = input.partner_id;
    let opp: { id: string; partner_id: string | null; stage: Stage; sales_rep_id: string | null } | undefined;
    if (input.opportunity_id) {
      [opp] = await q.query("select id, partner_id, stage, sales_rep_id from opportunity where id = $1 and company_id = $2", [input.opportunity_id, ctx.company]);
      if (!opp) throw notFound("Oportunidad");
      if (!opp.partner_id) throw new BusinessError("Da de alta antes como cliente a quien es la oportunidad: el presupuesto lleva sus datos", 409);
      if (partnerId && partnerId !== opp.partner_id) throw new BusinessError("El presupuesto y la oportunidad tienen que ser del mismo cliente");
      partnerId = opp.partner_id;
    }
    if (!partnerId) throw new BusinessError("Indica el cliente");
    const [partner] = await q.query<{ sales_rep_id: string | null; discount_pct: string | null }>(
      "select * from partner where id = $1 and company_id = maestro($2)",
      [partnerId, ctx.company],
    );
    if (!partner) throw notFound("Cliente");
    const rep = input.sales_rep_id === undefined ? opp?.sales_rep_id ?? (await repFor(q, ctx, partner.sales_rep_id)) : input.sales_rep_id;
    await checkRefs(q, ctx, { sales_rep_id: rep });

    // El modelo pone título, textos y validez; lo que venga escrito manda sobre el modelo.
    const [tpl] = input.template_id
      ? await q.query<TemplateInput & { id: string }>("select * from quotation_template where id = $1 and company_id = maestro($2)", [input.template_id, ctx.company])
      : [undefined];
    if (input.template_id && !tpl) throw notFound("Modelo de presupuesto");
    const date = input.quote_date ?? today();
    const title = input.title?.trim() || tpl?.title || "Presupuesto";
    const validUntil = input.valid_until === undefined ? addDays(date, tpl?.validity_days ?? 30) : input.valid_until;

    const number = await nextNumber(q, ctx, "quotation", "PR");
    const [row] = await q.query<{ id: string }>(
      `insert into quotation (company_id, number, partner_id, opportunity_id, template_id, title, intro, conditions, quote_date, valid_until, sales_rep_id, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [
        ctx.company, number, partnerId, opp?.id ?? null, tpl?.id ?? null, title,
        input.intro === undefined ? tpl?.intro ?? null : input.intro,
        input.conditions === undefined ? tpl?.conditions ?? null : input.conditions,
        date, validUntil, rep ?? null, input.notes ?? null,
      ],
    );
    await writeLines(q, ctx, row!.id, input.lines!, partner.discount_pct);
    // Hacer un presupuesto lleva la oportunidad a «propuesta».
    if (opp && (opp.stage === "new" || opp.stage === "contacted")) await setStageTx(q, ctx, opp.id, "proposal");
    await log(q, ctx, "quotation", row!.id, "create", { number });
    return getQuotation(q, ctx, row!.id);
  });
}

/** Cambiar un presupuesto: solo en borrador (uno enviado se vuelve antes a borrador). */
export async function updateQuotation(db: Db, ctx: Ctx, id: string, input: QuotationInput) {
  return db.tx(async (q) => {
    const qt = await getQuotation(q, ctx, id);
    if (qt.state !== "draft") throw new BusinessError("Solo se cambia un presupuesto en borrador: vuelve a borrador para corregirlo", 409);
    if (input.partner_id && input.partner_id !== qt.partner_id) throw new BusinessError("El cliente de un presupuesto no se cambia: haz uno nuevo", 409);
    if (input.sales_rep_id) await checkRefs(q, ctx, { sales_rep_id: input.sales_rep_id });
    const fields = (["title", "intro", "conditions", "quote_date", "valid_until", "sales_rep_id", "notes"] as const).filter((f) => input[f] !== undefined);
    if (input.title !== undefined && !input.title?.trim()) throw new BusinessError("El presupuesto necesita un título");
    if (fields.length)
      await q.query(`update quotation set ${fields.map((f, i) => `${f} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`, [id, ...fields.map((f) => input[f])]);
    if (input.lines) {
      if (!input.lines.length) throw new BusinessError("El presupuesto necesita al menos una línea");
      const [p] = await q.query<{ discount_pct: string | null }>("select discount_pct from partner where id = $1", [qt.partner_id]);
      await writeLines(q, ctx, id, input.lines, p?.discount_pct ?? null);
    }
    await log(q, ctx, "quotation", id, "update", { ...input, lines: input.lines?.length });
    return getQuotation(q, ctx, id);
  });
}

/**
 * Aceptar: se crea el pedido (confirmado) con las mismas líneas y precios, y la oportunidad
 * queda ganada. Rechazar: si la oportunidad no tiene otro presupuesto vivo, queda perdida.
 */
export async function quotationAction(db: Db, ctx: Ctx, id: string, action: QuotationAction, opts: { reason?: string | null } = {}) {
  return db.tx(async (q) => {
    const [cur] = await q.query<{ state: QuotationState; opportunity_id: string | null; valid_until: string | null }>(
      "select state, opportunity_id, valid_until::text from quotation where id = $1 and company_id = $2 for update",
      [id, ctx.company],
    );
    if (!cur) throw notFound("Presupuesto");
    const next = QuotationMachine.next(cur.state, action);
    if (action === "reject" && !opts.reason?.trim()) throw new BusinessError("Indica por qué lo ha rechazado");
    if (action === "send") {
      const [n] = await q.query<{ n: number }>("select count(*)::int as n from quotation_line where quotation_id = $1", [id]);
      if (!n?.n) throw new BusinessError("El presupuesto no tiene líneas");
    }
    if (action === "accept" && cur.valid_until && cur.valid_until < today())
      throw new BusinessError(`Este presupuesto caducó el ${cur.valid_until.split("-").reverse().join("/")}: amplía la validez (vuelve a borrador) o haz uno nuevo`, 409);

    await q.query("update quotation set state = $2, reject_reason = $3, updated_at = now() where id = $1", [id, next, action === "reject" ? opts.reason!.trim() : null]);
    await log(q, ctx, "quotation", id, action, { from: cur.state, to: next, reason: opts.reason ?? undefined });

    if (action === "accept") {
      const qt = await getQuotation(q, ctx, id);
      const number = await nextNumber(q, ctx, "sales_order", "PV");
      const [addr] = await q.query<{ id: string }>("select id from partner_address where partner_id = $1 and is_default limit 1", [qt.partner_id]);
      const [o] = await q.query<{ id: string }>(
        `insert into sales_order (company_id, number, partner_id, state, sales_rep_id, delivery_address_id, notes, quotation_id)
         values ($1,$2,$3,'confirmed',$4,$5,$6,$7) returning id`,
        [ctx.company, number, qt.partner_id, qt.sales_rep_id, addr?.id ?? null, `Presupuesto ${qt.number}${qt.notes ? ` · ${qt.notes}` : ""}`, id],
      );
      for (const l of qt.lines)
        await q.query(
          `insert into sales_order_line (order_id, position, product_id, description, quantity, unit_price, discount_pct, vat_rate)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [o!.id, l.position, l.product_id, l.description, l.quantity, l.unit_price, l.discount_pct, l.vat_rate],
        );
      await q.query("update quotation set order_id = $2 where id = $1", [id, o!.id]);
      await log(q, ctx, "sales_order", o!.id, "create", { number, quotation: qt.number });
      if (qt.opportunity_id) {
        await q.query("update opportunity set amount = coalesce(amount, $2::numeric) where id = $1", [qt.opportunity_id, qt.totals.untaxed]);
        await setStageTx(q, ctx, qt.opportunity_id, "won");
      }
    }
    if (action === "reject" && cur.opportunity_id) {
      const [vivo] = await q.query(
        "select 1 from quotation where opportunity_id = $1 and id <> $2 and state in ('draft', 'sent', 'accepted') limit 1",
        [cur.opportunity_id, id],
      );
      const [opp] = await q.query<{ stage: Stage }>("select stage from opportunity where id = $1", [cur.opportunity_id]);
      if (!vivo && opp && OPEN.includes(opp.stage)) await setStageTx(q, ctx, cur.opportunity_id, "lost", `Presupuesto rechazado: ${opts.reason!.trim()}`);
    }
    return getQuotation(q, ctx, id);
  });
}

/** Copia de un presupuesto (otra versión, otro año…) en borrador, con fecha y validez de hoy. */
export async function duplicateQuotation(db: Db, ctx: Ctx, id: string) {
  const qt = await getQuotation(db, ctx, id);
  const days = qt.valid_until && qt.quote_date ? Math.round((Date.parse(String(qt.valid_until)) - Date.parse(String(qt.quote_date))) / 86_400_000) : 30;
  return createQuotation(db, ctx, {
    partner_id: qt.partner_id,
    opportunity_id: qt.opportunity_id && ["won", "lost"].includes((await getOpportunity(db, ctx, qt.opportunity_id)).stage) ? null : qt.opportunity_id,
    template_id: qt.template_id,
    title: qt.title,
    intro: qt.intro,
    conditions: qt.conditions,
    valid_until: addDays(today(), Math.max(1, days)),
    sales_rep_id: qt.sales_rep_id,
    notes: qt.notes,
    lines: qt.lines.map((l: Record<string, string>) => ({
      product_id: l.product_id, quantity: l.quantity, unit_price: l.unit_price, discount_pct: l.discount_pct, description: l.description,
    })),
  });
}

/** Lo que se ve en Inicio y en el CRM: embudo, presupuestos por contestar y tareas vencidas. */
export async function crmSummary(q: Queryable, ctx: Ctx) {
  const [r] = await q.query<Record<string, string>>(
    `select
       (select count(*) from opportunity where company_id = $1 and stage in ('new', 'contacted', 'proposal'))::text as open_opportunities,
       (select coalesce(sum(amount * coalesce(probability, 0) / 100), 0) from opportunity where company_id = $1 and stage in ('new', 'contacted', 'proposal'))::text as weighted,
       (select count(*) from quotation where company_id = $1 and state = 'sent')::text as quotations_sent,
       (select count(*) from crm_activity where company_id = $1 and done_at is null and due_date <= current_date)::text as activities_due`,
    [ctx.company],
  );
  return r;
}
