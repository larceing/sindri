import { useState } from "react";
import { fecha, post, qty } from "../api";
import { useAction, useData } from "../hooks";
import { Empty, ErrorBox, Field, Page, Table, Code } from "../ui";

export function StockPage() {
  const { data: stock, reload } = useData<any[]>("/stock");
  const { data: moves, reload: reloadMoves } = useData<any[]>("/stock/moves");
  const { data: products } = useData<any[]>("/products");
  const [f, setF] = useState({ product_id: "", quantity: "", lot_code: "", expiry_date: "", origin: "receipt", unit_cost: "" });
  const { run, error, busy } = useAction();
  const product = products?.find((p) => p.id === f.product_id);
  const receive = () =>
    run(async () => {
      await post("/stock/receipts", Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "")));
      setF({ ...f, quantity: "", lot_code: "", expiry_date: "" });
      await Promise.all([reload(), reloadMoves()]);
    });
  return (
    <Page
      title="Almacén"
      actions={
        <>
          <a className="button" href="#/pda" title="Sindri para la PDA del almacén">Abrir PDA</a>
          <a className="button" href="#/pda-simulador" title="Probar la PDA sin aparato">Simulador de PDA</a>
        </>
      }
    >
      <div className="card">
        <h2>Entrada de mercancía</h2>
        <div className="form">
          <Field label="Producto">
            <select value={f.product_id} onChange={(e) => setF({ ...f, product_id: e.target.value })}>
              <option value="">—</option>
              {products?.filter((p) => p.kind !== "service").map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
            </select>
          </Field>
          <Field label="Cantidad"><input value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></Field>
          <Field label="Coste unitario"><input value={f.unit_cost} onChange={(e) => setF({ ...f, unit_cost: e.target.value })} /></Field>
          {product?.track_lots && (
            <>
              <Field label="Lote"><input value={f.lot_code} onChange={(e) => setF({ ...f, lot_code: e.target.value })} /></Field>
              <Field label="Caducidad"><input type="date" value={f.expiry_date} onChange={(e) => setF({ ...f, expiry_date: e.target.value })} /></Field>
            </>
          )}
          <Field label="Origen">
            <select value={f.origin} onChange={(e) => setF({ ...f, origin: e.target.value })}>
              <option value="receipt">Compra a proveedor</option>
              <option value="adjustment">Regularización de inventario</option>
            </select>
          </Field>
        </div>
        <ErrorBox error={error} />
        <button className="primary" onClick={receive} disabled={busy || !f.product_id}>Registrar entrada</button>
      </div>

      <Recuentos alCambiar={() => Promise.all([reload(), reloadMoves()])} />
      <Ubicaciones />

      <h2>Existencias</h2>
      {stock && stock.length === 0 ? <Empty>Sin existencias.</Empty> : (
        <Table>
          <thead><tr><th>Ref.</th><th>Producto</th><th>Lote</th><th className="num">Caducidad</th><th>Ubicación</th><th className="num">Cantidad</th></tr></thead>
          <tbody>
            {stock?.map((s, i) => (
              <tr key={i}><td><Code>{s.sku}</Code></td><td>{s.product_name}</td><td>{s.lot_id ? <a href={`#/relaciones/lote/${s.lot_id}`} title="Trazabilidad: a quién ha llegado este lote"><Code>{s.lot_code}</Code></a> : null}</td><td className="num">{fecha(s.expiry_date)}</td><td><Code>{s.location_code}</Code></td><td className="num">{qty(s.quantity)} {s.uom}</td></tr>
            ))}
          </tbody>
        </Table>
      )}

      <h2>Últimos movimientos</h2>
      <Table>
        <thead><tr><th className="num">Fecha</th><th>Ref.</th><th>Lote</th><th>De</th><th>A</th><th className="num">Cantidad</th></tr></thead>
        <tbody>
          {moves?.map((m) => (
            <tr key={m.id}><td className="num">{new Date(m.done_at).toLocaleString("es-ES")}</td><td><Code>{m.sku}</Code></td><td>{m.lot_id ? <a href={`#/relaciones/lote/${m.lot_id}`} title="Trazabilidad del lote"><Code>{m.lot_code}</Code></a> : null}</td><td><Code>{m.from_code}</Code></td><td><Code>{m.to_code}</Code></td><td className="num">{qty(m.quantity)}</td></tr>
          ))}
        </tbody>
      </Table>
    </Page>
  );
}

const ESTADO_RECUENTO: Record<string, string> = { open: "Contando", counted: "Por aprobar", approved: "Aprobado", cancelled: "Anulado" };

/**
 * Recuentos de inventario hechos con la PDA. Mientras se cuenta es a ciegas; al terminar se ven
 * las diferencias y alguien las aprueba: entonces se crean los ajustes de stock.
 */
