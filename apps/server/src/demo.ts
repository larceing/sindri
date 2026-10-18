/**
 * Datos de demostración para un sistema de prueba.
 * Solo se cargan si la base está vacía (sin empresa). Los NIF son inventados,
 * aunque tienen el dígito de control correcto.
 */
import type { Db } from "./db.js";
import * as s from "./services.js";
import { saveMachine } from "./planta.js";

const isoDaysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export async function seedDemo(db: Db): Promise<boolean> {
  if (await s.getCompany(db)) return false;

  await s.setupCompany(db, {
    name: "Conservas Demo del Norte, S.L.",
    tax_id: "B20128567",
    address: "Polígono Industrial Ibaiondo, nave 4",
    city: "Zarautz",
    postal_code: "20800",
  });

  const clientes = await Promise.all([
    s.createPartner(db, { kind: "customer", name: "Supermercados Ejemplo, S.A.", tax_id: "A59144956", city: "Barcelona", postal_code: "08020", email: "compras@ejemplo.test" }),
    s.createPartner(db, { kind: "customer", name: "Ultramarinos La Prueba, S.L.", tax_id: "B42350470", city: "Soria", postal_code: "42002", surcharge_regime: true }),
    s.createPartner(db, { kind: "customer", name: "Distribuciones Muestra, S.L.", tax_id: "B34182691", city: "Palencia", postal_code: "34004" }),
  ]);
  await s.createPartner(db, { kind: "supplier", name: "Envases Metálicos Test, S.L.", tax_id: "B82540279", city: "Madrid", postal_code: "28042" });
  await s.createPartner(db, { kind: "supplier", name: "Lonja Simulada, S.L.", tax_id: "B90419326", city: "Sevilla", postal_code: "41001" });

  const bonito = await s.createProduct(db, { sku: "BON-250", name: "Bonito del norte en aceite de oliva 250 g", sale_price: "4.95", cost_price: "2.60", vat_rate: "10", track_lots: true });
  const anchoa = await s.createProduct(db, { sku: "ANC-100", name: "Anchoas del Cantábrico 100 g", sale_price: "6.80", cost_price: "3.90", vat_rate: "10", track_lots: true });
  const mejillon = await s.createProduct(db, { sku: "MEJ-120", name: "Mejillones en escabeche 120 g", sale_price: "2.75", cost_price: "1.30", vat_rate: "10", track_lots: true });
  const caja = await s.createProduct(db, { sku: "CAJ-24", name: "Caja de cartón para 24 latas", kind: "consumable", sale_price: "0.60", cost_price: "0.35", vat_rate: "21" });
  const portes = await s.createProduct(db, { sku: "PORTES", name: "Portes", kind: "service", sale_price: "25", vat_rate: "21" });

  const id = (r: unknown) => (r as { id: string }).id;
  await s.receiveStock(db, { product_id: id(bonito), quantity: "600", unit_cost: "2.60", lot_code: "L-BON-2601", expiry_date: isoDaysFromNow(400) });
  await s.receiveStock(db, { product_id: id(bonito), quantity: "400", unit_cost: "2.55", lot_code: "L-BON-2588", expiry_date: isoDaysFromNow(120) });
  await s.receiveStock(db, { product_id: id(anchoa), quantity: "300", unit_cost: "3.90", lot_code: "L-ANC-2602", expiry_date: isoDaysFromNow(200) });
  await s.receiveStock(db, { product_id: id(mejillon), quantity: "800", unit_cost: "1.30", lot_code: "L-MEJ-2590", expiry_date: isoDaysFromNow(500) });
  await s.receiveStock(db, { product_id: id(caja), quantity: "1000", unit_cost: "0.35" });

  // Un pedido en cada estado, para que todas las pantallas tengan algo que enseñar.
  const pedido = (partner: unknown, lines: { product_id: string; quantity: string }[]) =>
    s.createSalesOrder(db, { partner_id: id(partner), lines });

  const cobrado = await pedido(clientes[0], [
    { product_id: id(bonito), quantity: "240" },
    { product_id: id(anchoa), quantity: "48" },
    { product_id: id(portes), quantity: "1" },
  ]);
  await s.confirmSalesOrder(db, id(cobrado));
  await s.deliverSalesOrder(db, id(cobrado));
  const f1 = await s.invoiceSalesOrder(db, id(cobrado));
  const f1e = (await s.issueInvoice(db, id(f1))) as { id: string; total: string };
  await s.registerPayment(db, f1e.id, { amount: f1e.total, method: "transferencia" });

  const pendiente = await pedido(clientes[1], [
    { product_id: id(mejillon), quantity: "96" },
    { product_id: id(anchoa), quantity: "24" },
  ]);
  await s.confirmSalesOrder(db, id(pendiente));
  await s.deliverSalesOrder(db, id(pendiente));
  const f2 = await s.invoiceSalesOrder(db, id(pendiente));
  await s.issueInvoice(db, id(f2));

  const porFacturar = await pedido(clientes[2], [{ product_id: id(bonito), quantity: "120" }]);
  await s.confirmSalesOrder(db, id(porFacturar));
  await s.deliverSalesOrder(db, id(porFacturar));

  const porEntregar = await pedido(clientes[0], [
    { product_id: id(mejillon), quantity: "144" },
    { product_id: id(caja), quantity: "6" },
  ]);
  await s.confirmSalesOrder(db, id(porEntregar));

  await pedido(clientes[2], [{ product_id: id(anchoa), quantity: "36" }]);
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
