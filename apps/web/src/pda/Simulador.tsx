/**
 * Simulador de PDA: prueba Sindri PDA sin hardware.
 *
 * A la izquierda, la PDA (la app de verdad, `#/pda`, en un marco del tamaño del aparato). A la
 * derecha, el «escáner»: códigos sacados de los datos de la empresa (productos, lotes, ubicaciones,
 * pedidos) y un generador de etiquetas GS1. Al leer, se manda el código a la PDA igual que lo haría
 * el lector elegido: tecleándolo deprisa (modo teclado de DataWedge, Honeywell o una pistola USB) o
 * como evento (Intent de DataWedge). También provoca los fallos típicos: sin red, lectura doble,
 * código dañado o el separador GS perdido.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { QrCode, ScanLine, Trash2, Wifi, WifiOff } from "lucide-react";
import { GS, aFechaGs1, componerGs1, conControl, gtin14 } from "@sindri/core/gs1";
import { buildSscc } from "@sindri/core";
import { api, fecha } from "../api";
import "./pda.css";

type Via = "teclado" | "evento";
interface Perfil {
  id: string;
  nombre: string;
  via: Via;
  /** ms entre caracteres en modo teclado. */
  hueco: number;
  sufijo: "Enter" | "Tab";
  /** Cómo llega el separador GS: Ctrl+] (DataWedge «Send Control Characters as Events»), como carácter, o se pierde. */
  gs: "ctrl" | "caracter" | "quitar";
  aim: boolean;
  nota: string;
}

const PERFILES: Perfil[] = [
  { id: "zebra-teclado", nombre: "Zebra · DataWedge, modo teclado", via: "teclado", hueco: 0, sufijo: "Enter", gs: "caracter", aim: false, nota: "Lo más común: el navegador de la PDA recibe el código como si se tecleara, con Intro al final." },
  { id: "zebra-intent", nombre: "Zebra · DataWedge, Intent", via: "evento", hueco: 0, sufijo: "Enter", gs: "caracter", aim: true, nota: "Llega entero y con su simbología. En una PDA real hace falta una app envoltorio o Enterprise Browser que lo pase a la web." },
  { id: "honeywell", nombre: "Honeywell · Wedge como teclas", via: "teclado", hueco: 2, sufijo: "Enter", gs: "ctrl", aim: false, nota: "Igual que el modo teclado de Zebra; el GS llega como Ctrl+]." },
  { id: "hid", nombre: "Pistola USB / Bluetooth (HID)", via: "teclado", hueco: 8, sufijo: "Enter", gs: "quitar", aim: false, nota: "Las pistolas baratas suelen perder el GS: las etiquetas GS1 con lote en medio se leen mal." },
  { id: "persona", nombre: "Persona tecleando (lento)", via: "teclado", hueco: 140, sufijo: "Enter", gs: "caracter", aim: false, nota: "Sirve para comprobar que la PDA no confunde a una persona escribiendo con una lectura." },
];

const APARATOS = [
  { id: "pda6", nombre: 'PDA 6" táctil', w: 360, h: 720 },
  { id: "pda4", nombre: 'PDA 4" con teclado', w: 320, h: 480 },
  { id: "tablet", nombre: 'Tablet de taller 10"', w: 800, h: 1180 },
];

interface CodigoPrueba {
  grupo: string;
  titulo: string;
  datos: string;
  simb: string;
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Teclea en la PDA como un lector en modo teclado. */
async function teclear(win: Window, texto: string, p: Perfil) {
  const W = win as unknown as typeof globalThis;
  const tecla = (key: string, extra: KeyboardEventInit = {}) => {
    const target = (win.document.activeElement as HTMLElement | null) ?? win.document.body;
    const ev = new W.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
    const sigue = target.dispatchEvent(ev);
    target.dispatchEvent(new W.KeyboardEvent("keyup", { key, bubbles: true, ...extra }));
    // Un evento sintético no escribe: se imita lo que haría el teclado en un campo de texto.
    if (sigue && key.length === 1 && !extra.ctrlKey && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
      const el = target as HTMLInputElement;
      const proto = target.tagName === "TEXTAREA" ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, el.value + key);
      el.dispatchEvent(new W.Event("input", { bubbles: true }));
    }
  };
  for (const c of texto) {
    if (c === GS) {
      if (p.gs === "quitar") continue;
      if (p.gs === "ctrl") tecla("]", { ctrlKey: true, code: "BracketRight" });
      else tecla(GS);
    } else tecla(c);
    await espera(p.hueco);
  }
  tecla(p.sufijo);
}

