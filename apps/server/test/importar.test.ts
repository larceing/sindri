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

  it("rechaza un fichero que no es de Sindri", async () => {
    const app = await nueva({ name: "Empresa Prueba SL", tax_id: "B12345674" });
    const r = await app.inject({ method: "POST", url: "/api/v1/datos/importar", payload: { clientes: [] } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain("sindri-datos");
  });
});
