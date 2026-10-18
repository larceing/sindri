import { useEffect, useState } from "react";
import { api } from "../api";
import { useAction, useData } from "../hooks";
import { ErrorBox, Field, Page } from "../ui";

export function CompanyPage() {
  const { data, reload } = useData("/company");
  const [f, setF] = useState({ name: "", tax_id: "", address: "", city: "", postal_code: "", gs1_prefix: "" });
  const { run, error, busy } = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) setF({ name: data.name ?? "", tax_id: data.tax_id ?? "", address: data.address ?? "", city: data.city ?? "", postal_code: data.postal_code ?? "", gs1_prefix: data.gs1_prefix ?? "" });
  }, [data]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = () =>
    run(async () => {
      const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ""));
      await api("/company", { method: "PUT", body });
      setSaved(true);
      await reload();
    });
  return (
    <Page title="Empresa">
      <p className="hint">Datos del emisor de las facturas. El NIF no se puede cambiar una vez emitida la primera factura.</p>
      <div className="form">
        <Field label="Razón social"><input value={f.name} onChange={set("name")} /></Field>
        <Field label="NIF"><input value={f.tax_id} onChange={set("tax_id")} disabled={!!data} /></Field>
        <Field label="Dirección"><input value={f.address} onChange={set("address")} /></Field>
        <Field label="Población"><input value={f.city} onChange={set("city")} /></Field>
        <Field label="Código postal"><input value={f.postal_code} onChange={set("postal_code")} /></Field>
        <Field label="Prefijo GS1 (para SSCC)"><input value={f.gs1_prefix} onChange={set("gs1_prefix")} /></Field>
      </div>
      <ErrorBox error={error} />
      <div className="row">
        <button className="primary" onClick={save} disabled={busy}>Guardar</button>
        {saved && <span className="ok">Guardado</span>}
      </div>
    </Page>
  );
}
