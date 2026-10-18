import { useState } from "react";
import { fecha, post } from "../api";
import { useAction, useData } from "../hooks";
import { useSession } from "../session";
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
  const { data: docs } = useData("/documentos");
  const { puede } = useSession();
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [ver, setVer] = useState<string | null>(null);
  const qs = (formato?: string) => new URLSearchParams(Object.fromEntries(Object.entries({ formato, desde, hasta }).filter(([, v]) => v)) as Record<string, string>).toString();
  const { data: rows, error: rowsError } = useData<any[]>(ver ? `/informes/datos/${ver}?${qs()}` : null);
  return (
    <Page title="Informes">
      <div className="card">
        <h2>Documentos en PDF (Report Server)</h2>
        {!docs ? null : !docs.report_server ? (
          <Alert tone="info">
            Sindri no tiene Report Server configurado: facturas, pedidos, albaranes y hojas de ruta se imprimen con el navegador.
            Para sacarlos en PDF con vuestras plantillas, pon <Code>REPORT_URL</Code> y <Code>REPORT_LLAVE</Code> en la configuración de Sindri (ver docs/report-server).
          </Alert>
        ) : docs.error ? (
          <Alert tone="error">{docs.error}. Revisa REPORT_URL y la llave.</Alert>
        ) : (
          <Table>
            <thead><tr><th>Documento</th><th>Plantilla</th><th>Estado</th></tr></thead>
            <tbody>
              {PLANTILLAS.map(([p, l]) => (
                <tr key={p}>
                  <td>{l}</td><td><Code>{p}</Code></td>
                  <td>{docs.plantillas.includes(p) ? <span className="ok">Lista</span> : <span className="muted">Falta importarla en el Report Server: se imprime con el navegador</span>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>

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
