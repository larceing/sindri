/**
 * Lectura y escritura de códigos GS1 (GS1-128, GS1 DataMatrix, GS1 QR, DataBar y Digital Link).
 *
 * Lo usan la PDA y su simulador: un escáner entrega una cadena y aquí se convierte en datos
 * (GTIN, lote, caducidad, SSCC, cantidad, peso…). Sin entrada/salida: funciona en el navegador,
 * en el servidor y sin conexión.
 *
 * Formatos de entrada que entiende:
 * - Cadena del escáner con identificador de simbología (`]C1`, `]d2`, `]Q3`, `]e0`, `]J1`) y el
 *   separador GS (carácter 29) tras cada campo de longitud variable.
 * - El separador escrito como texto (`<GS>`, `{GS}`, `\x1d`), para pruebas y escáneres en modo teclado.
 * - Texto legible con paréntesis: `(01)08412345678905(10)L123`.
 * - Enlace GS1 Digital Link: `https://id.gs1.org/01/08412345678905/10/L123?17=271231`.
 * - Un GTIN-8/12/13/14 suelto (código EAN/UPC del producto).
 * Lo demás se devuelve como texto (ubicaciones, pedidos, referencias internas).
 */
import { gs1CheckDigit } from "./identifiers.js";

export const GS = "\u001d";

type Formato = "n" | "an";
interface DefAI {
  /** Nombre corto en español. */
  nombre: string;
  formato: Formato;
  /** Longitud fija del dato, o máxima si `variable`. */
  longitud: number;
  variable?: boolean;
  /** Para fechas YYMMDD. */
  fecha?: boolean;
  /** Último dígito del AI = posición de la coma decimal (310n, 330n…). */
  decimales?: boolean;
  /** Lleva dígito de control GS1. */
  control?: boolean;
}

/** Los AI que aparecen en almacén, fabricación y expedición. Los demás se leen por su longitud estándar. */
const AIS: Record<string, DefAI> = {
  "00": { nombre: "SSCC", formato: "n", longitud: 18, control: true },
  "01": { nombre: "GTIN", formato: "n", longitud: 14, control: true },
  "02": { nombre: "GTIN contenido", formato: "n", longitud: 14, control: true },
  "10": { nombre: "Lote", formato: "an", longitud: 20, variable: true },
  "11": { nombre: "Fecha de fabricación", formato: "n", longitud: 6, fecha: true },
  "13": { nombre: "Fecha de envasado", formato: "n", longitud: 6, fecha: true },
  "15": { nombre: "Consumo preferente", formato: "n", longitud: 6, fecha: true },
  "16": { nombre: "Vender antes de", formato: "n", longitud: 6, fecha: true },
  "17": { nombre: "Caducidad", formato: "n", longitud: 6, fecha: true },
  "21": { nombre: "Número de serie", formato: "an", longitud: 20, variable: true },
  "22": { nombre: "Variante", formato: "an", longitud: 20, variable: true },
  "240": { nombre: "Referencia adicional", formato: "an", longitud: 30, variable: true },
  "241": { nombre: "Referencia del cliente", formato: "an", longitud: 30, variable: true },
  "254": { nombre: "Extensión de GLN", formato: "an", longitud: 20, variable: true },
  "30": { nombre: "Cantidad variable", formato: "n", longitud: 8, variable: true },
  "37": { nombre: "Unidades contenidas", formato: "n", longitud: 8, variable: true },
  "400": { nombre: "Pedido del cliente", formato: "an", longitud: 30, variable: true },
  "401": { nombre: "Envío (GINC)", formato: "an", longitud: 30, variable: true },
  "402": { nombre: "Expedición (GSIN)", formato: "n", longitud: 17, control: true },
  "410": { nombre: "Entregar a (GLN)", formato: "n", longitud: 13, control: true },
  "413": { nombre: "Destino final (GLN)", formato: "n", longitud: 13, control: true },
  "414": { nombre: "Ubicación (GLN)", formato: "n", longitud: 13, control: true },
  "415": { nombre: "Facturar a (GLN)", formato: "n", longitud: 13, control: true },
  "420": { nombre: "Código postal de entrega", formato: "an", longitud: 20, variable: true },
  "7003": { nombre: "Caducidad con hora", formato: "n", longitud: 10 },
  "8020": { nombre: "Referencia de pago", formato: "an", longitud: 25, variable: true },
  "90": { nombre: "Uso interno", formato: "an", longitud: 30, variable: true },
};
for (let n = 0; n <= 5; n++) {
  AIS[`310${n}`] = { nombre: "Peso neto (kg)", formato: "n", longitud: 6, decimales: true };
  AIS[`330${n}`] = { nombre: "Peso bruto (kg)", formato: "n", longitud: 6, decimales: true };
  AIS[`311${n}`] = { nombre: "Longitud (m)", formato: "n", longitud: 6, decimales: true };
  AIS[`315${n}`] = { nombre: "Volumen neto (l)", formato: "n", longitud: 6, decimales: true };
}
for (let n = 91; n <= 99; n++) AIS[String(n)] = { nombre: "Uso interno", formato: "an", longitud: 90, variable: true };

