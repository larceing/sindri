/**
 * Cálculo de totales de documentos comerciales con fiscalidad española.
 *
 * Criterio: la base de cada línea se redondea a 2 decimales y la cuota de IVA se calcula
 * sobre la suma de bases de cada tipo (desglose por tipo impositivo), que es como se
 * presenta en la factura y en los registros de facturación.
 */
import { D, Dec, type DecimalInput } from "./decimal.js";

export interface TaxLineInput {
  quantity: DecimalInput;
  unitPrice: DecimalInput;
  /** Descuento en % (0-100). */
  discountPct?: DecimalInput;
  /** Tipo de IVA en % (21, 10, 4, 0...). */
  vatRate: DecimalInput;
  /** Recargo de equivalencia en % (5.2, 1.4, 0.5...) si el cliente está en ese régimen. */
  surchargeRate?: DecimalInput;
}

export interface TaxBreakdownRow {
  vatRate: string;
  surchargeRate: string;
  base: string;
  vatAmount: string;
  surchargeAmount: string;
}

export interface DocumentTotals {
  lines: { base: string }[];
  breakdown: TaxBreakdownRow[];
  untaxed: string;
  vatTotal: string;
  surchargeTotal: string;
  /** Retención de IRPF (positiva; se resta del total a pagar). */
  withholding: string;
  /** Total factura: base + IVA + recargo. */
  total: string;
  /** Líquido a pagar: total - retención. */
  amountDue: string;
}

export const SPANISH_VAT_RATES = ["21", "10", "4", "0"] as const;
/** Recargo de equivalencia asociado a cada tipo general de IVA. */
export const SURCHARGE_FOR_VAT: Record<string, string> = { "21": "5.2", "10": "1.4", "4": "0.5", "0": "0" };

export function lineBase(l: TaxLineInput): Dec {
  const gross = D(l.quantity).mul(l.unitPrice);
  const disc = D(l.discountPct ?? 0);
  if (disc.isNegative() || disc.cmp(100) > 0) throw new RangeError("El descuento debe estar entre 0 y 100");
  return gross.sub(gross.mul(disc).div(100)).round(2);
}

export function computeTotals(lines: TaxLineInput[], withholdingRate: DecimalInput = 0): DocumentTotals {
  const groups = new Map<string, { vat: Dec; sur: Dec; base: Dec }>();
  const outLines: { base: string }[] = [];
  for (const l of lines) {
    const base = lineBase(l);
    outLines.push({ base: base.toFixed(2) });
    const vat = D(l.vatRate);
    const sur = D(l.surchargeRate ?? 0);
    const key = `${vat.toFixed()}|${sur.toFixed()}`;
    const g = groups.get(key) ?? { vat, sur, base: Dec.ZERO };
    g.base = g.base.add(base);
    groups.set(key, g);
  }
  const breakdown: TaxBreakdownRow[] = [];
  let untaxed = Dec.ZERO;
  let vatTotal = Dec.ZERO;
  let surTotal = Dec.ZERO;
  for (const g of [...groups.values()].sort((a, b) => b.vat.cmp(a.vat))) {
    const vatAmount = g.base.mul(g.vat).div(100).round(2);
    const surAmount = g.base.mul(g.sur).div(100).round(2);
    untaxed = untaxed.add(g.base);
    vatTotal = vatTotal.add(vatAmount);
    surTotal = surTotal.add(surAmount);
    breakdown.push({
      vatRate: g.vat.toFixed(),
      surchargeRate: g.sur.toFixed(),
      base: g.base.toFixed(2),
      vatAmount: vatAmount.toFixed(2),
      surchargeAmount: surAmount.toFixed(2),
    });
  }
  const withholding = untaxed.mul(withholdingRate).div(100).round(2);
  const total = untaxed.add(vatTotal).add(surTotal);
  return {
    lines: outLines,
    breakdown,
    untaxed: untaxed.toFixed(2),
    vatTotal: vatTotal.toFixed(2),
    surchargeTotal: surTotal.toFixed(2),
    withholding: withholding.toFixed(2),
    total: total.toFixed(2),
    amountDue: total.sub(withholding).toFixed(2),
  };
}
