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
