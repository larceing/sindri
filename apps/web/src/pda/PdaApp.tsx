/**
 * Sindri en la PDA: pantallas grandes, una tarea por pantalla y el escáner como entrada principal.
 * Se abre en `#/pda` desde el navegador de la PDA (o dentro del simulador, `#/pda-simulador`).
 *
 * Tareas de esta primera versión, con lo que ya tiene la API:
 * - Consultar: qué es un código (producto, lote, ubicación, pedido) y su stock.
 * - Recibir: entrada de mercancía leyendo la etiqueta del proveedor (GTIN, lote, caducidad, cantidad).
 * - Preparar pedido: comprobar leyendo cada artículo y confirmar la salida (albarán).
 * - Pendientes: lo hecho sin conexión que falta por mandar.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, CheckCircle2, ClipboardList, CloudOff, ListChecks, Minus, PackagePlus, PackageSearch, Plus, ScanLine, Upload, Wifi } from "lucide-react";
import { gtin14, leerCodigo, type LecturaCodigo } from "@sindri/core/gs1";
import { fecha, qty } from "../api";
import { navigate, useRoute } from "../router";
import { nombreEmpresa, type Me } from "../session";
import { useEscaner, type Escaneo } from "./escaner";
import { aviso, encolar, enviarCola, guardarCopia, leerCopia, nuevoId, pdaApi, quitarDeCola, reintentarOp, useCola, useCopia, useRed, type Operacion } from "./datos";
import "./pda.css";

interface Producto {
  id: string;
  sku: string;
  name: string;
  gtin: string | null;
  uom: string;
  kind: string;
  track_lots: boolean;
  on_hand: string;
}
interface Existencia {
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
interface Pedido {
  id: string;
  number: string;
  partner_name: string;
  delivery_date?: string | null;
  delivery_city?: string | null;
  lines?: { product_id: string; sku: string; description: string; quantity: string; uom: string }[];
}

type Mensaje = { tono: "ok" | "error" | "atencion" | "info"; texto: string } | null;

/** Busca el producto de una lectura: por GTIN o por referencia interna. */
export function productoDe(l: LecturaCodigo, productos: Producto[]): Producto | undefined {
  if (l.gtin) return productos.find((p) => p.gtin && gtin14(p.gtin) === l.gtin);
  const t = l.texto?.trim().toUpperCase();
  return t ? productos.find((p) => p.sku.toUpperCase() === t || (p.gtin && gtin14(p.gtin) === gtin14(t))) : undefined;
}

/** El lote que debería salir antes (FEFO) según la copia de existencias. */
const loteFefo = (stock: Existencia[], productId: string) =>
  stock
    .filter((s) => s.product_id === productId && s.lot_code && Number(s.quantity) > 0)
    .sort((a, b) => (a.expiry_date ?? "9999").localeCompare(b.expiry_date ?? "9999"))[0];

