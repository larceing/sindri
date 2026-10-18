import { useState } from "react";
import { api, fecha, post } from "../api";
import { useAction, useData } from "../hooks";
import { useSession } from "../session";
import { olvidarDocumentos } from "../docs";
import { Alert, Code, Empty, ErrorBox, Field, Page, Table } from "../ui";

const PLANTILLAS = [
  ["sindri-factura", "Factura"],
  ["sindri-pedido", "Pedido"],
  ["sindri-albaran", "Albarán"],
  ["sindri-hoja-ruta", "Hoja de ruta"],
];

const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

export function ReportsPage() {
  const { data: sets } = useData<{ id: string; label: string }[]>("/informes");
  const { puede } = useSession();
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [ver, setVer] = useState<string | null>(null);
  const qs = (formato?: string) => new URLSearchParams(Object.fromEntries(Object.entries({ formato, desde, hasta }).filter(([, v]) => v)) as Record<string, string>).toString();
  const { data: rows, error: rowsError } = useData<any[]>(ver ? `/informes/datos/${ver}?${qs()}` : null);
  return (
    <Page title="Informes">
      <ReportServer />

      <h2>Datos para informes</h2>
      <p className="hint">Datos de la empresa en uso, para Excel o cualquier herramienta de informes. CSV con punto y coma (se abre directo en Excel).</p>
      <div className="row">
        <Field label="Desde"><input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></Field>
        <Field label="Hasta"><input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></Field>
      </div>
      <Table>
        <thead><tr><th>Datos</th><th>Descargar</th><th /></tr></thead>
        <tbody>
          {sets?.map((s) => (
            <tr key={s.id}>
              <td>{s.label}</td>
              <td className="acts">
                {["csv", "xml", "json"].map((f) => <a key={f} href={`./api/v1/informes/datos/${s.id}?${qs(f)}`} download={`${s.id}.${f}`}>{f.toUpperCase()}</a>)}
              </td>
              <td><button className="link" onClick={() => setVer(ver === s.id ? null : s.id)}>{ver === s.id ? "Ocultar" : "Ver aquí"}</button></td>
            </tr>
          ))}
        </tbody>
      </Table>
      {ver && (
        <>
          <h3>{sets?.find((s) => s.id === ver)?.label}{rows && ` · ${rows.length} fila(s)`}</h3>
          <ErrorBox error={rowsError} />
          {rows && rows.length === 0 ? <Empty>Sin datos en ese periodo.</Empty> : rows && (
            <Table>
              <thead><tr>{Object.keys(rows[0]).map((k) => <th key={k}>{k}</th>)}</tr></thead>
              <tbody>{rows.slice(0, 200).map((r, i) => <tr key={i}>{Object.values(r).map((v, j) => <td key={j}>{cell(v)}</td>)}</tr>)}</tbody>
            </Table>
          )}
          {rows && rows.length > 200 && <p className="hint">Se ven las 200 primeras; la descarga lleva todas.</p>}
        </>
      )}
      {puede("informes") && <Readers />}
    </Page>
  );
}

