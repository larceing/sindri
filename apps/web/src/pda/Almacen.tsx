/**
 * Tareas de almacén con ubicaciones (fase 2): traspasar entre ubicaciones y recuento a ciegas.
 */
import { useEffect, useState } from "react";
import { qty } from "../api";
import { navigate } from "../router";
import { encolar, enviarCola, guardarCopia, leerCopia, nuevoId, pdaApi, useCopia } from "./datos";
import { Cantidad, mandar, Pista, productoDe, ubicacionDe, type Comun, type Producto, type Ubicacion } from "./comun";

// Traspasar ------------------------------------------------------------------------------

/**
 * Mover mercancía de una ubicación a otra: ubicar lo que está en el muelle, reponer una
 * estantería. Se lee origen, producto (y lote), cantidad y destino.
 */
export function Traspasar({ empresa, productos, stock, ubicaciones, decir, manejador, red }: Comun) {
  const vacio = { origen: null as Ubicacion | null, producto: null as Producto | null, lote: "", cantidad: "1", destino: null as Ubicacion | null };
  const [f, setF] = useState(vacio);
  const enOrigen = (productId: string, origen: string) => stock.filter((s) => s.product_id === productId && s.location_code === origen && Number(s.quantity) > 0);

  manejador.current = (l) => {
    const u = ubicacionDe(l, ubicaciones);
    if (u) {
      if (!f.origen || !f.producto) {
        setF({ ...vacio, origen: u });
        return decir("ok", `Desde ${u.code}`);
      }
      if (u.id === f.origen.id) return decir("error", "Es la misma ubicación de origen");
      setF({ ...f, destino: u });
      return decir("ok", `Hacia ${u.code}`);
    }
    const p = productoDe(l, productos);
    if (p) {
      if (p.kind === "service") return decir("error", `${p.sku} es un servicio: no tiene stock`);
      if (!f.origen) return decir("error", "Lee primero la ubicación de origen");
      const mismo = f.producto?.id === p.id && (!l.lote || l.lote === f.lote);
      // Si en el origen solo hay un lote de ese producto, se propone ese.
      const lotes = enOrigen(p.id, f.origen.code).map((s) => s.lot_code).filter(Boolean) as string[];
      const lote = l.lote ?? (mismo ? f.lote : p.track_lots && lotes.length === 1 ? lotes[0]! : "");
      setF({ ...f, producto: p, lote, cantidad: l.cantidad ?? (mismo ? String(Number(f.cantidad || 0) + 1) : "1"), destino: null });
      return decir(l.avisos.length ? "atencion" : "ok", l.avisos[0] ?? (mismo ? `+1 · ${p.sku}` : p.name));
    }
    if (f.producto?.track_lots && l.tipo === "texto" && l.texto) {
      setF({ ...f, lote: l.texto });
      return decir("ok", `Lote ${l.texto}`);
    }
    decir("error", "No es una ubicación ni un producto de este almacén");
  };

  const hay = f.producto && f.origen
    ? enOrigen(f.producto.id, f.origen.code).filter((s) => !f.producto!.track_lots || s.lot_code === f.lote).reduce((t, s) => t + Number(s.quantity), 0)
    : 0;
  const falta = !f.origen ? "Lee la ubicación de origen"
    : !f.producto ? "Lee el producto"
    : f.producto.track_lots && !f.lote ? "Falta el lote"
    : !(Number(f.cantidad) > 0) ? "Falta la cantidad"
    : !f.destino ? "Lee la ubicación de destino"
    : null;

  const confirmar = async () => {
    if (falta || !f.producto || !f.origen || !f.destino) return;
    const id = nuevoId();
    await mandar(empresa, {
      id,
      tipo: "traspaso",
      resumen: `${f.cantidad} ${f.producto.uom} ${f.producto.sku}${f.lote ? ` lote ${f.lote}` : ""}: ${f.origen.code} → ${f.destino.code}`,
      ruta: "/stock/transfers",
      cuerpo: { id, product_id: f.producto.id, quantity: f.cantidad, ...(f.lote ? { lot_code: f.lote } : {}), from_location_code: f.origen.code, to_location_code: f.destino.code, note: "PDA" },
    }, red, decir, `Movido a ${f.destino.code}`);
    // Se queda el origen: lo normal es vaciar el muelle de varias veces.
    setF({ ...vacio, origen: f.origen });
  };

  if (!f.origen) return <Pista>Lee la etiqueta de la ubicación de origen (por ejemplo, el muelle).</Pista>;
  return (
    <>
      <div className="pda-tarjeta">
        <div className="pda-ref">Desde</div>
        <div className="pda-nombre mono">{f.origen.code}</div>
        {f.producto && <div>{f.producto.sku} · {f.producto.name}</div>}
        {f.producto && <div className="pda-ref">Aquí hay {qty(String(hay))} {f.producto.uom}{f.lote ? ` del lote ${f.lote}` : ""} (según la PDA)</div>}
      </div>
      {f.producto?.track_lots && (
        <label className="pda-campo">
          <span>Lote</span>
          <input value={f.lote} onChange={(e) => setF({ ...f, lote: e.target.value })} placeholder="Lee o escribe el lote" />
        </label>
      )}
      {f.producto && <Cantidad uom={f.producto.uom} valor={f.cantidad} cambiar={(cantidad) => setF({ ...f, cantidad })} />}
      {f.producto && (
        <div className={`pda-item ${f.destino ? "hecho" : ""}`}>
          <div><span>Hacia</span><b className="mono">{f.destino?.code ?? "Lee la ubicación de destino"}</b></div>
        </div>
      )}
      <button className="pda-boton" disabled={!!falta} onClick={confirmar}>{falta ?? "Confirmar traspaso"}</button>
      <button className="pda-boton pda-sec" onClick={() => setF(vacio)}>Empezar de nuevo</button>
      <Pista>{!f.producto ? "Lee el producto que vas a mover." : !f.destino ? "Lee la ubicación de destino." : "Confirma o lee otra cosa."}</Pista>
    </>
  );
}