/** Longitud total (AI + dato) de los AI de longitud fija predefinida por GS1, por sus dos primeros dígitos. */
const FIJOS: Record<string, number> = {
  "00": 20, "01": 16, "02": 16, "03": 16, "04": 18, "11": 8, "12": 8, "13": 8, "14": 8, "15": 8, "16": 8, "17": 8, "18": 8, "19": 8, "20": 4,
  "31": 10, "32": 10, "33": 10, "34": 10, "35": 10, "36": 10, "41": 16,
};

/** Cuántos dígitos tiene el AI que empieza por estos dos. */
function longitudAI(dos: string): number {
  const n = Number(dos);
  if (n <= 22 || n === 30 || n === 37 || n >= 90) return 2;
  if ((n >= 23 && n <= 29) || (n >= 40 && n <= 42)) return 3;
  return 4; // 31-36, 39, 70-71, 80-81…
}

function defDe(ai: string): DefAI {
  const d = AIS[ai];
  if (d) return d;
  const fija = FIJOS[ai.slice(0, 2)];
  if (fija) return { nombre: `AI ${ai}`, formato: "an", longitud: fija - ai.length };
  return { nombre: `AI ${ai}`, formato: "an", longitud: 90, variable: true };
}

export interface CampoGs1 {
  ai: string;
  nombre: string;
  valor: string;
  /** Fecha ISO (AAAA-MM-DD) si el AI es de fecha. */
  fecha?: string;
  /** Número con su coma decimal si el AI la lleva en el último dígito (310n…). */
  numero?: string;
}

export interface LecturaCodigo {
  /** `gs1`: con identificadores de aplicación. `gtin`: código de producto suelto. `texto`: cualquier otro. */
  tipo: "gs1" | "gtin" | "texto";
  /** La cadena tal cual llegó. */
  bruto: string;
  /** Simbología si el escáner manda su identificador (]C1 = GS1-128, ]d2 = DataMatrix, ]Q3 = QR, ]E0 = EAN-13…). */
  simbologia?: string;
  campos: CampoGs1[];
  /** Texto sin identificador de simbología (solo para `texto`). */
  texto?: string;
  gtin?: string;
  lote?: string;
  serie?: string;
  caducidad?: string;
  sscc?: string;
  cantidad?: string;
  pesoNetoKg?: string;
  gln?: string;
  /** Avisos de datos que no cuadran (dígito de control, fecha imposible…). La lectura sigue siendo útil. */
  avisos: string[];
}

const SIMBOLOGIAS: Record<string, string> = {
  "]C1": "GS1-128", "]d2": "GS1 DataMatrix", "]Q3": "GS1 QR", "]e0": "GS1 DataBar", "]J1": "GS1 DotCode",
  "]E0": "EAN-13 / UPC", "]E4": "EAN-8", "]C0": "Code 128", "]A0": "Code 39", "]Q1": "QR", "]d1": "DataMatrix", "]I0": "ITF",
};
const SIMB_GS1 = new Set(["]C1", "]d2", "]Q3", "]e0", "]J1"]);

