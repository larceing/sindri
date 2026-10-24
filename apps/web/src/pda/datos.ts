/**
 * Datos de la PDA: red, copia local y cola de lo hecho sin conexión.
 *
 * La PDA trabaja en naves con zonas sin wifi. Lo que lee (productos, existencias, pedidos) se guarda
 * en el navegador para seguir consultando sin red, y lo que hace (entradas, entregas) va a una cola
 * que se manda sola al volver la conexión. Cada operación lleva su id: si se manda dos veces, el
 * servidor la cuenta una.
 */
import { useEffect, useState } from "react";
import { api, ApiError } from "../api";

declare global {
  interface Window {
    /** Lo pone el simulador para probar sin red sin desenchufar nada. */
    __sindriSinRed?: boolean;
    /** Simulador: cada llamada tarda 2 s más. */
    __sindriLenta?: boolean;
    /** Simulador: el servidor falla (503) una de cada tres llamadas. */
    __sindriFallo?: boolean;
  }
}

export const enLinea = () => navigator.onLine && !window.__sindriSinRed;

/** Se repinta al cambiar la red (real o simulada). */
export function useRed() {
  const [on, setOn] = useState(enLinea);
  useEffect(() => {
    const f = () => setOn(enLinea());
    window.addEventListener("online", f);
    window.addEventListener("offline", f);
    window.addEventListener("sindri:red", f);
    return () => {
      window.removeEventListener("online", f);
      window.removeEventListener("offline", f);
      window.removeEventListener("sindri:red", f);
    };
  }, []);
  return on;
}

export class SinRed extends Error {
  constructor() {
    super("Sin conexión con Sindri");
  }
}

/** El servidor no está disponible ahora (5xx, entrada caída): se reintenta, no es un rechazo. */
export class ServidorCaido extends SinRed {
  constructor(status: number) {
    super();
    this.message = `Sindri no responde (${status}): se reintentará`;
  }
}

/**
 * Como `api`, pero falla rápido y claro sin red (también la simulada). Un 5xx cuenta como
 * fallo pasajero: la cola lo reintenta en vez de marcarlo como rechazado.
 */
export async function pdaApi<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  if (!enLinea()) throw new SinRed();
  if (window.__sindriLenta) await new Promise((r) => setTimeout(r, 2000));
  if (window.__sindriFallo && Math.random() < 1 / 3) throw new ServidorCaido(503);
  try {
    return await api<T>(path, init);
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status >= 500) throw new ServidorCaido(e.status);
      throw e;
    }
    throw new SinRed(); // fallo de red del fetch
  }
}

