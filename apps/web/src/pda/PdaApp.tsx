/**
 * Sindri en la PDA: pantallas grandes, una tarea por pantalla y el escáner como entrada principal.
 * Se abre en `#/pda` desde el navegador de la PDA (o dentro del simulador, `#/pda-simulador`).
 *
 * Tareas:
 * - Consultar: qué es un código (producto, lote, ubicación, pedido) y su stock.
 * - Recibir: entrada leyendo la etiqueta del proveedor (GTIN, lote, caducidad, cantidad) y la ubicación.
 * - Traspasar: mover entre ubicaciones (Almacen.tsx).
 * - Preparar pedido: reservarlo, leer cada artículo con su lote y ubicación y dar la salida.
 * - Inventario: recuento a ciegas (Almacen.tsx).
 * - Pendientes: lo hecho sin conexión que falta por mandar.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRightLeft, Camera, CheckCircle2, ClipboardList, CloudOff, ListChecks, MapPin, PackagePlus, PackageSearch, Upload, Wifi } from "lucide-react";
import { leerCodigo, type LecturaCodigo } from "@sindri/core/gs1";
import { fecha, qty } from "../api";
import { navigate, useRoute } from "../router";
import { nombreEmpresa, type Me } from "../session";
import { appAndroid, useEscaner, type Escaneo } from "./escaner";
import { ApiError } from "../api";
import { aviso, enviarCola, guardarCopia, leerCopia, nuevoId, pdaApi, quitarDeCola, reintentarOp, SinRed, useCola, useCopia, useRed, type Operacion } from "./datos";
import { Cantidad, loteFefo, mandar, Pista, productoDe, ubicacionDe, type Comun, type Existencia, type Mensaje, type Pedido, type Tono, type Producto, type Ubicacion } from "./comun";
import { Recuentos, Traspasar } from "./Almacen";
import "./pda.css";

export function PdaApp({ me }: { me: Me }) {
  const empresa = me.company!;
  const route = useRoute();
  const pantalla = route.split("?")[0]!.split("/")[2] ?? "";
  const red = useRed();
  const cola = useCola(empresa);
  const productos = useCopia<Producto[]>(empresa, "productos", "/products");
  const stock = useCopia<Existencia[]>(empresa, "stock", "/stock");
  const pedidos = useCopia<Pedido[]>(empresa, "pedidos", "/sales-orders?state=confirmed");
  const locs = useCopia<Ubicacion[]>(empresa, "ubicaciones", "/locations");
  const ubicaciones = useMemo(() => (locs.datos ?? []).filter((u) => u.kind === "internal" && !u.archived), [locs.datos]);
  const [mensaje, setMensaje] = useState<Mensaje>(null);
  const [ultima, setUltima] = useState<{ e: Escaneo; l: LecturaCodigo } | null>(null);
  const manejador = useRef<(l: LecturaCodigo, e: Escaneo) => void>(() => {});
  const android = useMemo(appAndroid, []);

  const decir = (tono: Tono, texto: string) => {
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

  const comun: Comun = { empresa, productos: productos.datos ?? [], stock: stock.datos ?? [], ubicaciones, decir, manejador, ultima, red };
  const sub = route.split("?")[0]!.split("/")[3];
  const titulo = { "": "Sindri PDA", consultar: "Consultar", recibir: "Recibir mercancía", traspasar: "Traspasar", preparar: "Preparar pedido", recuento: "Recuento", pendientes: "Pendientes de enviar" }[pantalla] ?? "Sindri PDA";

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
        {android?.camara ? (
          <button className="pda-red" onClick={() => window.SindriAndroid?.camara()} aria-label="Leer con la cámara" title="Leer con la cámara">
            <Camera size={20} aria-hidden />
          </button>
        ) : null}
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
          <Recibir {...comun} />
        ) : pantalla === "traspasar" ? (
          <Traspasar {...comun} />
        ) : pantalla === "preparar" ? (
          <Preparar {...comun} pedidos={pedidos.datos ?? []} id={sub} recargarPedidos={pedidos.recargar} />
        ) : pantalla === "recuento" ? (
          <Recuentos {...comun} id={sub} />
        ) : pantalla === "pendientes" ? (
          <Pendientes empresa={empresa} cola={cola} red={red} decir={decir} manejador={manejador} />
        ) : (
          <Inicio cola={cola.length} copia={productos.at} manejador={manejador} decir={decir} productos={productos.datos ?? []} pedidos={pedidos.datos ?? []} ubicaciones={ubicaciones} />
        )}
      </main>
    </div>
  );
}

function Inicio({ cola, copia, manejador, decir, productos, pedidos, ubicaciones }: { cola: number; copia: string | null; manejador: Comun["manejador"]; decir: Comun["decir"]; productos: Producto[]; pedidos: Pedido[]; ubicaciones: Ubicacion[] }) {
  // En el menú, leer un pedido lo abre para preparar; un producto o una ubicación, se consulta.
  manejador.current = (l) => {
    const p = pedidos.find((x) => x.number === l.texto?.trim());
    if (p) return navigate(`/pda/preparar/${p.id}`);
    if (productoDe(l, productos) || ubicacionDe(l, ubicaciones) || l.tipo !== "texto") return navigate("/pda/consultar");
    decir("atencion", "Elige una tarea o lee un pedido, un producto o una ubicación.");
  };
  const tareas = [
    { ir: "/pda/recibir", icono: PackagePlus, txt: "Recibir", sub: "Entrada y ubicación" },
    { ir: "/pda/preparar", icono: ClipboardList, txt: "Preparar pedido", sub: "Leer y dar salida" },
    { ir: "/pda/traspasar", icono: ArrowRightLeft, txt: "Traspasar", sub: "Entre ubicaciones" },
    { ir: "/pda/recuento", icono: ListChecks, txt: "Inventario", sub: "Recuento a ciegas" },
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

function Consultar({ productos, stock, ubicaciones, decir, manejador, ultima, pedidos }: Comun & { pedidos: Pedido[] }) {
  manejador.current = (l) => {
    if (l.avisos.length) decir("atencion", l.avisos[0]!);
    else if (productoDe(l, productos) || ubicacionDe(l, ubicaciones) || pedidos.some((p) => p.number === l.texto?.trim())) decir("ok", "Leído");
    else decir("error", "No lo encuentro en Sindri");
  };
  if (!ultima) return <Pista>Lee un producto, una etiqueta de lote, una ubicación o un pedido.</Pista>;
  const l = ultima.l;
  const p = productoDe(l, productos);
  const t = l.texto?.trim();
  const ubi = ubicacionDe(l, ubicaciones);
  const enUbicacion = ubi ? stock.filter((s) => s.location_code === ubi.code) : [];
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
      {ubi && !p && (
        <div className="pda-tarjeta">
          <div className="pda-ref"><MapPin size={14} aria-hidden /> Ubicación</div>
          <div className="pda-nombre mono">{ubi.code}</div>
          {ubi.name !== ubi.code && <div>{ubi.name}</div>}
          {!enUbicacion.length && <div className="pda-ref">Vacía (según la PDA)</div>}
        </div>
      )}
      {pedido && (
        <button className="pda-boton" onClick={() => navigate(`/pda/preparar/${pedido.id}`)}>Preparar el pedido {pedido.number}</button>
      )}
      {lineas.length > 0 && (
        <div className="pda-lista">
          {lineas.map((s, i) => (
            <div className="pda-item" key={i}>
              <div><b className="mono">{p ? (s.lot_code ?? "Sin lote") : s.sku}</b><span>{p ? `${s.location_code}${s.expiry_date ? ` · caduca ${fecha(s.expiry_date)}` : ""}` : `${s.product_name}${s.lot_code ? ` · lote ${s.lot_code}` : ""}`}</span></div>
              <b>{qty(s.quantity)} {s.uom}</b>
            </div>
          ))}
        </div>
      )}
      {!p && !pedido && !ubi && <p className="pda-nota">No es ningún producto, ubicación ni pedido pendiente de esta empresa.</p>}
      <details className="pda-detalle">
        <summary>Lo que ha leído el escáner</summary>
        <Campos l={l} />
      </details>
      <Pista>Lee otro código.</Pista>
    </>
  );
}

function Recibir({ empresa, productos, ubicaciones, decir, manejador, red }: Comun) {
  const vacio = { producto: null as Producto | null, lote: "", caducidad: "", cantidad: "1" };
  const [f, setF] = useState(vacio);
  // La ubicación se queda entre entradas: se descarga en el mismo sitio varias veces.
  const [ubicacion, setUbicacion] = useState<Ubicacion | null>(null);
  manejador.current = (l) => {
    const u = ubicacionDe(l, ubicaciones);
    if (u) {
      setUbicacion(u);
      return decir("ok", `Se ubica en ${u.code}`);
    }
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
    await mandar(empresa, {
      id,
      tipo: "entrada",
      resumen: `${f.cantidad} ${f.producto.uom} ${f.producto.sku}${f.lote ? ` lote ${f.lote}` : ""}${ubicacion ? ` en ${ubicacion.code}` : ""}`,
      ruta: "/stock/receipts",
      cuerpo: {
        id,
        product_id: f.producto.id,
        quantity: f.cantidad,
        ...(f.lote ? { lot_code: f.lote } : {}),
        ...(f.caducidad ? { expiry_date: f.caducidad } : {}),
        ...(ubicacion ? { location_code: ubicacion.code } : {}),
        note: "PDA",
      },
    }, red, decir, `Entrada registrada${ubicacion ? ` en ${ubicacion.code}` : ""}`);
    setF(vacio);
  };
  const Donde = () =>
    ubicaciones.length > 1 ? (
      <div className={`pda-item ${ubicacion ? "hecho" : ""}`}>
        <div><span>Ubicación</span><b className="mono">{ubicacion?.code ?? "Almacén principal"}</b></div>
        {ubicacion ? <button className="pda-acciones" onClick={() => setUbicacion(null)} aria-label="Quitar ubicación">×</button> : <MapPin size={18} aria-hidden />}
      </div>
    ) : null;
  if (!f.producto)
    return (
      <>
        <Donde />
        <Pista>Lee la etiqueta del producto o del bulto del proveedor{ubicaciones.length > 1 ? ", y la de la ubicación donde lo dejas" : ""}.</Pista>
      </>
    );
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
      <Cantidad uom={f.producto.uom} valor={f.cantidad} cambiar={(cantidad) => setF({ ...f, cantidad })} />
      <Donde />
      <button className="pda-boton" disabled={!!falta} onClick={confirmar}>{falta ?? "Confirmar entrada"}</button>
      <button className="pda-boton pda-sec" onClick={() => setF(vacio)}>Cancelar</button>
      <Pista>Leer otra vez el mismo producto suma uno. Lee una ubicación para dejarlo allí.</Pista>
    </>
  );
}

/** Lo leído al preparar: qué producto, de qué lote y de qué ubicación. */
interface Lectura {
  product_id: string;
  lote: string;
  ubicacion: string;
  cantidad: number;
}

