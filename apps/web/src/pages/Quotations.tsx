import { useEffect, useState } from "react";
import { eur, fecha, patch, pct, post, put, qty, sinVacios } from "../api";
import { navigate, queryParam } from "../router";
import { useAction, useData } from "../hooks";
import { useSession } from "../session";
import { Alert, Badge, Code, Empty, ErrorBox, Field, Page, Table } from "../ui";
import { Totals } from "./Orders";
import { DocButton } from "../docs";
import { RelacionesBoton } from "./Relaciones";

const ESTADOS = [["", "Todos"], ["draft", "Borrador"], ["sent", "Enviado"], ["accepted", "Aceptado"], ["rejected", "Rechazado"], ["cancelled", "Cancelado"]];
const TABS = [["", "Presupuestos"], ["modelos", "Modelos"]] as const;

function Tabs({ tab }: { tab: string }) {
  return (
    <div className="tabs" role="tablist">
      {TABS.map(([t, label]) => (
        <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => navigate(`/presupuestos${t ? `/${t}` : ""}`)}>{label}</button>
      ))}
    </div>
  );
}

export function QuotationsPage() {
  const [state, setState] = useState("");
  const { data } = useData<any[]>(`/quotations${state ? `?state=${state}` : ""}`);
  const { puede } = useSession();
  return (
    <Page title="Presupuestos" actions={puede("presupuestos") && <button className="primary" onClick={() => navigate("/presupuestos/nuevo")}>Nuevo presupuesto</button>}>
      <Tabs tab="" />
      <div className="row filters">
        <Field label="Estado">
          <select value={state} onChange={(e) => setState(e.target.value)}>
            {ESTADOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
      </div>
      {data && data.length === 0 ? <Empty>No hay presupuestos{state ? " con ese filtro" : " todavía"}.</Empty> : (
        <Table clickable>
          <thead><tr><th>Número</th><th className="num">Fecha</th><th>Cliente</th><th>Título</th><th className="num">Válido hasta</th><th className="num">Base</th><th>Estado</th><th>Pedido</th></tr></thead>
          <tbody>
            {data?.map((q) => (
              <tr key={q.id} tabIndex={0} onClick={() => navigate(`/presupuestos/${q.id}`)} onKeyDown={(e) => e.key === "Enter" && navigate(`/presupuestos/${q.id}`)}>
                <td><Code>{q.number}</Code></td><td className="num">{fecha(q.quote_date)}</td><td>{q.partner_name}</td><td className="wrap">{q.title}</td>
                <td className="num">{fecha(q.valid_until)}{q.expired && <span className="tag">Caducado</span>}</td>
                <td className="num">{eur(q.untaxed)}</td><td><Badge state={q.state} /></td><td>{q.order_number && <Code>{q.order_number}</Code>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}

type Line = { product_id: string; quantity: string; unit_price: string; discount_pct: string; description: string };
type Head = { partner_id: string; template_id: string; title: string; intro: string; conditions: string; quote_date: string; valid_until: string; sales_rep_id: string; notes: string };
const nuevaLinea = (): Line => ({ product_id: "", quantity: "1", unit_price: "", discount_pct: "", description: "" });
const addDays = (iso: string, d: number) => {
  const x = new Date(`${iso}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};
const s = (v: unknown) => (v == null ? "" : String(v));

/** Alta y cambio de un presupuesto (en borrador). */
function QuotationForm({ q, onSaved, onCancel }: { q?: any; onSaved: (id: string) => void; onCancel?: () => void }) {
  const oportunidad = q ? q.opportunity_id : queryParam("oportunidad");
  const { data: opp } = useData(oportunidad && !q ? `/opportunities/${oportunidad}` : null);
  const { data: partners } = useData<any[]>("/partners");
  const { data: products } = useData<any[]>("/products");
  const { data: reps } = useData<any[]>("/sales-reps");
  const { data: models } = useData<any[]>("/quotation-templates");
  const hoy = new Date().toISOString().slice(0, 10);
  const [h, setH] = useState<Head>(() =>
    q
      ? { partner_id: q.partner_id, template_id: s(q.template_id), title: s(q.title), intro: s(q.intro), conditions: s(q.conditions), quote_date: s(q.quote_date).slice(0, 10), valid_until: s(q.valid_until).slice(0, 10), sales_rep_id: s(q.sales_rep_id), notes: s(q.notes) }
      : { partner_id: queryParam("cliente") ?? "", template_id: "", title: "", intro: "", conditions: "", quote_date: hoy, valid_until: "", sales_rep_id: "", notes: "" },
  );
  const [lines, setLines] = useState<Line[]>(() =>
    q ? q.lines.map((l: any) => ({ product_id: l.product_id, quantity: String(Number(l.quantity)), unit_price: String(Number(l.unit_price)), discount_pct: Number(l.discount_pct) ? String(Number(l.discount_pct)) : "", description: s(l.description) })) : [nuevaLinea()],
  );
  const { run, error, busy } = useAction();
  useEffect(() => {
    if (opp) setH((x) => ({ ...x, partner_id: opp.partner_id ?? "", title: x.title || opp.title, sales_rep_id: x.sales_rep_id || s(opp.sales_rep_id) }));
  }, [opp]);
  // Elegir un modelo rellena título, textos y validez; luego se cambian a mano si hace falta.
  const elegirModelo = (id: string) => {
    const m = models?.find((x) => x.id === id);
    setH({ ...h, template_id: id, ...(m ? { title: m.title, intro: s(m.intro), conditions: s(m.conditions), valid_until: addDays(h.quote_date || hoy, m.validity_days) } : {}) });
  };
  const setLine = (i: number, p: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const save = () =>
    run(async () => {
      const body = {
        ...(q ? {} : sinVacios({ partner_id: h.partner_id, template_id: h.template_id, opportunity_id: oportunidad ?? "" })),
        title: h.title,
        intro: h.intro || null,
        conditions: h.conditions || null,
        quote_date: h.quote_date || undefined,
        valid_until: h.valid_until || (q ? null : undefined),
        sales_rep_id: h.sales_rep_id || (q ? null : undefined),
        notes: h.notes || null,
        lines: lines.filter((l) => l.product_id).map((l) => sinVacios(l)),
      };
      const r = q ? await put(`/quotations/${q.id}`, body) : await post("/quotations", body);
      onSaved(r.id);
    });
  return (
    <>
      {opp && <p className="hint">Para la oportunidad <a href={`#/oportunidades/${opp.id}`}><Code>{opp.number}</Code> {opp.title}</a>.</p>}
      <div className="form">
        <Field label="Cliente">
          <select value={h.partner_id} onChange={(e) => setH({ ...h, partner_id: e.target.value })} disabled={!!q || !!oportunidad}>
            <option value="">—</option>
            {partners?.filter((p) => p.kind !== "supplier").map((p) => <option key={p.id} value={p.id}>{p.trade_name || p.name}</option>)}
            {q && !partners?.some((p) => p.id === q.partner_id) && <option value={q.partner_id}>{q.partner_name}</option>}
          </select>
        </Field>
        <Field label="Modelo">
          <select value={h.template_id} onChange={(e) => elegirModelo(e.target.value)} disabled={!!q}>
            <option value="">Sin modelo</option>
            {models?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="Título"><input value={h.title} onChange={(e) => setH({ ...h, title: e.target.value })} placeholder="Presupuesto" /></Field>
        <Field label="Fecha"><input type="date" value={h.quote_date} onChange={(e) => setH({ ...h, quote_date: e.target.value })} /></Field>
        <Field label="Válido hasta"><input type="date" value={h.valid_until} onChange={(e) => setH({ ...h, valid_until: e.target.value })} /></Field>
        <Field label="Comercial">
          <select value={h.sales_rep_id} onChange={(e) => setH({ ...h, sales_rep_id: e.target.value })}>
            <option value="">{q ? "Sin comercial" : "El del cliente"}</option>
            {reps?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        <Field label="Notas internas"><input value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} /></Field>
      </div>
      <Field label="Presentación (va antes de las líneas)"><textarea rows={3} value={h.intro} onChange={(e) => setH({ ...h, intro: e.target.value })} /></Field>
      <Table>
        <thead><tr><th>Producto o servicio</th><th>Descripción (vacía = la del producto)</th><th className="num">Cantidad</th><th className="num">Precio (vacío = tarifa)</th><th className="num">Dto. %</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <select value={l.product_id} onChange={(e) => setLine(i, { product_id: e.target.value })}>
                  <option value="">—</option>
                  {products?.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name} ({eur(p.sale_price)})</option>)}
                </select>
              </td>
              <td><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
              <td><input className="num" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></td>
              <td><input className="num" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: e.target.value })} /></td>
              <td><input className="num" value={l.discount_pct} onChange={(e) => setLine(i, { discount_pct: e.target.value })} /></td>
              <td><button className="link" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Quitar</button></td>
            </tr>
          ))}
        </tbody>
      </Table>
      <div className="row"><button onClick={() => setLines([...lines, nuevaLinea()])}>Añadir línea</button></div>
      <Field label="Condiciones (forma de pago, qué incluye…)"><textarea rows={5} value={h.conditions} onChange={(e) => setH({ ...h, conditions: e.target.value })} /></Field>
      <ErrorBox error={error} />
      <div className="row">
        <button className="primary" onClick={save} disabled={busy || !h.partner_id || !lines.some((l) => l.product_id)}>{q ? "Guardar cambios" : "Crear presupuesto"}</button>
        {onCancel && <button onClick={onCancel}>Cancelar</button>}
      </div>
    </>
  );
}

export function NewQuotationPage() {
  return (
    <Page title="Nuevo presupuesto">
      <QuotationForm onSaved={(id) => navigate(`/presupuestos/${id}`)} />
    </Page>
  );
}

const ACTION_LABEL: Record<string, string> = { send: "Marcar como enviado", edit: "Volver a borrador", accept: "Aceptado: crear pedido", reject: "Rechazado", cancel: "Anular" };

export function QuotationPage({ id }: { id: string }) {
  const { data: q, reload, error: loadError } = useData(`/quotations/${id}`);
  const { puede } = useSession();
  const editar = puede("presupuestos");
  const { run, error, busy } = useAction();
  const [editando, setEditando] = useState(false);
  const [rechazo, setRechazo] = useState<string | null>(null);
  if (!q) return <Page title="Presupuesto"><ErrorBox error={loadError} /></Page>;
  const act = (a: string, reason?: string) =>
    a === "reject" && reason === undefined
      ? setRechazo("")
      : run(async () => {
          await post(`/quotations/${id}/${a}`, reason ? { reason } : {});
          setRechazo(null);
          await reload();
        });
  const duplicar = () => run(async () => navigate(`/presupuestos/${(await post(`/quotations/${id}/duplicate`)).id}`));
  return (
    <Page
      title={`Presupuesto ${q.number}`}
      actions={!editando && <>
        <RelacionesBoton tipo="presupuesto" id={id} />
        <DocButton tipo="presupuesto" id={id} label="Presupuesto" />
        {editar && <>
          {q.state === "draft" && <button onClick={() => setEditando(true)}>Editar</button>}
          {q.actions.map((a: string) => (
            <button key={a} className={a === "accept" ? "primary" : a === "cancel" || a === "reject" ? "danger" : undefined} disabled={busy} onClick={() => act(a)}>{ACTION_LABEL[a]}</button>
          ))}
          <button onClick={duplicar} disabled={busy}>Duplicar</button>
        </>}
      </>}
    >
      <p className="sub">
        <Badge state={q.state} /> · <a href={`#/clientes/${q.partner_id}`}>{q.partner_name}</a> · {fecha(q.quote_date)}
        {q.valid_until && <> · válido hasta {fecha(q.valid_until)}</>}
        {q.template_name && <> · modelo {q.template_name}</>}
        {q.opportunity_id && <> · <a href={`#/oportunidades/${q.opportunity_id}`}><Code>{q.opportunity_number}</Code> {q.opportunity_title}</a></>}
        {q.order_id && <> · pedido <a href={`#/pedidos/${q.order_id}`}><Code>{q.order_number}</Code></a></>}
      </p>
      {q.expired && <Alert tone="aviso">Este presupuesto ha caducado. Para aceptarlo, vuelve a borrador y amplía la validez, o duplícalo.</Alert>}
      {q.state === "rejected" && q.reject_reason && <p className="hint">Motivo del rechazo: {q.reject_reason}</p>}
      {rechazo !== null && (
        <div className="card">
          <Field label="¿Por qué lo ha rechazado?"><input autoFocus value={rechazo} onChange={(e) => setRechazo(e.target.value)} placeholder="Precio, plazo, se fue con otro…" /></Field>
          <div className="row">
            <button className="danger" disabled={busy || !rechazo.trim()} onClick={() => act("reject", rechazo)}>Marcar como rechazado</button>
            <button onClick={() => setRechazo(null)}>Cancelar</button>
          </div>
        </div>
      )}
      <ErrorBox error={error} />
      {editando ? (
        <QuotationForm q={q} onCancel={() => setEditando(false)} onSaved={async () => { setEditando(false); await reload(); }} />
      ) : (
        <>
          <h2>{q.title}</h2>
          {q.intro && <p className="prewrap">{q.intro}</p>}
          <Table>
            <thead><tr><th>Ref.</th><th>Descripción</th><th className="num">Cantidad</th><th className="num">Precio</th><th className="num">Dto.</th><th className="num">IVA</th><th className="num">Base</th></tr></thead>
            <tbody>
              {q.lines.map((l: any, i: number) => (
                <tr key={l.id}>
                  <td><Code>{l.sku}</Code></td><td className="wrap">{l.description}</td><td className="num">{qty(l.quantity)} {l.uom}</td><td className="num">{eur(l.unit_price)}</td>
                  <td className="num">{Number(l.discount_pct) ? pct(l.discount_pct) : ""}</td><td className="num">{pct(l.vat_rate)}</td>
                  <td className="num">{eur(q.totals.lines[i]?.base)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Totals t={q.totals} />
          {q.conditions && <><h3>Condiciones</h3><p className="prewrap">{q.conditions}</p></>}
          {q.notes && <p className="hint">Notas internas: {q.notes}</p>}
        </>
      )}
    </Page>
  );
}

type Model = { id?: string; name: string; title: string; intro: string; conditions: string; validity_days: string; active: boolean };

/** Modelos de presupuesto (proyecto, soporte, servicios…): el texto de partida de cada tipo. */
export function TemplatesPage() {
  const { data, reload } = useData<any[]>("/quotation-templates?todos=1");
  const { puede } = useSession();
  const editar = puede("presupuestos");
  const [m, setM] = useState<Model | null>(null);
  const { run, error, busy } = useAction();
  const save = () =>
    run(async () => {
      const { id, ...b } = m!;
      const body = { ...b, intro: b.intro || null, conditions: b.conditions || null, validity_days: Number(b.validity_days) || 30 };
      if (id) await patch(`/quotation-templates/${id}`, body);
      else await post("/quotation-templates", body);
      setM(null);
      await reload();
    });
  return (
    <Page title="Presupuestos" actions={editar && !m && <button className="primary" onClick={() => setM({ name: "", title: "", intro: "", conditions: "", validity_days: "30", active: true })}>Nuevo modelo</button>}>
      <Tabs tab="modelos" />
      <p className="hint">Cada modelo pone el título, la presentación, las condiciones y la validez de un presupuesto nuevo. Después se cambian en cada presupuesto si hace falta.</p>
      {m && (
        <div className="card">
          <div className="form">
            <Field label="Nombre"><input value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} placeholder="Proyecto, Soporte…" /></Field>
            <Field label="Título del presupuesto"><input value={m.title} onChange={(e) => setM({ ...m, title: e.target.value })} /></Field>
            <Field label="Validez (días)"><input className="num" value={m.validity_days} onChange={(e) => setM({ ...m, validity_days: e.target.value })} /></Field>
            <Field label="En uso">
              <select value={m.active ? "1" : ""} onChange={(e) => setM({ ...m, active: !!e.target.value })}>
                <option value="1">Sí</option>
                <option value="">No (no se ofrece)</option>
              </select>
            </Field>
          </div>
          <Field label="Presentación"><textarea rows={3} value={m.intro} onChange={(e) => setM({ ...m, intro: e.target.value })} /></Field>
          <Field label="Condiciones"><textarea rows={6} value={m.conditions} onChange={(e) => setM({ ...m, conditions: e.target.value })} /></Field>
          <ErrorBox error={error} />
          <div className="row">
            <button className="primary" onClick={save} disabled={busy || !m.name.trim() || !m.title.trim()}>Guardar</button>
            <button onClick={() => setM(null)}>Cancelar</button>
          </div>
        </div>
      )}
      {data && data.length === 0 ? <Empty>No hay modelos.</Empty> : (
        <Table clickable={editar}>
          <thead><tr><th>Nombre</th><th>Título</th><th className="num">Validez</th><th>En uso</th></tr></thead>
          <tbody>
            {data?.map((t) => (
              <tr key={t.id} tabIndex={editar ? 0 : undefined} onClick={() => editar && setM({ id: t.id, name: t.name, title: t.title, intro: s(t.intro), conditions: s(t.conditions), validity_days: String(t.validity_days), active: t.active })}>
                <td>{t.name}</td><td>{t.title}</td><td className="num">{t.validity_days} días</td><td>{t.active ? "Sí" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}