/** Lectores: acceso de solo lectura para una herramienta externa (Power BI, Metabase, Excel…). */
function Readers() {
  const { data, reload } = useData<any[]>("/informes/lectores");
  const [name, setName] = useState("");
  const [nuevo, setNuevo] = useState<{ name: string; token: string } | null>(null);
  const { run, error, busy } = useAction();
  const base = new URL("./api/informes/v1/", window.location.href).href;
  return (
    <div className="card">
      <h2>Acceso para herramientas de informes</h2>
      <p className="hint">
        Cada lector tiene un token propio, solo lee y solo ve esta empresa. Dirección: <Code>{base}</Code>&lt;datos&gt;?formato=csv, con
        la cabecera <Code>Authorization: Bearer …</Code> o <Code>?token=…</Code>.
      </p>
      {nuevo && (
        <Alert tone="ok">
          Token de «{nuevo.name}» (cópialo ahora, no se vuelve a enseñar):<br />
          <Code>{nuevo.token}</Code>
        </Alert>
      )}
      <div className="row">
        <Field label="Nombre del lector"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Power BI dirección" /></Field>
        <button className="primary" disabled={busy || !name.trim()} onClick={() => run(async () => { setNuevo(await post("/informes/lectores", { name })); setName(""); await reload(); })}>Crear lector</button>
      </div>
      <ErrorBox error={error} />
      {data && data.length > 0 && (
        <Table>
          <thead><tr><th>Lector</th><th>Token</th><th>Creado por</th><th className="num">Creado</th><th className="num">Último uso</th><th /></tr></thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id} className={r.revoked_at ? "inactive" : undefined}>
                <td>{r.name}</td><td><Code>…{r.token_hint}</Code></td><td>{r.created_by}</td><td className="num">{fecha(r.created_at)}</td><td className="num">{fecha(r.last_used_at)}</td>
                <td>{r.revoked_at ? `Revocado ${fecha(r.revoked_at)}` : <button className="link" onClick={() => run(async () => { await post(`/informes/lectores/${r.id}/revocar`); await reload(); })}>Revocar</button>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

/** Conexión con el Report Server: dirección y llave, probadas antes de guardarlas. */
function ReportServer() {
  const { me } = useSession();
  const { data: docs, reload } = useData("/documentos");
  const { data: con, reload: reloadCon } = useData(me?.admin ? "/documentos/conexion" : null);
  const [f, setF] = useState<{ url: string; llave: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const { run, error, busy } = useAction();
  const recargar = async () => { olvidarDocumentos(); await reload(); await reloadCon(); };
  const guardar = () =>
    run(async () => {
      const r = await api("/documentos/conexion", { method: "PUT", body: { url: f!.url, llave: f!.llave } });
      setF(null);
      setOk(`Conectado. Plantillas de Sindri encontradas: ${r.plantillas.length} de ${PLANTILLAS.length}.`);
      await recargar();
    });
  const quitar = () =>
    run(async () => {
      if (!confirm("¿Desconectar Sindri del Report Server? Los documentos volverán a imprimirse con el navegador.")) return;
      await api("/documentos/conexion", { method: "DELETE" });
      setOk(null);
      await recargar();
    });
  const editable = me?.admin && con && con.origen !== "variables";
  return (
    <div className="card">
      <div className="card-head">
        <h2>Documentos en PDF (Report Server)</h2>
        {editable && !f && <button onClick={() => { setOk(null); setF({ url: con.url ?? "", llave: "" }); }}>{con.origen ? "Cambiar conexión" : "Conectar"}</button>}
      </div>
      {f ? (
        <>
          <p className="hint">
            En el Report Server, entra en <b>Llaves</b> y crea una para la app <Code>sindri</Code>; cópiala aquí. La dirección es la del
            Report Server por la red interna del servidor (la que pone su README, «Cómo genera una app»); también vale la pública si se
            llega a ella desde el servidor. Sindri la prueba antes de guardarla.
          </p>
          <div className="form">
            <Field label="Dirección del Report Server"><input value={f.url} placeholder="http://…:3000" onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
            <Field label={con?.llave_fin ? `Llave (vacía = seguir con …${con.llave_fin})` : "Llave (rs_…)"}>
              <input value={f.llave} type="password" autoComplete="off" placeholder="rs_…" onChange={(e) => setF({ ...f, llave: e.target.value })} />
            </Field>
          </div>
          <ErrorBox error={error} />
          <div className="row">
            <button className="primary" disabled={busy || !f.url || (!f.llave && !con?.llave_fin)} onClick={guardar}>{busy ? "Probando…" : "Probar y guardar"}</button>
            <button onClick={() => setF(null)}>Cancelar</button>
          </div>
        </>
      ) : !docs ? null : !docs.report_server ? (
        <Alert tone="info">
          Sindri no está conectado al Report Server: facturas, pedidos, albaranes y hojas de ruta se imprimen con el navegador.
          {me?.admin ? " Pulsa «Conectar» y pon la dirección y la llave." : " Pídele a administración que lo conecte."}
        </Alert>
      ) : (
        <>
          {ok && <Alert tone="ok">{ok}</Alert>}
          {docs.error && <Alert tone="error">{docs.error}.</Alert>}
          {con?.origen && (
            <p className="hint">
              Conectado a <Code>{con.url}</Code> con la llave …{con.llave_fin}
              {con.origen === "variables" ? " (viene del app.env del servidor; se cambia ahí)." : "."}
            </p>
          )}
          <Table>
            <thead><tr><th>Documento</th><th>Plantilla</th><th>Estado</th></tr></thead>
            <tbody>
              {PLANTILLAS.map(([p, l]) => (
                <tr key={p}>
                  <td>{l}</td><td><Code>{p}</Code></td>
                  <td>{docs.plantillas.includes(p) ? <span className="ok">Lista</span> : <span className="muted">Falta importarla en el Report Server (docs/report-server): mientras, se imprime con el navegador</span>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {editable && <div className="row"><button className="danger" onClick={quitar} disabled={busy}>Desconectar</button></div>}
          {!f && <ErrorBox error={error} />}
        </>
      )}
    </div>
  );
}
