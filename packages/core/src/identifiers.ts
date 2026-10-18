/** Validación de identificadores españoles y GS1. */

const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

/** Valida NIF de persona física (DNI), NIE o NIF de persona jurídica (antiguo CIF). */
export function isValidSpanishTaxId(raw: string): boolean {
  const v = raw.toUpperCase().replace(/[\s.-]/g, "").replace(/^ES/, "");
  if (/^\d{8}[A-Z]$/.test(v)) return DNI_LETTERS[Number(v.slice(0, 8)) % 23] === v[8];
  if (/^[XYZ]\d{7}[A-Z]$/.test(v)) {
    const n = Number(String("XYZ".indexOf(v[0]!)) + v.slice(1, 8));
    return DNI_LETTERS[n % 23] === v[8];
  }
  if (/^[KLM]\d{7}[A-Z]$/.test(v)) return DNI_LETTERS[Number(v.slice(1, 8)) % 23] === v[8];
  if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(v)) {
    const digits = v.slice(1, 8);
    let sum = 0;
    for (let i = 0; i < 7; i++) {
      let d = Number(digits[i]);
      if (i % 2 === 0) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    const control = (10 - (sum % 10)) % 10;
    const letter = "JABCDEFGHI"[control]!;
    const last = v[8]!;
    if ("PQRSNW".includes(v[0]!)) return last === letter;
    if ("ABEH".includes(v[0]!)) return last === String(control);
    return last === String(control) || last === letter;
  }
  return false;
}

/** Dígito de control GS1 (módulo 10) para GTIN-8/12/13/14, SSCC-18, GLN-13. */
export function gs1CheckDigit(body: string): number {
  if (!/^\d+$/.test(body)) throw new RangeError("Solo dígitos");
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidGs1(code: string): boolean {
  return /^\d{8,18}$/.test(code) && gs1CheckDigit(code.slice(0, -1)) === Number(code.slice(-1));
}

/**
 * Construye un SSCC-18: dígito de extensión + prefijo de empresa GS1 + referencia serie + control.
 */
export function buildSscc(extension: number, companyPrefix: string, serial: number | bigint): string {
  if (extension < 0 || extension > 9) throw new RangeError("Extensión 0-9");
  if (!/^\d{6,12}$/.test(companyPrefix)) throw new RangeError("Prefijo de empresa GS1 de 6 a 12 dígitos");
  const serialLen = 16 - companyPrefix.length;
  const s = String(serial);
  if (s.length > serialLen) throw new RangeError(`La referencia serie no cabe en ${serialLen} dígitos`);
  const body = `${extension}${companyPrefix}${s.padStart(serialLen, "0")}`;
  return body + gs1CheckDigit(body);
}
