/**
 * Captura del escáner en la PDA. Sirve igual para una PDA de verdad y para el simulador.
 *
 * Dos caminos, como en las PDA reales:
 * 1. **Modo teclado** (DataWedge «Keystroke output», Honeywell «Wedge as keys», pistolas USB/Bluetooth):
 *    el lector «teclea» el código muy deprisa y termina con Intro o Tab. Se distingue de una persona
 *    por la velocidad: entre tecla y tecla pasan pocos milisegundos. Si caía en un campo de texto,
 *    se le devuelve el valor que tenía.
 * 2. **Evento** `sindri:escaneo` en `window` con `{ datos, simbologia? }`. Es lo que haría una app
 *    envoltorio de Android al recibir el «Intent output» de DataWedge o el Intent de Honeywell, y lo
 *    que usa el simulador en ese modo. Llega entero, con el GS y sin depender del teclado.
 */
import { useEffect, useRef } from "react";

export interface Escaneo {
  datos: string;
  simbologia?: string;
  via: "teclado" | "evento";
}

export interface OpcionesEscaner {
  /** Hueco máximo entre teclas de un escáner (ms). Más lento es una persona. */
  huecoMaximo?: number;
  /** Longitud mínima para tomarlo como lectura. */
  minimo?: number;
  /** Prefijo opcional configurado en el lector (p. ej. «§» o STX): lo que sigue es lectura seguro. */
  prefijo?: string;
  /** Lecturas iguales dentro de este margen (ms) cuentan una (gatillo pulsado dos veces, rebote). */
  antiRebote?: number;
}

const GS = "\u001d";

/** Pone un valor a un campo controlado por React y avisa del cambio. */
function restaurar(el: HTMLInputElement | HTMLTextAreaElement, valor: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, valor);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const esCampo = (t: EventTarget | null): t is HTMLInputElement | HTMLTextAreaElement =>
  !!t && ((t as Element).tagName === "INPUT" || (t as Element).tagName === "TEXTAREA");

/** Escucha el escáner mientras el componente está montado. */
export function useEscaner(alLeer: (e: Escaneo) => void, op: OpcionesEscaner = {}) {
  const cb = useRef(alLeer);
  cb.current = alLeer;
  const { huecoMaximo = 50, minimo = 3, prefijo, antiRebote = 700 } = op;

  useEffect(() => {
    let buf = "";
    let ultima = 0;
    let rapido = true;
    let conPrefijo = false;
    let campo: HTMLInputElement | HTMLTextAreaElement | null = null;
    let valorAntes = "";
    let anterior = { datos: "", t: 0 };

    const emitir = (e: Escaneo) => {
      const ahora = performance.now();
      if (e.datos === anterior.datos && ahora - anterior.t < antiRebote) return;
      anterior = { datos: e.datos, t: ahora };
      cb.current(e);
    };
    const reiniciar = () => {
      buf = "";
      rapido = true;
      conPrefijo = false;
      campo = null;
    };

    const tecla = (ev: KeyboardEvent) => {
      if ((ev.target as Element | null)?.closest?.("[data-escaner='no']")) return;
      const ahora = performance.now();
      const hueco = ahora - ultima;
      ultima = ahora;
      if (buf && hueco > huecoMaximo && !conPrefijo) {
        // Demasiado lento: lo anterior lo tecleaba una persona. Esta tecla puede empezar una lectura.
        reiniciar();
      }
      if (prefijo && ev.key === prefijo && !buf) {
        conPrefijo = true;
        ev.preventDefault();
        return;
      }
      if (ev.key === "Enter" || ev.key === "Tab") {
        const valido = conPrefijo || (rapido && buf.length >= minimo);
        if (valido && buf) {
          ev.preventDefault();
          ev.stopPropagation();
          if (campo) restaurar(campo, valorAntes);
          emitir({ datos: buf, via: "teclado" });
        }
        reiniciar();
        return;
      }
      // DataWedge con «Send Control Characters as Events» manda el GS como Ctrl+].
      let c: string | null = null;
      if (ev.ctrlKey && (ev.key === "]" || ev.code === "BracketRight")) c = GS;
      else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) c = ev.key;
      if (c === null) return;
      if (!buf) {
        campo = esCampo(ev.target) ? ev.target : null;
        valorAntes = campo?.value ?? "";
      } else if (hueco > huecoMaximo) {
        rapido = false;
      }
      buf += c;
      if (conPrefijo) ev.preventDefault();
    };

    const evento = (ev: Event) => {
      const d = (ev as CustomEvent<{ datos?: string; simbologia?: string }>).detail;
      if (d?.datos) emitir({ datos: d.datos, simbologia: d.simbologia, via: "evento" });
    };

    window.addEventListener("keydown", tecla, true);
    window.addEventListener("sindri:escaneo", evento);
    return () => {
      window.removeEventListener("keydown", tecla, true);
      window.removeEventListener("sindri:escaneo", evento);
    };
  }, [huecoMaximo, minimo, prefijo, antiRebote]);
}