export function PdaApp({ me }: { me: Me }) {
  const empresa = me.company!;
  const route = useRoute();
  const pantalla = route.split("?")[0]!.split("/")[2] ?? "";
  const red = useRed();
  const cola = useCola(empresa);
  const productos = useCopia<Producto[]>(empresa, "productos", "/products");
  const stock = useCopia<Existencia[]>(empresa, "stock", "/stock");
  const pedidos = useCopia<Pedido[]>(empresa, "pedidos", "/sales-orders?state=confirmed");
  const [mensaje, setMensaje] = useState<Mensaje>(null);
  const [ultima, setUltima] = useState<{ e: Escaneo; l: LecturaCodigo } | null>(null);
  const manejador = useRef<(l: LecturaCodigo, e: Escaneo) => void>(() => {});

  const decir = (tono: NonNullable<Mensaje>["tono"], texto: string) => {
    setMensaje({ tono, texto });
    if (tono !== "info") aviso(tono);
  };

  useEscaner((e) => {
    const l = leerCodigo(e.datos);
    setUltima({ e, l });
    manejador.current(l, e);
  });

  // Al volver la red se refresca todo y se manda lo pendiente.
  useEffect(() => {
    if (!red) return;
    void enviarCola(empresa).then((r) => {
      if (r.enviadas) decir("ok", r.enviadas === 1 ? "Enviada 1 operación pendiente" : `Enviadas ${r.enviadas} operaciones pendientes`);
      void stock.recargar();
      void productos.recargar();
    });
  }, [red, cola.length]);
  // Cada pantalla empieza sin el mensaje de la anterior.
  useEffect(() => setMensaje(null), [pantalla]);

  const comun = { empresa, productos: productos.datos ?? [], stock: stock.datos ?? [], decir, manejador, ultima };
  const titulo = { "": "Sindri PDA", consultar: "Consultar", recibir: "Recibir mercancía", preparar: "Preparar pedido", pendientes: "Pendientes de enviar" }[pantalla] ?? "Sindri PDA";

  return (
    <div className="pda">
      <header className="pda-cab">
        {pantalla ? (
          <button className="pda-atras" onClick={() => navigate("/pda")} aria-label="Volver">
            <ArrowLeft size={22} />
          </button>
        ) : null}
        <div className="pda-titulo">
          <strong>{titulo}</strong>
          <span>{me.companies.find((c) => c.id === empresa) ? nombreEmpresa(me.companies.find((c) => c.id === empresa)!) : ""} · {me.name}</span>
        </div>
        <button className={`pda-red ${red ? "on" : "off"}`} onClick={() => navigate("/pda/pendientes")} title={red ? "Con conexión" : "Sin conexión"}>
          {red ? <Wifi size={18} aria-hidden /> : <CloudOff size={18} aria-hidden />}
          {cola.length ? <span className="pda-num">{cola.length}</span> : null}
        </button>
      </header>
      {!red && <div className="pda-sinred">Sin conexión. Puedes seguir: lo que hagas se manda al volver.</div>}
      {mensaje && (
        <div className={`pda-msg pda-msg-${mensaje.tono}`} role={mensaje.tono === "error" ? "alert" : "status"} onClick={() => setMensaje(null)}>
          {mensaje.texto}
        </div>
      )}
      <main className="pda-cuerpo">
        {pantalla === "consultar" ? (
          <Consultar {...comun} pedidos={pedidos.datos ?? []} />
        ) : pantalla === "recibir" ? (
          <Recibir {...comun} red={red} />
        ) : pantalla === "preparar" ? (
          <Preparar {...comun} pedidos={pedidos.datos ?? []} red={red} id={route.split("?")[0]!.split("/")[3]} recargarPedidos={pedidos.recargar} />
        ) : pantalla === "pendientes" ? (
          <Pendientes empresa={empresa} cola={cola} red={red} decir={decir} manejador={manejador} />
        ) : (
          <Inicio cola={cola.length} copia={productos.at} manejador={manejador} decir={decir} productos={productos.datos ?? []} pedidos={pedidos.datos ?? []} />
        )}
      </main>
    </div>
  );
}

interface Comun {
  empresa: string;
  productos: Producto[];
  stock: Existencia[];
  decir: (t: NonNullable<Mensaje>["tono"], s: string) => void;
  manejador: React.MutableRefObject<(l: LecturaCodigo, e: Escaneo) => void>;
  ultima: { e: Escaneo; l: LecturaCodigo } | null;
}

const Pista = ({ children }: { children: ReactNode }) => (
  <p className="pda-pista">
    <ScanLine size={20} aria-hidden /> {children}
  </p>
);