/** UUID v4. `crypto.randomUUID` solo existe en HTTPS o localhost; en la red de la fábrica puede ir por HTTP. */
export function nuevoId(): string {
  if (typeof crypto.randomUUID === "function" && window.isSecureContext) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Copia local ------------------------------------------------------------------------

const k = (empresa: string, clave: string) => `sindri.pda.${empresa}.${clave}`;

export function leerCopia<T>(empresa: string, clave: string): { datos: T; at: string } | null {
  try {
    const s = localStorage.getItem(k(empresa, clave));
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

export function guardarCopia(empresa: string, clave: string, datos: unknown) {
  try {
    localStorage.setItem(k(empresa, clave), JSON.stringify({ datos, at: new Date().toISOString() }));
  } catch {
    /* sin espacio o sin almacenamiento: se sigue sin copia */
  }
}

/** Datos con copia local: se piden al servidor si hay red y, si no, se usa la última copia. */
export function useCopia<T>(empresa: string, clave: string, ruta: string) {
  const red = useRed();
  const [estado, setEstado] = useState<{ datos: T | null; at: string | null; error: string | null }>(() => {
    const c = leerCopia<T>(empresa, clave);
    return { datos: c?.datos ?? null, at: c?.at ?? null, error: null };
  });
  const recargar = async () => {
    try {
      const d = await pdaApi<T>(ruta);
      guardarCopia(empresa, clave, d);
      setEstado({ datos: d, at: new Date().toISOString(), error: null });
    } catch (e) {
      setEstado((s) => ({ ...s, error: (e as Error).message }));
    }
  };
  useEffect(() => {
    if (red) void recargar();
  }, [red, ruta]);
  return { ...estado, recargar };
}

// Cola sin conexión -------------------------------------------------------------------

export interface Operacion {
  id: string;
  tipo: "entrada" | "entrega";
  /** Texto para la persona: «50 ud TOR-8 lote L1». */
  resumen: string;
  ruta: string;
  cuerpo: unknown;
  creada: string;
  intentos: number;
  error?: string;
}

const COLA = (empresa: string) => k(empresa, "cola");

export function leerCola(empresa: string): Operacion[] {
  try {
    return JSON.parse(localStorage.getItem(COLA(empresa)) ?? "[]");
  } catch {
    return [];
  }
}

function guardarCola(empresa: string, cola: Operacion[]) {
  localStorage.setItem(COLA(empresa), JSON.stringify(cola));
  window.dispatchEvent(new Event("sindri:cola"));
}

export function encolar(empresa: string, op: Omit<Operacion, "creada" | "intentos">) {
  guardarCola(empresa, [...leerCola(empresa), { ...op, creada: new Date().toISOString(), intentos: 0 }]);
}

export function quitarDeCola(empresa: string, id: string) {
  guardarCola(empresa, leerCola(empresa).filter((o) => o.id !== id));
}

/** Quita la marca de error para que vuelva a intentarse, sin cambiar su sitio en la cola. */
export function reintentarOp(empresa: string, id: string) {
  guardarCola(empresa, leerCola(empresa).map((o) => (o.id === id ? { ...o, error: undefined } : o)));
}

let enviando = false;

/**
 * Manda la cola en orden. Para al primer fallo de red (se reintenta luego). Un rechazo del servidor
 * (sin stock, pedido ya entregado…) se queda marcado para que la persona lo vea y decida.
 */
export async function enviarCola(empresa: string): Promise<{ enviadas: number; errores: number }> {
  if (enviando || !enLinea()) return { enviadas: 0, errores: 0 };
  enviando = true;
  let enviadas = 0;
  let errores = 0;
  try {
    for (const op of leerCola(empresa)) {
      if (op.error) {
        errores++;
        continue;
      }
      try {
        await pdaApi(op.ruta, { method: "POST", body: op.cuerpo });
        quitarDeCola(empresa, op.id);
        enviadas++;
      } catch (e) {
        if (e instanceof SinRed) break;
        errores++;
        guardarCola(
          empresa,
          leerCola(empresa).map((o) => (o.id === op.id ? { ...o, intentos: o.intentos + 1, error: (e as Error).message } : o)),
        );
      }
    }
  } finally {
    enviando = false;
  }
  return { enviadas, errores };
}

/** La cola, viva: se repinta al cambiar y se reintenta cada 15 s mientras haya red. */
export function useCola(empresa: string) {
  const red = useRed();
  const [cola, setCola] = useState(() => leerCola(empresa));
  useEffect(() => {
    const f = () => setCola(leerCola(empresa));
    window.addEventListener("sindri:cola", f);
    window.addEventListener("storage", f);
    return () => {
      window.removeEventListener("sindri:cola", f);
      window.removeEventListener("storage", f);
    };
  }, [empresa]);
  useEffect(() => {
    if (!red) return;
    // El envío al volver la red lo hace la pantalla (para avisar); aquí solo los reintentos.
    const t = setInterval(() => void enviarCola(empresa), 15000);
    return () => clearInterval(t);
  }, [red, empresa]);
  return cola;
}

// Avisos al operario --------------------------------------------------------------------

let audio: AudioContext | null = null;

/** Pitido y vibración: en la nave no se mira la pantalla en cada lectura. */
export function aviso(tipo: "ok" | "error" | "atencion") {
  try {
    audio ??= new AudioContext();
    const tonos = tipo === "ok" ? [[1800, 0.08]] : tipo === "error" ? [[380, 0.18], [300, 0.25]] : [[1000, 0.1], [1400, 0.1]];
    let t = audio.currentTime;
    for (const [f, d] of tonos) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = f!;
      o.type = tipo === "error" ? "square" : "sine";
      g.gain.value = 0.08;
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + d!);
      t += d! + 0.04;
    }
  } catch {
    /* sin audio */
  }
  navigator.vibrate?.(tipo === "ok" ? 40 : tipo === "error" ? [120, 60, 120] : [60, 40, 60]);
}
