import { useState } from "react";
import { post } from "../api";
import { useAction, useData } from "../hooks";
import { Empty, ErrorBox, Field, Page } from "../ui";

const blank = { name: "", tax_id: "", email: "", phone: "", city: "", kind: "customer", surcharge_regime: false, withholding_rate: "0" };

export function PartnersPage() {
  const [q, setQ] = useState("");
  const { data, reload } = useData<any[]>(`/partners${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  const [f, setF] = useState(blank);
  const [open, setOpen] = useState(false);
  const { run, error, busy } = useAction();
  const create = () =>
    run(async () => {
      const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ""));
      await post("/partners", body);
      setF(blank);
      setOpen(false);
      await reload();
    });
  return (
    <Page title="Clientes y proveedores" actions={<button className="primary" onClick={() => setOpen(!open)}>Nuevo</button>}>
      {open && (
        <div className="card">
          <div className="form">
            <Field label="Nombre"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="NIF"><input value={f.tax_id} onChange={(e) => setF({ ...f, tax_id: e.target.value })} /></Field>
            <Field label="Tipo">
              <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
                <option value="customer">Cliente</option>
                <option value="supplier">Proveedor</option>
                <option value="both">Ambos</option>
              </select>
            </Field>
            <Field label="Email"><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Teléfono"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
            <Field label="Población"><input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
            <Field label="Retención IRPF %"><input value={f.withholding_rate} onChange={(e) => setF({ ...f, withholding_rate: e.target.value })} /></Field>
            <label className="check">
              <input type="checkbox" checked={f.surcharge_regime} onChange={(e) => setF({ ...f, surcharge_regime: e.target.checked })} />
              Recargo de equivalencia
            </label>
          </div>
          <ErrorBox error={error} />
          <button className="primary" onClick={create} disabled={busy}>Guardar</button>
        </div>
      )}
      <input className="search" placeholder="Buscar por nombre o NIF" value={q} onChange={(e) => setQ(e.target.value)} />
      {data && data.length === 0 ? (
        <Empty>Todavía no hay terceros.</Empty>
      ) : (
        <table>
          <thead><tr><th>Nombre</th><th>NIF</th><th>Tipo</th><th>Población</th><th>Régimen</th></tr></thead>
          <tbody>
            {data?.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td><td>{p.tax_id}</td>
                <td>{({ customer: "Cliente", supplier: "Proveedor", both: "Ambos" } as Record<string, string>)[p.kind]}</td>
                <td>{p.city}</td>
                <td>{p.surcharge_regime ? "Recargo eq." : ""}{Number(p.withholding_rate) ? ` IRPF ${Number(p.withholding_rate)}%` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
