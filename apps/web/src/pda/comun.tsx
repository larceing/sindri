/** Tipos y piezas que comparten las pantallas de la PDA. */
import type { ReactNode } from "react";
import { Minus, Plus, ScanLine } from "lucide-react";
import { gtin14, type LecturaCodigo } from "@sindri/core/gs1";
import { appAndroid, type Escaneo } from "./escaner";
import { encolar, enviarCola, leerCola, type Operacion } from "./datos";

export interface Producto {
  id: string;
  sku: string;
  name: string;
  gtin: string | null;
  uom: string;
  kind: string;
  track_lots: boolean;
  on_hand: string;
}
export interface Existencia {
  product_id: string;
  sku: string;
  product_name: string;
  uom: string;
  lot_id: string | null;
  lot_code: string | null;
  expiry_date: string | null;
  location_code: string;
  quantity: string;
}
export interface Pedido {
  id: string;
  number: string;
  partner_name: string;
  delivery_date?: string | null;
  delivery_city?: string | null;
  picked_by?: string | null;
  lines?: { product_id: string; sku: string; description: string; quantity: string; uom: string }[];
}
export interface Ubicacion {
  id: string;
  code: string;
  name: string;
  kind: string;
  parent_id: string | null;
  archived?: boolean;
}

export type Tono = "ok" | "error" | "atencion" | "info";
export type Mensaje = { tono: Tono; texto: string } | null;

export interface Comun {
  empresa: string;
  productos: Producto[];
  stock: Existencia[];
  ubicaciones: Ubicacion[];
  decir: (t: Tono, s: string) => void;
  manejador: React.MutableRefObject<(l: LecturaCodigo, e: Escaneo) => void>;
  ultima: { e: Escaneo; l: LecturaCodigo } | null;
  red: boolean;
}

/** Busca el producto de una lectura: por GTIN o por referencia interna. */
export function productoDe(l: LecturaCodigo, productos: Producto[]): Producto | undefined {
  if (l.gtin) return productos.find((p) => p.gtin && gtin14(p.gtin) === l.gtin);
  const t = l.texto?.trim().toUpperCase();
  return t ? productos.find((p) => p.sku.toUpperCase() === t || (p.gtin && gtin14(p.gtin) === gtin14(t))) : undefined;
}

/** La lectura es la etiqueta de una ubicación del almacén (su código). */
export function ubicacionDe(l: LecturaCodigo, ubicaciones: Ubicacion[]): Ubicacion | undefined {
  const t = l.tipo === "texto" ? l.texto?.trim().toUpperCase() : undefined;
  return t ? ubicaciones.find((u) => u.code.toUpperCase() === t) : undefined;
}

/** El lote que debería salir antes (FEFO) según la copia de existencias, con su ubicación. */
export const loteFefo = (stock: Existencia[], productId: string) =>
  stock
    .filter((s) => s.product_id === productId && Number(s.quantity) > 0)
    .sort((a, b) => (a.expiry_date ?? "9999").localeCompare(b.expiry_date ?? "9999") || a.location_code.localeCompare(b.location_code))[0];

/** Lo que hay que leer en cada pantalla. En una Zebra con la app Android, tocarlo dispara el lector. */
export const Pista = ({ children }: { children: ReactNode }) =>
  appAndroid()?.dataWedge ? (
    <button className="pda-pista" onClick={() => window.SindriAndroid?.gatillo()}>
      <ScanLine size={20} aria-hidden /> {children}
    </button>
  ) : (
    <p className="pda-pista">
      <ScanLine size={20} aria-hidden /> {children}
    </p>
  );

/** Cantidad con − y + grandes, para guantes. */
export function Cantidad({ uom, valor, cambiar }: { uom: string; valor: string; cambiar: (v: string) => void }) {
  const suma = (d: number) => cambiar(String(Math.max(0, Number(valor || 0) + d)));
  return (
    <div className="pda-campo">
      <span>Cantidad ({uom})</span>
      <div className="pda-cantidad">
        <button onClick={() => suma(-1)} aria-label="Una menos"><Minus /></button>
        <input inputMode="decimal" value={valor} onChange={(e) => cambiar(e.target.value.replace(",", "."))} data-escaner="no" />
        <button onClick={() => suma(1)} aria-label="Una más"><Plus /></button>
      </div>
    </div>
  );
}

/**
 * Pone la operación en la cola y la intenta mandar. Sin red queda guardada; si Sindri la
 * rechaza, se ve en Pendientes.
 */
export async function mandar(empresa: string, op: Omit<Operacion, "creada" | "intentos">, red: boolean, decir: Comun["decir"], hecho: string) {
  encolar(empresa, op);
  await enviarCola(empresa);
  const queda = leerCola(empresa).find((o) => o.id === op.id);
  if (!queda) decir("ok", hecho);
  else if (queda.error) decir("error", `Sindri la ha rechazado: ${queda.error}`);
  else decir("atencion", red ? "No se ha podido mandar: se reintentará" : "Guardada en la PDA: se manda al volver la conexión");
  return queda ? (queda.error ? "rechazada" : "pendiente") : "enviada";
}
