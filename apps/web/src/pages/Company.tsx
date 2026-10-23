import { useEffect, useState } from "react";
import { api, del, eur, post, sinVacios } from "../api";
import { useAction, useData } from "../hooks";
import { useSession } from "../session";
import { Code, ErrorBox, Field, Page, Table } from "../ui";
import { IntegrationKeys, MailSettings } from "./Integrations";

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
      {data && (me?.admin || me?.company_admin) && <ClaveEmpresa empresa={data} onSaved={async () => { await reload(); await reloadMe(); }} />}
      {me?.admin && companies && (
        <>
          <h2>Empresas del grupo</h2>
          <p className="hint">
            Cada empresa lleva sus presupuestos, pedidos, facturas, numeración, stock y su cadena VERI*FACTU por separado. Los clientes, productos, tarifas y
            modelos de presupuesto pueden ser comunes a varias. Quien trabaja en varias elige una al entrar.
          </p>
          <Table>
            <thead><tr><th>Código</th><th>Razón social</th><th>Nombre comercial</th><th>NIF</th><th>Clientes y productos</th><th>Acceso</th><th>Contraseña</th></tr></thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id}>
                  <td><Code>{c.code}</Code></td>
                  <td>{c.name}{c.id === me.company ? " (en uso)" : ""}{c.demo && <span className="tag tag-aviso">DEMO</span>}</td>
                  <td>{c.trade_name}</td>
                  <td><Code>{c.tax_id}</Code></td>
                  <td>{c.master_company_id ? `Los de ${companies.find((m) => m.id === c.master_company_id)?.name ?? "otra empresa"}` : "Propios"}</td>
                  <td>{c.restricted ? "Reservada" : "Normal"}</td>
                  <td>
                    {c.has_password ? (
                      <>
                        Sí{" "}
                        <button className="link" title="Si se ha olvidado: la quita sin saberla (queda en el registro)" onClick={() => run(async () => { await del(`/companies/${c.id}/password`); await reloadList(); await reloadMe(); })}>
                          Quitar
                        </button>
                      </>
                    ) : (
                      "No"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {data && <Compartir empresa={data} companies={companies} onSaved={async () => { await reload(); await reloadList(); await reloadMe(); }} />}
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
      {me?.admin && data && (
        <>
          <MailSettings />
          <IntegrationKeys />
        </>
      )}
    </Page>
  );
}

/**
 * Con quién comparte la empresa en uso clientes y productos, y si es reservada. Las reservadas
 * solo las ve quien esté en su grupo de Keycloak (<grupo de Sindri>/Empresa/<código>), también
 * quien administra.
 */
/** Contraseña que pide la empresa al elegirla. Para cambiarla o quitarla hay que saber la actual. */
function ClaveEmpresa({ empresa, onSaved }: { empresa: any; onSaved: () => Promise<void> }) {
  const [actual, setActual] = useState("");
  const [nueva, setNueva] = useState("");
  const [repetir, setRepetir] = useState("");
  const [hecho, setHecho] = useState<string | null>(null);
  const { run, error, busy } = useAction();
  const tiene = !!empresa.has_password;
  const guardar = (quitar: boolean) =>
    run(async () => {
      await api("/company/password", { method: "PUT", body: { ...(tiene ? { actual } : {}), nueva: quitar ? null : nueva } });
      setActual("");
      setNueva("");
      setRepetir("");
      setHecho(quitar ? "Contraseña quitada" : "Contraseña guardada: quien tuviera la empresa abierta la tendrá que escribir");
      await onSaved();
    });
  return (
    <div className="card">
      <h2>Contraseña de la empresa ({empresa.name})</h2>
      <p className="hint">
        {tiene
          ? "Para trabajar en esta empresa hay que escribir su contraseña al elegirla, además de entrar con tu usuario. Para cambiarla o quitarla hace falta la actual."
          : "Si le pones contraseña, para trabajar en esta empresa habrá que escribirla al elegirla, además de entrar con el usuario."}
      </p>
      <div className="form">
        {tiene && (
          <Field label="Contraseña actual">
            <input type="password" autoComplete="current-password" value={actual} onChange={(e) => setActual(e.target.value)} />
          </Field>
        )}
        <Field label="Nueva contraseña (mínimo 8 caracteres)">
          <input type="password" autoComplete="new-password" value={nueva} onChange={(e) => setNueva(e.target.value)} />
        </Field>
        <Field label="Repite la nueva">
          <input type="password" autoComplete="new-password" value={repetir} onChange={(e) => setRepetir(e.target.value)} />
        </Field>
      </div>
      <ErrorBox error={error} />
      {nueva && repetir && nueva !== repetir && <p className="hint">Las dos contraseñas no coinciden.</p>}
      <div className="row">
        <button className="primary" onClick={() => guardar(false)} disabled={busy || nueva.length < 8 || nueva !== repetir || (tiene && !actual)}>
          {tiene ? "Cambiar contraseña" : "Poner contraseña"}
        </button>
        {tiene && <button onClick={() => guardar(true)} disabled={busy || !actual}>Quitar contraseña</button>}
        {hecho && <span className="ok">{hecho}</span>}
      </div>
    </div>
  );
}

function Compartir({ empresa, companies, onSaved }: { empresa: any; companies: any[]; onSaved: () => Promise<void> }) {
  const [master, setMaster] = useState<string>(empresa.master_company_id ?? "");
  const [reservada, setReservada] = useState<boolean>(!!empresa.restricted);
  const [aviso, setAviso] = useState<string | null>(null);
  const { run, error, busy } = useAction();
  useEffect(() => {
    setMaster(empresa.master_company_id ?? "");
    setReservada(!!empresa.restricted);
  }, [empresa]);
  const otras = companies.filter((c) => c.id !== empresa.id && !c.master_company_id);
  const guardar = (aunSinVerla = false) =>
    run(async () => {
      const body: Record<string, unknown> = { restricted: reservada };
      if ((empresa.master_company_id ?? "") !== master) body.master_company_id = master || null;
      if (aunSinVerla) body.aun_sin_verla = true;
      try {
        await api("/company/sharing", { method: "PUT", body });
        setAviso(null);
      } catch (e) {
        if ((e as { code?: string }).code === "dejarias_de_verla") return setAviso((e as Error).message);
        throw e;
      }
      await onSaved();
    });
  return (
    <div className="card">
      <h2>Compartir y reservar ({empresa.name})</h2>
      <p className="hint">
        Con clientes y productos comunes, lo que una empresa da de alta lo ve la otra; los precios de cada línea se siguen pudiendo cambiar en el documento.
        Solo se elige con la empresa vacía.
      </p>
      <div className="form">
        <Field label="Clientes, productos y tarifas">
          <select value={master} onChange={(e) => setMaster(e.target.value)}>
            <option value="">Propios de esta empresa</option>
            {otras.map((c) => <option key={c.id} value={c.id}>Los de {c.code} {c.name}</option>)}
          </select>
        </Field>
        <Field label="Acceso">
          <select value={reservada ? "1" : ""} onChange={(e) => setReservada(e.target.value === "1")}>
            <option value="">Normal: quien tenga la empresa asignada (y administración)</option>
            <option value="1">Reservada: solo su grupo de Keycloak Empresa/{empresa.code}</option>
          </select>
        </Field>
      </div>
      <ErrorBox error={error} />
      {aviso ? (
        <div className="row">
          <span className="hint">{aviso}</span>
          <button className="primary" onClick={() => guardar(true)} disabled={busy}>Reservarla igualmente</button>
          <button onClick={() => setAviso(null)}>Cancelar</button>
        </div>
      ) : (
        <div className="row"><button onClick={() => guardar()} disabled={busy}>Guardar</button></div>
      )}
    </div>
  );
}

type Resultado = {
  probar: boolean;
  clientes: { creados: number; actualizados: number };
  productos: { creados: number; actualizados: number };
  modelos: { creados: number; actualizados: number };
  tarifas?: number;
  por_facturar?: { creados: number; actualizados: number; sin_tocar: number };
  tabla?: { cliente: string; sku: string; servicio: string; uom: string; cantidad: string; precio: string | null; importe: string; elementos: number }[];
  avisos: string[];
};

const num = (v: string) => Number(v).toLocaleString("es-ES", { maximumFractionDigits: 2 });

/** Lo que entra en Pedidos → Por facturar, por cliente y servicio. */
function TablaPorFacturar({ r }: { r: Resultado }) {
  const pf = r.por_facturar;
  if (!pf || pf.creados + pf.actualizados + pf.sin_tocar === 0) return null;
  const filas = r.tabla ?? [];
  const total = filas.reduce((t, f) => t + Number(f.importe), 0);
  return (
    <>
      <p>
        Por facturar: {pf.creados} {pf.creados === 1 ? "nuevo" : "nuevos"}, {pf.actualizados} ya {pf.actualizados === 1 ? "estaba" : "estaban"} (se actualizan)
        {pf.sin_tocar ? `, ${pf.sin_tocar} ya en un pedido (no se tocan)` : ""}.
      </p>
      {filas.length > 0 && (
        <Table>
          <thead><tr><th>Cliente</th><th>Servicio</th><th className="num">Cantidad</th><th className="num">Tarifa</th><th className="num">Importe</th></tr></thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.cliente + f.sku}>
                <td>{f.cliente}</td>
                <td><Code>{f.sku}</Code> {f.servicio}</td>
                <td className="num">{num(f.cantidad)} {f.uom}</td>
                <td className="num">{f.precio === null ? "varias" : eur(f.precio)}</td>
                <td className="num">{eur(f.importe)}</td>
              </tr>
            ))}
            <tr><td colSpan={4}><b>Total sin impuestos ni descuentos</b></td><td className="num"><b>{eur(total)}</b></td></tr>
          </tbody>
        </Table>
      )}
    </>
  );
}

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
        Clientes (con contactos, direcciones y tarifas propias), productos y modelos de presupuesto de la empresa en uso, en un fichero .json.
        Sirve para pasar a PRO lo que has preparado en DEV o para traer del Gestor de incidencias los clientes, los servicios y las horas pendientes de cobrar.
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
            {!!prueba.tarifas && <li>Tarifas propias de clientes: {prueba.tarifas}</li>}
            {prueba.avisos.map((a) => <li key={a}>{a}</li>)}
          </ul>
          <TablaPorFacturar r={prueba} />
          <div className="row">
            <button className="primary" onClick={importar} disabled={busy}>Importar</button>
            <button onClick={() => { setPrueba(null); setFichero(null); }} disabled={busy}>Cancelar</button>
          </div>
        </div></div>
      )}
      {hecho && (
        <p className="ok">
          Importado. {cuenta(hecho.clientes, "Clientes")}. {cuenta(hecho.productos, "Productos")}. {cuenta(hecho.modelos, "Modelos")}.
          {hecho.por_facturar && hecho.por_facturar.creados + hecho.por_facturar.actualizados > 0 && <> Lo pendiente está en <a href="#/pedidos/por-facturar">Pedidos → Por facturar</a>.</>}
          {hecho.avisos.length ? ` Avisos: ${hecho.avisos.join(" ")}` : ""}
        </p>
      )}
    </div>
  );
}