function Inicio({ cola, copia, manejador, decir, productos, pedidos }: { cola: number; copia: string | null; manejador: Comun["manejador"]; decir: Comun["decir"]; productos: Producto[]; pedidos: Pedido[] }) {
  // En el menú, leer un pedido lo abre para preparar y leer un producto lo consulta.
  manejador.current = (l) => {
    const p = pedidos.find((x) => x.number === l.texto?.trim());
    if (p) return navigate(`/pda/preparar/${p.id}`);
    if (productoDe(l, productos) || l.tipo !== "texto") return navigate("/pda/consultar");
    decir("atencion", "Elige una tarea o lee un pedido o un producto.");
  };
  const tareas = [
    { ir: "/pda/recibir", icono: PackagePlus, txt: "Recibir", sub: "Entrada de proveedor" },
    { ir: "/pda/preparar", icono: ClipboardList, txt: "Preparar pedido", sub: "Comprobar y dar salida" },
    { ir: "/pda/consultar", icono: PackageSearch, txt: "Consultar", sub: "Producto, lote, ubicación" },
    { ir: "/pda/pendientes", icono: Upload, txt: "Pendientes", sub: cola ? `${cola} sin enviar` : "Todo enviado" },
  ];
  return (
    <>
      <div className="pda-tareas">
        {tareas.map((t) => (
          <button key={t.ir} className="pda-tarea" onClick={() => navigate(t.ir)}>
            <t.icono size={30} aria-hidden />
            <strong>{t.txt}</strong>
            <span>{t.sub}</span>
          </button>
        ))}
        <button className="pda-tarea" disabled title="Necesita ubicaciones y recuentos en Sindri (ver plan)">
          <ListChecks size={30} aria-hidden />
          <strong>Inventario</strong>
          <span>Próximamente</span>
        </button>
      </div>
      <p className="pda-nota">{copia ? `Datos guardados en la PDA: ${new Date(copia).toLocaleString("es-ES")}` : "Aún no hay datos guardados en la PDA."}</p>
    </>
  );
}

function Campos({ l }: { l: LecturaCodigo }) {
  return (
    <div className="pda-ficha">
      <div className="pda-fila"><span>Tipo</span><b>{l.tipo === "gs1" ? "GS1" : l.tipo === "gtin" ? "Código de producto" : "Texto"}{l.simbologia ? ` · ${l.simbologia}` : ""}</b></div>
      {l.campos.map((c, i) => (
        <div className="pda-fila" key={i}><span>({c.ai}) {c.nombre}</span><b className="mono">{c.fecha ? fecha(c.fecha) : c.numero ?? c.valor}</b></div>
      ))}
      {l.texto ? <div className="pda-fila"><span>Texto</span><b className="mono">{l.texto}</b></div> : null}
      {l.avisos.map((a, i) => <div className="pda-aviso" key={i}>{a}</div>)}
    </div>
  );
}

function Consultar({ productos, stock, decir, manejador, ultima, pedidos }: Comun & { pedidos: Pedido[] }) {
  manejador.current = (l) => {
    if (l.avisos.length) decir("atencion", l.avisos[0]!);
    else if (productoDe(l, productos) || stock.some((s) => s.location_code === l.texto?.trim()) || pedidos.some((p) => p.number === l.texto?.trim())) decir("ok", "Leído");
    else decir("error", "No lo encuentro en Sindri");
  };
  if (!ultima) return <Pista>Lee un producto, una etiqueta de lote, una ubicación o un pedido.</Pista>;
  const l = ultima.l;
  const p = productoDe(l, productos);
  const t = l.texto?.trim();
  const enUbicacion = t ? stock.filter((s) => s.location_code === t) : [];
  const pedido = t ? pedidos.find((x) => x.number === t) : undefined;
  const lineas = p ? stock.filter((s) => s.product_id === p.id) : enUbicacion;
  return (
    <>
      {p && (
        <div className="pda-tarjeta">
          <div className="pda-ref mono">{p.sku}</div>
          <div className="pda-nombre">{p.name}</div>
          <div className="pda-grande">{qty(p.on_hand)} {p.uom}</div>
          {l.lote && <div>Lote leído: <b className="mono">{l.lote}</b>{l.caducidad ? ` · caduca ${fecha(l.caducidad)}` : ""}</div>}
        </div>
      )}
      {pedido && (
        <button className="pda-boton" onClick={() => navigate(`/pda/preparar/${pedido.id}`)}>Preparar el pedido {pedido.number}</button>
      )}
      {lineas.length > 0 && (
        <div className="pda-lista">
          {lineas.map((s, i) => (
            <div className="pda-item" key={i}>
              <div><b className="mono">{p ? (s.lot_code ?? "Sin lote") : s.sku}</b><span>{p ? `${s.location_code}${s.expiry_date ? ` · caduca ${fecha(s.expiry_date)}` : ""}` : s.product_name}</span></div>
              <b>{qty(s.quantity)} {s.uom}</b>
            </div>
          ))}
        </div>
      )}
      {!p && !pedido && !lineas.length && <p className="pda-nota">No es ningún producto, ubicación ni pedido pendiente de esta empresa.</p>}
      <details className="pda-detalle">
        <summary>Lo que ha leído el escáner</summary>
        <Campos l={l} />
      </details>
      <Pista>Lee otro código.</Pista>
    </>
  );
}

