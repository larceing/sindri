import { useState } from "react";
import { eur, patch, pct, post, sinVacios, vaciosANull } from "../api";
import { useAction, useData } from "../hooks";
import { useSession } from "../session";
import { Code, Empty, ErrorBox, Field, Page, Table } from "../ui";

const BLANK = { code: "", name: "", kind: "internal", email: "", phone: "", zone: "", commission_pct: "0", tax_id: "", user_id: "", active: true };
type F = typeof BLANK & { id?: string };

/** Comerciales de plantilla y representantes (agentes externos, con su NIF y comisión). */
export function RepsPage() {
  const [todos, setTodos] = useState(false);
  const { data, reload } = useData<any[]>(`/sales-reps${todos ? "?todos=1" : ""}`);
  const { me, puede } = useSession();
  const { data: users } = useData<any[]>(me?.admin ? "/users" : null);
  const [f, setF] = useState<F | null>(null);
  const { run, error, busy } = useAction();
  const editar = puede("comerciales");
  const save = () =>
    run(async () => {
      const { id, ...b } = f!;
      if (id) await patch(`/sales-reps/${id}`, vaciosANull(b));
      else await post("/sales-reps", sinVacios(b));
      setF(null);
      await reload();
    });
  const set = (k: keyof F) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f!, [k]: e.target.value });
  const total = (k: string) => (data ?? []).reduce((a, r) => a + Number(r[k]), 0);
  return (
    <Page title="Comerciales y representantes" actions={editar && !f && <button className="primary" onClick={() => setF({ ...BLANK })}>Nuevo comercial</button>}>
      {f && (
        <div className="card">
          <h2>{f.id ? `Editar ${f.name}` : "Nuevo comercial"}</h2>
          <div className="form">
            <Field label="Código *"><input value={f.code} onChange={set("code")} placeholder="C01" /></Field>
            <Field label="Nombre *"><input value={f.name} onChange={set("name")} /></Field>
            <Field label="Tipo">
              <select value={f.kind} onChange={set("kind")}>
                <option value="internal">Comercial de plantilla</option>
                <option value="agent">Representante (agente externo)</option>
              </select>
            </Field>
            {f.kind === "agent" && <Field label="NIF del agente"><input value={f.tax_id} onChange={set("tax_id")} /></Field>}
            <Field label="Zona"><input value={f.zone} onChange={set("zone")} /></Field>
            <Field label="Comisión %"><input value={f.commission_pct} onChange={set("commission_pct")} inputMode="decimal" /></Field>
            <Field label="Teléfono"><input value={f.phone} onChange={set("phone")} /></Field>
            <Field label="Email"><input value={f.email} onChange={set("email")} /></Field>
            {users && (
              <Field label="Usuario de Sindri">
                <select value={f.user_id} onChange={set("user_id")}>
                  <option value="">Ninguno</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name ?? u.username}</option>)}
                </select>
              </Field>
            )}
            <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> En activo</label>
          </div>
          <ErrorBox error={error} />
          <div className="row">
            <button className="primary" onClick={save} disabled={busy || !f.code || !f.name}>Guardar</button>
            <button onClick={() => setF(null)}>Cancelar</button>
          </div>
        </div>
      )}
      <label className="check"><input type="checkbox" checked={todos} onChange={(e) => setTodos(e.target.checked)} /> Ver también los que ya no están en activo</label>
      {data && data.length === 0 ? <Empty>Todavía no hay comerciales.</Empty> : (
        <Table clickable={editar}>
          <thead>
            <tr><th>Código</th><th>Nombre</th><th>Tipo</th><th>Zona</th><th className="num">Clientes</th><th className="num">Pedidos abiertos</th><th className="num">Facturado mes</th><th className="num">Comisión mes</th><th className="num">Facturado año</th><th className="num">Comisión año</th></tr>
          </thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.id} className={r.active ? undefined : "inactive"} onClick={() => editar && setF({ ...(Object.fromEntries(Object.keys(BLANK).map((k) => [k, r[k] === null || r[k] === undefined ? (BLANK as any)[k] : k === "commission_pct" ? String(Number(r[k])) : r[k]])) as F), id: r.id })}>
                <td><Code>{r.code}</Code></td><td>{r.name}</td><td>{r.kind === "agent" ? "Representante" : "Plantilla"}</td><td>{r.zone}</td>
                <td className="num">{r.customers}</td>
                <td className="num">{r.open_orders}</td>
                <td className="num">{eur(r.billed_month)}</td><td className="num">{eur(r.commission_month)} <small className="muted">{pct(r.commission_pct)}</small></td>
                <td className="num">{eur(r.billed_year)}</td><td className="num">{eur(r.commission_year)}</td>
              </tr>
            ))}
          </tbody>
          {data && data.length > 1 && (
            <tfoot>
              <tr><td colSpan={6}>Total</td><td className="num">{eur(total("billed_month"))}</td><td className="num">{eur(total("commission_month"))}</td><td className="num">{eur(total("billed_year"))}</td><td className="num">{eur(total("commission_year"))}</td></tr>
            </tfoot>
          )}
        </Table>
      )}
      <p className="hint">La comisión se calcula sobre la base de lo facturado de los pedidos de cada comercial. El comercial de un pedido se toma de la ficha del cliente y se puede cambiar en el pedido.</p>
    </Page>
  );
}
