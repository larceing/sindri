/**
 * VERI*FACTU: huella (hash) encadenada de los registros de facturación y URL del código QR.
 *
 * Base normativa: RD 1007/2023 (Reglamento de sistemas informáticos de facturación) y
 * Orden HAC/1177/2024. Los formatos siguen el documento de la AEAT "Detalle de las
 * especificaciones técnicas para generación de la huella o hash de los registros de
 * facturación" y el de "Características del QR".
 *
 * IMPORTANTE: antes de producción hay que validar contra el entorno de pruebas de la AEAT
 * (formato de importes, zona horaria y caracteres especiales en el QR).
 */
import { createHash } from "node:crypto";

export interface AltaHashFields {
  /** NIF del emisor de la factura. */
  issuerTaxId: string;
  /** Serie + número de la factura, tal como figura en ella. */
  seriesNumber: string;
  /** Fecha de expedición (YYYY-MM-DD). */
  issueDate: string;
  /** Tipo de factura AEAT: F1, F2, R1..R5, F3. */
  invoiceType: string;
  /** Suma de cuotas (IVA + recargo), texto con 2 decimales. */
  taxTotal: string;
  /** Importe total de la factura, texto con 2 decimales. */
  amountTotal: string;
  /** Huella del registro anterior de la cadena ("" si es el primero). */
  previousHash: string;
  /** Fecha, hora y huso de generación del registro, ISO 8601 con offset (2024-01-01T19:20:30+01:00). */
  generatedAt: string;
}

export interface AnulacionHashFields {
  issuerTaxId: string;
  seriesNumber: string;
  issueDate: string;
  previousHash: string;
  generatedAt: string;
}

/** Fecha YYYY-MM-DD -> DD-MM-YYYY, el formato que usa la AEAT. */
export function aeatDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new RangeError(`Fecha no válida: ${isoDate}`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function sha256Upper(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").toUpperCase();
}

/** Cadena de entrada de la huella de un registro de alta. */
export function altaHashInput(f: AltaHashFields): string {
  return [
    `IDEmisorFactura=${f.issuerTaxId.trim()}`,
    `NumSerieFactura=${f.seriesNumber.trim()}`,
    `FechaExpedicionFactura=${aeatDate(f.issueDate)}`,
    `TipoFactura=${f.invoiceType.trim()}`,
    `CuotaTotal=${f.taxTotal.trim()}`,
    `ImporteTotal=${f.amountTotal.trim()}`,
    `Huella=${f.previousHash.trim()}`,
    `FechaHoraHusoGenRegistro=${f.generatedAt.trim()}`,
  ].join("&");
}

export function altaHash(f: AltaHashFields): string {
  return sha256Upper(altaHashInput(f));
}

export function anulacionHashInput(f: AnulacionHashFields): string {
  return [
    `IDEmisorFacturaAnulada=${f.issuerTaxId.trim()}`,
    `NumSerieFacturaAnulada=${f.seriesNumber.trim()}`,
    `FechaExpedicionFacturaAnulada=${aeatDate(f.issueDate)}`,
    `Huella=${f.previousHash.trim()}`,
    `FechaHoraHusoGenRegistro=${f.generatedAt.trim()}`,
  ].join("&");
}

export function anulacionHash(f: AnulacionHashFields): string {
  return sha256Upper(anulacionHashInput(f));
}

/** Fecha-hora local con offset, sin milisegundos (2024-01-01T19:20:30+01:00). */
export function isoWithOffset(d: Date, timeZone = "Europe/Madrid"): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const off = String(parts.timeZoneName).replace("GMT", "") || "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`;
}

export const QR_BASE_URL = {
  production: "https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR",
  test: "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR",
} as const;

/** URL de cotejo que va dentro del código QR de la factura. */
export function qrUrl(
  p: { issuerTaxId: string; seriesNumber: string; issueDate: string; amountTotal: string },
  env: keyof typeof QR_BASE_URL = "test",
): string {
  const q = new URLSearchParams({
    nif: p.issuerTaxId,
    numserie: p.seriesNumber,
    fecha: aeatDate(p.issueDate),
    importe: p.amountTotal,
  });
  return `${QR_BASE_URL[env]}?${q.toString()}`;
}

/** Verifica una cadena completa de registros (en orden). Devuelve el índice del primer registro roto o -1. */
export function verifyChain(records: (AltaHashFields & { hash: string })[]): number {
  let prev = "";
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.previousHash !== prev || altaHash(r) !== r.hash) return i;
    prev = r.hash;
  }
  return -1;
}
