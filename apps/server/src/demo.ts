/**
 * Datos de demostración para un sistema de prueba.
 * Solo se cargan si la base está vacía (sin empresa). Los NIF son inventados,
 * aunque tienen el dígito de control correcto.
 */
import type { Db } from "./db.js";
import * as s from "./services.js";
import * as c from "./comercial.js";
import { saveMachine } from "./planta.js";

const isoDaysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export async function seedDemo(db: Db): Promise<boolean> {
  if (await s.getCompany(db)) return seedDemoComercial(db);

  const empresa = (await s.setupCompany(db, null, {
    name: "Conservas Demo del Norte, S.L.",
    tax_id: "B20128567",
    address: "Polígono Industrial Ibaiondo, nave 4",
    city: "Zarautz",
    postal_code: "20800",
    demo: true,
  })) as { id: string };
  const ctx: s.Ctx = { company: empresa.id, actor: "demo" };

  const clientes = await Promise.all([
    s.createPartner(db, ctx, { kind: "customer", name: "Supermercados Ejemplo, S.A.", tax_id: "A59144956", city: "Barcelona", postal_code: "08020", email: "compras@ejemplo.test" }),
    s.createPartner(db, ctx, { kind: "customer", name: "Ultramarinos La Prueba, S.L.", tax_id: "B42350470", city: "Soria", postal_code: "42002", surcharge_regime: true }),
    s.createPartner(db, ctx, { kind: "customer", name: "Distribuciones Muestra, S.L.", tax_id: "B34182691", city: "Palencia", postal_code: "34004" }),
  ]);
  await s.createPartner(db, ctx, { kind: "supplier", name: "Envases Metálicos Test, S.L.", tax_id: "B82540279", city: "Madrid", postal_code: "28042" });
  await s.createPartner(db, ctx, { kind: "supplier", name: "Lonja Simulada, S.L.", tax_id: "B90419326", city: "Sevilla", postal_code: "41001" });

  // GTIN del rango 20…29 (uso interno de GS1): no coincide con ningún producto real. Sirven para el simulador de PDA.
  const bonito = await s.createProduct(db, ctx, { sku: "BON-250", gtin: "2000000000015", name: "Bonito del norte en aceite de oliva 250 g", sale_price: "4.95", cost_price: "2.60", vat_rate: "10", track_lots: true });
  const anchoa = await s.createProduct(db, ctx, { sku: "ANC-100", gtin: "2000000000022", name: "Anchoas del Cantábrico 100 g", sale_price: "6.80", cost_price: "3.90", vat_rate: "10", track_lots: true });
  const mejillon = await s.createProduct(db, ctx, { sku: "MEJ-120", gtin: "2000000000039", name: "Mejillones en escabeche 120 g", sale_price: "2.75", cost_price: "1.30", vat_rate: "10", track_lots: true });
  const caja = await s.createProduct(db, ctx, { sku: "CAJ-24", gtin: "2000000000046", name: "Caja de cartón para 24 latas", kind: "consumable", sale_price: "0.60", cost_price: "0.35", vat_rate: "21" });
  const portes = await s.createProduct(db, ctx, { sku: "PORTES", name: "Portes", kind: "service", sale_price: "25", vat_rate: "21" });

  const id = (r: unknown) => (r as { id: string }).id;
  await s.receiveStock(db, ctx, { product_id: id(bonito), quantity: "600", unit_cost: "2.60", lot_code: "L-BON-2601", expiry_date: isoDaysFromNow(400) });
  await s.receiveStock(db, ctx, { product_id: id(bonito), quantity: "400", unit_cost: "2.55", lot_code: "L-BON-2588", expiry_date: isoDaysFromNow(120) });
  await s.receiveStock(db, ctx, { product_id: id(anchoa), quantity: "300", unit_cost: "3.90", lot_code: "L-ANC-2602", expiry_date: isoDaysFromNow(200) });
  await s.receiveStock(db, ctx, { product_id: id(mejillon), quantity: "800", unit_cost: "1.30", lot_code: "L-MEJ-2590", expiry_date: isoDaysFromNow(500) });
  await s.receiveStock(db, ctx, { product_id: id(caja), quantity: "1000", unit_cost: "0.35" });

  // Un pedido en cada estado, para que todas las pantallas tengan algo que enseñar.
  const pedido = (partner: unknown, lines: { product_id: string; quantity: string }[]) =>
    s.createSalesOrder(db, ctx, { partner_id: id(partner), lines });

  const cobrado = await pedido(clientes[0], [
    { product_id: id(bonito), quantity: "240" },
    { product_id: id(anchoa), quantity: "48" },
    { product_id: id(portes), quantity: "1" },
  ]);
  await s.confirmSalesOrder(db, ctx, id(cobrado));
  await s.deliverSalesOrder(db, ctx, id(cobrado));
  const f1 = await s.invoiceSalesOrder(db, ctx, id(cobrado));
  const f1e = (await s.issueInvoice(db, ctx, id(f1))) as { id: string; total: string };
  await s.registerPayment(db, ctx, f1e.id, { amount: f1e.total, method: "transferencia" });

  const pendiente = await pedido(clientes[1], [
    { product_id: id(mejillon), quantity: "96" },
    { product_id: id(anchoa), quantity: "24" },
  ]);
  await s.confirmSalesOrder(db, ctx, id(pendiente));
  await s.deliverSalesOrder(db, ctx, id(pendiente));
  const f2 = await s.invoiceSalesOrder(db, ctx, id(pendiente));
  await s.issueInvoice(db, ctx, id(f2));

  const porFacturar = await pedido(clientes[2], [{ product_id: id(bonito), quantity: "120" }]);
  await s.confirmSalesOrder(db, ctx, id(porFacturar));
  await s.deliverSalesOrder(db, ctx, id(porFacturar));

  const porEntregar = await pedido(clientes[0], [
    { product_id: id(mejillon), quantity: "144" },
    { product_id: id(caja), quantity: "6" },
  ]);
  await s.confirmSalesOrder(db, ctx, id(porEntregar));

  await pedido(clientes[2], [{ product_id: id(anchoa), quantity: "36" }]);
  await seedDemoComercial(db);
  return true;
}

