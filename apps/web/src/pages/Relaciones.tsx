/**
 * Relaciones: la cadena de cualquier registro dibujada como un grafo de nodos.
 *
 * cliente → oportunidad → presupuesto → pedido → albarán / hoja de ruta → lote / factura → cobro
 *
 * Al pulsar un nodo se resalta todo lo que viene antes y después (la traza) y se puede abrir el
 * registro o centrar el grafo en él. Además del diagrama hay una vista en lista, que se lee mejor
 * con lector de pantalla y se imprime.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Banknote, Boxes, Circle, ExternalLink, FileSignature, FileText, List, Minus, Network, PackageCheck, Plus, Search, ShoppingCart, Target, Truck, Users, type LucideIcon,
} from "lucide-react";
import { api, eur, fecha } from "../api";
import { useData } from "../hooks";
import { navigate } from "../router";
import { Alert, Badge, Empty, ErrorBox, Page, Table } from "../ui";

export interface Nodo {
  key: string;
  tipo: string;
  id: string;
  titulo: string;
  subtitulo: string | null;
  estado: string | null;
  importe: string | null;
  fecha: string | null;
  ruta: string | null;
}
interface Arista {
  from: string;
  to: string;
  rel: string;
}
interface Grafo {
  inicio: string;
  nodos: Nodo[];
  aristas: Arista[];
  truncado: boolean;
  tipos: Record<string, { etiqueta: string; centro: boolean }>;
}

/**
 * Orden de las columnas: el del negocio, de izquierda a derecha. Lo que sale de un pedido
 * (albarán, hoja de ruta, factura) va en la misma columna, para que ninguna flecha pase por
 * debajo de otra tarjeta.
 */
const RANGO: Record<string, number> = { cliente: 0, oportunidad: 1, presupuesto: 2, pedido: 3, albaran: 4, ruta: 4, factura: 4, lote: 5, cobro: 5 };
const ICONO: Record<string, LucideIcon> = {
  cliente: Users, oportunidad: Target, presupuesto: FileSignature, pedido: ShoppingCart, albaran: PackageCheck, ruta: Truck, factura: FileText, cobro: Banknote, lote: Boxes,
};
const ETIQUETA: Record<string, string> = {
  cliente: "Cliente", oportunidad: "Oportunidad", presupuesto: "Presupuesto", pedido: "Pedido", albaran: "Albarán", ruta: "Hoja de ruta", factura: "Factura", cobro: "Cobro", lote: "Lote",
};

const W = 216;
const H = 76;
const GAP_X = 72;
const GAP_Y = 16;
const PAD = 16;

/**
 * Layout por capas: cada nodo va en la columna de su tipo, o más a la derecha si viene de otro
 * de la misma columna (un pedido separado de otro). Las columnas vacías se quitan. Dentro de cada
 * columna se ordena por el baricentro de sus vecinos para que se crucen pocas aristas.
 */
