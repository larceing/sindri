import { describe, expect, it } from "vitest";
import { buildApp, migrate, openEmbedded } from "../src/index.js";

async function nueva(empresa: { name: string; tax_id: string }) {
  const db = await openEmbedded();
  await migrate(db);
  const app = await buildApp({ db });
  const r = await app.inject({ method: "PUT", url: "/api/v1/company", payload: { ...empresa, city: "Zarautz", postal_code: "20800" } });
  expect(r.statusCode, r.body).toBeLessThan(300);
  return app;
}

const fichero = {
  formato: "sindri-datos",
  version: 1,
  origen: "Gestor de incidencias",
  empresa: { name: "Empresa Prueba SL", tax_id: "B12345674" },
  clientes: [
    { name: "Cliente Uno SL", tax_id: "b91234567", email: "uno@example.com", contactos: [{ name: "Ana" }], direcciones: [{ label: "Oficina", city: "Soria" }] },
    { name: "Cliente Sin NIF", notes: "Viene del gestor" },
    { name: "Cliente NIF Malo", tax_id: "12345678A" },
  ],
  productos: [{ sku: "HORA", name: "Hora de servicio", kind: "service", uom: "h", sale_price: 45, vat_rate: "21" }],
  modelos: [{ name: "Mantenimiento", title: "Presupuesto de mantenimiento", validity_days: 30 }],
};