function Recibir({ empresa, productos, decir, manejador, red }: Comun & { red: boolean }) {
  const vacio = { producto: null as Producto | null, lote: "", caducidad: "", cantidad: "1" };
  const [f, setF] = useState(vacio);
  manejador.current = (l) => {
    const p = productoDe(l, productos);
    if (p) {
      if (p.kind === "service") return decir("error", `${p.sku} es un servicio: no tiene stock`);
      const mismo = f.producto?.id === p.id && (!l.lote || l.lote === f.lote);
      setF({
        producto: p,
        lote: l.lote ?? (mismo ? f.lote : ""),
        caducidad: l.caducidad ?? (mismo ? f.caducidad : ""),
        cantidad: l.cantidad ?? (mismo ? String(Number(f.cantidad || 0) + 1) : "1"),
      });
      return decir(l.avisos.length ? "atencion" : "ok", l.avisos[0] ?? (mismo ? `+1 · ${p.sku}` : p.name));
    }
    // Sin producto leído no se sabe a qué asignar el texto; con producto con lote, el texto es el lote.
    if (f.producto?.track_lots && l.tipo === "texto" && l.texto) {
      setF({ ...f, lote: l.texto });
      return decir("ok", `Lote ${l.texto}`);
    }
    decir("error", l.gtin ? "Ese código de producto no está dado de alta en Sindri" : "Lee primero el producto");
  };
  const falta = !f.producto ? "Lee el producto" : f.producto.track_lots && !f.lote ? "Falta el lote" : !(Number(f.cantidad) > 0) ? "Falta la cantidad" : null;
  const confirmar = async () => {
    if (!f.producto || falta) return;
    const id = nuevoId();
    encolar(empresa, {
      id,
      tipo: "entrada",
      resumen: `${f.cantidad} ${f.producto.uom} ${f.producto.sku}${f.lote ? ` lote ${f.lote}` : ""}`,
      ruta: "/stock/receipts",
      cuerpo: { id, product_id: f.producto.id, quantity: f.cantidad, ...(f.lote ? { lot_code: f.lote } : {}), ...(f.caducidad ? { expiry_date: f.caducidad } : {}), note: "PDA" },
    });
    const r = await enviarCola(empresa);
    decir(r.errores ? "error" : red && r.enviadas ? "ok" : "atencion", r.errores ? "Sindri la ha rechazado: mira Pendientes" : red && r.enviadas ? "Entrada registrada" : "Guardada en la PDA: se manda al volver la conexión");
    setF(vacio);
  };
  const cambia = (d: number) => setF({ ...f, cantidad: String(Math.max(0, Number(f.cantidad || 0) + d)) });
  if (!f.producto) return <Pista>Lee la etiqueta del producto o del bulto del proveedor.</Pista>;
  return (
    <>
      <div className="pda-tarjeta">
        <div className="pda-ref mono">{f.producto.sku}</div>
        <div className="pda-nombre">{f.producto.name}</div>
      </div>
      {f.producto.track_lots && (
        <label className="pda-campo">
          <span>Lote</span>
          <input value={f.lote} onChange={(e) => setF({ ...f, lote: e.target.value })} placeholder="Lee o escribe el lote" />
        </label>
      )}
      {f.producto.track_lots && (
        <label className="pda-campo">
          <span>Caducidad</span>
          <input type="date" value={f.caducidad} onChange={(e) => setF({ ...f, caducidad: e.target.value })} />
        </label>
      )}
      <div className="pda-campo">
        <span>Cantidad ({f.producto.uom})</span>
        <div className="pda-cantidad">
          <button onClick={() => cambia(-1)} aria-label="Una menos"><Minus /></button>
          <input inputMode="decimal" value={f.cantidad} onChange={(e) => setF({ ...f, cantidad: e.target.value.replace(",", ".") })} data-escaner="no" />
          <button onClick={() => cambia(1)} aria-label="Una más"><Plus /></button>
        </div>
      </div>
      <button className="pda-boton" disabled={!!falta} onClick={confirmar}>{falta ?? "Confirmar entrada"}</button>
      <button className="pda-boton pda-sec" onClick={() => setF(vacio)}>Cancelar</button>
      <Pista>Leer otra vez el mismo producto suma uno.</Pista>
    </>
  );
}

