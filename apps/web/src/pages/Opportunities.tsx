import { useState } from "react";
import { del, eur, fecha, patch, post, sinVacios, vaciosANull } from "../api";
import { navigate } from "../router";
import { useAction, useData } from "../hooks";
import { useSession } from "../session";
import { Badge, Code, Empty, ErrorBox, Field, Page, Table } from "../ui";
import { RelacionesBoton } from "./Relaciones";

export const ETAPAS = [["new", "Nueva"], ["contacted", "Contactada"], ["proposal", "Propuesta"], ["won", "Ganada"], ["lost", "Perdida"]] as const;
const TIPOS = [["call", "Llamada"], ["email", "Correo"], ["meeting", "Reunión"], ["task", "Tarea"], ["note", "Nota"]] as const;
const tipo = (k: string) => TIPOS.find(([v]) => v === k)?.[1] ?? k;
const hoy = () => new Date().toISOString().slice(0, 10);

type OppForm = { title: string; partner_id: string; prospect_name: string; contact_name: string; email: string; phone: string; amount: string; expected_close: string; sales_rep_id: string; source: string; notes: string };
const VACIA: OppForm = { title: "", partner_id: "", prospect_name: "", contact_name: "", email: "", phone: "", amount: "", expected_close: "", sales_rep_id: "", source: "", notes: "" };