// Recuento -------------------------------------------------------------------------------

interface Recuento {
  id: string;
  number: string;
  state: string;
  location_code: string | null;
  entries: number;
}
interface Contado {
  sku: string;
  lote: string;
  ubicacion: string;
  cantidad: string;
}

/**
 * Recuento de inventario **a ciegas**: la PDA no enseña lo que dice Sindri, solo lo que se va
 * contando. Se lee la ubicación, luego cada producto (y su lote); leer otra vez el mismo suma uno.
 * Al terminar, en Sindri (web) se ven las diferencias y alguien las aprueba.
 */
export function Recuentos({ empresa, productos, ubicaciones, decir, manejador, red, id }: Comun & { id?: string }) {
  const lista = useCopia<Recuento[]>(empresa, "recuentos", "/stock/counts?state=activos");
  const [nueva, setNueva] = useState<Ubicacion | null>(null);
  const recuento = lista.datos?.find((c) => c.id === id);

  if (!id) {
    manejador.current = (l) => {
      const u = ubicacionDe(l, ubicaciones);
      if (u) {
        setNueva(u);
        return decir("ok", `Ubicación ${u.code}`);
      }
      decir("error", "Lee la etiqueta de una ubicación");
    };
    const crear = async (codigo?: string) => {
      try {
        const c = await pdaApi<Recuento>("/stock/counts", { method: "POST", body: codigo ? { location_code: codigo, note: "PDA" } : { note: "PDA" } });
        await lista.recargar();
        navigate(`/pda/recuento/${c.id}`);
      } catch (e) {
        decir("error", (e as Error).message);
      }
    };
    const abiertos = (lista.datos ?? []).filter((c) => c.state === "open");
    return (
      <>
        <div className="pda-lista">
          {abiertos.length === 0 && <p className="pda-nota">No hay recuentos abiertos.</p>}
          {abiertos.map((c) => (
            <button className="pda-item" key={c.id} onClick={() => navigate(`/pda/recuento/${c.id}`)}>
              <div><b className="mono">{c.number}</b><span>{c.location_code ?? "Todo el almacén"} · {c.entries} lecturas</span></div>
            </button>
          ))}
        </div>
        {nueva ? (
          <button className="pda-boton" disabled={!red} onClick={() => crear(nueva.code)}>{red ? `Contar ${nueva.code}` : "Sin conexión"}</button>
        ) : (
          <Pista>Lee una ubicación para empezar a contarla, o elige un recuento abierto.</Pista>
        )}
        <button className="pda-boton pda-sec" disabled={!red} onClick={() => crear()} title="Lo que no se cuente quedará a cero al aprobarlo">
          Contar todo el almacén
        </button>
      </>
    );
  }
  return <Contar key={id} id={id} recuento={recuento} empresa={empresa} productos={productos} ubicaciones={ubicaciones} decir={decir} manejador={manejador} red={red} recargar={lista.recargar} />;
}

