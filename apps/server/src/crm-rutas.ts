/**
 * Rutas HTTP del CRM: oportunidades, actividades, modelos de presupuesto y presupuestos.
 * Están aparte para que el CRM (Brokkr) pueda salir de Sindri como módulo sin tocar el resto de la API.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "./db.js";
import * as crm from "./crm.js";
import { ctxOf } from "./usuarios.js";
import { confirmacionAutomatica, type MailConfig } from "./correo.js";
import type { ReportServerConfig } from "./documentos.js";

const dec = z.union([z.string(), z.number()]).transform(String).refine((v) => /^-?\d+([.,]\d+)?$/.test(v.trim()), "Número no válido");
const optText = z.string().trim().min(1).nullish();
const optDec = dec.nullish();

const OpportunitySchema = z.object({
  title: z.string().trim().min(1),
  partner_id: z.uuid().nullish(),
  prospect_name: optText,
  contact_name: optText,
  email: optText,
  phone: optText,
  amount: optDec,
  probability: z.number().int().min(0).max(100).nullish(),
  expected_close: z.iso.date().nullish(),
  sales_rep_id: z.uuid().nullish(),
  source: optText,
  notes: optText,
});
const ActivitySchema = z.object({
  kind: z.enum(["call", "email", "meeting", "task", "note"]).optional(),
  subject: z.string().trim().min(1),
  due_date: z.iso.date().nullish(),
  notes: optText,
  done: z.boolean().optional(),
});
const TemplateSchema = z.object({
  name: z.string().trim().min(1),
  title: z.string().trim().min(1),
  intro: z.string().nullish(),
  conditions: z.string().nullish(),
  validity_days: z.number().int().min(1).max(365).optional(),
  active: z.boolean().optional(),
});
const QuotationSchema = z.object({
  partner_id: z.uuid().optional(),
  opportunity_id: z.uuid().nullish(),
  template_id: z.uuid().nullish(),
  title: z.string().optional(),
  intro: z.string().nullish(),
  conditions: z.string().nullish(),
  quote_date: z.iso.date().optional(),
  valid_until: z.iso.date().nullish(),
  sales_rep_id: z.uuid().nullish(),
  notes: z.string().nullish(),
  lines: z
    .array(z.object({ product_id: z.uuid(), quantity: dec, unit_price: dec.optional(), discount_pct: dec.optional(), description: z.string().optional() }))
    .optional(),
});
const ReasonSchema = z.object({ reason: z.string().nullish() }).default({});

type IdParams = { Params: { id: string } };

export function registerCrm(app: FastifyInstance, db: Db, opts: { mail?: MailConfig; reportServer?: ReportServerConfig }) {
  const { mail, reportServer } = opts;
  // CRM: oportunidades con su embudo y actividades de seguimiento.
  app.get<{ Querystring: { stage?: string; sales_rep_id?: string; partner_id?: string } }>("/api/v1/opportunities", async (req) => crm.listOpportunities(db, ctxOf(req), req.query));
  app.post("/api/v1/opportunities", async (req, reply) => reply.status(201).send(await crm.createOpportunity(db, ctxOf(req), OpportunitySchema.parse(req.body))));
  app.get<IdParams>("/api/v1/opportunities/:id", async (req) => crm.getOpportunity(db, ctxOf(req), req.params.id));
  app.patch<IdParams>("/api/v1/opportunities/:id", async (req) => crm.updateOpportunity(db, ctxOf(req), req.params.id, OpportunitySchema.partial().parse(req.body)));
  app.post<IdParams>("/api/v1/opportunities/:id/stage", async (req) => {
    const b = z.object({ stage: z.enum(crm.STAGES), lost_reason: z.string().nullish() }).parse(req.body);
    return crm.setOpportunityStage(db, ctxOf(req), req.params.id, b.stage, b.lost_reason);
  });
  app.post<IdParams>("/api/v1/opportunities/:id/partner", async (req, reply) =>
    reply.status(201).send(await crm.opportunityToPartner(db, ctxOf(req), req.params.id, z.object({ tax_id: optText }).default({}).parse(req.body ?? {}))),
  );
  app.post<IdParams>("/api/v1/opportunities/:id/activities", async (req, reply) => reply.status(201).send(await crm.addActivity(db, ctxOf(req), req.params.id, ActivitySchema.parse(req.body))));
  app.get<{ Querystring: { pendientes?: string } }>("/api/v1/crm/activities", async (req) => crm.listActivities(db, ctxOf(req), { pending: req.query.pendientes === "1" }));
  app.patch<IdParams>("/api/v1/crm/activities/:id", async (req) => crm.updateActivity(db, ctxOf(req), req.params.id, ActivitySchema.partial().parse(req.body)));
  app.delete<IdParams>("/api/v1/crm/activities/:id", async (req) => crm.deleteActivity(db, ctxOf(req), req.params.id));
  app.get("/api/v1/crm/summary", async (req) => crm.crmSummary(db, ctxOf(req)));


  // Presupuestos: salen de un modelo y, aceptados, se convierten en pedido.
  app.get<{ Querystring: { todos?: string } }>("/api/v1/quotation-templates", async (req) => crm.listTemplates(db, ctxOf(req), { all: req.query.todos === "1" }));
  app.post("/api/v1/quotation-templates", async (req, reply) => reply.status(201).send(await crm.createTemplate(db, ctxOf(req), TemplateSchema.parse(req.body))));
  app.patch<IdParams>("/api/v1/quotation-templates/:id", async (req) => crm.updateTemplate(db, ctxOf(req), req.params.id, TemplateSchema.partial().parse(req.body)));
  app.get<{ Querystring: { state?: string; partner_id?: string } }>("/api/v1/quotations", async (req) => crm.listQuotations(db, ctxOf(req), req.query));
  app.post("/api/v1/quotations", async (req, reply) => reply.status(201).send(await crm.createQuotation(db, ctxOf(req), QuotationSchema.parse(req.body))));
  app.get<IdParams>("/api/v1/quotations/:id", async (req) => crm.getQuotation(db, ctxOf(req), req.params.id));
  app.put<IdParams>("/api/v1/quotations/:id", async (req) => crm.updateQuotation(db, ctxOf(req), req.params.id, QuotationSchema.parse(req.body)));
  for (const action of ["send", "edit", "accept", "reject", "cancel"] as const)
    app.post<IdParams>(`/api/v1/quotations/:id/${action}`, async (req) => {
      const q = await crm.quotationAction(db, ctxOf(req), req.params.id, action, ReasonSchema.parse(req.body ?? {}));
      // Aceptar crea el pedido confirmado: misma confirmación por correo que al confirmar a mano.
      if (action === "accept" && q.order_id) confirmacionAutomatica(db, { mail, reportServer }, ctxOf(req), q.order_id);
      return q;
    });
  app.post<IdParams>("/api/v1/quotations/:id/duplicate", async (req, reply) => reply.status(201).send(await crm.duplicateQuotation(db, ctxOf(req), req.params.id)));
}
