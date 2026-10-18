/** Cliente de la API. En escritorio y en la web la API está en el mismo origen. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`./api/v1${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  // Con Keycloak, una sesión caducada se renueva volviendo a entrar (con usuario y clave lo pide el navegador).
  if (res.status === 401 && !res.headers.get("www-authenticate")) {
    window.location.assign("./login");
    return new Promise<T>(() => {});
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // La empresa elegida caducó (sesión nueva del navegador): la web vuelve a preguntar.
    if (res.status === 409 && (data?.code === "elegir_empresa" || data?.code === "sin_empresa"))
      window.dispatchEvent(new CustomEvent("sindri:empresa", { detail: data.code }));
    throw new ApiError(data?.error ?? `Error ${res.status}`, res.status, data?.code);
  }
  return data as T;
}

export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body });
export const patch = <T = any>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body });
export const put = <T = any>(path: string, body: unknown) => api<T>(path, { method: "PUT", body });
export const del = <T = any>(path: string) => api<T>(path, { method: "DELETE" });

/** Quita los campos vacíos: en un alta lo vacío no se manda. */
export const sinVacios = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== undefined));
/** En una modificación lo vacío se manda como null (borra el dato). */
export const vaciosANull = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === "" ? null : v]));

/*
 * Formato es-ES para tablas: agrupación SIEMPRE (Intl es-ES no agrupa 4 cifras por defecto y
 * descuadraría las columnas), decimales fijos por columna y signo menos tipográfico (U+2212).
 */
const fmtCache = new Map<string, Intl.NumberFormat>();
function nf(min: number, max: number, currency?: boolean) {
  const k = `${min}|${max}|${currency}`;
  let f = fmtCache.get(k);
  if (!f) {
    f = new Intl.NumberFormat("es-ES", {
      useGrouping: "always",
      minimumFractionDigits: min,
      maximumFractionDigits: max,
      ...(currency ? { style: "currency", currency: "EUR" } : {}),
    } as Intl.NumberFormatOptions);
    fmtCache.set(k, f);
  }
  return f;
}
const minus = (s: string) => s.replace("-", "−");

export const eur = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === "" ? "" : minus(nf(2, 2, true).format(Number(v)));

export const qty = (v: string | number | null | undefined, decimals = 0) =>
  v === null || v === undefined || v === "" ? "" : minus(nf(decimals, Math.max(decimals, 4)).format(Number(v)));

export const pct = (v: string | number) => `${minus(nf(0, 2).format(Number(v)))} %`;

export const fecha = (iso: string | null | undefined) => {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};

export const STATE_LABEL: Record<string, string> = {
  draft: "Borrador",
  confirmed: "Confirmado",
  delivered: "Entregado",
  invoiced: "Facturado",
  cancelled: "Cancelado",
  issued: "Emitida",
  paid: "Cobrada",
  discarded: "Descartada",
  pending: "Pendiente de envío",
  sent: "Enviado",
  error: "Error de envío",
  on_route: "En ruta",
  closed: "Cerrada",
  incident: "Incidencia",
};