function Preparar({ empresa, productos, stock, ubicaciones, decir, manejador, pedidos, red, id, recargarPedidos }: Comun & { pedidos: Pedido[]; id?: string; recargarPedidos: () => Promise<void> }) {
  const [pedido, setPedido] = useState<Pedido | null>(() => (id ? leerCopia<Pedido>(empresa, `pedido.${id}`)?.datos ?? null : null));
  const clave = `lecturas.${id}`;
  const [lecturas, setLecturas] = useState<Lectura[]>(() => (id ? leerCopia<Lectura[]>(empresa, clave)?.datos ?? [] : []));
  const [ubicacion, setUbicacion] = useState<Ubicacion | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  // Al abrir el pedido se reserva: si otra persona lo está preparando, se avisa.
  const reservar = async (force = false) => {
    if (!id) return;
    try {
      const p = await pdaApi<Pedido>(`/sales-orders/${id}/take`, { method: "POST", body: force ? { force: true } : {} });
      guardarCopia(empresa, `pedido.${id}`, p);
      setPedido(p);
      setOcupado(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setOcupado(e.message);
      else if (!(e instanceof SinRed)) decir("error", (e as Error).message);
      else setPedido(leerCopia<Pedido>(empresa, `pedido.${id}`)?.datos ?? null);
    }
  };
  useEffect(() => {
    if (!id) return setPedido(null);
    setLecturas(leerCopia<Lectura[]>(empresa, `lecturas.${id}`)?.datos ?? []);
    setOcupado(null);
    if (!red) return setPedido(leerCopia<Pedido>(empresa, `pedido.${id}`)?.datos ?? null);
    void reservar();
  }, [id, red, empresa]);

  const porProducto = useMemo(() => new Map(productos.map((p) => [p.id, p])), [productos]);
  // Solo se leen los almacenables: es lo que mueve stock al dar salida.
  const pedidas = new Map<string, number>();
  for (const ln of pedido?.lines ?? []) pedidas.set(ln.product_id, (pedidas.get(ln.product_id) ?? 0) + Number(ln.quantity));
  const lineas = (pedido?.lines ?? []).map((ln) => ({ ...ln, almacenable: porProducto.get(ln.product_id)?.kind === "stockable" }));
  const leidas = (pid: string) => lecturas.filter((x) => x.product_id === pid).reduce((t, x) => t + x.cantidad, 0);
  const hechas = lineas.filter((ln) => !ln.almacenable || leidas(ln.product_id) >= (pedidas.get(ln.product_id) ?? 0));
  const sinLote = lecturas.find((x) => porProducto.get(x.product_id)?.track_lots && !x.lote);
  const completo = lineas.length > 0 && hechas.length === lineas.length && !sinLote;
  const guardar = (r: Lectura[]) => {
    setLecturas(r);
    guardarCopia(empresa, clave, r);
  };

  manejador.current = (l) => {
    if (!id) {
      const p = pedidos.find((x) => x.number === l.texto?.trim());
      return p ? navigate(`/pda/preparar/${p.id}`) : decir("error", "No es un pedido confirmado pendiente");
    }
    if (ocupado) return decir("error", "Este pedido lo está preparando otra persona");
    const u = ubicacionDe(l, ubicaciones);
    if (u) {
      setUbicacion(u);
      return decir("ok", `Cogiendo de ${u.code}`);
    }
    const p = productoDe(l, productos);
    if (!p) {
      // Un texto después de un producto con lote es su lote.
      const ultimo = lecturas[0];
      if (l.tipo === "texto" && l.texto && ultimo && porProducto.get(ultimo.product_id)?.track_lots && !ultimo.lote) {
        guardar([{ ...ultimo, lote: l.texto }, ...lecturas.slice(1)]);
        return decir("ok", `Lote ${l.texto}`);
      }
      return decir("error", "No es un producto ni una ubicación de Sindri");
    }
    const ln = lineas.find((x) => x.product_id === p.id);
    if (!ln) return decir("error", `${p.sku} no está en este pedido`);
    if (!ln.almacenable) return decir("atencion", `${p.sku} no lleva stock: no hace falta leerlo`);
    const ya = leidas(p.id);
    const suma = Number(l.cantidad ?? 1);
    const total = pedidas.get(p.id) ?? 0;
    if (ya + suma > total) return decir("error", `Te pasas: el pedido lleva ${qty(String(total))} de ${p.sku}`);
    const lote = l.lote ?? "";
    // Misma lectura que la anterior (mismo lote y ubicación): se suma a esa.
    const ultimo = lecturas[0];
    const igual = ultimo && ultimo.product_id === p.id && ultimo.lote === lote && ultimo.ubicacion === (ubicacion?.code ?? "") && (lote || !p.track_lots);
    guardar(igual ? [{ ...ultimo, cantidad: ultimo.cantidad + suma }, ...lecturas.slice(1)] : [{ product_id: p.id, lote, ubicacion: ubicacion?.code ?? "", cantidad: suma }, ...lecturas]);
    if (p.track_lots && !lote) return decir("atencion", `${p.sku} ${ya + suma}/${qty(String(total))}: lee el lote`);
    const fefo = p.track_lots ? loteFefo(stock, p.id) : undefined;
    if (lote && fefo?.lot_code && lote !== fefo.lot_code) return decir("atencion", `Lote ${lote}: el que caduca antes es ${fefo.lot_code} (${fefo.location_code}). Sale el que has leído.`);
    decir("ok", `${p.sku} ${ya + suma}/${qty(String(total))}`);
  };

  const confirmar = async () => {
    if (!pedido || !completo) return;
    const picks = lecturas
      .filter((x) => porProducto.get(x.product_id)?.kind === "stockable")
      .map((x) => ({ product_id: x.product_id, quantity: String(x.cantidad), ...(x.lote ? { lot_code: x.lote } : {}), ...(x.ubicacion ? { location_code: x.ubicacion } : {}) }));
    const r = await mandar(empresa, { id: nuevoId(), tipo: "entrega", resumen: `Salida del pedido ${pedido.number}`, ruta: `/sales-orders/${pedido.id}/deliver`, cuerpo: { picks } }, red, decir, `Pedido ${pedido.number} entregado`);
    if (r === "rechazada") return; // se queda en la pantalla con lo leído para corregir
    guardarCopia(empresa, clave, []);
    void recargarPedidos();
    navigate("/pda/preparar");
  };
  const dejar = async () => {
    if (pedido && red) await pdaApi(`/sales-orders/${pedido.id}/release`, { method: "POST" }).catch(() => {});
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
              <div><b className="mono">{p.number}</b><span>{p.partner_name}{p.delivery_city ? ` · ${p.delivery_city}` : ""}{p.picked_by ? ` · lo prepara ${p.picked_by}` : ""}</span></div>
              <span>{p.delivery_date ? fecha(p.delivery_date) : ""}</span>
            </button>
          ))}
        </div>
      </>
    );
  if (ocupado)
    return (
      <>
        <div className="pda-msg pda-msg-atencion">{ocupado}</div>
        <button className="pda-boton pda-sec" onClick={() => reservar(true)}>Prepararlo yo igualmente</button>
        <button className="pda-boton" onClick={() => navigate("/pda/preparar")}>Elegir otro pedido</button>
      </>
    );
  if (!pedido) return <p className="pda-nota">{red ? "Cargando…" : "Este pedido no está guardado en la PDA y no hay conexión."}</p>;
  return (
    <>
      <div className="pda-tarjeta">
        <div className="pda-ref mono">{pedido.number}</div>
        <div className="pda-nombre">{pedido.partner_name}</div>
        <div className="pda-barra"><i style={{ width: `${lineas.length ? (hechas.length / lineas.length) * 100 : 0}%` }} /></div>
        <div>{hechas.length} de {lineas.length} líneas{ubicacion ? ` · cogiendo de ${ubicacion.code}` : ""}</div>
      </div>
      <div className="pda-lista">
        {lineas.map((ln) => {
          const r = leidas(ln.product_id);
          const total = pedidas.get(ln.product_id) ?? 0;
          const ok = !ln.almacenable || r >= total;
          const sug = ln.almacenable && !ok ? loteFefo(stock, ln.product_id) : undefined;
          const deEste = lecturas.filter((x) => x.product_id === ln.product_id);
          return (
            <div className={`pda-item ${ok ? "hecho" : ""}`} key={ln.product_id + ln.description}>
              <div>
                <b className="mono">{ln.sku}</b>
                <span>{ln.description}</span>
                {sug && <span>Coge de <b className="mono">{sug.location_code}</b>{sug.lot_code ? <> · lote <b className="mono">{sug.lot_code}</b></> : null}</span>}
                {deEste.map((x, i) => <span key={i} className="mono">{x.cantidad} × {x.lote || (porProducto.get(x.product_id)?.track_lots ? "¿lote?" : "—")}{x.ubicacion ? ` · ${x.ubicacion}` : ""}</span>)}
              </div>
              <b>{ok ? <CheckCircle2 size={18} aria-label="Hecho" /> : null} {ln.almacenable ? `${qty(String(r))}/${qty(String(total))}` : "—"}</b>
            </div>
          );
        })}
      </div>
      <button className="pda-boton" disabled={!completo} onClick={confirmar}>{completo ? "Confirmar salida" : sinLote ? `Falta el lote de ${porProducto.get(sinLote.product_id)?.sku}` : "Lee todos los artículos"}</button>
      {lecturas.length > 0 && <button className="pda-boton pda-sec" onClick={() => guardar([])}>Empezar de nuevo</button>}
      <button className="pda-boton pda-sec" onClick={dejar}>Dejar el pedido</button>
      <Pista>Lee la ubicación y cada artículo. Una etiqueta con cantidad (AI 37) suma esa cantidad.</Pista>
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