describe("Exportar e importar los datos de una empresa", () => {
  it("probar no guarda nada y dice qué haría", async () => {
    const app = await nueva({ name: "Empresa Prueba SL", tax_id: "B12345674" });
    const r = await app.inject({ method: "POST", url: "/api/v1/datos/importar?probar=1", payload: fichero });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ probar: true, clientes: { creados: 3, actualizados: 0 }, productos: { creados: 1 }, modelos: { creados: 1 } });
    expect(r.json().avisos.join(" ")).toContain("12345678A");
    const lista = (await app.inject({ url: "/api/v1/partners" })).json();
    expect(lista).toHaveLength(0);
  });

  it("importa, no duplica al repetir y lo que exporta se vuelve a importar en otra base", async () => {
    const app = await nueva({ name: "Empresa Prueba SL", tax_id: "B12345674" });
    const una = await app.inject({ method: "POST", url: "/api/v1/datos/importar", payload: fichero });
    expect(una.json()).toMatchObject({ probar: false, clientes: { creados: 3 }, productos: { creados: 1 } });
    const otra = await app.inject({ method: "POST", url: "/api/v1/datos/importar", payload: fichero });
    expect(otra.json()).toMatchObject({ clientes: { creados: 0, actualizados: 3 }, productos: { creados: 0, actualizados: 1 } });

    const clientes = (await app.inject({ url: "/api/v1/partners" })).json() as { name: string; tax_id: string | null; id: string }[];
    expect(clientes.map((c) => c.name).sort()).toEqual(["Cliente NIF Malo", "Cliente Sin NIF", "Cliente Uno SL"]);
    const uno = clientes.find((c) => c.name === "Cliente Uno SL")!;
    expect(uno.tax_id).toBe("B91234567");
    const ficha = (await app.inject({ url: `/api/v1/partners/${uno.id}` })).json();
    expect(ficha.contacts ?? ficha.contactos ?? []).toHaveLength(1);

    const exp = await app.inject({ url: "/api/v1/datos/exportar" });
    expect(exp.statusCode, exp.body).toBe(200);
    expect(exp.headers["content-disposition"]).toContain("sindri-001-");
    const datos = exp.json();
    expect(datos).toMatchObject({ formato: "sindri-datos", version: 1, empresa: { tax_id: "B12345674" } });
    expect(datos.clientes.find((c: { name: string }) => c.name === "Cliente Uno SL").direcciones).toHaveLength(1);

    // En PRO la empresa es otra base: lo exportado entra igual (y avisa si el NIF no coincide).
    const pro = await nueva({ name: "Otra Empresa SL", tax_id: "A58818501" });
    const r = await pro.inject({ method: "POST", url: "/api/v1/datos/importar", payload: datos });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().clientes.creados).toBe(3);
    expect(r.json().modelos.creados + r.json().modelos.actualizados).toBeGreaterThan(0);
    expect(r.json().avisos.join(" ")).toContain("B12345674");
  });

  it("trae servicios, tarifas por cliente y horas por facturar, y la tarifa sale en los pedidos", async () => {
    const app = await nueva({ name: "Empresa Prueba SL", tax_id: "B12345674" });
    const gestor = {
      formato: "sindri-datos", version: 1, origen: "Gestor de incidencias", origen_app: "incidencias",
      clientes: [{ name: "Cliente Uno SL", tax_id: "B91234567", discount_pct: "10", tarifas: [{ sku: "SOP-INC", precio: "30" }, { sku: "NO-HAY", precio: "1" }] }],
      productos: [
        { sku: "SOP-INC", name: "Soporte: incidencias", kind: "service", uom: "h", sale_price: "40", vat_rate: "21" },
        { sku: "SOP-PET", name: "Soporte: peticiones", kind: "service", uom: "h", sale_price: "40", vat_rate: "21" },
      ],
      por_facturar: [
        { ref: "SES-1", cliente: { tax_id: "B91234567", name: "Cliente Uno SL" }, sku: "SOP-INC", fecha: "2026-10-01", cantidad: "2", precio: "30", descripcion: "INC 1 · Impresora" },
        { ref: "SES-2", cliente: { tax_id: "B91234567", name: "Cliente Uno SL" }, sku: "SOP-INC", fecha: "2026-10-02", cantidad: "1.5", precio: "30", descripcion: "INC 2 · Red" },
        { ref: "SES-3", cliente: { tax_id: null, name: "Cliente Uno SL" }, sku: "SOP-PET", fecha: "2026-10-03", cantidad: "1", descripcion: "PET 3 · Informe" },
        { ref: "SES-4", cliente: { tax_id: null, name: "Nadie" }, sku: "SOP-PET", fecha: "2026-10-03", cantidad: "1", descripcion: "Sin cliente" },
      ],
    };
    const prueba = await app.inject({ method: "POST", url: "/api/v1/datos/importar?probar=1", payload: gestor });
    expect(prueba.statusCode, prueba.body).toBe(200);
    const pr = prueba.json();
    expect(pr).toMatchObject({ tarifas: 1, por_facturar: { creados: 3, actualizados: 0, sin_tocar: 0 } });
    expect(pr.tabla).toEqual([
      { cliente: "Cliente Uno SL", sku: "SOP-INC", servicio: "Soporte: incidencias", uom: "h", cantidad: "3.5", precio: "30", importe: "105.00", elementos: 2 },
      { cliente: "Cliente Uno SL", sku: "SOP-PET", servicio: "Soporte: peticiones", uom: "h", cantidad: "1", precio: "40", importe: "40.00", elementos: 1 },
    ]);
    expect(pr.avisos.join(" ")).toContain("NO-HAY");
    expect(pr.avisos.join(" ")).toContain("Nadie");
    expect((await app.inject({ url: "/api/v1/por-facturar" })).json()).toHaveLength(0);

    expect((await app.inject({ method: "POST", url: "/api/v1/datos/importar", payload: gestor })).statusCode).toBe(200);
    const otra = (await app.inject({ method: "POST", url: "/api/v1/datos/importar", payload: gestor })).json();
    expect(otra.por_facturar).toEqual({ creados: 0, actualizados: 3, sin_tocar: 0 });
    const pend = (await app.inject({ url: "/api/v1/por-facturar" })).json() as { id: string; external_ref: string; source: string; price: string }[];
    expect(pend.map((p) => [p.external_ref, p.source, Number(p.price)]).sort()).toEqual([["SES-1", "incidencias", 30], ["SES-2", "incidencias", 30], ["SES-3", "incidencias", 40]]);

    // La ficha enseña la tarifa propia; un pedido sin precio la usa y aplica el descuento habitual.
    const cli = ((await app.inject({ url: "/api/v1/partners" })).json() as { id: string }[])[0]!;
    const ficha = (await app.inject({ url: `/api/v1/partners/${cli.id}` })).json();
    expect(ficha.prices.map((x: { sku: string; unit_price: string }) => [x.sku, Number(x.unit_price)])).toEqual([["SOP-INC", 30]]);
    const prods = (await app.inject({ url: "/api/v1/products" })).json() as { id: string; sku: string }[];
    const inc = prods.find((x) => x.sku === "SOP-INC")!;
    const ped = await app.inject({ method: "POST", url: "/api/v1/sales-orders", payload: { partner_id: cli.id, lines: [{ product_id: inc.id, quantity: "1" }] } });
    expect(ped.statusCode, ped.body).toBe(201);
    const linea = (await app.inject({ url: `/api/v1/sales-orders/${ped.json().id}` })).json().lines[0];
    expect([Number(linea.unit_price), Number(linea.discount_pct)]).toEqual([30, 10]);

    // Lo pasado a un pedido ya no se toca al volver a importar.
    const deUno = pend.filter((p) => p.external_ref !== "SES-3").map((p) => p.id);
    expect((await app.inject({ method: "POST", url: "/api/v1/por-facturar/pedido", payload: { ids: deUno } })).statusCode).toBe(201);
    const tercera = (await app.inject({ method: "POST", url: "/api/v1/datos/importar", payload: gestor })).json();
    expect(tercera.por_facturar).toEqual({ creados: 0, actualizados: 1, sin_tocar: 2 });

    // Cambiar y quitar la tarifa desde la ficha; la exportación la lleva.
    expect((await app.inject({ method: "PUT", url: `/api/v1/partners/${cli.id}/prices/${inc.id}`, payload: { unit_price: "32,5" } })).statusCode).toBe(200);
    const exp = (await app.inject({ url: "/api/v1/datos/exportar" })).json();
    expect(exp.clientes[0].tarifas).toEqual([{ sku: "SOP-INC", precio: "32.5" }]);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/partners/${cli.id}/prices/${inc.id}` })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/v1/partners/${cli.id}` })).json().prices).toHaveLength(0);
  });

  it("rechaza un fichero que no es de Sindri", async () => {
    const app = await nueva({ name: "Empresa Prueba SL", tax_id: "B12345674" });
    const r = await app.inject({ method: "POST", url: "/api/v1/datos/importar", payload: { clientes: [] } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain("sindri-datos");
  });
});
