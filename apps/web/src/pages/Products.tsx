import { useState } from "react";
import { eur, post, qty } from "../api";
import { useAction, useData } from "../hooks";
import { Empty, ErrorBox, Field, Page } from "../ui";

const blank = { sku: "", name: "", kind: "stockable", uom: "ud", gtin: "", sale_price: "", cost_price: "", vat_rate: "21", track_lots: false };

export function ProductsPage() {
  const [q, setQ] = useState("");
  const { data, reload } = useData<any[]>(`/products${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  const [f, setF] = useState(blank);
  const [open, setOpen] = useState(false);
  const { run, error, busy } = useAction();
  const create = () =>
    run(async () => {
      await post("/products", Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "")));
      setF(blank);
      setOpen(false);
      await reload();
    });
  return (
    <Page title="Productos" actions={<button className="primary" onClick={() => setOpen(!open)}>Nuevo</button>}>
      {open && (
        <div className="card">
          <div className="form">
            <Field label="Referencia"><input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></Field>
            <Field label="Nombre"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Tipo">
              <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
                <option value="stockable">Almacenable</option>
                <option value="consumable">Consumible</option>
                <option value="service">Servicio</option>
              </select>
            </Field>
            <Field label="Unidad"><input value={f.uom} onChange={(e) => setF({ ...f, uom: e.target.value })} /></Field>
            <Field label="GTIN / EAN"><input value={f.gtin} onChange={(e) => setF({ ...f, gtin: e.target.value })} /></Field>
            <Field label="Precio venta"><input value={f.sale_price} onChange={(e) => setF({ ...f, sale_price: e.target.value })} /></Field>
            <Field label="Coste"><input value={f.cost_price} onChange={(e) => setF({ ...f, cost_price: e.target.value })} /></Field>
            <Field label="IVA %">
              <select value={f.vat_rate} onChange={(e) => setF({ ...f, vat_rate: e.target.value })}>
                {["21", "10", "4", "0"].map((v) => <option key={v}>{v}</option>)}
              </select>
            </Field>
            <label className="check">
              <input type="checkbox" checked={f.track_lots} onChange={(e) => setF({ ...f, track_lots: e.target.checked })} />
              Control por lotes
            </label>
          </div>
          <ErrorBox error={error} />
          <button className="primary" onClick={create} disabled={busy}>Guardar</button>
        </div>
      )}
      <input className="search" placeholder="Buscar por referencia o nombre" value={q} onChange={(e) => setQ(e.target.value)} />
      {data && data.length === 0 ? (
        <Empty>Todavía no hay productos.</Empty>
      ) : (
        <table>
          <thead><tr><th>Ref.</th><th>Nombre</th><th className="num">Precio</th><th className="num">IVA</th><th className="num">Stock</th><th>Lotes</th></tr></thead>
          <tbody>
            {data?.map((p) => (
              <tr key={p.id}>
                <td>{p.sku}</td><td>{p.name}</td><td className="num">{eur(p.sale_price)}</td>
                <td className="num">{Number(p.vat_rate)}%</td>
                <td className="num">{p.kind === "service" ? "—" : `${qty(p.on_hand)} ${p.uom}`}</td>
                <td>{p.track_lots ? "Sí" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