function OppFields({ f, set, nueva }: { f: OppForm; set: (p: Partial<OppForm>) => void; nueva?: boolean }) {
  const { data: partners } = useData<any[]>("/partners");
  const { data: reps } = useData<any[]>("/sales-reps");
  return (
    <div className="form">
      <Field label="Qué quiere"><input value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="Web nueva, soporte anual…" /></Field>
      {(nueva || f.partner_id) && (
        <Field label="Cliente">
          <select value={f.partner_id} onChange={(e) => set({ partner_id: e.target.value })} disabled={!nueva}>
            <option value="">Todavía no es cliente</option>
            {partners?.filter((p) => p.kind !== "supplier").map((p) => <option key={p.id} value={p.id}>{p.trade_name || p.name}</option>)}
          </select>
        </Field>
      )}
      {!f.partner_id && <Field label="Nombre (empresa o persona)"><input value={f.prospect_name} onChange={(e) => set({ prospect_name: e.target.value })} /></Field>}
      <Field label="Persona de contacto"><input value={f.contact_name} onChange={(e) => set({ contact_name: e.target.value })} /></Field>
      <Field label="Correo"><input type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
      <Field label="Teléfono"><input value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
      <Field label="Importe estimado"><input className="num" value={f.amount} onChange={(e) => set({ amount: e.target.value })} /></Field>
      <Field label="Cierre previsto"><input type="date" value={f.expected_close} onChange={(e) => set({ expected_close: e.target.value })} /></Field>
      <Field label="Comercial">
        <select value={f.sales_rep_id} onChange={(e) => set({ sales_rep_id: e.target.value })}>
          <option value="">{nueva ? "El del cliente" : "Sin comercial"}</option>
          {reps?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Field>
      <Field label="Cómo llegó"><input value={f.source} onChange={(e) => set({ source: e.target.value })} placeholder="Recomendación, web, feria…" /></Field>
      <Field label="Notas"><input value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
    </div>
  );
}

export function OpportunitiesPage() {
  const [stage, setStage] = useState("");
  const { data, reload } = useData<{ items: any[]; funnel: Record<string, { count: number; amount: string }>; weighted: string }>(`/opportunities${stage ? `?stage=${stage}` : ""}`);
  const { data: tareas, reload: reloadTareas } = useData<any[]>("/crm/activities?pendientes=1");
  const { puede } = useSession();
  const editar = puede("crm");
  const [alta, setAlta] = useState<OppForm | null>(null);
  const { run, error, busy } = useAction();
  const crear = () =>
    run(async () => {
      const o = await post("/opportunities", sinVacios(alta!));
      setAlta(null);
      await reload();
      navigate(`/oportunidades/${o.id}`);
    });
  const hecha = (id: string) => run(async () => { await patch(`/crm/activities/${id}`, { done: true }); await reloadTareas(); });
  return (
    <Page title="Oportunidades" actions={editar && !alta && <button className="primary" onClick={() => setAlta({ ...VACIA })}>Nueva oportunidad</button>}>
      {alta && (
        <div className="card">
          <h2>Nueva oportunidad</h2>
          <OppFields f={alta} set={(p) => setAlta({ ...alta, ...p })} nueva />
          <ErrorBox error={error} />
          <div className="row">
            <button className="primary" onClick={crear} disabled={busy || !alta.title || (!alta.partner_id && !alta.prospect_name)}>Crear</button>
            <button onClick={() => setAlta(null)}>Cancelar</button>
          </div>
        </div>
      )}
      {data && (
        <div className="kpis">
          {ETAPAS.map(([k, l]) => (
            <button key={k} className={`kpi kpi-btn ${stage === k ? "active" : ""}`} onClick={() => setStage(stage === k ? "" : k)} aria-pressed={stage === k}>
              <span>{l}</span>
              <b>{data.funnel[k]?.count ?? 0}</b>
              <small>{eur(data.funnel[k]?.amount ?? 0)}</small>
            </button>
          ))}
          {!stage && <div className="kpi"><span>Previsión (abiertas × probabilidad)</span><b>{eur(data.weighted)}</b></div>}
        </div>
      )}
      {tareas && tareas.some((t) => t.due_date && t.due_date.slice(0, 10) <= hoy()) && (
        <>
          <h2>Seguimientos para hoy</h2>
          <Table>
            <thead><tr><th className="num">Fecha</th><th>Tipo</th><th>Qué</th><th>Oportunidad</th><th /></tr></thead>
            <tbody>
              {tareas.filter((t) => t.due_date && t.due_date.slice(0, 10) <= hoy()).map((t) => (
                <tr key={t.id}>
                  <td className="num">{fecha(t.due_date)}</td><td>{tipo(t.kind)}</td><td className="wrap">{t.subject}</td>
                  <td><a href={`#/oportunidades/${t.opportunity_id}`}>{t.customer_name} · {t.opportunity_title}</a></td>
                  <td>{editar && <button className="link" disabled={busy} onClick={() => hecha(t.id)}>Hecho</button>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
      {tareas?.some((t) => t.due_date && t.due_date.slice(0, 10) <= hoy()) && <h2>Embudo</h2>}
      {data && data.items.length === 0 ? <Empty>No hay oportunidades{stage ? " en esa etapa" : " todavía"}.</Empty> : (
        <Table clickable>
          <thead><tr><th>Número</th><th>Cliente</th><th>Qué quiere</th><th>Etapa</th><th className="num">Importe</th><th className="num">Prob.</th><th className="num">Cierre</th><th className="num">Próximo paso</th><th>Comercial</th></tr></thead>
          <tbody>
            {data?.items.map((o) => (
              <tr key={o.id} tabIndex={0} onClick={() => navigate(`/oportunidades/${o.id}`)} onKeyDown={(e) => e.key === "Enter" && navigate(`/oportunidades/${o.id}`)}>
                <td><Code>{o.number}</Code></td><td>{o.customer_name}{!o.partner_id && <span className="tag">Nuevo</span>}</td><td className="wrap">{o.title}</td>
                <td><Badge state={o.stage} /></td><td className="num">{eur(o.amount)}</td><td className="num">{o.probability ?? ""} %</td>
                <td className="num">{fecha(o.expected_close)}</td><td className="num">{fecha(o.next_activity)}</td><td>{o.sales_rep_name}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}

const aForm = (o: any): OppForm => Object.fromEntries(Object.keys(VACIA).map((k) => [k, o[k] == null ? "" : String(k === "expected_close" ? o[k].slice(0, 10) : o[k])])) as OppForm;

export function OpportunityPage({ id }: { id: string }) {
  const { data: o, reload, error: loadError } = useData(`/opportunities/${id}`);
  const { puede } = useSession();
  const editar = puede("crm");
  const { run, error, busy } = useAction();
  const [f, setF] = useState<OppForm | null>(null);
  const [perder, setPerder] = useState<string | null>(null);
  const [nif, setNif] = useState<string | null>(null);
  const [act, setAct] = useState({ kind: "call", subject: "", due_date: "", notes: "", done: true });
  if (!o) return <Page title="Oportunidad"><ErrorBox error={loadError} /></Page>;
  const abierta = ["new", "contacted", "proposal"].includes(o.stage);
  const etapa = (stage: string, lost_reason?: string) => run(async () => { await post(`/opportunities/${id}/stage`, { stage, lost_reason }); setPerder(null); await reload(); });
  const guardar = () =>
    run(async () => {
      const { partner_id: _p, ...rest } = f!;
      await patch(`/opportunities/${id}`, { ...vaciosANull(rest), probability: undefined });
      setF(null);
      await reload();
    });
  const darDeAlta = () => run(async () => { await post(`/opportunities/${id}/partner`, sinVacios({ tax_id: nif })); setNif(null); await reload(); });
  const anotar = () =>
    run(async () => {
      await post(`/opportunities/${id}/activities`, { ...sinVacios({ kind: act.kind, subject: act.subject, due_date: act.due_date, notes: act.notes }), done: act.done });
      setAct({ ...act, subject: "", notes: "", due_date: "" });
      await reload();
    });
  const marcar = (aid: string, done: boolean) => run(async () => { await patch(`/crm/activities/${aid}`, { done }); await reload(); });
  const borrar = (aid: string) => run(async () => { await del(`/crm/activities/${aid}`); await reload(); });
  return (
    <Page
      title={`${o.number} · ${o.title}`}
      actions={<>
        <RelacionesBoton tipo="oportunidad" id={id} />
        {editar && <>
        {abierta && !o.partner_id && nif === null && <button onClick={() => setNif("")}>Dar de alta como cliente</button>}
        {abierta && o.partner_id && <button className="primary" onClick={() => navigate(`/presupuestos/nuevo?oportunidad=${id}`)}>Nuevo presupuesto</button>}
        {abierta && <button onClick={() => etapa("won")} disabled={busy}>Ganada</button>}
        {abierta && perder === null && <button className="danger" onClick={() => setPerder("")}>Perdida</button>}
        {!abierta && <button onClick={() => etapa("contacted")} disabled={busy}>Reabrir</button>}
        {!f && <button onClick={() => setF(aForm(o))}>Editar</button>}
        </>}
      </>}
    >
      <p className="sub">
        <Badge state={o.stage} /> · {o.partner_id ? <a href={`#/clientes/${o.partner_id}`}>{o.customer_name}</a> : <>{o.customer_name} (todavía no es cliente)</>}
        {o.amount && <> · {eur(o.amount)} al {o.probability ?? 0} %</>}
        {o.expected_close && <> · cierre {fecha(o.expected_close)}</>}
        {o.sales_rep_name && <> · {o.sales_rep_name}</>}
      </p>
      {o.stage === "lost" && o.lost_reason && <p className="hint">Motivo: {o.lost_reason}</p>}
      {abierta && editar && (
        <div className="row" role="group" aria-label="Etapa">
          {ETAPAS.slice(0, 3).map(([k, l]) => (
            <button key={k} className={o.stage === k ? "primary" : undefined} aria-pressed={o.stage === k} disabled={busy || o.stage === k} onClick={() => etapa(k)}>{l}</button>
          ))}
        </div>
      )}
      {perder !== null && (
        <div className="card">
          <Field label="¿Por qué se ha perdido?"><input autoFocus value={perder} onChange={(e) => setPerder(e.target.value)} placeholder="Precio, plazo, se fue con otro…" /></Field>
          <div className="row">
            <button className="danger" disabled={busy || !perder.trim()} onClick={() => etapa("lost", perder)}>Marcar como perdida</button>
            <button onClick={() => setPerder(null)}>Cancelar</button>
          </div>
        </div>
      )}
      {nif !== null && (
        <div className="card">
          <p className="hint">Se crea la ficha de cliente de {o.prospect_name} con su contacto, correo y teléfono. Hace falta para hacerle un presupuesto.</p>
          <Field label="NIF (opcional)"><input autoFocus value={nif} onChange={(e) => setNif(e.target.value)} /></Field>
          <div className="row">
            <button className="primary" disabled={busy} onClick={darDeAlta}>Dar de alta</button>
            <button onClick={() => setNif(null)}>Cancelar</button>
          </div>
        </div>
      )}
      <ErrorBox error={error} />
      {f ? (
        <div className="card">
          <OppFields f={f} set={(p) => setF({ ...f, ...p })} />
          <div className="row">
            <button className="primary" onClick={guardar} disabled={busy || !f.title}>Guardar</button>
            <button onClick={() => setF(null)}>Cancelar</button>
          </div>
        </div>
      ) : (
        <p className="hint">
          {[o.contact_name, o.email, o.phone, o.source && `Llegó por: ${o.source}`].filter(Boolean).join(" · ")}
          {o.notes && <><br />{o.notes}</>}
        </p>
      )}

      <h2>Presupuestos</h2>
      {o.quotations.length === 0 ? <Empty>Todavía no hay presupuestos para esta oportunidad.</Empty> : (
        <Table clickable>
          <thead><tr><th>Número</th><th>Título</th><th className="num">Fecha</th><th className="num">Válido hasta</th><th className="num">Base</th><th>Estado</th></tr></thead>
          <tbody>
            {o.quotations.map((q: any) => (
              <tr key={q.id} tabIndex={0} onClick={() => navigate(`/presupuestos/${q.id}`)}>
                <td><Code>{q.number}</Code></td><td>{q.title}</td><td className="num">{fecha(q.quote_date)}</td><td className="num">{fecha(q.valid_until)}</td>
                <td className="num">{eur(q.untaxed)}</td><td><Badge state={q.state} /></td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <h2>Seguimiento</h2>
      {editar && (
        <div className="form">
          <Field label="Tipo">
            <select value={act.kind} onChange={(e) => setAct({ ...act, kind: e.target.value, done: e.target.value !== "task" })}>
              {TIPOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Qué"><input value={act.subject} onChange={(e) => setAct({ ...act, subject: e.target.value })} placeholder="Llamada para ver la propuesta…" /></Field>
          <Field label="Fecha"><input type="date" value={act.due_date} onChange={(e) => setAct({ ...act, due_date: e.target.value })} /></Field>
          <Field label="Notas"><input value={act.notes} onChange={(e) => setAct({ ...act, notes: e.target.value })} /></Field>
          <Field label="Estado">
            <select value={act.done ? "1" : ""} onChange={(e) => setAct({ ...act, done: !!e.target.value })}>
              <option value="1">Ya hecho</option>
              <option value="">Pendiente</option>
            </select>
          </Field>
          <div className="row"><button className="primary" disabled={busy || !act.subject.trim()} onClick={anotar}>Anotar</button></div>
        </div>
      )}
      {o.activities.length === 0 ? <Empty>Sin llamadas, correos ni tareas anotadas.</Empty> : (
        <Table>
          <thead><tr><th className="num">Fecha</th><th>Tipo</th><th>Qué</th><th>Notas</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {o.activities.map((a: any) => (
              <tr key={a.id}>
                <td className="num">{fecha(a.due_date ?? a.done_at ?? a.created_at)}</td><td>{tipo(a.kind)}</td><td className="wrap">{a.subject}</td><td className="wrap">{a.notes}</td>
                <td>{a.done_at ? "Hecho" : <b>Pendiente</b>}</td>
                <td>{editar && <>
                  <button className="link" disabled={busy} onClick={() => marcar(a.id, !a.done_at)}>{a.done_at ? "Reabrir" : "Hecho"}</button>{" "}
                  <button className="link" disabled={busy} onClick={() => borrar(a.id)}>Quitar</button>
                </>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}
