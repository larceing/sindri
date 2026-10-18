/**
 * Aritmética decimal exacta para importes y cantidades.
 *
 * Nunca usamos `number` (coma flotante) para dinero ni para stock: 0.1 + 0.2 !== 0.3.
 * Internamente cada valor es un entero BigInt escalado a 10^SCALE.
 * En la API y en la base de datos los valores viajan como texto ("12.3456").
 */

const SCALE = 8;
const FACTOR = 10n ** BigInt(SCALE);

export type DecimalInput = Dec | string | number | bigint;

export class Dec {
  private constructor(private readonly units: bigint) {}

  static readonly ZERO = new Dec(0n);

  static of(value: DecimalInput): Dec {
    if (value instanceof Dec) return value;
    if (typeof value === "bigint") return new Dec(value * FACTOR);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new RangeError(`Número no finito: ${value}`);
      // Los number solo se aceptan si son enteros seguros o literales cortos; se pasan por texto.
      return Dec.parse(String(value));
    }
    return Dec.parse(value);
  }

  private static parse(text: string): Dec {
    const s = text.trim().replace(",", ".");
    const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) throw new RangeError(`Decimal no válido: "${text}"`);
    const [, sign, intPart, fracRaw = ""] = m;
    const units =
      fracRaw.length > SCALE
        ? roundUnits(BigInt(`${intPart}${fracRaw}`), fracRaw.length - SCALE) // redondeo half-up
        : BigInt(intPart!) * FACTOR + BigInt(fracRaw.padEnd(SCALE, "0"));
    return new Dec(sign === "-" ? -units : units);
  }

  add(o: DecimalInput): Dec {
    return new Dec(this.units + Dec.of(o).units);
  }
  sub(o: DecimalInput): Dec {
    return new Dec(this.units - Dec.of(o).units);
  }
  /** Multiplica y redondea half-up a la escala interna. */
  mul(o: DecimalInput): Dec {
    return new Dec(roundUnits(this.units * Dec.of(o).units, SCALE));
  }
  /** Divide y redondea half-up a la escala interna. */
  div(o: DecimalInput): Dec {
    const d = Dec.of(o).units;
    if (d === 0n) throw new RangeError("División por cero");
    const num = this.units * FACTOR * 10n;
    let q = num / d;
    // q tiene un dígito extra para redondear
    const neg = q < 0n;
    if (neg) q = -q;
    q = (q + 5n) / 10n;
    return new Dec(neg ? -q : q);
  }
  /** Redondeo comercial (half away from zero) a `decimals` decimales. */
  round(decimals: number): Dec {
    if (decimals >= SCALE) return this;
    const drop = SCALE - decimals;
    const step = 10n ** BigInt(drop);
    return new Dec(roundUnits(this.units, drop) * step);
  }
  negate(): Dec {
    return new Dec(-this.units);
  }
  abs(): Dec {
    return this.units < 0n ? new Dec(-this.units) : this;
  }
  cmp(o: DecimalInput): -1 | 0 | 1 {
    const b = Dec.of(o).units;
    return this.units < b ? -1 : this.units > b ? 1 : 0;
  }
  eq(o: DecimalInput): boolean {
    return this.cmp(o) === 0;
  }
  isZero(): boolean {
    return this.units === 0n;
  }
  isNegative(): boolean {
    return this.units < 0n;
  }

  /** Texto con exactamente `decimals` decimales (por defecto, sin ceros sobrantes). */
  toFixed(decimals?: number): string {
    const v = decimals === undefined ? this : this.round(decimals);
    const neg = v.units < 0n;
    const abs = neg ? -v.units : v.units;
    const int = abs / FACTOR;
    let frac = (abs % FACTOR).toString().padStart(SCALE, "0");
    if (decimals === undefined) frac = frac.replace(/0+$/, "");
    else frac = frac.slice(0, decimals);
    const body = frac.length ? `${int}.${frac}` : `${int}`;
    return neg && !/^0(\.0*)?$/.test(body) ? `-${body}` : body;
  }
  toString(): string {
    return this.toFixed();
  }
  toJSON(): string {
    return this.toFixed();
  }

  static sum(values: Iterable<DecimalInput>): Dec {
    let acc = Dec.ZERO;
    for (const v of values) acc = acc.add(v);
    return acc;
  }
}

/** Divide `units` entre 10^drop con redondeo half away from zero. */
function roundUnits(units: bigint, drop: number): bigint {
  if (drop <= 0) return units;
  const step = 10n ** BigInt(drop);
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const q = (abs + step / 2n) / step;
  return neg ? -q : q;
}

export const D = Dec.of;
