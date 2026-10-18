/** Cliente de la API. En escritorio y en la web la API está en el mismo origen. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`./api${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error ?? `Error ${res.status}`, res.status);
  return data as T;
}

export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body });

export const eur = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === "" ? "" : new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(Number(v));

export const qty = (v: string | number | null | undefined) =>
  v === null || v === undefined ? "" : new Intl.NumberFormat("es-ES", { maximumFractionDigits: 4 }).format(Number(v));

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
  error: "Error",
};
