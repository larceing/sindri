import { useEffect, useState } from "react";
import { api, post, sinVacios } from "../api";
import { useAction, useData } from "../hooks";
import { useSession } from "../session";
import { Code, ErrorBox, Field, Page, Table } from "../ui";

const BLANK = { name: "", trade_name: "", tax_id: "", address: "", city: "", postal_code: "", gs1_prefix: "" };
type F = typeof BLANK;

function CompanyForm({ f, setF, nifFijo }: { f: F; setF: (f: F) => void; nifFijo?: boolean }) {
  const set = (k: keyof F) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="form">
      <Field label="Razón social"><input value={f.name} onChange={set("name")} /></Field>
      <Field label="Nombre comercial"><input value={f.trade_name} onChange={set("trade_name")} /></Field>
      <Field label="NIF"><input value={f.tax_id} onChange={set("tax_id")} disabled={nifFijo} /></Field>
      <Field label="Dirección"><input value={f.address} onChange={set("address")} /></Field>
      <Field label="Población"><input value={f.city} onChange={set("city")} /></Field>
      <Field label="Código postal"><input value={f.postal_code} onChange={set("postal_code")} /></Field>
      <Field label="Prefijo GS1 (para SSCC)"><input value={f.gs1_prefix} onChange={set("gs1_prefix")} /></Field>
    </div>
  );
}

export function CompanyPage() {
  const { me, reload: reloadMe, puede } = useSession();
  const { data, reload } = useData("/company");
  const { data: companies, reload: reloadList } = useData<any[]>(me?.admin ? "/companies" : null);
  const [f, setF] = useState(BLANK);
  const [nueva, setNueva] = useState<F | null>(null);
  const { run, error, busy } = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) setF(Object.fromEntries(Object.keys(BLANK).map((k) => [k, data[k] ?? ""])) as F);
  }, [data]);
  const save = () =>
    run(async () => {
      await api("/company", { method: "PUT", body: sinVacios(f) });
      setSaved(true);
      await reload();
      await reloadMe();
    });
  const crear = () =>
    run(async () => {
      await post("/companies", sinVacios(nueva!));
      setNueva(null);
      await reloadList();
      await reloadMe();
    });
  return (
    <Page title="Empresa">
      <p className="hint">Datos del emisor de las facturas de la empresa en uso. El NIF no se puede cambiar una vez emitida la primera factura.</p>
      <CompanyForm f={f} setF={setF} nifFijo={!!data} />
      <ErrorBox error={error} />
      {puede("empresa") && (
        <div className="row">
          <button className="primary" onClick={save} disabled={busy}>Guardar</button>
          {saved && <span className="ok">Guardado</span>}
        </div>
      )}
      {me?.admin && companies && (
        <>
          <h2>Empresas del grupo</h2>
          <p className="hint">Cada empresa lleva sus clientes, productos, pedidos, facturas, numeración y su cadena VERI*FACTU por separado. Quien trabaja en varias elige una al entrar.</p>
          <Table>
            <thead><tr><th>Razón social</th><th>Nombre comercial</th><th>NIF</th><th>Población</th></tr></thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id}><td>{c.name}{c.id === me.company ? " (en uso)" : ""}</td><td>{c.trade_name}</td><td><Code>{c.tax_id}</Code></td><td>{c.city}</td></tr>
              ))}
            </tbody>
          </Table>
          {nueva ? (
            <div className="card">
              <h2>Nueva empresa</h2>
              <CompanyForm f={nueva} setF={setNueva} />
              <div className="row">
                <button className="primary" onClick={crear} disabled={busy || !nueva.name || !nueva.tax_id}>Crear empresa</button>
                <button onClick={() => setNueva(null)}>Cancelar</button>
              </div>
            </div>
          ) : (
            <div className="row"><button onClick={() => setNueva(BLANK)}>Añadir empresa</button></div>
          )}
        </>
      )}
    </Page>
  );
}