function Contar({ id, recuento, empresa, productos, ubicaciones, decir, manejador, red, recargar }: Pick<Comun, "empresa" | "productos" | "ubicaciones" | "decir" | "manejador" | "red"> & { id: string; recuento?: Recuento; recargar: () => Promise<void> }) {
  const clave = `recuento.${id}`;
  const [contado, setContado] = useState<Contado[]>(() => leerCopia<Contado[]>(empresa, clave)?.datos ?? []);
  // Si el recuento es de una ubicación sin huecos dentro, ya se sabe dónde se cuenta.
  const raiz = ubicaciones.find((u) => u.code === recuento?.location_code);
  const sinHijas = raiz && !ubicaciones.some((u) => u.parent_id === raiz.id);
  const [ubicacion, setUbicacion] = useState<Ubicacion | null>(sinHijas ? raiz! : null);
  const [actual, setActual] = useState<{ producto: Producto; lote: string; cantidad: string } | null>(null);
  useEffect(() => {
    if (sinHijas && !ubicacion) setUbicacion(raiz!);
  }, [sinHijas]);

  const guardar = async (a = actual, u = ubicacion) => {
    if (!a || !u || !(Number(a.cantidad) >= 0)) return;
    if (a.producto.track_lots && !a.lote) {
      decir("error", `Falta el lote de ${a.producto.sku}: léelo antes de seguir`);
      return false;
    }
    const op = nuevoId();
    encolar(empresa, {
      id: op,
      tipo: "recuento",
      resumen: `Recuento ${recuento?.number ?? ""}: ${a.cantidad} ${a.producto.sku}${a.lote ? ` lote ${a.lote}` : ""} en ${u.code}`,
      ruta: `/stock/counts/${id}/entries`,
      cuerpo: { id: op, product_id: a.producto.id, quantity: a.cantidad, ...(a.lote ? { lot_code: a.lote } : {}), location_code: u.code },
    });
    const nuevo = [{ sku: a.producto.sku, lote: a.lote, ubicacion: u.code, cantidad: a.cantidad }, ...contado];
    setContado(nuevo);
    guardarCopia(empresa, clave, nuevo);
    setActual(null);
    void enviarCola(empresa);
    return true;
  };

  manejador.current = async (l) => {
    const u = ubicacionDe(l, ubicaciones);
    if (u) {
      if (actual && (await guardar()) === false) return;
      setUbicacion(u);
      return decir("ok", `Contando en ${u.code}`);
    }
    const p = productoDe(l, productos);
    if (p) {
      if (p.kind === "service") return decir("error", `${p.sku} es un servicio: no se cuenta`);
      if (!ubicacion) return decir("error", "Lee primero la ubicación");
      const mismo = actual?.producto.id === p.id && (!l.lote || l.lote === actual.lote);
      if (mismo) {
        const suma = Number(l.cantidad ?? 1);
        setActual({ ...actual!, cantidad: String(Number(actual!.cantidad || 0) + suma) });
        return decir("ok", `${p.sku}: ${Number(actual!.cantidad || 0) + suma}`);
      }
      if (actual && (await guardar()) === false) return;
      setActual({ producto: p, lote: l.lote ?? "", cantidad: l.cantidad ?? "1" });
      return decir(l.avisos.length ? "atencion" : "ok", l.avisos[0] ?? (p.track_lots && !l.lote ? `${p.sku}: lee el lote` : p.name));
    }
    if (actual?.producto.track_lots && l.tipo === "texto" && l.texto) {
      setActual({ ...actual, lote: l.texto });
      return decir("ok", `Lote ${l.texto}`);
    }
    decir("error", "No es una ubicación ni un producto de este almacén");
  };

  const terminar = async () => {
    if (actual && (await guardar()) === false) return;
    await enviarCola(empresa);
    try {
      await pdaApi(`/stock/counts/${id}/finish`, { method: "POST" });
      guardarCopia(empresa, clave, []);
      decir("ok", `Recuento ${recuento?.number ?? ""} terminado: falta que lo aprueben en Sindri`);
      await recargar();
      navigate("/pda/recuento");
    } catch (e) {
      decir("error", (e as Error).message);
    }
  };

  return (
    <>
      <div className="pda-tarjeta">
        <div className="pda-ref mono">{recuento?.number ?? "Recuento"}{recuento?.location_code ? ` · ${recuento.location_code}` : " · todo el almacén"}</div>
        <div className="pda-nombre">{ubicacion ? <>Contando en <span className="mono">{ubicacion.code}</span></> : "Lee la ubicación"}</div>
        <div className="pda-ref">A ciegas: aquí no se ve lo que dice Sindri.</div>
      </div>
      {actual && (
        <>
          <div className="pda-tarjeta">
            <div className="pda-ref mono">{actual.producto.sku}</div>
            <div className="pda-nombre">{actual.producto.name}</div>
          </div>
          {actual.producto.track_lots && (
            <label className="pda-campo">
              <span>Lote</span>
              <input value={actual.lote} onChange={(e) => setActual({ ...actual, lote: e.target.value })} placeholder="Lee o escribe el lote" />
            </label>
          )}
          <Cantidad uom={actual.producto.uom} valor={actual.cantidad} cambiar={(cantidad) => setActual({ ...actual, cantidad })} />
          <button className="pda-boton" onClick={() => guardar()}>Guardar</button>
        </>
      )}
      {contado.length > 0 && (
        <div className="pda-lista">
          {contado.slice(0, 30).map((c, i) => (
            <div className="pda-item" key={i}>
              <div><b className="mono">{c.sku}</b><span>{c.ubicacion}{c.lote ? ` · lote ${c.lote}` : ""}</span></div>
              <b>{qty(c.cantidad)}</b>
            </div>
          ))}
        </div>
      )}
      <button className="pda-boton pda-sec" disabled={!red} onClick={terminar}>{red ? "Terminar recuento" : "Sin conexión: sigue contando"}</button>
      <Pista>{!ubicacion ? "Lee la etiqueta de la ubicación." : "Lee cada producto. Leer otra vez el mismo suma uno; otra ubicación guarda lo anterior."}</Pista>
    </>
  );
}