function layout(g: Grafo) {
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const n of g.nodos) {
    preds.set(n.key, []);
    succs.set(n.key, []);
  }
  for (const a of g.aristas) {
    preds.get(a.to)?.push(a.from);
    succs.get(a.from)?.push(a.to);
  }
  const capa = new Map<string, number>();
  for (const n of g.nodos) capa.set(n.key, RANGO[n.tipo] ?? 3);
  // Relajación (como mucho tantas vueltas como nodos: el grafo no tiene ciclos, pero por si acaso).
  for (let i = 0, cambio = true; cambio && i < g.nodos.length; i++) {
    cambio = false;
    for (const a of g.aristas) {
      const need = (capa.get(a.from) ?? 0) + 1;
      if ((capa.get(a.to) ?? 0) < need) {
        capa.set(a.to, need);
        cambio = true;
      }
    }
  }
  const usadas = [...new Set(capa.values())].sort((a, b) => a - b);
  const col = new Map<string, number>([...capa].map(([k, c]) => [k, usadas.indexOf(c)]));
  const columnas: string[][] = usadas.map(() => []);
  const porKey = new Map(g.nodos.map((n) => [n.key, n]));
  for (const n of [...g.nodos].sort((a, b) => (a.fecha ?? "").localeCompare(b.fecha ?? "") || a.titulo.localeCompare(b.titulo))) columnas[col.get(n.key)!]!.push(n.key);
  const fila = new Map<string, number>();
  const numerar = () => columnas.forEach((c) => c.forEach((k, i) => fila.set(k, i)));
  numerar();
  const bari = (k: string, vecinos: string[]) => (vecinos.length ? vecinos.reduce((s, v) => s + (fila.get(v) ?? 0), 0) / vecinos.length : (fila.get(k) ?? 0));
  for (let vuelta = 0; vuelta < 4; vuelta++) {
    const orden = vuelta % 2 === 0 ? columnas.map((_, i) => i) : columnas.map((_, i) => columnas.length - 1 - i);
    for (const i of orden) {
      const c = columnas[i]!;
      const v = (k: string) => (vuelta % 2 === 0 ? preds.get(k)! : succs.get(k)!);
      c.sort((a, b) => bari(a, v(a)) - bari(b, v(b)));
      numerar();
    }
  }
  const alto = Math.max(...columnas.map((c) => c.length), 1);
  const pos = new Map<string, { x: number; y: number }>();
  columnas.forEach((c, i) => {
    // Cada columna centrada en vertical respecto a la más alta.
    const off = ((alto - c.length) * (H + GAP_Y)) / 2;
    c.forEach((k, j) => pos.set(k, { x: PAD + i * (W + GAP_X), y: PAD + off + j * (H + GAP_Y) }));
  });
  return {
    pos,
    preds,
    succs,
    porKey,
    columnas,
    ancho: PAD * 2 + columnas.length * W + Math.max(columnas.length - 1, 0) * GAP_X,
    altura: PAD * 2 + alto * H + (alto - 1) * GAP_Y,
  };
}

/** Todo lo que va antes y después de un nodo: su traza. */
function traza(key: string, preds: Map<string, string[]>, succs: Map<string, string[]>) {
  const out = new Set<string>([key]);
  for (const m of [preds, succs]) {
    const pila = [key];
    while (pila.length) for (const v of m.get(pila.pop()!) ?? []) if (!out.has(v)) out.add(v), pila.push(v);
  }
  return out;
}

export const rutaRelaciones = (tipo: string, id: string) => `/relaciones/${tipo}/${id}`;

/** Botón para las fichas: «Relaciones» abre el grafo de ese registro. */
export const RelacionesBoton = ({ tipo, id }: { tipo: string; id: string }) => (
  <button type="button" onClick={() => navigate(rutaRelaciones(tipo, id))} title="Ver de dónde viene y a dónde va">
    <Network size={16} aria-hidden /> Relaciones
  </button>
);