function Preparar({ empresa, productos, stock, decir, manejador, pedidos, red, id, recargarPedidos }: Comun & { pedidos: Pedido[]; red: boolean; id?: string; recargarPedidos: () => Promise<void> }) {
  const [pedido, setPedido] = useState<Pedido | null>(() => (id ? leerCopia<Pedido>(empresa, `pedido.${id}`)?.datos ?? null : null));
  const claveRecogido = `recogido.${id}`;
  const [recogido, setRecogido] = useState<Record<string, number>>(() => (id ? leerCopia<Record<string, number>>(empresa, claveRecogido)?.datos ?? {} : {}));
  useEffect(() => {
    if (!id) return setPedido(null);
    setRecogido(leerCopia<Record<string, number>>(empresa, `recogido.${id}`)?.datos ?? {});
    if (!red) return setPedido(leerCopia<Pedido>(empresa, `pedido.${id}`)?.datos ?? null);
    pdaApi<Pedido>(`/sales-orders/${id}`)
      .then((p) => {
        guardarCopia(empresa, `pedido.${id}`, p);
        setPedido(p);
      })
      .catch(() => setPedido(leerCopia<Pedido>(empresa, `pedido.${id}`)?.datos ?? null));
  }, [id, red, empresa]);
  const porProducto = useMemo(() => new Map(productos.map((p) => [p.id, p])), [productos]);
  // Solo se leen los almacenables: es lo que mueve stock al dar salida.
  const lineas = (pedido?.lines ?? []).map((ln) => ({ ...ln, almacenable: porProducto.get(ln.product_id)?.kind === "stockable" }));
  const hechas = lineas.filter((ln) => !ln.almacenable || (recogido[ln.product_id] ?? 0) >= Number(ln.quantity));
  const completo = lineas.length > 0 && hechas.length === lineas.length;
  const guardar = (r: Record<string, number>) => {
    setRecogido(r);
    guardarCopia(empresa, claveRecogido, r);
  };

  manejador.current = (l) => {
    if (!id) {
      const p = pedidos.find((x) => x.number === l.texto?.trim());
      return p ? navigate(`/pda/preparar/${p.id}`) : decir("error", "No es un pedido confirmado pendiente");
    }
    const p = productoDe(l, productos);
    if (!p) return decir("error", "No es un producto de Sindri");
    const ln = lineas.find((x) => x.product_id === p.id);
    if (!ln) return decir("error", `${p.sku} no está en este pedido`);
    if (!ln.almacenable) return decir("atencion", `${p.sku} no lleva stock: no hace falta leerlo`);
    const ya = recogido[p.id] ?? 0;
    const suma = Number(l.cantidad ?? 1);
    if (ya + suma > Number(ln.quantity)) return decir("error", `Te pasas: el pedido lleva ${qty(ln.quantity)} de ${p.sku}`);
    guardar({ ...recogido, [p.id]: ya + suma });
    const fefo = p.track_lots ? loteFefo(stock, p.id) : undefined;
    if (l.lote && fefo && l.lote !== fefo.lot_code) return decir("atencion", `Lote ${l.lote}: el que caduca antes es ${fefo.lot_code}. Hoy Sindri da salida por FEFO.`);
    decir("ok", `${p.sku} ${ya + suma}/${qty(ln.quantity)}`);
  };

  const confirmar = async () => {
    if (!pedido) return;
    const op = nuevoId();
    encolar(empresa, { id: op, tipo: "entrega", resumen: `Salida del pedido ${pedido.number}`, ruta: `/sales-orders/${pedido.id}/deliver`, cuerpo: {} });
    guardarCopia(empresa, claveRecogido, {});
    const r = await enviarCola(empresa);
    decir(r.errores ? "error" : red && r.enviadas ? "ok" : "atencion", r.errores ? "Sindri no ha podido dar la salida: mira Pendientes" : red && r.enviadas ? `Pedido ${pedido.number} entregado` : "Salida guardada: se manda al volver la conexión");
    void recargarPedidos();
    navigate("/pda/preparar");
  };

  if (!id)
    return (
      <>
        <Pista>Lee el número del pedido o elígelo.</Pista>
        <div className="pda-lista">
          {pedidos.length === 0 && <p className="pda-nota">No hay pedidos confirmados pendientes.</p>}
          {pedidos.map((p) => (
            <button className="pda-item" key={p.id} onClick={() => navigate(`/pda/preparar/${p.id}`)}>
              <div><b className="mono">{p.number}</b><span>{p.partner_name}{p.delivery_city ? ` · ${p.delivery_city}` : ""}</span></div>
              <span>{p.delivery_date ? fecha(p.delivery_date) : ""}</span>
            </button>
          ))}
        </div>
      </>
    );
  if (!pedido) return <p className="pda-nota">{red ? "Cargando…" : "Este pedido no está guardado en la PDA y no hay conexión."}</p>;
  return (
    <>
      <div className="pda-tarjeta">
        <div className="pda-ref mono">{pedido.number}</div>
        <div className="pda-nombre">{pedido.partner_name}</div>
        <div className="pda-barra"><i style={{ width: `${lineas.length ? (hechas.length / lineas.length) * 100 : 0}%` }} /></div>
        <div>{hechas.length} de {lineas.length} líneas</div>
      </div>
      <div className="pda-lista">
        {lineas.map((ln) => {
          const r = recogido[ln.product_id] ?? 0;
          const ok = !ln.almacenable || r >= Number(ln.quantity);
          return (
            <div className={`pda-item ${ok ? "hecho" : ""}`} key={ln.product_id + ln.description}>
              <div><b className="mono">{ln.sku}</b><span>{ln.description}</span></div>
              <b>{ok ? <CheckCircle2 size={18} aria-label="Hecho" /> : null} {ln.almacenable ? `${qty(r)}/${qty(ln.quantity)}` : "—"}</b>
            </div>
          );
        })}
      </div>
      <button className="pda-boton" disabled={!completo} onClick={confirmar}>{completo ? "Confirmar salida" : "Lee todos los artículos"}</button>
      {Object.keys(recogido).length > 0 && <button className="pda-boton pda-sec" onClick={() => guardar({})}>Empezar de nuevo</button>}
      <Pista>Lee cada artículo. Una etiqueta con cantidad (AI 37) suma esa cantidad.</Pista>
    </>
  );
}

