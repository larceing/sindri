import { describe, expect, it } from "vitest";
import { GS, aFechaGs1, componerGs1, conControl, fechaGs1, gtin14, leerCodigo } from "../src/gs1.js";
import { buildSscc } from "../src/identifiers.js";

const HOY = new Date(Date.UTC(2026, 9, 24));
const GTIN = conControl("0841234567890"); // 14 dígitos con su control

describe("GS1: fechas", () => {
  it("convierte YYMMDD con la ventana de siglo de GS1", () => {
    expect(fechaGs1("271231", HOY)).toBe("2027-12-31");
    expect(fechaGs1("990101", HOY)).toBe("1999-01-01"); // 99 − 26 = 73 ≥ 51 → siglo anterior
    expect(fechaGs1("760101", HOY)).toBe("2076-01-01"); // 76 − 26 = 50 → mismo siglo
  });
  it("día 00 es el último del mes y rechaza fechas imposibles", () => {
    expect(fechaGs1("280200", HOY)).toBe("2028-02-29");
    expect(fechaGs1("270200", HOY)).toBe("2027-02-28");
    expect(fechaGs1("271301", HOY)).toBeNull();
    expect(fechaGs1("270231", HOY)).toBeNull();
    expect(aFechaGs1("2027-03-09")).toBe("270309");
  });
});

describe("GS1: lectura", () => {
  it("GS1-128 de escáner con simbología y separador GS", () => {
    const l = leerCodigo(`]C101${GTIN}17271231` + `10L-2026/7${GS}3712`, HOY);
    expect(l.tipo).toBe("gs1");
    expect(l.simbologia).toBe("GS1-128");
    expect(l.gtin).toBe(GTIN);
    expect(l.caducidad).toBe("2027-12-31");
    expect(l.lote).toBe("L-2026/7");
    expect(l.cantidad).toBe("12");
    expect(l.avisos).toEqual([]);
  });
  it("acepta el separador escrito como <GS> (modo teclado y pruebas)", () => {
    const l = leerCodigo(`01${GTIN}10ABC<GS>21S0001`, HOY);
    expect(l.lote).toBe("ABC");
    expect(l.serie).toBe("S0001");
  });
  it("texto legible con paréntesis y peso con decimales", () => {
    const l = leerCodigo(`(01)${GTIN}(3103)012500(10)LOTE9`, HOY);
    expect(l.tipo).toBe("gs1");
    expect(l.pesoNetoKg).toBe("12.500");
    expect(l.lote).toBe("LOTE9");
  });
  it("SSCC de un palé", () => {
    const sscc = buildSscc(3, "8412345", 42);
    const l = leerCodigo(`]C100${sscc}`, HOY);
    expect(l.sscc).toBe(sscc);
    expect(l.avisos).toEqual([]);
  });
  it("avisa del dígito de control mal sin perder la lectura", () => {
    const malo = GTIN.slice(0, -1) + String((Number(GTIN.slice(-1)) + 1) % 10);
    const l = leerCodigo(`(01)${malo}(10)X`, HOY);
    expect(l.tipo).toBe("gs1");
    expect(l.avisos[0]).toMatch(/control/);
  });
  it("GS1 Digital Link", () => {
    const l = leerCodigo(`https://id.gs1.org/01/${GTIN.slice(1)}/10/AB%2F1?17=270630&3103=001250`, HOY);
    expect(l.tipo).toBe("gs1");
    expect(l.gtin).toBe(GTIN);
    expect(l.lote).toBe("AB/1");
    expect(l.caducidad).toBe("2027-06-30");
    expect(l.pesoNetoKg).toBe("1.250");
  });
  it("EAN-13 suelto es un GTIN", () => {
    const ean = conControl("841234567890");
    const l = leerCodigo(`]E0${ean}`, HOY);
    expect(l.tipo).toBe("gtin");
    expect(l.gtin).toBe(`0${ean}`);
    expect(gtin14(ean)).toBe(`0${ean}`);
    expect(gtin14("8412345678901")).toBe(gtin14("8412345678901")); // estable
  });
  it("lo demás es texto (ubicaciones, pedidos, referencias)", () => {
    expect(leerCodigo("WH/STOCK\r\n")).toMatchObject({ tipo: "texto", texto: "WH/STOCK", avisos: [] });
    expect(leerCodigo("P2026-00012")).toMatchObject({ tipo: "texto", texto: "P2026-00012" });
    expect(leerCodigo("1234567")).toMatchObject({ tipo: "texto" });
  });
  it("una cadena GS1 rota no revienta: se devuelve como texto con aviso", () => {
    const l = leerCodigo("]C1ZZ", HOY);
    expect(l.tipo).toBe("texto");
    expect(l.avisos.length).toBe(1);
  });
});

describe("GS1: composición", () => {
  it("pone los fijos delante y GS solo entre variables", () => {
    const s = componerGs1([
      { ai: "10", valor: "L1" },
      { ai: "01", valor: GTIN },
      { ai: "17", valor: "271231" },
      { ai: "21", valor: "S9" },
    ]);
    expect(s).toBe(`01${GTIN}17271231` + `10L1${GS}21S9`);
    expect(leerCodigo(s, HOY)).toMatchObject({ gtin: GTIN, lote: "L1", serie: "S9", caducidad: "2027-12-31" });
    expect(componerGs1([{ ai: "01", valor: GTIN }, { ai: "10", valor: "L1" }], "hri")).toBe(`(01)${GTIN}(10)L1`);
  });
  it("rechaza un fijo con longitud mala", () => {
    expect(() => componerGs1([{ ai: "01", valor: "123" }])).toThrow();
  });
});

describe("GS1: GS perdido", () => {
  const hoy = new Date("2026-10-24T00:00:00Z");
  it("avisa si el lote se ha tragado la cantidad", () => {
    const l = leerCodigo("]C101020000000000151728123110L-BON-26113724", hoy);
    expect(l.tipo).toBe("gs1");
    expect(l.lote).toBe("L-BON-26113724");
    expect(l.avisos[0]).toContain("(37) 24");
  });
  it("también sin simbología (pistola en modo teclado)", () => {
    const l = leerCodigo("01020000000000151728123110L-BON-26113724", hoy);
    expect(l.tipo).toBe("gs1");
    expect(l.gtin).toBe("02000000000015");
    expect(l.avisos[0]).toContain("separador GS");
  });
  it("no avisa con el GS en su sitio ni con un lote normal", () => {
    expect(leerCodigo(`]C101020000000000151728123110L-BON-2611${GS}3724`, hoy).avisos).toEqual([]);
    expect(leerCodigo("]C101020000000000151728123110L-BON-2611", hoy).avisos).toEqual([]);
  });
});
