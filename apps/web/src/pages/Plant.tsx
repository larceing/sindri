import { useEffect, useState } from "react";
import { api, post } from "../api";
import { useAction, useData } from "../hooks";
import { Alert, Code, Empty, ErrorBox, Field, Page, Table } from "../ui";

/** Estado del tag "state": 0 parada, 1 en marcha, 2 avería (como el simulador y la mayoría de SCADA). */
const ESTADO: Record<number, [string, string]> = { 0: ["Parada", "confirmed"], 1: ["En marcha", "paid"], 2: ["Avería", "error"] };

const hace = (iso: string | null | undefined) => {
  if (!iso) return "nunca";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return new Date(iso).toLocaleString("es-ES");
};

/** Refresca cada `ms` sin parpadeo. */
function useEvery(reload: () => Promise<void>, ms: number) {
  useEffect(() => {
    const t = setInterval(() => void reload(), ms);
    return () => clearInterval(t);
  }, [reload, ms]);
}

function Machine({ m }: { m: any }) {
  const u = m.ultimos ?? {};
  const estado = u.Estado ? ESTADO[u.Estado.value] : undefined;
  const ultima = Object.values(u).map((r: any) => r.ts).sort().pop() as string | undefined;
  const otros = m.tags.filter((t: any) => t.key !== "Estado");
  return (
    <div className="card">
      <header className="page-head">
        <h2>{m.name} <Code>{m.code}</Code></h2>
        {estado ? <span className={`badge badge-${estado[1]}`}>{estado[0]}</span> : <span className="badge">Sin datos</span>}
      </header>
      {u.Alarma?.text_value ? <Alert tone="error">{u.Alarma.text_value}</Alert> : null}
      <div className="kpis">
        {otros.filter((t: any) => t.key !== "Alarma").map((t: any) => {
          const r = u[t.key];
          // Contador: el último; valor: la media del último minuto; texto: tal cual.
          const n = t.kind === "value" ? r?.avg_value : r?.value;
          const v = !r ? "—" : t.kind === "text" ? r.text_value || "—" : `${Number(n).toLocaleString("es-ES", { maximumFractionDigits: 1 })}${t.unit ? " " + t.unit : ""}`;
          return <div className="kpi" key={t.key}><span>{t.label ?? t.key}</span><b className={t.kind === "text" ? "kpi-texto" : undefined}>{v}</b></div>;
        })}
      </div>
      <p className="hint">
        {m.agent_name ? <>Agente <Code>{m.agent_name}</Code>. </> : "Sin agente asignado. "}
        Último dato {hace(ultima)}. Contadores: último valor. Medidas: media del último minuto.
      </p>
    </div>
  );
}

/** Efesto 0.2 dice cómo va cada fuente (Modbus, S7, OPC UA…): aquí, un resumen y el detalle al pasar el ratón. */
function Fuentes({ fuentes }: { fuentes: Record<string, { driver: string; ok: boolean; tags?: number; fallan?: number; error?: string | null }> }) {
  const lista = Object.entries(fuentes).filter(([, f]) => (f.tags ?? 0) > 0);
  if (!lista.length) return null;
  const bien = lista.filter(([, f]) => f.ok && !f.fallan).length;
  const detalle = lista.map(([n, f]) => `${n} (${f.driver}): ${f.ok ? (f.fallan ? `${f.fallan} de ${f.tags} tags sin leer` : "bien") : f.error || "sin conexión"}`).join("\n");
  return <> <span className={`badge ${bien === lista.length ? "badge-paid" : "badge-error"}`} title={detalle}>{bien}/{lista.length} fuentes</span></>;
}