function Recuentos({ alCambiar }: { alCambiar: () => Promise<unknown> }) {
  const { data: lista, reload } = useData<any[]>("/stock/counts");
  const [abierto, setAbierto] = useState<string | null>(null);
  const { data: detalle, reload: recargar } = useData<any>(abierto ? `/stock/counts/${abierto}` : null);
  const { run, error, busy } = useAction();
  const accion = (que: "approve" | "reopen" | "cancel" | "finish") =>
    run(async () => {
      if (que === "approve" && !confirm("Se crearán los ajustes de stock de todas las diferencias. ¿Aprobar?")) return;
      await post(`/stock/counts/${abierto}/${que}`, {});
      await Promise.all([reload(), recargar(), alCambiar()]);
    });
  const activos = lista?.filter((c) => c.state === "open" || c.state === "counted") ?? [];
  if (!lista?.length) return null;
  return (
    <div className="card">
      <h2>Recuentos de inventario</h2>
      <p className="hint">Se hacen con la PDA (Inventario). {activos.length ? `${activos.length} sin cerrar.` : ""}</p>
      <Table clickable>
        <thead><tr><th>Número</th><th>Ubicación</th><th>Estado</th><th className="num">Lecturas</th><th>Creado por</th></tr></thead>
        <tbody>
          {lista.slice(0, 20).map((c) => (
            <tr key={c.id} onClick={() => setAbierto(abierto === c.id ? null : c.id)} className={abierto === c.id ? "selected" : undefined}>
              <td><Code>{c.number}</Code></td><td>{c.location_code ? <Code>{c.location_code}</Code> : "Todo el almacén"}</td>
              <td>{ESTADO_RECUENTO[c.state] ?? c.state}</td><td className="num">{c.entries}</td><td>{c.created_by}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      {abierto && detalle && (
        <>
          <h3>{detalle.number} · {ESTADO_RECUENTO[detalle.state]}</h3>
          {detalle.state === "open" && <p className="hint">Se está contando a ciegas: aquí solo se ve lo contado. Las diferencias aparecen al terminar.</p>}
          {detalle.state === "counted" && <p className="hint">Lo que Sindri tenía en estas ubicaciones y no se ha contado queda a cero al aprobar.</p>}
          {detalle.lines.length === 0 ? <Empty>Sin lecturas.</Empty> : (
            <Table>
              <thead><tr><th>Ubicación</th><th>Ref.</th><th>Lote</th>{detalle.state !== "open" && <th className="num">Sindri</th>}<th className="num">Contado</th>{detalle.state !== "open" && <th className="num">Diferencia</th>}</tr></thead>
              <tbody>
                {detalle.lines.map((l: any, i: number) => (
                  <tr key={i}>
                    <td><Code>{l.location_code}</Code></td><td><Code>{l.sku}</Code> {l.product_name}</td><td>{l.lot_code ? <Code>{l.lot_code}</Code> : null}</td>
                    {detalle.state !== "open" && <td className="num">{qty(l.expected)}</td>}
                    <td className="num">{qty(l.counted)}</td>
                    {detalle.state !== "open" && <td className="num" style={{ color: Number(l.difference) ? (Number(l.difference) < 0 ? "var(--error-11)" : "var(--ok-11)") : undefined }}>{Number(l.difference) > 0 ? "+" : ""}{qty(l.difference)}</td>}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <ErrorBox error={error} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            {detalle.state === "open" && <button onClick={() => accion("finish")} disabled={busy}>Terminar recuento</button>}
            {detalle.state === "counted" && <button className="primary" onClick={() => accion("approve")} disabled={busy}>Aprobar y ajustar stock</button>}
            {detalle.state === "counted" && <button onClick={() => accion("reopen")} disabled={busy}>Volver a abrir</button>}
            {(detalle.state === "open" || detalle.state === "counted") && <button onClick={() => accion("cancel")} disabled={busy}>Anular</button>}
          </div>
        </>
      )}
    </div>
  );
}

/** Ubicaciones del almacén (estanterías, huecos). El código es lo que va en la etiqueta que lee la PDA. */
function Ubicaciones() {
  const { data, reload } = useData<any[]>("/locations");
  const [f, setF] = useState({ code: "", name: "", parent_code: "" });
  const { run, error, busy } = useAction();
  const internas = data?.filter((l) => l.kind === "internal" && !l.archived) ?? [];
  const porId = new Map(internas.map((l) => [l.id, l]));
  const crear = () =>
    run(async () => {
      await post("/locations", Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "")));
      setF({ code: "", name: "", parent_code: "" });
      await reload();
    });
  return (
    <details className="card">
      <summary><h2 style={{ display: "inline" }}>Ubicaciones</h2> <span className="hint">{internas.length}</span></summary>
      <Table>
        <thead><tr><th>Código (etiqueta)</th><th>Nombre</th><th>Dentro de</th></tr></thead>
        <tbody>
          {internas.map((l) => (
            <tr key={l.id}><td><Code>{l.code}</Code></td><td>{l.name}</td><td>{l.parent_id ? <Code>{porId.get(l.parent_id)?.code ?? "—"}</Code> : null}</td></tr>
          ))}
        </tbody>
      </Table>
      <div className="form">
        <Field label="Código"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="A-01" /></Field>
        <Field label="Nombre"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Estantería A, hueco 1" /></Field>
        <Field label="Dentro de">
          <select value={f.parent_code} onChange={(e) => setF({ ...f, parent_code: e.target.value })}>
            <option value="">Almacén principal</option>
            {internas.map((l) => <option key={l.id} value={l.code}>{l.code}</option>)}
          </select>
        </Field>
      </div>
      <ErrorBox error={error} />
      <button onClick={crear} disabled={busy || !f.code}>Crear ubicación</button>
    </details>
  );
}