/**
 * Comerciales, direcciones de entrega, contactos, una hoja de ruta y una segunda empresa,
 * para enseñar lo de la versión 0.2. Se carga una vez (si no hay ningún comercial), también
 * sobre un DEV que ya tenía los datos de antes.
 */
export async function seedDemoComercial(db: Db): Promise<boolean> {
  const [rep] = await db.query("select 1 from sales_rep limit 1");
  if (rep) return false;
  const first = (await s.getCompany(db)) as { id: string } | null;
  if (!first) return false;
  const ctx: s.Ctx = { company: first.id, actor: "demo" };
  const id = (r: unknown) => (r as { id: string }).id;

  const ana = await c.createSalesRep(db, ctx, { code: "C01", name: "Ana Comercial Demo", zone: "Norte", commission_pct: "3", email: "ana@demo.test" });
  const agente = await c.createSalesRep(db, ctx, { code: "R01", name: "Representaciones Ejemplo, S.L.", kind: "agent", zone: "Cataluña", commission_pct: "5", tax_id: "B66778895" });
  const partners = (await s.listPartners(db, ctx)) as { id: string; name: string; kind: string }[];
  for (const p of partners.filter((x) => x.kind !== "supplier")) {
    const barcelona = p.name.startsWith("Supermercados");
    await s.updatePartner(db, ctx, p.id, {
      sales_rep_id: barcelona ? id(agente) : id(ana),
      payment_method: barcelona ? "Recibo SEPA" : "Transferencia",
      payment_days: barcelona ? 60 : 30,
      route_zone: barcelona ? "Cataluña" : "Castilla",
      province: barcelona ? "Barcelona" : p.name.startsWith("Ultramarinos") ? "Soria" : "Palencia",
    });
    await s.saveContact(db, ctx, p.id, { name: barcelona ? "Marta Compras" : "Javier Pedidos", position: "Compras", phone: "600000000", email: "compras@ejemplo.test" });
    await s.saveAddress(db, ctx, p.id, {
      label: barcelona ? "Plataforma logística" : "Tienda",
      address: barcelona ? "Calle de la Logística, 10" : "Calle Mayor, 1",
      city: barcelona ? "El Prat de Llobregat" : p.name.startsWith("Ultramarinos") ? "Soria" : "Palencia",
      postal_code: barcelona ? "08820" : p.name.startsWith("Ultramarinos") ? "42002" : "34001",
      schedule: "L-V de 7:00 a 13:00",
      is_default: true,
    });
  }
  // Pedidos de antes sin comercial: el del cliente.
  await db.query("update sales_order o set sales_rep_id = p.sales_rep_id from partner p where p.id = o.partner_id and o.sales_rep_id is null and o.company_id = $1", [ctx.company]);

  const listos = (await c.routeCandidates(db, ctx)) as { id: string }[];
  if (listos.length) await c.createRoute(db, ctx, { driver: "Conductor Demo", vehicle: "1234-ABC", zone: "Castilla", order_ids: listos.map((o) => o.id) });

  // Segunda empresa: al entrar, quien trabaja en las dos elige.
  const otra = (await s.createCompany(db, { name: "Metalúrgica Demo del Sur, S.L.", tax_id: "B41234568", city: "Sevilla", postal_code: "41001", demo: true }, "demo")) as { id: string };
  const ctx2: s.Ctx = { company: otra.id, actor: "demo" };
  const cli = await s.createPartner(db, ctx2, { kind: "customer", name: "Talleres Ejemplo Andaluces, S.L.", tax_id: "B91234567", city: "Málaga", postal_code: "29001" });
  const soporte = await s.createProduct(db, ctx2, { sku: "SOP-01", name: "Soporte de acero galvanizado", sale_price: "12.50", cost_price: "7.10", vat_rate: "21" });
  await s.receiveStock(db, ctx2, { product_id: id(soporte), quantity: "500", unit_cost: "7.10" });
  await s.createSalesOrder(db, ctx2, { partner_id: id(cli), lines: [{ product_id: id(soporte), quantity: "40" }] });
  return true;
}