export function PlantPage() {
  const status = useData<any[]>("/planta");
  const agents = useData<any[]>("/planta/agentes");
  useEvery(status.reload, 5000);
  useEvery(agents.reload, 15000);
  const [name, setName] = useState("");
  const [nuevo, setNuevo] = useState<{ name: string; token: string } | null>(null);
  const { run, error, busy } = useAction();

  const crear = () =>
    run(async () => {
      const a = await post("/planta/agentes", { name: name.trim() });
      setNuevo(a);
      setName("");
      await agents.reload();
    });
  const revocar = (a: any) =>
    run(async () => {
      if (!window.confirm(`¿Revocar el agente ${a.name}? Dejará de poder mandar datos.`)) return;
      await post(`/planta/agentes/${a.id}/revocar`);
      await agents.reload();
    });
  const asignar = (m: any, agent_id: string) =>
    run(async () => {
      await api("/planta/maquinas", { method: "PUT", body: { ...m, agent_id: agent_id || null, ultimos: undefined, agent_name: undefined, id: undefined } });
      await status.reload();
    });

  const activos = agents.data?.filter((a) => !a.revoked_at) ?? [];
  return (
    <Page title="Planta">
      {status.data && status.data.length === 0 && <Empty>No hay máquinas configuradas.</Empty>}
      {status.data?.map((m) => <Machine key={m.id} m={m} />)}

      <h2>Agentes de planta</h2>
      <p className="hint">
        El agente va dentro de la fábrica, lee del SCADA y manda los datos aquí. Solo lee: Sindri nunca escribe en la planta.
      </p>
      {nuevo && (
        <Alert tone="aviso">
          Token del agente <Code>{nuevo.name}</Code>. Cópialo ahora: no se vuelve a enseñar. Va en el fichero del token del agente,
          nunca en un chat ni en el repositorio.
          <pre className="mono-block">{nuevo.token}</pre>
          <button onClick={() => void navigator.clipboard?.writeText(nuevo.token)}>Copiar</button>{" "}
          <button onClick={() => setNuevo(null)}>Ya lo he guardado</button>
        </Alert>
      )}
      <ErrorBox error={error} />
      {agents.data && agents.data.length === 0 ? <Empty>Todavía no hay agentes.</Empty> : (
        <Table>
          <thead><tr><th>Nombre</th><th>Estado</th><th>Último latido</th><th>Versión</th><th className="num">Pendientes</th><th>Token</th><th /></tr></thead>
          <tbody>
            {agents.data?.map((a) => (
              <tr key={a.id}>
                <td><Code>{a.name}</Code></td>
                <td>
                  {a.revoked_at ? <span className="badge badge-cancelled">Revocado</span>
                    : a.callado ? <span className="badge badge-confirmed">Callado</span>
                    : <span className="badge badge-paid">Conectado</span>}
                  {a.last_status?.fuente_ok === false && !a.revoked_at ? <> <span className="badge badge-error">Sin SCADA</span></> : null}
                  {a.last_status?.fuentes && !a.revoked_at ? <Fuentes fuentes={a.last_status.fuentes} /> : null}
                </td>
                <td>{hace(a.last_seen_at)}</td>
                <td><Code>{a.last_version ?? "—"}</Code></td>
                <td className="num">{a.last_status?.pendientes ?? "—"}</td>
                <td><Code>…{a.token_hint}</Code></td>
                <td>{!a.revoked_at && <button onClick={() => revocar(a)} disabled={busy}>Revocar</button>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <div className="card">
        <h2>Nuevo agente</h2>
        <div className="form">
          <Field label="Nombre (p. ej. planta-dev)"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        </div>
        <button className="primary" onClick={crear} disabled={busy || !name.trim()}>Crear agente</button>
      </div>

      {status.data && status.data.length > 0 && (
        <div className="card">
          <h2>Qué agente lee cada máquina</h2>
          <div className="form">
            {status.data.map((m) => (
              <Field key={m.id} label={m.name}>
                <select value={m.agent_id ?? ""} onChange={(e) => asignar(m, e.target.value)} disabled={busy}>
                  <option value="">Ninguno</option>
                  {activos.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
            ))}
          </div>
        </div>
      )}
    </Page>
  );
}