function Pendientes({ empresa, cola, red, decir, manejador }: { empresa: string; cola: Operacion[]; red: boolean; decir: Comun["decir"]; manejador: Comun["manejador"] }) {
  manejador.current = () => decir("info", "En esta pantalla no se lee nada.");
  const reintentar = async (o?: Operacion) => {
    if (o) reintentarOp(empresa, o.id);
    const r = await enviarCola(empresa);
    decir(r.errores ? "error" : "ok", r.errores ? `${r.errores} con error` : `${r.enviadas} enviadas`);
  };
  return (
    <>
      {cola.length === 0 ? <p className="pda-nota">Todo enviado.</p> : (
        <div className="pda-lista">
          {cola.map((o) => (
            <div className={`pda-item ${o.error ? "error" : ""}`} key={o.id}>
              <div>
                <b>{o.resumen}</b>
                <span>{new Date(o.creada).toLocaleString("es-ES")}{o.error ? ` · ${o.error}` : ""}</span>
              </div>
              {o.error && (
                <span className="pda-acciones">
                  <button onClick={() => reintentar(o)}>Reintentar</button>
                  <button onClick={() => quitarDeCola(empresa, o.id)}>Descartar</button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <button className="pda-boton" disabled={!red || cola.length === 0} onClick={() => reintentar()}>{red ? "Enviar ahora" : "Sin conexión"}</button>
    </>
  );
}
