import { useEffect, useState } from "react";
import { api, post, sinVacios } from "../api";
import { useAction, useData } from "../hooks";
import { useSession } from "../session";
import { Code, ErrorBox, Field, Page, Table } from "../ui";

const BLANK = { code: "", name: "", trade_name: "", tax_id: "", address: "", city: "", postal_code: "", gs1_prefix: "", demo: "" };
type F = typeof BLANK;
const cuerpo = (f: F) => ({ ...sinVacios({ ...f, demo: undefined }), demo: f.demo === "1" });

function CompanyForm({ f, setF, nifFijo }: { f: F; setF: (f: F) => void; nifFijo?: boolean }) {
  const set = (k: keyof F) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="form">
      <Field label="Código"><input value={f.code} onChange={set("code")} placeholder="El siguiente libre (001, 002…)" /></Field>
      <Field label="Tipo">
        <select value={f.demo} onChange={set("demo")}>
          <option value="">Empresa real</option>
          <option value="1">Demostración o pruebas (abierta a todos)</option>
        </select>
      </Field>
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
    if (data) setF(Object.fromEntries(Object.keys(BLANK).map((k) => [k, k === "demo" ? (data.demo ? "1" : "") : data[k] ?? ""])) as F);
  }, [data]);
  const save = () =>
    run(async () => {
      await api("/company", { method: "PUT", body: cuerpo(f) });
      setSaved(true);
      await reload();
      await reloadMe();
    });
  const crear = () =>
    run(async () => {
      await post("/companies", cuerpo(nueva!));
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
            <thead><tr><th>Código</th><th>Razón social</th><th>Nombre comercial</th><th>NIF</th><th>Población</th></tr></thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id}><td><Code>{c.code}</Code></td><td>{c.name}{c.id === me.company ? " (en uso)" : ""}{c.demo && <span className="tag tag-aviso">DEMO</span>}</td><td>{c.trade_name}</td><td><Code>{c.tax_id}</Code></td><td>{c.city}</td></tr>
              ))}
            </tbody>
          </Table>
          {data && <DatosEmpresa empresa={data} />}
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

type Resultado = {
  probar: boolean;
  clientes: { creados: number; actualizados: number };
  productos: { creados: number; actualizados: number };
  modelos: { creados: number; actualizados: number };
  avisos: string[];
};

const cuenta = (n: { creados: number; actualizados: number }, que: string) =>
  `${que}: ${n.creados} ${n.creados === 1 ? "nuevo" : "nuevos"}, ${n.actualizados} ${n.actualizados === 1 ? "ya estaba" : "ya estaban"} (se actualiza${n.actualizados === 1 ? "" : "n"})`;

/** Llevar los datos de la empresa en uso a otra instalación (DEV → PRO) o traerlos de otra app. */
function DatosEmpresa({ empresa }: { empresa: { code?: string; name: string } }) {
  const [fichero, setFichero] = useState<{ nombre: string; datos: unknown } | null>(null);
  const [prueba, setPrueba] = useState<Resultado | null>(null);
  const [hecho, setHecho] = useState<Resultado | null>(null);
  const { run, error, busy } = useAction();
  const elegir = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setPrueba(null);
    setHecho(null);
    run(async () => {
      let datos: unknown;
      try {
        datos = JSON.parse(await f.text());
      } catch {
        throw new Error("Ese fichero no es un .json válido");
      }
      setFichero({ nombre: f.name, datos });
      setPrueba(await post<Resultado>("/datos/importar?probar=1", datos));
    });
  };
  const importar = () =>
    run(async () => {
      setHecho(await post<Resultado>("/datos/importar", fichero!.datos));
      setPrueba(null);
      setFichero(null);
    });
  return (
    <div className="card">
      <h2>Llevar y traer datos</h2>
      <p className="hint">
        Clientes (con contactos y direcciones), productos y modelos de presupuesto de la empresa en uso, en un fichero .json.
        Sirve para pasar a PRO lo que has preparado en DEV o para traer los clientes del Gestor de incidencias.
        Importar nunca borra: añade lo que falta y actualiza lo que ya hay (clientes por NIF, productos por referencia).
        Pedidos y facturas no viajan: la numeración y la cadena VERI*FACTU son de cada instalación.
      </p>
      <div className="row">
        <a className="button" href="./api/v1/datos/exportar" download>Descargar los datos de {empresa.code ? `${empresa.code} · ` : ""}{empresa.name}</a>
        <label className="button">
          Importar un fichero…
          <input type="file" accept=".json,application/json" onChange={elegir} hidden disabled={busy} />
        </label>
      </div>
      <ErrorBox error={error} />
      {prueba && fichero && (
        <div className="alert"><div>
          <p><b>{fichero.nombre}</b>: esto es lo que haría en {empresa.name} (todavía no se ha guardado nada).</p>
          <ul>
            <li>{cuenta(prueba.clientes, "Clientes")}</li>
            <li>{cuenta(prueba.productos, "Productos")}</li>
            <li>{cuenta(prueba.modelos, "Modelos de presupuesto")}</li>
            {prueba.avisos.map((a) => <li key={a}>{a}</li>)}
          </ul>
          <div className="row">
            <button className="primary" onClick={importar} disabled={busy}>Importar</button>
            <button onClick={() => { setPrueba(null); setFichero(null); }} disabled={busy}>Cancelar</button>
          </div>
        </div></div>
      )}
      {hecho && (
        <p className="ok">
          Importado. {cuenta(hecho.clientes, "Clientes")}. {cuenta(hecho.productos, "Productos")}. {cuenta(hecho.modelos, "Modelos")}.
          {hecho.avisos.length ? ` Avisos: ${hecho.avisos.join(" ")}` : ""}
        </p>
      )}
    </div>
  );
}
