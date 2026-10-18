import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, migrate, openEmbedded, type Db } from "../src/index.js";

describe("CRM: oportunidad → presupuesto → pedido", () => {
  let db: Db;
  let app: FastifyInstance;
  const call = async (method: string, url: string, body?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, payload: body as object });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };

  beforeAll(async () => {
    db = await openEmbedded();
    await migrate(db);
    app = await buildApp({ db });
    await call("PUT", "/api/v1/company", { name: "Servicios Demo SL", tax_id: "B12345674" });
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  let opp: string, horas: string, quote: string, models: { id: string; name: string; title: string; validity_days: number }[];

  it("crea una oportunidad de alguien que todavía no es cliente", async () => {
    expect((await call("POST", "/api/v1/opportunities", { title: "Sin nadie" })).status).toBe(422);
    const r = await call("POST", "/api/v1/opportunities", {
      title: "Web nueva",
      prospect_name: "Taller Sur SL",
      contact_name: "Ana",
      email: "ana@example.test",
      amount: "3000",
    });
    expect(r.status).toBe(201);
    opp = r.body.id;
    expect(r.body.number).toMatch(/^OP\d{4}-00001$/);
    expect(r.body.stage).toBe("new");
    expect(r.body.probability).toBe(10);
  });

  it("una llamada hecha la pasa a contactada; una tarea queda pendiente", async () => {
    await call("POST", `/api/v1/opportunities/${opp}/activities`, { kind: "call", subject: "Primera llamada", done: true });
    const t = await call("POST", `/api/v1/opportunities/${opp}/activities`, { kind: "task", subject: "Enviar propuesta", due_date: "2020-01-01" });
    expect(t.status).toBe(201);
    const o = (await call("GET", `/api/v1/opportunities/${opp}`)).body;
    expect(o.stage).toBe("contacted");
    expect(o.activities).toHaveLength(2);
    const pend = (await call("GET", "/api/v1/crm/activities?pendientes=1")).body;
    expect(pend).toHaveLength(1);
    expect((await call("GET", "/api/v1/crm/summary")).body.activities_due).toBe("1");
    expect((await call("PATCH", `/api/v1/crm/activities/${t.body.id}`, { done: true })).body.done_at).toBeTruthy();
  });

  it("perder exige motivo", async () => {
    expect((await call("POST", `/api/v1/opportunities/${opp}/stage`, { stage: "lost" })).status).toBe(422);
  });

  it("trae los modelos de partida y se pueden cambiar", async () => {
    models = (await call("GET", "/api/v1/quotation-templates")).body;
    expect(models.map((m) => m.name)).toEqual(["Proyecto", "Servicios", "Soporte"]);
    const soporte = models.find((m) => m.name === "Soporte")!;
    const r = await call("PATCH", `/api/v1/quotation-templates/${soporte.id}`, { validity_days: 20 });
    expect(r.body.validity_days).toBe(20);
  });

  it("no deja presupuestar sin dar de alta el cliente", async () => {
    horas = (await call("POST", "/api/v1/products", { sku: "HORA", name: "Hora de desarrollo", kind: "service", sale_price: "50", vat_rate: "21" })).body.id;
    const r = await call("POST", "/api/v1/quotations", { opportunity_id: opp, lines: [{ product_id: horas, quantity: "10" }] });
    expect(r.status).toBe(409);
    const o = await call("POST", `/api/v1/opportunities/${opp}/partner`, { tax_id: "A58818501" });
    expect(o.status).toBe(201);
    expect(o.body.partner_id).toBeTruthy();
    expect(o.body.customer_name).toBe("Taller Sur SL");
  });

  it("crea el presupuesto desde el modelo y la oportunidad pasa a propuesta", async () => {
    const proyecto = models.find((m) => m.name === "Proyecto")!;
    const r = await call("POST", "/api/v1/quotations", {
      opportunity_id: opp,
      template_id: proyecto.id,
      quote_date: "2030-01-10",
      lines: [{ product_id: horas, quantity: "40", description: "Diseño y desarrollo" }],
    });
    expect(r.status).toBe(201);
    quote = r.body.id;
    expect(r.body.number).toMatch(/^PR\d{4}-00001$/);
    expect(r.body.title).toBe(proyecto.title);
    expect(r.body.conditions).toMatch(/50 %/);
    expect(r.body.valid_until).toBe("2030-02-09");
    expect(r.body.totals.untaxed).toBe("2000.00");
    expect(r.body.totals.total).toBe("2420.00");
    expect(r.body.actions).toEqual(["send", "accept", "cancel"]);
    expect((await call("GET", `/api/v1/opportunities/${opp}`)).body.stage).toBe("proposal");
  });

  it("se cambia en borrador; enviado ya no, hasta volver a borrador", async () => {
    expect((await call("PUT", `/api/v1/quotations/${quote}`, { lines: [{ product_id: horas, quantity: "50" }] })).body.totals.untaxed).toBe("2500.00");
    expect((await call("POST", `/api/v1/quotations/${quote}/send`)).body.state).toBe("sent");
    expect((await call("PUT", `/api/v1/quotations/${quote}`, { title: "Otro" })).status).toBe(409);
    expect((await call("POST", `/api/v1/quotations/${quote}/reject`, {})).status).toBe(422);
    expect((await call("GET", "/api/v1/crm/summary")).body.quotations_sent).toBe("1");
  });

  it("aceptar crea el pedido confirmado y gana la oportunidad", async () => {
    const r = await call("POST", `/api/v1/quotations/${quote}/accept`);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("accepted");
    expect(r.body.order_number).toMatch(/^PV\d{4}-00001$/);
    const order = (await call("GET", `/api/v1/sales-orders/${r.body.order_id}`)).body;
    expect(order.state).toBe("confirmed");
    expect(order.totals.untaxed).toBe("2500.00");
    const o = (await call("GET", `/api/v1/opportunities/${opp}`)).body;
    expect(o.stage).toBe("won");
    expect(o.probability).toBe(100);
    expect((await call("POST", `/api/v1/quotations/${quote}/cancel`)).status).toBe(409);
    // El pedido de servicios sigue su camino hasta la factura.
    expect((await call("POST", `/api/v1/sales-orders/${r.body.order_id}/deliver`)).status).toBe(200);
    expect((await call("POST", `/api/v1/sales-orders/${r.body.order_id}/invoice`)).status).toBe(200);
  });

  it("duplica un presupuesto en borrador; rechazarlo pierde la oportunidad abierta", async () => {
    const o2 = (await call("POST", "/api/v1/opportunities", { title: "Soporte anual", partner_id: (await call("GET", `/api/v1/opportunities/${opp}`)).body.partner_id })).body;
    const q2 = (await call("POST", "/api/v1/quotations", { opportunity_id: o2.id, lines: [{ product_id: horas, quantity: "5" }] })).body;
    const copia = await call("POST", `/api/v1/quotations/${q2.id}/duplicate`);
    expect(copia.status).toBe(201);
    expect(copia.body.state).toBe("draft");
    expect(copia.body.number).not.toBe(q2.number);
    await call("POST", `/api/v1/quotations/${copia.body.id}/cancel`);
    await call("POST", `/api/v1/quotations/${q2.id}/send`);
    expect((await call("POST", `/api/v1/quotations/${q2.id}/reject`, { reason: "Caro" })).body.state).toBe("rejected");
    const lost = (await call("GET", `/api/v1/opportunities/${o2.id}`)).body;
    expect(lost.stage).toBe("lost");
    expect(lost.lost_reason).toMatch(/Caro/);
    const list = (await call("GET", "/api/v1/opportunities")).body;
    expect(list.funnel.won.count).toBe(1);
    expect(list.funnel.lost.count).toBe(1);
  });

  it("no acepta un presupuesto caducado", async () => {
    const pid = (await call("GET", `/api/v1/opportunities/${opp}`)).body.partner_id;
    const q3 = (await call("POST", "/api/v1/quotations", { partner_id: pid, quote_date: "2020-01-01", lines: [{ product_id: horas, quantity: "1" }] })).body;
    expect(q3.expired).toBe(true);
    expect((await call("POST", `/api/v1/quotations/${q3.id}/accept`)).status).toBe(409);
  });
});
