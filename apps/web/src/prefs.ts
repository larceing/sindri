import { useEffect, useState } from "react";

export type Tema = "sistema" | "claro" | "oscuro";
export type Modo = "oficina" | "taller";
export type Densidad = "compacta" | "normal" | "comoda" | "tactil" | "guantes";
export interface Prefs {
  tema: Tema;
  modo: Modo;
  densidad: Densidad;
}

const KEY = "ariadna.prefs";
const DEFAULT: Prefs = { tema: "sistema", modo: "oficina", densidad: "normal" };

function load(): Prefs {
  try {
    return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULT;
  }
}

/** Preferencias de presentación por puesto (se guardan en este navegador / equipo). */
export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(load);
  useEffect(() => {
    const root = document.documentElement;
    // En taller el tema siempre es explícito (día/noche por turno), nunca el del sistema.
    const tema = prefs.tema === "sistema" ? (prefs.modo === "taller" ? "claro" : null) : prefs.tema;
    if (tema) root.dataset.tema = tema;
    else delete root.dataset.tema;
    root.dataset.modo = prefs.modo;
    root.dataset.densidad = prefs.densidad;
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* sin almacenamiento: se usan los valores por defecto */
    }
  }, [prefs]);
  return [prefs, (p: Partial<Prefs>) => setPrefs((old) => ({ ...old, ...p }))] as const;
}