function Buscador({ autoFocus }: { autoFocus?: boolean }) {
  const [texto, setTexto] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(texto.trim()), 250);
    return () => clearTimeout(t);
  }, [texto]);
  const { data, error } = useData<Nodo[]>(q.length >= 2 ? `/grafo/buscar?q=${encodeURIComponent(q)}` : null);
  return (
    <div className="rel-buscar">
      <label className="rel-buscar-campo">
        <Search size={16} aria-hidden />
        <input
          type="search"
          autoFocus={autoFocus}
          placeholder="Buscar por número, cliente, lote…"
          aria-label="Buscar un registro"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
        />
      </label>
      <ErrorBox error={error} />
      {q.length >= 2 && data && (
        <ul className="rel-resultados" role="listbox" aria-label="Resultados">
          {data.length === 0 && <li className="muted">Nada con «{q}».</li>}
          {data.map((n) => {
            const Icon = ICONO[n.tipo] ?? Circle;
            return (
              <li key={n.key}>
                <button type="button" className="rel-resultado" onClick={() => { setTexto(""); navigate(rutaRelaciones(n.tipo, n.id)); }}>
                  <Icon size={16} aria-hidden />
                  <span>
                    <b>{n.titulo}</b> <small className="muted">{ETIQUETA[n.tipo] ?? n.tipo}{n.subtitulo ? ` · ${n.subtitulo}` : ""}</small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Tarjeta({ n, x, y, inicio, sel, tenue, onSel }: { n: Nodo; x: number; y: number; inicio: boolean; sel: boolean; tenue: boolean; onSel: () => void }) {
  const Icon = ICONO[n.tipo] ?? Circle;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && e.shiftKey) navigate(rutaRelaciones(n.tipo, n.id));
  };
  return (
    <button
      type="button"
      className={`rel-nodo rel-${n.tipo}${inicio ? " rel-inicio" : ""}${sel ? " rel-sel" : ""}${tenue ? " rel-tenue" : ""}`}
      style={{ left: x, top: y, width: W, height: H }}
      aria-pressed={sel}
      onClick={onSel}
      onDoubleClick={() => navigate(rutaRelaciones(n.tipo, n.id))}
      onKeyDown={onKey}
      title={`${ETIQUETA[n.tipo] ?? n.tipo} ${n.titulo}. Doble clic: centrar aquí`}
    >
      <span className="rel-nodo-tipo">
        <Icon size={14} aria-hidden /> {ETIQUETA[n.tipo] ?? n.tipo}
        {n.estado && <Badge state={n.estado} />}
      </span>
      <b className="rel-nodo-titulo">{n.titulo}</b>
      <span className="rel-nodo-sub">
        {[n.subtitulo, n.importe !== null ? eur(n.importe) : null].filter(Boolean).join(" · ")}
      </span>
    </button>
  );
}

function Diagrama({ g, sel, setSel }: { g: Grafo; sel: string | null; setSel: (k: string | null) => void }) {
  const L = useMemo(() => layout(g), [g]);
  const [zoom, setZoom] = useState(1);
  const marco = useRef<HTMLDivElement>(null);
  const resaltado = useMemo(() => (sel ? traza(sel, L.preds, L.succs) : null), [sel, L]);
  // Al cargar, el nodo de partida a la vista.
  useEffect(() => {
    const p = L.pos.get(g.inicio);
    const m = marco.current;
    if (p && m) m.scrollTo({ left: Math.max(0, p.x * zoom - m.clientWidth / 2 + W / 2), top: Math.max(0, p.y * zoom - m.clientHeight / 2 + H / 2) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.inicio, L]);
  const ajustar = () => {
    const m = marco.current;
    if (m) setZoom(Math.max(0.4, Math.min(1, (m.clientWidth - 8) / L.ancho, 640 / L.altura)));
  };
  return (
    <div className="rel-diagrama">
      <div className="rel-barra">
        <span className="hint">Pulsa un nodo para ver su traza; doble clic para centrar el grafo en él.</span>
        <div className="rel-zoom" role="group" aria-label="Zoom">
        <button type="button" onClick={() => setZoom((z) => Math.max(0.4, z - 0.15))} aria-label="Alejar"><Minus size={16} aria-hidden /></button>
        <button type="button" onClick={() => setZoom(1)} aria-label="Tamaño normal">{Math.round(zoom * 100)} %</button>
        <button type="button" onClick={() => setZoom((z) => Math.min(1.6, z + 0.15))} aria-label="Acercar"><Plus size={16} aria-hidden /></button>
          <button type="button" onClick={ajustar}>Ajustar</button>
        </div>
      </div>
      <div className="rel-marco" ref={marco} onClick={(e) => e.target === e.currentTarget && setSel(null)}>
        <div className="rel-lienzo" style={{ width: L.ancho * zoom, height: L.altura * zoom }}>
          <div style={{ width: L.ancho, height: L.altura, transform: `scale(${zoom})`, transformOrigin: "0 0", position: "relative" }} onClick={(e) => e.target === e.currentTarget && setSel(null)}>
            <svg className="rel-aristas" width={L.ancho} height={L.altura} aria-hidden>
              <defs>
                <marker id="rel-flecha" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0 0L10 5L0 10z" fill="context-stroke" />
                </marker>
              </defs>
              {g.aristas.map((a) => {
                const p = L.pos.get(a.from);
                const q = L.pos.get(a.to);
                if (!p || !q) return null;
                const x1 = p.x + W, y1 = p.y + H / 2, x2 = q.x, y2 = q.y + H / 2;
                const dx = Math.max(32, (x2 - x1) / 2);
                const on = resaltado ? resaltado.has(a.from) && resaltado.has(a.to) : false;
                return (
                  <g key={`${a.from}>${a.to}`} className={`rel-arista${on ? " on" : ""}${resaltado && !on ? " tenue" : ""}${a.rel === "…" ? " oculta" : ""}`}>
                    <path d={`M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`} markerEnd="url(#rel-flecha)" />
                    <title>{a.rel === "…" ? "Pasa por registros que tu rol no deja ver" : a.rel}</title>
                  </g>
                );
              })}
            </svg>
            {g.nodos.map((n) => {
              const p = L.pos.get(n.key)!;
              return (
                <Tarjeta
                  key={n.key}
                  n={n}
                  x={p.x}
                  y={p.y}
                  inicio={n.key === g.inicio}
                  sel={n.key === sel}
                  tenue={!!resaltado && !resaltado.has(n.key)}
                  onSel={() => setSel(n.key === sel ? null : n.key)}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Lista({ g }: { g: Grafo }) {
  const grupos = useMemo(() => {
    const m = new Map<string, Nodo[]>();
    for (const n of [...g.nodos].sort((a, b) => (RANGO[a.tipo] ?? 9) - (RANGO[b.tipo] ?? 9) || (a.fecha ?? "").localeCompare(b.fecha ?? ""))) m.set(n.tipo, [...(m.get(n.tipo) ?? []), n]);
    return [...m];
  }, [g]);
  const titulo = new Map(g.nodos.map((n) => [n.key, n.titulo]));
  const de = (k: string) => g.aristas.filter((a) => a.to === k).map((a) => titulo.get(a.from)).filter(Boolean).join(", ");
  return (
    <Table>
      <thead>
        <tr><th>Tipo</th><th>Registro</th><th>Detalle</th><th>Estado</th><th className="num">Importe</th><th>Fecha</th><th>Viene de</th><th /></tr>
      </thead>
      <tbody>
        {grupos.flatMap(([tipo, ns]) =>
          ns.map((n) => (
            <tr key={n.key} className={n.key === g.inicio ? "rel-fila-inicio" : undefined}>
              <td>{ETIQUETA[tipo] ?? tipo}</td>
              <td><b>{n.titulo}</b></td>
              <td>{n.subtitulo}</td>
              <td>{n.estado && <Badge state={n.estado} />}</td>
              <td className="num">{n.importe !== null ? eur(n.importe) : ""}</td>
              <td>{fecha(n.fecha)}</td>
              <td>{de(n.key)}</td>
              <td className="rel-acciones">
                {n.key !== g.inicio && <button type="button" className="link" onClick={() => navigate(rutaRelaciones(n.tipo, n.id))}>Centrar</button>}
                {n.ruta && !n.ruta.startsWith("/relaciones/") && <button type="button" className="link" onClick={() => navigate(n.ruta!)}>Abrir</button>}
              </td>
            </tr>
          )),
        )}
      </tbody>
    </Table>
  );
}

function Detalle({ n, g, onClose }: { n: Nodo; g: Grafo; onClose: () => void }) {
  const titulo = new Map(g.nodos.map((x) => [x.key, x]));
  const antes = g.aristas.filter((a) => a.to === n.key).map((a) => titulo.get(a.from)!).filter(Boolean);
  const despues = g.aristas.filter((a) => a.from === n.key).map((a) => titulo.get(a.to)!).filter(Boolean);
  const Item = ({ x }: { x: Nodo }) => <li>{ETIQUETA[x.tipo] ?? x.tipo} <b>{x.titulo}</b></li>;
  return (
    <aside className="rel-detalle card" aria-label="Registro elegido">
      <div className="card-head">
        <h2>{ETIQUETA[n.tipo] ?? n.tipo} {n.titulo}</h2>
        <button type="button" className="link" onClick={onClose}>Cerrar</button>
      </div>
      {n.subtitulo && <p className="muted">{n.subtitulo}</p>}
      <p>
        {n.estado && <Badge state={n.estado} />} {n.importe !== null && <b>{eur(n.importe)}</b>} {n.fecha && <span className="muted">{fecha(n.fecha)}</span>}
      </p>
      {antes.length > 0 && <><h3>Viene de</h3><ul>{antes.map((x) => <Item key={x.key} x={x} />)}</ul></>}
      {despues.length > 0 && <><h3>Va a</h3><ul>{despues.map((x) => <Item key={x.key} x={x} />)}</ul></>}
      <div className="row">
        {n.ruta && !n.ruta.startsWith("/relaciones/") && (
          <button type="button" className="primary" onClick={() => navigate(n.ruta!)}><ExternalLink size={16} aria-hidden /> Abrir</button>
        )}
        {n.key !== g.inicio && (
          <button type="button" onClick={() => navigate(rutaRelaciones(n.tipo, n.id))}><Network size={16} aria-hidden /> Centrar aquí</button>
        )}
      </div>
    </aside>
  );
}

const VISTA_KEY = "sindri.relaciones.vista";
const leerVista = () => {
  try {
    return localStorage.getItem(VISTA_KEY) === "lista" ? "lista" : "diagrama";
  } catch {
    return "diagrama";
  }
};

export function RelacionesPage({ tipo, id }: { tipo?: string; id?: string }) {
  const { data: g, error, loading } = useData<Grafo>(tipo && id ? `/grafo?tipo=${encodeURIComponent(tipo)}&id=${encodeURIComponent(id)}` : null);
  const [sel, setSel] = useState<string | null>(null);
  const [vista, setVistaState] = useState<"diagrama" | "lista">(leerVista);
  const setVista = (v: "diagrama" | "lista") => {
    setVistaState(v);
    try {
      localStorage.setItem(VISTA_KEY, v);
    } catch {
      /* sin almacenamiento: solo para esta vez */
    }
  };
  useEffect(() => setSel(null), [tipo, id]);
  const inicio = g?.nodos.find((n) => n.key === g.inicio);
  const elegido = g && sel ? g.nodos.find((n) => n.key === sel) : undefined;

  return (
    <Page
      title={inicio ? `Relaciones · ${ETIQUETA[inicio.tipo] ?? inicio.tipo} ${inicio.titulo}` : "Relaciones"}
      actions={
        g && (
          <div className="tabs-inline" role="group" aria-label="Vista">
            <button type="button" className={vista === "diagrama" ? "primary" : ""} aria-pressed={vista === "diagrama"} onClick={() => setVista("diagrama")}>
              <Network size={16} aria-hidden /> Diagrama
            </button>
            <button type="button" className={vista === "lista" ? "primary" : ""} aria-pressed={vista === "lista"} onClick={() => setVista("lista")}>
              <List size={16} aria-hidden /> Lista
            </button>
          </div>
        )
      }
    >
      <p className="sub">De dónde viene y a dónde va cada registro: cliente, oportunidad, presupuesto, pedido, albarán, hoja de ruta, lote, factura y cobro.</p>
      <Buscador autoFocus={!tipo} />
      <ErrorBox error={error} />
      {!tipo && <Empty>Busca un pedido, una factura, un cliente o un lote para ver su cadena. También se abre con el botón «Relaciones» de cada ficha.</Empty>}
      {loading && !g && <p className="hint">Cargando…</p>}
      {g && (
        <>
          {g.truncado && <Alert tone="aviso">Hay demasiados registros para dibujarlos todos: se enseñan los más recientes. Centra el grafo en uno concreto para ver su parte.</Alert>}
          {g.aristas.some((a) => a.rel === "…") && <Alert tone="info">Las líneas a trazos pasan por registros que tu rol no deja ver.</Alert>}
          {vista === "diagrama" ? (
            <>
              <div className={`rel-cuerpo${elegido ? " con-detalle" : ""}`}>
                <Diagrama g={g} sel={sel} setSel={setSel} />
                {elegido && <Detalle n={elegido} g={g} onClose={() => setSel(null)} />}
              </div>
            </>
          ) : (
            <Lista g={g} />
          )}
        </>
      )}
    </Page>
  );
}
