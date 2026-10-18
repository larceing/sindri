import { useEffect, useState } from "react";
import { eur, fecha, patch, pct, post, qty, sinVacios } from "../api";
import { navigate, queryParam } from "../router";
import { useAction, useData } from "../hooks";
import { useSession } from "../session";
import { DocButton } from "../docs";
import { Alert, Badge, Empty, ErrorBox, Field, Page, Table, Code } from "../ui";
import { RelacionesBoton } from "./Relaciones";

const ESTADOS = [["", "Todos"], ["draft", "Borrador"], ["confirmed", "Confirmado"], ["delivered", "Entregado"], ["invoiced", "Facturado"], ["cancelled", "Cancelado"]];

export function OrdersPage() {
  const [state, setState] = useState("");
  const [rep, setRep] = useState("");
  const qs = new URLSearchParams(sinVacios({ state, sales_rep_id: rep }) as Record<string, string>).toString();
  const { data } = useData<any[]>(`/sales-orders${qs ? `?${qs}` : ""}`);
  const { data: reps } = useData<any[]>("/sales-reps");
  const { puede } = useSession();
  return (
    <Page title="Pedidos de venta" actions={<>
      <button onClick={() => navigate("/pedidos/por-facturar")}>Por facturar</button>
      {puede("pedidos") && <button className="primary" onClick={() => navigate("/pedidos/nuevo")}>Nuevo pedido</button>}
    </>}>
      <div className="row filters">
        <Field label="Estado">
          <select value={state} onChange={(e) => setState(e.target.value)}>
            {ESTADOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        {reps && reps.length > 0 && (
          <Field label="Comercial">
            <select value={rep} onChange={(e) => setRep(e.target.value)}>
              <option value="">Todos</option>
              {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
        )}
      </div>
      {data && data.length === 0 ? <Empty>No hay pedidos{state || rep ? " con ese filtro" : " todavía"}.</Empty> : (
        <Table clickable>
          <thead><tr><th>Número</th><th className="num">Fecha</th><th>Cliente</th><th>Entrega</th><th>Comercial</th><th className="num">Base</th><th>Estado</th></tr></thead>
          <tbody>
            {data?.map((o) => (
              <tr key={o.id} tabIndex={0} onClick={() => navigate(`/pedidos/${o.id}`)} onKeyDown={(e) => e.key === "Enter" && navigate(`/pedidos/${o.id}`)}>
                <td><Code>{o.number}</Code></td><td className="num">{fecha(o.order_date)}</td><td>{o.partner_name}</td>
                <td>{[o.delivery_date && fecha(o.delivery_date), o.delivery_city].filter(Boolean).join(" · ")}{o.route_number && <span className="tag">{o.route_number}</span>}</td>
                <td>{o.sales_rep_name}</td>
                <td className="num">{eur(o.untaxed)}</td><td><Badge state={o.state} /></td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}

type Line = { product_id: string; quantity: string; unit_price: string; discount_pct: string };

/** Comercial y dirección de entrega del cliente elegido. */
function useClienteDatos(partnerId: string) {
  const { data } = useData(partnerId ? `/partners/${partnerId}` : null);
  return data;
}

export function NewOrderPage() {
  const { data: partners } = useData<any[]>("/partners");
  const { data: products } = useData<any[]>("/products");
  const { data: reps } = useData<any[]>("/sales-reps");
  const [partner, setPartner] = useState(queryParam("cliente") ?? "");
  const cliente = useClienteDatos(partner);
  const [head, setHead] = useState({ sales_rep_id: "", delivery_address_id: "", delivery_date: "", notes: "" });
  const [lines, setLines] = useState<Line[]>([{ product_id: "", quantity: "1", unit_price: "", discount_pct: "" }]);
  const { run, error, busy } = useAction();
  useEffect(() => {
    // Al elegir cliente se proponen su comercial y su dirección habitual.
    if (cliente)
      setHead((h) => ({
        ...h,
        sales_rep_id: cliente.sales_rep_id ?? "",
        delivery_address_id: cliente.addresses.find((a: any) => a.is_default)?.id ?? "",
      }));
  }, [cliente]);
  const setLine = (i: number, p: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const save = () =>
    run(async () => {
      const o = await post("/sales-orders", {
        partner_id: partner,
        ...sinVacios(head),
        lines: lines.filter((l) => l.product_id).map((l) => sinVacios(l)),
      });
      navigate(`/pedidos/${o.id}`);
    });
  const descuento = cliente?.discount_pct && Number(cliente.discount_pct) ? Number(cliente.discount_pct) : null;
  return (
    <Page title="Nuevo pedido">
      <div className="form">
        <Field label="Cliente">
          <select value={partner} onChange={(e) => setPartner(e.target.value)}>
            <option value="">—</option>
            {partners?.filter((p) => p.kind !== "supplier").map((p) => <option key={p.id} value={p.id}>{p.trade_name || p.name}</option>)}
          </select>
        </Field>
        <Field label="Comercial">
          <select value={head.sales_rep_id} onChange={(e) => setHead({ ...head, sales_rep_id: e.target.value })}>
            <option value="">Sin comercial</option>
            {reps?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        <Field label="Entregar en">
          <select value={head.delivery_address_id} onChange={(e) => setHead({ ...head, delivery_address_id: e.target.value })} disabled={!cliente}>
            <option value="">Dirección fiscal</option>
            {cliente?.addresses.map((a: any) => <option key={a.id} value={a.id}>{a.label} · {a.city}</option>)}
          </select>
        </Field>
        <Field label="Fecha de entrega"><input type="date" value={head.delivery_date} onChange={(e) => setHead({ ...head, delivery_date: e.target.value })} /></Field>
        <Field label="Notas"><input value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} /></Field>
      </div>
      {cliente && (cliente.payment_method || descuento) && (
        <p className="hint">Condiciones del cliente: {[cliente.payment_method, cliente.payment_days && `${cliente.payment_days} días`, descuento && `descuento ${descuento} % (se aplica si dejas el Dto. vacío)`].filter(Boolean).join(" · ")}</p>
      )}
      <Table>
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
              <td><input className="num" value={l.discount_pct} placeholder={descuento ? String(descuento) : ""} onChange={(e) => setLine(i, { discount_pct: e.target.value })} /></td>
              <td><button className="link" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Quitar</button></td>
            </tr>
          ))}
        </tbody>
      </Table>
      <div className="row">
        <button onClick={() => setLines([...lines, { product_id: "", quantity: "1", unit_price: "", discount_pct: "" }])}>Añadir línea</button>
        <button className="primary" onClick={save} disabled={busy || !partner}>Crear pedido</button>
      </div>
      <ErrorBox error={error} />
    </Page>
  );
}

const ACTION_LABEL: Record<string, string> = { confirm: "Confirmar", deliver: "Entregar (albarán)", invoice: "Crear factura", cancel: "Cancelar", split: "Separar pedido" };

/** Pasar parte del pedido a uno nuevo (lo que se sirve más tarde, en otra entrega…). */
function SplitPanel({ o, onDone, onCancel }: { o: any; onDone: (id: string) => void; onCancel: () => void }) {
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const { run, error, busy } = useAction();
  const chosen = Object.entries(qtys).filter(([, v]) => v && Number(v.replace(",", ".")) > 0);
  const go = () =>
    run(async () => {
      const r = await post(`/sales-orders/${o.id}/split`, {
        lines: chosen.map(([line_id, quantity]) => ({ line_id, quantity })),
        ...sinVacios({ delivery_date: date, notes }),
      });
      onDone(r.id);
    });
  return (
    <div className="card">
      <h2>Separar pedido</h2>
      <p className="hint">Indica qué cantidades pasan a un pedido nuevo. Lo que no muevas se queda en {o.number}. El pedido nuevo queda en el mismo estado, con el mismo cliente, comercial y dirección.</p>
      <Table>
        <thead><tr><th>Ref.</th><th>Descripción</th><th className="num">En el pedido</th><th className="num">Pasar al nuevo</th></tr></thead>
        <tbody>
          {o.lines.map((l: any) => (
            <tr key={l.id}>
              <td><Code>{l.sku}</Code></td><td className="wrap">{l.description}</td><td className="num">{qty(l.quantity)} {l.uom}</td>
              <td className="num">
                <input className="num" value={qtys[l.id] ?? ""} placeholder="0" onChange={(e) => setQtys({ ...qtys, [l.id]: e.target.value })} />{" "}
                <button className="link" onClick={() => setQtys({ ...qtys, [l.id]: String(Number(l.quantity)) })}>Todo</button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <div className="form">
        <Field label="Fecha de entrega del nuevo"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Notas del nuevo"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
      <ErrorBox error={error} />
      <div className="row">
        <button className="primary" onClick={go} disabled={busy || chosen.length === 0}>Crear pedido separado</button>
        <button onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
}

function HeaderPanel({ o, onSaved }: { o: any; onSaved: () => void }) {
  const { data: reps } = useData<any[]>("/sales-reps");
  const cliente = useClienteDatos(o.partner_id);
  const editable = ["draft", "confirmed"].includes(o.state);
  const [h, setH] = useState({ sales_rep_id: o.sales_rep_id ?? "", delivery_address_id: o.delivery_address_id ?? "", delivery_date: o.delivery_date?.slice(0, 10) ?? "", notes: o.notes ?? "" });
  const { run, error, busy } = useAction();
  const dirty = h.sales_rep_id !== (o.sales_rep_id ?? "") || h.delivery_address_id !== (o.delivery_address_id ?? "") || h.delivery_date !== (o.delivery_date?.slice(0, 10) ?? "") || h.notes !== (o.notes ?? "");
  const save = () =>
    run(async () => {
      await patch(`/sales-orders/${o.id}`, Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v === "" ? null : v])));
      onSaved();
    });
  return (
    <>
      <fieldset className="plain" disabled={!editable}>
        <div className="form">
          <Field label="Comercial">
            <select value={h.sales_rep_id} onChange={(e) => setH({ ...h, sales_rep_id: e.target.value })}>
              <option value="">Sin comercial</option>
              {reps?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              {o.sales_rep_id && !reps?.some((r) => r.id === o.sales_rep_id) && <option value={o.sales_rep_id}>{o.sales_rep_name}</option>}
            </select>
          </Field>
          <Field label="Entregar en">
            <select value={h.delivery_address_id} onChange={(e) => setH({ ...h, delivery_address_id: e.target.value })}>
              <option value="">Dirección fiscal</option>
              {(cliente?.addresses ?? (o.delivery_address ? [o.delivery_address] : [])).map((a: any) => <option key={a.id} value={a.id}>{a.label} · {a.city}</option>)}
            </select>
          </Field>
          <Field label="Fecha de entrega"><input type="date" value={h.delivery_date} onChange={(e) => setH({ ...h, delivery_date: e.target.value })} /></Field>
          <Field label="Notas"><input value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} /></Field>
        </div>
      </fieldset>
      {o.delivery_address && (
        <p className="hint">
          Entrega: {[o.delivery_address.address, o.delivery_address.postal_code, o.delivery_address.city].filter(Boolean).join(", ")}
          {o.delivery_address.schedule && ` · Horario ${o.delivery_address.schedule}`}
          {o.delivery_address.phone && ` · Tel. ${o.delivery_address.phone}`}
        </p>
      )}
      <ErrorBox error={error} />
      {editable && dirty && <div className="row"><button className="primary" onClick={save} disabled={busy}>Guardar cambios</button></div>}
    </>
  );
}

export function OrderPage({ id }: { id: string }) {
  const { data: o, reload, error: loadError } = useData(`/sales-orders/${id}`);
  const { puede } = useSession();
  const { run, error, busy } = useAction();
  const [splitting, setSplitting] = useState(false);
  const [correo, setCorreo] = useState<string | null>(null);
  const [enviado, setEnviado] = useState<string | null>(null);
  const enviar = () =>
    run(async () => {
      const r = await post(`/sales-orders/${id}/correo`, correo?.trim() ? { para: correo.split(/[;,]/).map((x) => x.trim()).filter(Boolean) } : {});
      setCorreo(null);
      setEnviado(`Confirmación enviada a ${r.para.join(", ")}${r.pdf ? " con el pedido en PDF" : ""}.${r.aviso ? ` ${r.aviso}.` : ""}`);
      await reload();
    });
  const act = (a: string) =>
    a === "split"
      ? setSplitting(true)
      : run(async () => {
          const r = await post(`/sales-orders/${id}/${a}`);
          if (a === "invoice") navigate(`/facturas/${r.id}`);
          else await reload();
        });
  if (!o) return <Page title="Pedido"><ErrorBox error={loadError} /></Page>;
  const editar = puede("pedidos");
  return (
    <Page
      title={`Pedido ${o.number}`}
      actions={<>
        <RelacionesBoton tipo="pedido" id={id} />
        {editar && !splitting && o.actions.map((a: string) => (
          <button key={a} className={a === "cancel" ? "danger" : a === "split" ? undefined : "primary"} disabled={busy} onClick={() => act(a)}>{ACTION_LABEL[a]}</button>
        ))}
        {editar && ["confirmed", "delivered", "invoiced"].includes(o.state) && !splitting && <button disabled={busy} onClick={() => setCorreo(correo === null ? "" : null)}>Enviar por correo</button>}
        <DocButton tipo="pedido" id={id} label="Pedido" />
        {["delivered", "invoiced"].includes(o.state) && <DocButton tipo="albaran" id={id} label="Albarán" />}
      </>}
    >
      <p className="sub">
        <Badge state={o.state} /> · <a href={`#/clientes/${o.partner_id}`}>{o.partner_name}</a> · {fecha(o.order_date)}
        {o.split_from_id && <> · Separado de <a href={`#/pedidos/${o.split_from_id}`}><Code>{o.split_from_number}</Code></a></>}
        {o.splits.length > 0 && <> · Separados: {o.splits.map((s: any, i: number) => <span key={s.id}>{i > 0 && ", "}<a href={`#/pedidos/${s.id}`}><Code>{s.number}</Code></a></span>)}</>}
      </p>
      <ErrorBox error={error} />
      {enviado && <Alert tone="ok">{enviado}</Alert>}
      {o.mailed_at && !enviado && <p className="hint">Confirmación enviada por correo el {fecha(o.mailed_at)}.</p>}
      {correo !== null && (
        <div className="card">
          <p className="hint">Se manda la confirmación del pedido, con el PDF si el Report Server está conectado.</p>
          <div className="row">
            <Field label="Para (vacío = el correo del cliente)"><input autoFocus value={correo} placeholder="cliente@empresa.com" onChange={(e) => setCorreo(e.target.value)} /></Field>
            <button className="primary" disabled={busy} onClick={enviar}>{busy ? "Enviando…" : "Enviar"}</button>
            <button onClick={() => setCorreo(null)}>Cancelar</button>
          </div>
        </div>
      )}
      {splitting ? (
        <SplitPanel o={o} onCancel={() => setSplitting(false)} onDone={(nid) => { setSplitting(false); navigate(`/pedidos/${nid}`); }} />
      ) : (
        <HeaderPanel key={o.updated_at ?? JSON.stringify([o.sales_rep_id, o.delivery_address_id, o.delivery_date, o.notes])} o={o} onSaved={reload} />
      )}
      <Table>
        <thead><tr><th>Ref.</th><th>Descripción</th><th className="num">Cantidad</th><th className="num">Precio</th><th className="num">Dto.</th><th className="num">IVA</th><th className="num">Base</th></tr></thead>
        <tbody>
          {o.lines.map((l: any, i: number) => (
            <tr key={l.id}>
              <td><Code>{l.sku}</Code></td><td className="wrap">{l.description}</td><td className="num">{qty(l.quantity)} {l.uom}</td><td className="num">{eur(l.unit_price)}</td>
              <td className="num">{Number(l.discount_pct) ? pct(l.discount_pct) : ""}</td><td className="num">{pct(l.vat_rate)}</td>
              <td className="num">{eur(o.totals.lines[i]?.base)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
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