/** Fecha GS1 YYMMDD a ISO. Siglo por la regla de GS1 (ventana de −49/+50 años) y DD=00 = último día del mes. */
export function fechaGs1(yymmdd: string, hoy = new Date()): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  let dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12) return null;
  const actual = hoy.getUTCFullYear();
  let siglo = Math.floor(actual / 100) * 100;
  const dif = yy - (actual % 100);
  if (dif >= 51) siglo -= 100;
  else if (dif <= -50) siglo += 100;
  const y = siglo + yy;
  const ultimo = new Date(Date.UTC(y, mm, 0)).getUTCDate();
  if (dd === 0) dd = ultimo;
  if (dd > ultimo) return null;
  return `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** ISO (AAAA-MM-DD) a YYMMDD. */
export const aFechaGs1 = (iso: string) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);

function conDecimales(ai: string, valor: string): string {
  const d = Number(ai.slice(-1));
  const n = valor.replace(/^0+(?=\d)/, "");
  if (d === 0) return n;
  const p = n.padStart(d + 1, "0");
  return `${p.slice(0, -d)}.${p.slice(-d)}`;
}

function completar(l: LecturaCodigo, hoy: Date) {
  for (const c of l.campos) {
    const def = defDe(c.ai);
    if (def.fecha) {
      const f = fechaGs1(c.valor, hoy);
      if (f) c.fecha = f;
      else l.avisos.push(`Fecha no válida en (${c.ai}): ${c.valor}`);
    }
    if (def.decimales) c.numero = conDecimales(c.ai, c.valor);
    if (def.control && /^\d+$/.test(c.valor) && gs1CheckDigit(c.valor.slice(0, -1)) !== Number(c.valor.slice(-1)))
      l.avisos.push(`Dígito de control incorrecto en (${c.ai}) ${c.valor}`);
    if (def.formato === "n" && !/^\d+$/.test(c.valor)) l.avisos.push(`(${c.ai}) solo admite números: ${c.valor}`);
    if (!def.variable && c.valor.length !== def.longitud && AIS[c.ai]) l.avisos.push(`(${c.ai}) debe tener ${def.longitud} caracteres`);
    if (def.variable && c.valor.length > def.longitud) l.avisos.push(`(${c.ai}) admite como mucho ${def.longitud} caracteres`);
    switch (c.ai) {
      case "01":
      case "02":
        l.gtin ??= c.valor;
        break;
      case "00":
        l.sscc = c.valor;
        break;
      case "10":
        l.lote = c.valor;
        break;
      case "21":
        l.serie = c.valor;
        break;
      case "17":
        if (c.fecha) l.caducidad = c.fecha;
        break;
      case "15":
        if (c.fecha && !l.caducidad) l.caducidad = c.fecha;
        break;
      case "30":
      case "37":
        l.cantidad = c.valor.replace(/^0+(?=\d)/, "");
        break;
      case "414":
        l.gln = c.valor;
        break;
    }
    if (/^310\d$/.test(c.ai)) l.pesoNetoKg = c.numero;
  }
}

/** Lee una cadena GS1 en bruto (sin identificador de simbología), con GS tras los campos variables. */
function leerElementos(s: string, l: LecturaCodigo) {
  let i = 0;
  while (i < s.length) {
    if (s[i] === GS) {
      i++;
      continue;
    }
    const dos = s.slice(i, i + 2);
    if (!/^\d\d$/.test(dos)) throw new Error(`Se esperaba un AI en la posición ${i + 1}`);
    const ai = s.slice(i, i + longitudAI(dos));
    i += ai.length;
    const def = defDe(ai);
    let valor: string;
    if (def.variable) {
      const fin = s.indexOf(GS, i);
      valor = fin === -1 ? s.slice(i) : s.slice(i, fin);
      i = fin === -1 ? s.length : fin + 1;
    } else {
      valor = s.slice(i, i + def.longitud);
      i += def.longitud;
    }
    l.campos.push({ ai, nombre: def.nombre, valor });
  }
}

/** Texto legible: (01)08412345678905(10)L123 */
function leerParentesis(s: string, l: LecturaCodigo) {
  const re = /\((\d{2,4})\)([^(]*)/g;
  let m: RegExpExecArray | null;
  let visto = 0;
  while ((m = re.exec(s))) {
    visto += m[0].length;
    l.campos.push({ ai: m[1]!, nombre: defDe(m[1]!).nombre, valor: m[2]!.trim() });
  }
  if (visto !== s.replace(/\s+$/, "").length) throw new Error("Texto entre paréntesis mal formado");
}

/** Claves primarias que pueden abrir la ruta de un Digital Link. */
const CLAVES_DL = ["01", "00", "414", "8003", "8004", "8006", "8010", "8013", "8017", "8018", "255", "253", "401", "402", "417"];

function leerDigitalLink(url: URL, l: LecturaCodigo) {
  const partes = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const inicio = partes.findIndex((p, i) => CLAVES_DL.includes(p) && i + 1 < partes.length);
  if (inicio === -1) throw new Error("El enlace no lleva una clave GS1");
  for (let i = inicio; i + 1 < partes.length; i += 2) {
    const ai = partes[i]!;
    if (!/^\d{2,4}$/.test(ai)) throw new Error(`AI no válido en el enlace: ${ai}`);
    let valor = partes[i + 1]!;
    // En el enlace el GTIN puede ir con 8, 12 o 13 dígitos: se normaliza a 14.
    if (ai === "01" && /^\d{8,13}$/.test(valor)) valor = valor.padStart(14, "0");
    l.campos.push({ ai, nombre: defDe(ai).nombre, valor });
  }
  for (const [ai, valor] of url.searchParams) {
    if (/^\d{2,4}$/.test(ai)) l.campos.push({ ai, nombre: defDe(ai).nombre, valor });
  }
}

/** Interpreta lo que manda un escáner. Nunca lanza: lo que no entiende lo devuelve como texto. */
/** Lo que, pegado al final de un lote o serie, parece otro campo GS1 que se lo ha tragado. */
function campoPegado(cola: string, hoy: Date): string | null {
  let m = /^(37|30)(\d{1,8})$/.exec(cola);
  if (m) return `(${m[1]}) ${m[2]}`;
  m = /^(1[1357])(\d{6})$/.exec(cola);
  if (m && fechaGs1(m[2]!, hoy)) return `(${m[1]}) ${m[2]}`;
  m = /^(3[12]0\d)(\d{6})$/.exec(cola);
  if (m) return `(${m[1]}) ${m[2]}`;
  return null;
}

/**
 * Si se pierde el GS tras un lote o una serie (pistola que no lo manda), el campo siguiente se pega:
 * lote «L1» + (37) 24 se lee como lote «L13724». No se puede saber seguro, así que solo se avisa.
 */
function avisarGsPerdido(l: LecturaCodigo, hoy: Date) {
  const ultimo = l.campos.at(-1);
  if (!ultimo || (ultimo.ai !== "10" && ultimo.ai !== "21")) return;
  const v = ultimo.valor;
  for (let i = 1; i <= v.length - 3; i++) {
    const pegado = campoPegado(v.slice(i), hoy);
    if (pegado) {
      const que = ultimo.ai === "10" ? "El lote" : "La serie";
      l.avisos.push(`¿Falta el separador GS? ${que} «${v}» acaba en «${v.slice(i)}», que parece ${pegado}. Revisa antes de confirmar.`);
      return;
    }
  }
}

export function leerCodigo(entrada: string, hoy = new Date()): LecturaCodigo {
  const bruto = entrada;
  let s = entrada.replace(/[\r\n\t]+$/g, "").replace(/<GS>|\{GS\}|\\x1[dD]|\\u001[dD]/g, GS);
  const l: LecturaCodigo = { tipo: "texto", bruto, campos: [], avisos: [] };
  const simb = /^\][A-Za-z]\d/.exec(s)?.[0];
  if (simb) {
    l.simbologia = SIMBOLOGIAS[simb] ?? simb;
    s = s.slice(3);
  }
  const intento = (fn: () => void): boolean => {
    try {
      fn();
      l.tipo = "gs1";
      completar(l, hoy);
      if (!s.startsWith("(") && !/^https?:/i.test(s)) avisarGsPerdido(l, hoy);
      return true;
    } catch (e) {
      l.campos = [];
      l.avisos = [(e as Error).message];
      return false;
    }
  };
  // Un FNC1 inicial (GS) también marca una cadena GS1 en escáneres que no mandan simbología.
  const marcadoGs1 = (simb && SIMB_GS1.has(simb)) || s.startsWith(GS);
  if (/^https?:\/\//i.test(s)) {
    try {
      const url = new URL(s);
      if (intento(() => leerDigitalLink(url, l))) return l;
    } catch {
      /* no es un enlace válido: texto */
    }
  } else if (s.startsWith("(")) {
    if (intento(() => leerParentesis(s, l))) return l;
  } else if (marcadoGs1 || s.includes(GS)) {
    if (intento(() => leerElementos(s, l))) return l;
  } else if (/^\d{8}$|^\d{12,14}$/.test(s) && gs1CheckDigit(s.slice(0, -1)) === Number(s.slice(-1))) {
    l.tipo = "gtin";
    l.gtin = s.padStart(14, "0");
    l.campos = [{ ai: "01", nombre: "GTIN", valor: l.gtin }];
    return l;
  } else if (/^(00|01|02)\d{14,}/.test(s)) {
    // GS1-128 leído en modo teclado sin simbología ni GS final: se intenta, y si no cuadra es texto.
    const copia = { ...l, campos: [] as CampoGs1[], avisos: [] as string[] };
    try {
      leerElementos(s, copia);
      completar(copia, hoy);
      if (!copia.avisos.length) {
        avisarGsPerdido(copia, hoy);
        return { ...copia, tipo: "gs1" };
      }
    } catch {
      /* texto */
    }
  }
  l.tipo = "texto";
  l.campos = [];
  // Solo se avisa si parecía GS1 y no cuadraba; un código interno no lleva avisos.
  if (!marcadoGs1 && !s.startsWith("(") && !/^https?:/i.test(s)) l.avisos = [];
  l.texto = s.replaceAll(GS, "");
  return l;
}

export interface CampoNuevo {
  ai: string;
  valor: string;
}

/**
 * Compone una cadena GS1. `gs`: la que codifica la etiqueta (GS tras cada variable salvo el último).
 * `hri`: la legible bajo el código, con paréntesis. Ordena primero los de longitud fija, como recomienda GS1.
 */
export function componerGs1(campos: CampoNuevo[], formato: "gs" | "hri" = "gs"): string {
  const lista = [...campos].sort((a, b) => Number(!!defDe(a.ai).variable) - Number(!!defDe(b.ai).variable));
  if (formato === "hri") return lista.map((c) => `(${c.ai})${c.valor}`).join("");
  return lista
    .map((c, i) => {
      const def = defDe(c.ai);
      if (!def.variable && c.valor.length !== def.longitud) throw new RangeError(`(${c.ai}) debe tener ${def.longitud} caracteres`);
      return c.ai + c.valor + (def.variable && i < lista.length - 1 ? GS : "");
    })
    .join("");
}

/** GTIN de 8, 12, 13 o 14 dígitos normalizado a 14, o null si no es válido. */
export function gtin14(codigo: string): string | null {
  const s = codigo.trim();
  if (!/^\d{8}$|^\d{12,14}$/.test(s)) return null;
  return gs1CheckDigit(s.slice(0, -1)) === Number(s.slice(-1)) ? s.padStart(14, "0") : null;
}

/** Completa un cuerpo de GTIN/SSCC/GLN con su dígito de control. */
export const conControl = (cuerpo: string) => cuerpo + gs1CheckDigit(cuerpo);
