import { useState } from "react";
import { eur, post, qty } from "../api";
import { navigate } from "../router";
import { useAction, useData } from "../hooks";
import { Badge, Empty, ErrorBox, Field, Page } from "../ui";

export function OrdersPage() {
  const { data } = useData<any[]>("/sales-orders");
  return (
    <Page title="Pedidos de venta" actions={<button className="primary" onClick={() => navigate("/pedidos/nuevo")}>Nuevo pedido</button>}>
      {data && data.length === 0 ? <Empty>Todavía no hay pedidos.</Empty> : (
        <table className="clickable">
          <thead><tr><th>Número</th><th>Fecha</th><th>Cliente</th><th className="num">Base</th><th>Estado</th></tr></thead>
          <tbody>
            {data?.map((o) => (
              <tr key={o.id} onClick={() => navigate(`/pedidos/${o.id}`)}>
                <td>{o.number}</td><td>{o.order_date}</td><td>{o.partner_name}</td><td className="num">{eur(o.untaxed)}</td><td><Badge state={o.state} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

type Line = { product_id: string; quantity: string; unit_price: string; discount_pct: string };

export function NewOrderPage() {
  const { data: partners } = useData<any[]>("/partners");
  const { data: products } = useData<any[]>("/products");
  const [partner, setPartner] = useState("");
  const [lines, setLines] = useState<Line[]>([{ product_id: "", quantity: "1", unit_price: "", discount_pct: "" }]);
  const { run, error, busy } = useAction();
  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const save = () =>
    run(async () => {
      const o = await post("/sales-orders", {
        partner_id: partner,
        lines: lines.filter((l) => l.product_id).map((l) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== ""))),
      });
      navigate(`/pedidos/${o.id}`);
    });
  return (
    <Page title="Nuevo pedido">
      <div className="form">
        <Field label="Cliente">
          <select value={partner} onChange={(e) => setPartner(e.target.value)}>
            <option value="">—</option>
            {partners?.filter((p) => p.kind !== "supplier").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      </div>
      <table>
        <thead><tr><th>Producto</th><th className="num">Cantidad</th><th className="num">Precio (vacío = tarifa)</th><th className="num">Dto. %</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <select value={l.product_id} onChange={(e) => setLine(i, { product_id: e.target.value })}>
                  <option value="">—</option>
                  {products?.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name} ({eur(p.sale_price)})</option>)}
                </select>
              </td>
              <td><input className="num" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></td>
              <td><input className="num" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: e.target.value })} /></td>
              <td><input className="num" value={l.discount_pct} onChange={(e) => setLine(i, { discount_pct: e.target.value })} /></td>
              <td><button className="link" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Quitar</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button onClick={() => setLines([...lines, { product_id: "", quantity: "1", unit_price: "", discount_pct: "" }])}>Añadir línea</button>
        <button className="primary" onClick={save} disabled={busy || !partner}>Crear pedido</button>
      </div>
      <ErrorBox error={error} />
    </Page>
  );
}

const ACTION_LABEL: Record<string, string> = { confirm: "Confirmar", deliver: "Entregar (albarán)", invoice: "Crear factura", cancel: "Cancelar" };

export function OrderPage({ id }: { id: string }) {
  const { data: o, reload, error: loadError } = useData(`/sales-orders/${id}`);
  const { run, error, busy } = useAction();
  const act = (a: string) =>
    run(async () => {
      const r = await post(`/sales-orders/${id}/${a}`);
      if (a === "invoice") navigate(`/facturas/${r.id}`);
      else await reload();
    });
  if (!o) return <Page title="Pedido"><ErrorBox error={loadError} /></Page>;
  return (
    <Page title={`Pedido ${o.number}`} actions={o.actions.map((a: string) => (
      <button key={a} className={a === "cancel" ? "danger" : "primary"} disabled={busy} onClick={() => act(a)}>{ACTION_LABEL[a]}</button>
    ))}>
      <p><Badge state={o.state} /> · {o.partner_name} · {o.order_date}</p>
      <ErrorBox error={error} />
      <table>
        <thead><tr><th>Ref.</th><th>Descripción</th><th className="num">Cantidad</th><th className="num">Precio</th><th className="num">Dto.</th><th className="num">IVA</th><th className="num">Base</th></tr></thead>
        <tbody>
          {o.lines.map((l: any, i: number) => (
            <tr key={l.id}>
              <td>{l.sku}</td><td>{l.description}</td><td className="num">{qty(l.quantity)} {l.uom}</td><td className="num">{eur(l.unit_price)}</td>
              <td className="num">{Number(l.discount_pct) ? `${Number(l.discount_pct)}%` : ""}</td><td className="num">{Number(l.vat_rate)}%</td>
              <td className="num">{eur(o.totals.lines[i]?.base)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Totals t={o.totals} />
    </Page>
  );
}

export function Totals({ t }: { t: { untaxed: string; breakdown: any[]; withholding: string; total: string; amountDue?: string } }) {
  return (
    <div className="totals">
      <div><span>Base imponible</span><b>{eur(t.untaxed)}</b></div>
      {t.breakdown.map((b) => (
        <div key={b.vatRate + b.surchargeRate}>
          <span>IVA {b.vatRate}% sobre {eur(b.base)}{Number(b.surchargeRate) ? ` + R.E. ${b.surchargeRate}%` : ""}</span>
          <b>{eur(Number(b.vatAmount) + Number(b.surchargeAmount))}</b>
        </div>
      ))}
      {Number(t.withholding) > 0 && <div><span>Retención IRPF</span><b>-{eur(t.withholding)}</b></div>}
      <div className="grand"><span>Total</span><b>{eur(t.amountDue ?? t.total)}</b></div>
    </div>
  );
}
