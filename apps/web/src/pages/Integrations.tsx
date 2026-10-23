import { useState } from "react";
import { api, del, fecha, post } from "../api";
import { useAction, useData } from "../hooks";
import { Alert, Code, Empty, ErrorBox, Field, Table } from "../ui";

/** Llaves para que otras apps (incidencias, tareas…) lean clientes y productos y manden lo que hay que facturar. */
export function IntegrationKeys() {
  const { data, reload } = useData<any[]>("/integraciones/llaves");
  const [nombre, setNombre] = useState<string | null>(null);
  const [nueva, setNueva] = useState<{ name: string; key: string } | null>(null);
  const { run, error, busy } = useAction();
  const crear = () =>
    run(async () => {
      const r = await post("/integraciones/llaves", { name: nombre });
      setNueva(r);
      setNombre(null);
      await reload();
    });
  const revocar = (k: any) =>
    run(async () => {
      if (!confirm(`¿Revocar la llave de ${k.name}? Esa app dejará de llegar a Sindri hasta que le pongas otra.`)) return;
      await del(`/integraciones/llaves/${k.id}`);
      await reload();
    });
  return (
    <div className="card">
      <div className="card-head">
        <h2>Integraciones</h2>
        {nombre === null && <button onClick={() => { setNueva(null); setNombre(""); }}>Nueva llave</button>}
      </div>
      <p className="hint">
        Otras apps (el gestor de incidencias, el de tareas…) usan una llave de esta empresa para leer sus clientes y productos y mandar
        lo que hay que facturar, que aparece en Pedidos → Por facturar. En la otra app van como <Code>SINDRI_URL</Code> y <Code>SINDRI_LLAVE</Code>.
      </p>
      {nueva && (
        <Alert tone="ok">
          Llave para <b>{nueva.name}</b>: <Code>{nueva.key}</Code>
          <br />Cópiala ahora en la otra app: no se vuelve a enseñar.
        </Alert>
      )}
      {nombre !== null && (
        <div className="row">
          <Field label="App que la usa"><input autoFocus value={nombre} placeholder="incidencias" onChange={(e) => setNombre(e.target.value.toLowerCase())} /></Field>
          <button className="primary" disabled={busy || nombre.trim().length < 2} onClick={crear}>Crear llave</button>
          <button onClick={() => setNombre(null)}>Cancelar</button>
        </div>
      )}
      <ErrorBox error={error} />
      {data && data.length === 0 ? <Empty>Ninguna app conectada todavía.</Empty> : (
        <Table>
          <thead><tr><th>App</th><th>Llave</th><th className="num">Creada</th><th className="num">Último uso</th><th className="num">Envíos</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {data?.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td><td><Code>…{k.key_end}</Code></td><td className="num">{fecha(k.created_at)}</td>
                <td className="num">{k.last_used_at ? fecha(k.last_used_at) : "Nunca"}</td><td className="num">{k.items}</td>
                <td>{k.revoked_at ? "Revocada" : "Activa"}</td>
                <td>{!k.revoked_at && <button className="link" disabled={busy} onClick={() => revocar(k)}>Revocar</button>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

/** Conexión con el Mail del servidor y confirmación de pedidos por correo. */
/** Correo de la empresa. Conectar o desconectar el Mail es de todo Sindri: solo administración («global»). */
export function MailSettings({ global = true }: { global?: boolean }) {
  const { data: c, reload } = useData("/correo");
  const [f, setF] = useState<{ url: string; llave: string } | null>(null);
  const { run, error, busy } = useAction();
  const guardar = () =>
    run(async () => {
      await api("/correo/conexion", { method: "PUT", body: { url: f!.url, llave: f!.llave || undefined } });
      setF(null);
      await reload();
    });
  const pedidos = (activo: boolean) => run(async () => { await api("/correo/pedidos", { method: "PUT", body: { activo } }); await reload(); });
  const quitar = () =>
    run(async () => {
      if (!confirm("¿Desconectar Sindri del Mail? Dejarán de salir las confirmaciones de pedido.")) return;
      await api("/correo/conexion", { method: "DELETE" });
      await reload();
    });
  if (!c) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Correo</h2>
        {global && !f && c.origen !== "variables" && <button onClick={() => setF({ url: c.url ?? "", llave: "" })}>{c.origen ? "Cambiar conexión" : "Conectar"}</button>}
      </div>
      {f ? (
        <>
          <p className="hint">En el Mail, entra en <b>Llaves</b>, crea una para la app <Code>sindri</Code> y cópiala aquí. Sindri la prueba antes de guardarla (sin enviar nada).</p>
          <div className="form">
            <Field label="Dirección del Mail"><input value={f.url} placeholder="http://…:3000" onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
            <Field label={c.llave_fin ? `Llave (vacía = seguir con …${c.llave_fin})` : "Llave (ml_…)"}>
              <input value={f.llave} type="password" autoComplete="off" placeholder="ml_…" onChange={(e) => setF({ ...f, llave: e.target.value })} />
            </Field>
          </div>
          <ErrorBox error={error} />
          <div className="row">
            <button className="primary" disabled={busy || !f.url || (!f.llave && !c.llave_fin)} onClick={guardar}>{busy ? "Probando…" : "Probar y guardar"}</button>
            <button onClick={() => setF(null)}>Cancelar</button>
          </div>
        </>
      ) : !c.origen ? (
        <Alert tone="info">Sindri no está conectado al Mail.{global ? " Pulsa «Conectar» para poder mandar la confirmación de los pedidos." : " Lo conecta administración."}</Alert>
      ) : (
        <>
          <p className="hint">
            Conectado a <Code>{c.url}</Code> con la llave …{c.llave_fin}
            {c.origen === "variables" ? " (viene del app.env del servidor; se cambia ahí)." : "."}
            {global && c.origen === "sindri" && <> <button className="link" onClick={quitar}>Desconectar</button></>}
          </p>
          <label className="check">
            <input type="checkbox" checked={c.pedidos} disabled={busy} onChange={(e) => pedidos(e.target.checked)} />
            Al confirmar un pedido de esta empresa, mandar la confirmación al correo del cliente, con el pedido en PDF
          </label>
          <ErrorBox error={error} />
        </>
      )}
    </div>
  );
}