/**
 * La línea del simulador OPC UA (planta/simulador). Sin agente: el token lo crea un
 * administrador en la pantalla de Planta y se asigna la máquina a ese agente.
 */
export async function seedDemoPlanta(db: Db): Promise<boolean> {
  const rows = await db.query("select 1 from plant_machine limit 1");
  if (rows.length > 0) return false;
  const p = "Planta/Linea1/";
  await saveMachine(db, {
    code: "LINEA1",
    name: "Línea 1 de envasado (simulador)",
    namespace_uri: "urn:sindri:simulador",
    tags: [
      { key: "Estado", source: p + "Estado", kind: "state", label: "Estado" },
      { key: "PiezasBuenas", source: p + "PiezasBuenas", kind: "counter", label: "Piezas buenas", unit: "uds" },
      { key: "PiezasMalas", source: p + "PiezasMalas", kind: "counter", label: "Piezas malas", unit: "uds" },
      { key: "Velocidad", source: p + "Velocidad", kind: "value", label: "Velocidad", unit: "uds/min" },
      { key: "TemperaturaHorno", source: p + "TemperaturaHorno", kind: "value", label: "Temperatura del horno", unit: "°C" },
      { key: "OrdenActual", source: p + "OrdenActual", kind: "text", label: "Orden en curso" },
      { key: "Alarma", source: p + "Alarma", kind: "text", label: "Alarma" },
    ],
  });
  return true;
}