/** Cambia un dígito: simula una etiqueta rayada que el lector lee mal. */
function danar(s: string): string {
  const pos = [...s].map((c, i) => (/\d/.test(c) ? i : -1)).filter((i) => i >= 0);
  if (!pos.length) return s + "?";
  const i = pos[Math.floor(pos.length / 2)]!;
  return s.slice(0, i) + String((Number(s[i]) + 1) % 10) + s.slice(i + 1);
}

const verGs = (s: string) => s.replaceAll(GS, "‹GS›");

export function SimuladorPda() {
  const marco = useRef<HTMLIFrameElement>(null);
  const [perfil, setPerfil] = useState(PERFILES[0]!);
  const [aparato, setAparato] = useState(APARATOS[0]!);
  const [sinRed, setSinRed] = useState(false);
  const [doble, setDoble] = useState(false);
  const [danado, setDanado] = useState(false);
  const [libre, setLibre] = useState("");
  const [registro, setRegistro] = useState<{ t: string; txt: string; tono?: string }[]>([]);
  const [qr, setQr] = useState<{ titulo: string; url: string } | null>(null);
  const [datos, setDatos] = useState<{ productos: any[]; stock: any[]; pedidos: any[]; ubicaciones: any[]; empresa: any } | null>(null);
  const [et, setEt] = useState({ producto: "", lote: "L" + new Date().toISOString().slice(2, 10).replaceAll("-", ""), caducidad: "", cantidad: "" });

  useEffect(() => {
    Promise.all([api("/products"), api("/stock"), api("/sales-orders?state=confirmed"), api("/locations"), api("/company")])
      .then(([productos, stock, pedidos, ubicaciones, empresa]) => setDatos({ productos, stock, pedidos, ubicaciones, empresa }))
      .catch((e) => anotar(`No se pudieron cargar los datos: ${(e as Error).message}`, "error"));
  }, []);

  const anotar = (txt: string, tono?: string) => setRegistro((r) => [{ t: new Date().toLocaleTimeString("es-ES"), txt, tono }, ...r].slice(0, 60));

  const aplicarRed = (v: boolean) => {
    const w = marco.current?.contentWindow;
    if (!w) return;
    w.__sindriSinRed = v;
    w.dispatchEvent(new Event("sindri:red"));
  };
  useEffect(() => aplicarRed(sinRed), [sinRed]);

  const codigos = useMemo<CodigoPrueba[]>(() => {
    if (!datos) return [];
    const lista: CodigoPrueba[] = [];
    for (const p of datos.productos.filter((x) => x.kind !== "service").slice(0, 30)) {
      const g = p.gtin ? gtin14(p.gtin) : null;
      lista.push(g ? { grupo: "Productos", titulo: `${p.sku} · ${p.name}`, datos: g.startsWith("0") ? g.slice(1) : g, simb: "]E0" } : { grupo: "Productos", titulo: `${p.sku} · ${p.name} (sin GTIN: se lee la referencia)`, datos: p.sku, simb: "]C0" });
    }
    for (const s of datos.stock.filter((x) => x.lot_code).slice(0, 30)) {
      const p = datos.productos.find((x) => x.id === s.product_id);
      const g = p?.gtin ? gtin14(p.gtin) : null;
      if (!g) continue;
      const campos = [{ ai: "01", valor: g }, { ai: "10", valor: s.lot_code }];
      if (s.expiry_date) campos.push({ ai: "17", valor: aFechaGs1(s.expiry_date) });
      lista.push({ grupo: "Etiquetas de lote (GS1-128)", titulo: `${s.sku} lote ${s.lot_code}${s.expiry_date ? ` · caduca ${fecha(s.expiry_date)}` : ""}`, datos: componerGs1(campos), simb: "]C1" });
    }
    for (const u of datos.ubicaciones.filter((x) => x.kind === "internal")) lista.push({ grupo: "Ubicaciones", titulo: `${u.code} · ${u.name}`, datos: u.code, simb: "]C0" });
    for (const o of datos.pedidos.slice(0, 20)) lista.push({ grupo: "Pedidos confirmados", titulo: `${o.number} · ${o.partner_name}`, datos: o.number, simb: "]C0" });
    const prefijo = datos.empresa?.gs1_prefix && /^\d{6,12}$/.test(datos.empresa.gs1_prefix) ? datos.empresa.gs1_prefix : "8400000";
    lista.push({ grupo: "Palés y bultos", titulo: `Palé SSCC de ejemplo (prefijo ${prefijo})`, datos: componerGs1([{ ai: "00", valor: buildSscc(3, prefijo, 1) }]), simb: "]C1" });
    lista.push({ grupo: "Para provocar errores", titulo: "Código que no existe en Sindri", datos: conControl("841234567899"), simb: "]E0" });
    lista.push({ grupo: "Para provocar errores", titulo: "GS1 con fecha imposible (31 de febrero)", datos: componerGs1([{ ai: "01", valor: "08400000000014" }, { ai: "17", valor: "270231" }]), simb: "]C1" });
    return lista;
  }, [datos]);

  const etiqueta = useMemo(() => {
    const p = datos?.productos.find((x) => x.id === et.producto);
    const g = p?.gtin ? gtin14(p.gtin) : null;
    if (!g) return null;
    const campos = [{ ai: "01", valor: g }];
    if (et.caducidad) campos.push({ ai: "17", valor: aFechaGs1(et.caducidad) });
    if (et.lote) campos.push({ ai: "10", valor: et.lote });
    if (et.cantidad) campos.push({ ai: "37", valor: et.cantidad });
    try {
      return componerGs1(campos);
    } catch {
      return null;
    }
  }, [et, datos]);

  const leer = async (c: { datos: string; simb: string; titulo?: string }) => {
    const w = marco.current?.contentWindow;
    if (!w) return;
    let d = danado ? danar(c.datos) : c.datos;
    const veces = doble ? 2 : 1;
    for (let i = 0; i < veces; i++) {
      if (perfil.via === "evento") {
        w.dispatchEvent(new (w as unknown as typeof globalThis).CustomEvent("sindri:escaneo", { detail: { datos: perfil.aim ? c.simb + d : d, simbologia: c.simb } }));
      } else {
        await teclear(w, (perfil.aim ? c.simb : "") + d, perfil);
      }
      if (i === 0) anotar(`${perfil.via === "evento" ? "Evento" : "Teclado"} · ${verGs(d)}${danado ? " (dañado)" : ""}${doble ? " ×2" : ""}`);
      if (veces > 1) await espera(120);
    }
    w.focus();
  };

  const verQr = async (c: CodigoPrueba) => {
    // Para leerlo con una PDA o un móvil de verdad apuntando a la pantalla.
    setQr({ titulo: c.titulo, url: await QRCode.toDataURL(c.datos, { margin: 2, width: 260 }) });
  };

  const grupos = [...new Set(codigos.map((c) => c.grupo))];
  const productosGtin = datos?.productos.filter((p) => p.gtin && p.kind !== "service") ?? [];

  return (
    <div className="sim">
      <div className="sim-aparato">
        <div className="sim-carcasa" style={{ width: aparato.w + 24 }}>
          <div className="sim-ventana" />
          <iframe ref={marco} title="PDA" src={`${location.pathname}${location.search}#/pda`} style={{ width: aparato.w, height: aparato.h }} onLoad={() => aplicarRed(sinRed)} />
          <button className="sim-gatillo" onClick={() => leer({ datos: libre.replace(/<GS>/g, GS) || codigos[0]?.datos || "", simb: "]C0" })} title="Lee el texto libre (o el primer código)">
            <ScanLine size={18} aria-hidden /> Gatillo
          </button>
        </div>
      </div>

      <aside className="sim-panel">
        <h1>Simulador de PDA</h1>
        <p className="sim-nota">La PDA de la izquierda es Sindri de verdad: lo que hagas cambia el stock de esta empresa. Úsalo en DEV o con una empresa DEMO.</p>

        <section>
          <h2>Lector y aparato</h2>
          <label className="sim-campo">
            <span>Lector</span>
            <select value={perfil.id} onChange={(e) => setPerfil(PERFILES.find((p) => p.id === e.target.value)!)}>
              {PERFILES.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </select>
          </label>
          <p className="sim-nota">{perfil.nota}</p>
          <div className="sim-fila">
            <label className="sim-campo">
              <span>Aparato</span>
              <select value={aparato.id} onChange={(e) => setAparato(APARATOS.find((a) => a.id === e.target.value)!)}>
                {APARATOS.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
              </select>
            </label>
            <label className="sim-check"><input type="checkbox" checked={perfil.aim} onChange={(e) => setPerfil({ ...perfil, aim: e.target.checked })} /> Mandar simbología (]C1…)</label>
          </div>
        </section>

        <section>
          <h2>Fallos</h2>
          <div className="sim-fila">
            <button className={`sim-toggle ${sinRed ? "on" : ""}`} onClick={() => setSinRed(!sinRed)}>{sinRed ? <WifiOff size={16} /> : <Wifi size={16} />} {sinRed ? "Sin red" : "Con red"}</button>
            <label className="sim-check"><input type="checkbox" checked={doble} onChange={(e) => setDoble(e.target.checked)} /> Lectura doble</label>
            <label className="sim-check"><input type="checkbox" checked={danado} onChange={(e) => setDanado(e.target.checked)} /> Etiqueta dañada</label>
            <label className="sim-check"><input type="checkbox" checked={perfil.gs === "quitar"} onChange={(e) => setPerfil({ ...perfil, gs: e.target.checked ? "quitar" : "caracter" })} /> Se pierde el GS</label>
          </div>
        </section>

        <section>
          <h2>Códigos de esta empresa</h2>
          {!datos && <p className="sim-nota">Cargando…</p>}
          {grupos.map((g) => (
            <details key={g} open={g === "Productos" || g === "Etiquetas de lote (GS1-128)"}>
              <summary>{g} ({codigos.filter((c) => c.grupo === g).length})</summary>
              <ul className="sim-codigos">
                {codigos.filter((c) => c.grupo === g).map((c, i) => (
                  <li key={i}>
                    <div>
                      <span>{c.titulo}</span>
                      <code>{verGs(c.datos)}</code>
                    </div>
                    <button className="sim-leer" onClick={() => leer(c)}><ScanLine size={16} aria-hidden /> Leer</button>
                    <button className="sim-ico" onClick={() => verQr(c)} title="Ver QR para leer con un aparato de verdad" aria-label="Ver QR"><QrCode size={16} /></button>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </section>

        <section>
          <h2>Etiqueta de proveedor</h2>
          <p className="sim-nota">Compón la etiqueta GS1-128 que traería un palé o una caja del proveedor.</p>
          <div className="sim-fila">
            <label className="sim-campo">
              <span>Producto (con GTIN)</span>
              <select value={et.producto} onChange={(e) => setEt({ ...et, producto: e.target.value })}>
                <option value="">—</option>
                {productosGtin.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
              </select>
            </label>
            <label className="sim-campo"><span>Lote (10)</span><input value={et.lote} onChange={(e) => setEt({ ...et, lote: e.target.value })} /></label>
            <label className="sim-campo"><span>Caducidad (17)</span><input type="date" value={et.caducidad} onChange={(e) => setEt({ ...et, caducidad: e.target.value })} /></label>
            <label className="sim-campo"><span>Cantidad (37)</span><input inputMode="numeric" value={et.cantidad} onChange={(e) => setEt({ ...et, cantidad: e.target.value.replace(/\D/g, "") })} /></label>
          </div>
          {productosGtin.length === 0 && datos && <p className="sim-nota">Ningún producto tiene GTIN. Pon el EAN en la ficha del producto para probar etiquetas.</p>}
          {etiqueta && (
            <div className="sim-etiqueta">
              <code>{verGs(etiqueta)}</code>
              <button className="sim-leer" onClick={() => leer({ datos: etiqueta, simb: "]C1" })}><ScanLine size={16} aria-hidden /> Leer</button>
            </div>
          )}
        </section>

        <section>
          <h2>Texto libre</h2>
          <textarea rows={2} value={libre} onChange={(e) => setLibre(e.target.value)} placeholder="Cualquier código. Escribe <GS> para el separador." data-escaner="no" />
          <button className="sim-leer" disabled={!libre} onClick={() => leer({ datos: libre.replace(/<GS>/g, GS), simb: "]C0" })}><ScanLine size={16} aria-hidden /> Leer</button>
        </section>

        <section>
          <h2>
            Registro
            {registro.length > 0 && <button className="sim-ico" onClick={() => setRegistro([])} aria-label="Vaciar registro"><Trash2 size={16} /></button>}
          </h2>
          <ol className="sim-registro">
            {registro.map((r, i) => <li key={i} className={r.tono}><time>{r.t}</time> {r.txt}</li>)}
          </ol>
        </section>
      </aside>

      {qr && (
        <div className="sim-qr" role="dialog" aria-label="QR" onClick={() => setQr(null)}>
          <div>
            <img src={qr.url} alt={`QR de ${qr.titulo}`} />
            <p>{qr.titulo}</p>
            <p className="sim-nota">Es un QR normal con los mismos datos (con el GS dentro). Un lector de verdad lo dará como QR, no como GS1 QR; Sindri lo entiende igual.</p>
            <button>Cerrar</button>
          </div>
        </div>
      )}
    </div>
  );
}
