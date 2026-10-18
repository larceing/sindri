import { describe, expect, it } from "vitest";
import { D, computeTotals, SalesOrderMachine, InvoiceMachine, TransitionError, isValidSpanishTaxId, gs1CheckDigit, buildSscc, isValidGs1 } from "../src/index.js";
import { altaHash, altaHashInput, qrUrl, verifyChain, isoWithOffset } from "../src/verifactu.js";

describe("Decimal", () => {
  it("es exacto donde float falla", () => {
    expect(D("0.1").add("0.2").toFixed()).toBe("0.3");
    expect(D("1.005").round(2).toFixed(2)).toBe("1.01");
    expect(D("-1.005").round(2).toFixed(2)).toBe("-1.01");
    expect(D("10").div(3).toFixed(4)).toBe("3.3333");
    expect(D("2,5").mul("4").toFixed()).toBe("10");
    expect(D("0.123456789").toFixed()).toBe("0.12345679");
  });
  it("rechaza valores no válidos", () => {
    expect(() => D("abc")).toThrow();
    expect(() => D(1).div(0)).toThrow();
  });
});

describe("Totales con IVA español", () => {
  it("desglosa por tipo y aplica recargo y retención", () => {
    const t = computeTotals(
      [
        { quantity: "3", unitPrice: "10.333", vatRate: "21", surchargeRate: "5.2" },
        { quantity: "1", unitPrice: "100", discountPct: "10", vatRate: "10", surchargeRate: "1.4" },
      ],
      "15",
    );
    expect(t.lines.map((l) => l.base)).toEqual(["31.00", "90.00"]);
    expect(t.breakdown).toEqual([
      { vatRate: "21", surchargeRate: "5.2", base: "31.00", vatAmount: "6.51", surchargeAmount: "1.61" },
      { vatRate: "10", surchargeRate: "1.4", base: "90.00", vatAmount: "9.00", surchargeAmount: "1.26" },
    ]);
    expect(t.untaxed).toBe("121.00");
    expect(t.total).toBe("139.38");
    expect(t.withholding).toBe("18.15");
    expect(t.amountDue).toBe("121.23");
  });
});

describe("Máquinas de estado", () => {
  it("no permite saltos ilegales", () => {
    expect(SalesOrderMachine.next("draft", "confirm")).toBe("confirmed");
    expect(() => SalesOrderMachine.next("draft", "invoice")).toThrow(TransitionError);
    expect(InvoiceMachine.actions("issued")).toEqual(["pay"]);
  });
});

describe("Identificadores", () => {
  it("valida NIF, NIE y CIF", () => {
    expect(isValidSpanishTaxId("12345678Z")).toBe(true);
    expect(isValidSpanishTaxId("12345678A")).toBe(false);
    expect(isValidSpanishTaxId("X1234567L")).toBe(true);
    expect(isValidSpanishTaxId("B12345674")).toBe(true);
    expect(isValidSpanishTaxId("ESB12345674")).toBe(true);
  });
  it("calcula dígitos GS1 y SSCC", () => {
    expect(gs1CheckDigit("400638133393")).toBe(1);
    expect(isValidGs1("4006381333931")).toBe(true); // GTIN-13 de ejemplo GS1
    const sscc = buildSscc(3, "8412345", 1);
    expect(sscc).toHaveLength(18);
    expect(isValidGs1(sscc)).toBe(true);
  });
});

describe("VERI*FACTU", () => {
  const first = {
    issuerTaxId: "89890001K",
    seriesNumber: "12345678/G33",
    issueDate: "2024-01-01",
    invoiceType: "F1",
    taxTotal: "12.35",
    amountTotal: "123.45",
    previousHash: "",
    generatedAt: "2024-01-01T19:20:30+01:00",
  };
  it("construye la cadena de entrada en el orden de la AEAT", () => {
    expect(altaHashInput(first)).toBe(
      "IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33&FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35&ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00",
    );
  });
  it("reproduce la huella del ejemplo de la AEAT", () => {
    expect(altaHash(first)).toBe("3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60");
  });
  it("reproduce la huella encadenada del segundo ejemplo de la AEAT", () => {
    const second = { ...first, seriesNumber: "12345679/G34", previousHash: altaHash(first), generatedAt: "2024-01-01T19:20:35+01:00" };
    expect(altaHash(second)).toBe("F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97");
  });
  it("detecta una cadena manipulada", () => {
    const h1 = altaHash(first);
    const second = { ...first, seriesNumber: "12345679/G34", previousHash: h1, generatedAt: "2024-01-01T19:20:35+01:00" };
    const chain = [{ ...first, hash: h1 }, { ...second, hash: altaHash(second) }];
    expect(verifyChain(chain)).toBe(-1);
    chain[0]!.amountTotal = "999.00";
    expect(verifyChain(chain)).toBe(0);
  });
  it("genera la URL del QR", () => {
    expect(qrUrl({ issuerTaxId: "89890001K", seriesNumber: "12345678&G33", issueDate: "2024-01-01", amountTotal: "241.4" })).toBe(
      "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=12345678%26G33&fecha=01-01-2024&importe=241.4",
    );
  });
  it("formatea la fecha con huso horario de Madrid", () => {
    expect(isoWithOffset(new Date("2024-01-01T18:20:30Z"))).toBe("2024-01-01T19:20:30+01:00");
    expect(isoWithOffset(new Date("2024-07-01T18:20:30Z"))).toBe("2024-07-01T20:20:30+02:00");
  });
});
