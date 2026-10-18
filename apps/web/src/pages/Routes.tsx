import { useState } from "react";
import { ArrowDown, ArrowUp, Check, TriangleAlert } from "lucide-react";
import { api, del, fecha, patch, post, qty, sinVacios, vaciosANull } from "../api";
import { navigate } from "../router";
import { useAction, useData } from "../hooks";
import { useSession } from "../session";
import { DocButton } from "../docs";
import { Badge, Code, Empty, ErrorBox, Field, Page, Table } from "../ui";

const RUTA: Record<string, string> = { draft: "Preparando", on_route: "En ruta", closed: "Cerrada" };
const PARADA: Record<string, string> = { pending: "Pendiente", delivered: "Entregado", incident: "Incidencia" };
const hoy = () => new Date().toISOString().slice(0, 10);

/** Pedidos confirmados o entregados que todavía no van en ninguna hoja abierta. */
function Candidates({ chosen, setChosen }: { chosen: string[]; setChosen: (ids: string[]) => void }) {
  const { data } = useData<any[]>("/routes/candidates");
  const [zona, setZona] = useState("");
  if (!data) return null;
  if (data.length === 0) return <Empty>No hay pedidos pendientes de reparto (confirmados o entregados sin hoja de ruta).</Empty>;
  const zonas = [...new Set(data.map((o) => o.route_zone).filter(Boolean))] as string[];
  const shown = data.filter((o) => !zona || o.route_zone === zona);
  const all = shown.every((o) => chosen.includes(o.id));
  return (
    <>
      {zonas.length > 0 && (
        <div className="row">
          <Field label="Zona de reparto">
            <select value={zona} onChange={(e) => setZona(e.target.value)}>
              <option value="">Todas</option>
              {zonas.map((z) => <option key={z}>{z}</option>)}
            </select>
          </Field>
        </div>
      )}
      <Table>
        <thead>
          <tr>
            <th><input type="checkbox" aria-label="Todos" checked={all} onChange={() => setChosen(all ? chosen.filter((id) => !shown.some((o) => o.id === id)) : [...new Set([...chosen, ...shown.map((o) => o.id)])])} /></th>
            <th>Pedido</th><th>Cliente</th><th>Población</th><th>Zona</th><th className="num">Entrega</th><th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((o) => (
            <tr key={o.id} onClick={() => setChosen(chosen.includes(o.id) ? chosen.filter((x) => x !== o.id) : [...chosen, o.id])}>
              <td><input type="checkbox" checked={chosen.includes(o.id)} readOnly aria-label={o.number} /></td>
              <td><Code>{o.number}</Code></td><td>{o.partner_name}</td><td>{o.city}</td><td>{o.route_zone}</td><td className="num">{fecha(o.delivery_date)}</td><td><Badge state={o.state} /></td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

export function RoutesPage() {
  const { data } = useData<any[]>("/routes");
  const { puede } = useSession();
  const [f, setF] = useState<{ route_date: string; driver: string; vehicle: string; zone: string; notes: string } | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const { run, error, busy } = useAction();
  const create = () =>
    run(async () => {
      const r = await post("/routes", { ...sinVacios(f!), order_ids: chosen });
      navigate(`/rutas/${r.id}`);
    });
  return (
    <Page title="Hojas de ruta" actions={puede("rutas") && !f && <button className="primary" onClick={() => setF({ route_date: hoy(), driver: "", vehicle: "", zone: "", notes: "" })}>Nueva hoja de ruta</button>}>
      {f && (
        <div className="card">
          <h2>Nueva hoja de ruta</h2>
          <div className="form">
            <Field label="Fecha"><input type="date" value={f.route_date} onChange={(e) => setF({ ...f, route_date: e.target.value })} /></Field>
            <Field label="Conductor"><input value={f.driver} onChange={(e) => setF({ ...f, driver: e.target.value })} /></Field>
            <Field label="Vehículo / matrícula"><input value={f.vehicle} onChange={(e) => setF({ ...f, vehicle: e.target.value })} /></Field>
            <Field label="Zona"><input value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })} /></Field>
            <Field label="Notas"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          </div>
          <h3>Pedidos que van en la ruta</h3>
          <Candidates chosen={chosen} setChosen={setChosen} />
          <ErrorBox error={error} />
          <div className="row">
            <button className="primary" onClick={create} disabled={busy}>Crear hoja{chosen.length ? ` con ${chosen.length} parada(s)` : ""}</button>
            <button onClick={() => { setF(null); setChosen([]); }}>Cancelar</button>
          </div>
        </div>
      )}
      {data && data.length === 0 ? <Empty>Todavía no hay hojas de ruta.</Empty> : (
        <Table clickable>
          <thead><tr><th>Hoja</th><th className="num">Fecha</th><th>Conductor</th><th>Vehículo</th><th>Zona</th><th className="num">Paradas</th><th>Estado</th></tr></thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.id} tabIndex={0} onClick={() => navigate(`/rutas/${r.id}`)} onKeyDown={(e) => e.key === "Enter" && navigate(`/rutas/${r.id}`)}>
                <td><Code>{r.number}</Code></td><td className="num">{fecha(r.route_date)}</td><td>{r.driver}</td><td>{r.vehicle}</td><td>{r.zone}</td>
                <td className="num">{r.delivered}/{r.stops}{Number(r.incidents) > 0 && <span className="tag tag-aviso">{r.incidents} incid.</span>}</td>
                <td><span className={`badge badge-route-${r.state}`}>{RUTA[r.state]}</span></td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}

export function RoutePage({ id }: { id: string }) {
  const { data: r, reload, error: loadError } = useData(`/routes/${id}`);
  const { puede } = useSession();
  const { run, error, busy } = useAction();
  const [adding, setAdding] = useState<string[] | null>(null);
  const [edit, setEdit] = useState<Record<string, string> | null>(null);
  if (!r) return <Page title="Hoja de ruta"><ErrorBox error={loadError} /></Page>;
  const editar = puede("rutas") && r.state !== "closed";
  const stops: any[] = r.stops;
  const go = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  const move = (i: number, d: number) => {
    const ids = stops.map((s) => s.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    return go(() => api(`/routes/${id}/order`, { method: "PUT", body: { stop_ids: ids } }));
  };
  const mark = (s: any, state: string) => {
    const note = state === "incident" ? prompt("¿Qué ha pasado? (ausente, rechazado, dirección errónea…)", s.note ?? "") : null;
    if (state === "incident" && note === null) return;
    return go(() => post(`/routes/${id}/stops/${s.id}/state`, sinVacios({ state, note: note ?? "" })));
  };
  const pendientes = stops.filter((s) => s.state === "pending").length;
  return (
    <Page
      title={`Hoja de ruta ${r.number}`}
      actions={<>
        {editar && r.state === "draft" && <button className="primary" disabled={busy || !stops.length} onClick={() => go(() => post(`/routes/${id}/start`))}>Salir a ruta</button>}
        {editar && r.state === "on_route" && <button className="primary" disabled={busy || pendientes > 0} title={pendientes ? "Marca antes todas las paradas" : undefined} onClick={() => go(() => post(`/routes/${id}/close`))}>Cerrar hoja</button>}
        <DocButton tipo="hoja_ruta" id={id} label="Imprimir hoja" />
      </>}
    >
      <p className="sub">
        <span className={`badge badge-route-${r.state}`}>{RUTA[r.state]}</span> · {fecha(r.route_date)}
        {r.driver && <> · Conductor: {r.driver}</>}{r.vehicle && <> · Vehículo: {r.vehicle}</>}{r.zone && <> · Zona: {r.zone}</>}
        {editar && !edit && <> · <button className="link" onClick={() => setEdit({ route_date: r.route_date?.slice(0, 10) ?? "", driver: r.driver ?? "", vehicle: r.vehicle ?? "", zone: r.zone ?? "", notes: r.notes ?? "" })}>Cambiar datos</button></>}
      </p>
      {r.notes && <p className="hint">{r.notes}</p>}
      {edit && (
        <div className="card">
          <div className="form">
            <Field label="Fecha"><input type="date" value={edit.route_date} onChange={(e) => setEdit({ ...edit, route_date: e.target.value })} /></Field>
            <Field label="Conductor"><input value={edit.driver} onChange={(e) => setEdit({ ...edit, driver: e.target.value })} /></Field>
            <Field label="Vehículo"><input value={edit.vehicle} onChange={(e) => setEdit({ ...edit, vehicle: e.target.value })} /></Field>
            <Field label="Zona"><input value={edit.zone} onChange={(e) => setEdit({ ...edit, zone: e.target.value })} /></Field>
            <Field label="Notas"><input value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
          </div>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => go(async () => { await patch(`/routes/${id}`, { ...vaciosANull(edit), route_date: edit.route_date || undefined }); setEdit(null); })}>Guardar</button>
            <button onClick={() => setEdit(null)}>Cancelar</button>
          </div>
        </div>
      )}
      <ErrorBox error={error} />
      {stops.length === 0 ? <Empty>La hoja no tiene paradas todavía.</Empty> : (
        <Table>
          <thead>
            <tr><th className="num">#</th><th>Cliente y dirección</th><th>Teléfono / horario</th><th>Pedido</th><th>Mercancía</th><th>Estado</th><th className="print-only">Firma y DNI</th>{editar && <th className="no-print" />}</tr>
          </thead>
          <tbody>
            {stops.map((s, i) => (
              <tr key={s.id} className={`stop stop-${s.state}`}>
                <td className="num">{s.position}</td>
                <td className="wrap">
                  <b>{s.trade_name || s.partner_name}</b>{s.address_label && <small className="muted"> · {s.address_label}</small>}
                  <br />{[s.address, [s.postal_code, s.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
                  {s.delivery_notes && <><br /><small>{s.delivery_notes}</small></>}
                </td>
                <td className="wrap">{s.phone}{s.schedule && <><br /><small>{s.schedule}</small></>}</td>
                <td><a href={`#/pedidos/${s.order_id}`}><Code>{s.order_number}</Code></a>{s.delivery_number && <><br /><Code>{s.delivery_number}</Code></>}</td>
                <td className="wrap">{s.lines.map((l: any, j: number) => <div key={j}>{qty(l.quantity)} {l.uom} · {l.description}</div>)}</td>
                <td className="wrap">
                  <span className={`badge badge-stop-${s.state}`}>{PARADA[s.state]}</span>
                  {s.note && <><br /><small>{s.note}</small></>}
                </td>
                <td className="print-only sign" />
                {editar && (
                  <td className="acts no-print">
                    {r.state === "on_route" && s.state !== "delivered" && <button title="Entregado" onClick={() => mark(s, "delivered")} disabled={busy}><Check size={16} aria-hidden /> Entregado</button>}
                    {r.state === "on_route" && s.state !== "incident" && <button title="Incidencia" onClick={() => mark(s, "incident")} disabled={busy}><TriangleAlert size={16} aria-hidden /> Incidencia</button>}
                    {r.state === "on_route" && s.state !== "pending" && <button className="link" onClick={() => mark(s, "pending")} disabled={busy}>Deshacer</button>}
                    {i > 0 && <button aria-label="Subir" onClick={() => move(i, -1)} disabled={busy}><ArrowUp size={16} aria-hidden /></button>}
                    {i < stops.length - 1 && <button aria-label="Bajar" onClick={() => move(i, 1)} disabled={busy}><ArrowDown size={16} aria-hidden /></button>}
                    {r.state === "draft" && <button className="link" onClick={() => go(() => del(`/routes/${id}/stops/${s.id}`))} disabled={busy}>Quitar</button>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {editar && (
        adding ? (
          <div className="card">
            <h2>Añadir pedidos</h2>
            <Candidates chosen={adding} setChosen={setAdding} />
            <div className="row">
              <button className="primary" disabled={busy || !adding.length} onClick={() => go(async () => { await post(`/routes/${id}/stops`, { order_ids: adding }); setAdding(null); })}>Añadir {adding.length || ""} parada(s)</button>
              <button onClick={() => setAdding(null)}>Cancelar</button>
            </div>
          </div>
        ) : (
          <div className="row no-print"><button onClick={() => setAdding([])}>Añadir pedidos a la hoja</button></div>
        )
      )}
    </Page>
  );
}
