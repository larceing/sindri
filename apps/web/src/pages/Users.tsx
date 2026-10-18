import { useState } from "react";
import { del, fecha, patch, post, sinVacios } from "../api";
import { navigate } from "../router";
import { useAction, useData } from "../hooks";
import { MODULOS, useSession } from "../session";
import { Alert, Code, Empty, ErrorBox, Field, Page, Table } from "../ui";

const TABS = [["", "Usuarios"], ["roles", "Roles y permisos"], ["departamentos", "Departamentos"]] as const;

export function UsersPage({ tab = "" }: { tab?: string }) {
  const { me } = useSession();
  if (!me?.admin)
    return <Page title="Usuarios"><Alert tone="aviso">Solo administración gestiona usuarios, roles y departamentos.</Alert></Page>;
  return (
    <Page title="Usuarios">
      <div className="tabs" role="tablist">
        {TABS.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => navigate(`/usuarios${t ? `/${t}` : ""}`)}>{label}</button>
        ))}
      </div>
      {tab === "roles" ? <Roles /> : tab === "departamentos" ? <Departments /> : <Users />}
    </Page>
  );
}

type UF = { id?: string; username: string; name: string; email: string; role_id: string; department_id: string; active: boolean; company_ids: string[] };

function Users() {
  const { data, reload } = useData<any[]>("/users");
  const { data: roles } = useData<any[]>("/roles");
  const { data: deps } = useData<any[]>("/departments");
  const { data: companies } = useData<any[]>("/companies");
  const [f, setF] = useState<UF | null>(null);
  const { run, error, busy } = useAction();
  const save = () =>
    run(async () => {
      const { id, username, ...b } = f!;
      const body = { ...b, role_id: b.role_id || null, department_id: b.department_id || null, name: b.name || null, email: b.email || null };
      if (id) await patch(`/users/${id}`, body);
      else await post("/users", { username, ...body });
      setF(null);
      await reload();
    });
  const cname = (id: string) => companies?.find((c) => c.id === id)?.trade_name || companies?.find((c) => c.id === id)?.name;
  return (
    <>
      <p className="hint">
        Quién entra lo decide Keycloak; aquí se decide qué hace cada uno. Quien entra por primera vez aparece solo, con el rol «Consulta».
        Para dejar a alguien listo antes de que entre, créalo con el mismo usuario que tiene en Keycloak.
      </p>
      {f ? (
        <div className="card">
          <h2>{f.id ? `Editar ${f.name || f.username}` : "Nuevo usuario"}</h2>
          <div className="form">
            <Field label="Usuario (el de Keycloak) *"><input value={f.username} disabled={!!f.id} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
            <Field label="Nombre"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Email"><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Rol">
              <select value={f.role_id} onChange={(e) => setF({ ...f, role_id: e.target.value })}>
                <option value="">Sin rol (solo Inicio)</option>
                {roles?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
            <Field label="Departamento">
              <select value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
                <option value="">—</option>
                {deps?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Puede entrar en Sindri</label>
          </div>
          {companies && companies.length > 1 && (
            <fieldset className="plain">
              <h3>Empresas en las que trabaja</h3>
              <p className="hint">Sin ninguna marcada, trabaja en todas. Con varias, elige una al entrar.</p>
              <div className="checks">
                {companies.map((c) => (
                  <label key={c.id} className="check">
                    <input type="checkbox" checked={f.company_ids.includes(c.id)} onChange={(e) => setF({ ...f, company_ids: e.target.checked ? [...f.company_ids, c.id] : f.company_ids.filter((x) => x !== c.id) })} />
                    {c.trade_name || c.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <ErrorBox error={error} />
          <div className="row">
            <button className="primary" onClick={save} disabled={busy || !f.username}>Guardar</button>
            <button onClick={() => setF(null)}>Cancelar</button>
          </div>
        </div>
      ) : (
        <div className="row"><button className="primary" onClick={() => setF({ username: "", name: "", email: "", role_id: roles?.find((r) => r.name === "Consulta")?.id ?? "", department_id: "", active: true, company_ids: [] })}>Nuevo usuario</button></div>
      )}
      {data && data.length === 0 ? <Empty>Todavía no ha entrado nadie.</Empty> : (
        <Table clickable>
          <thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Departamento</th><th>Empresas</th><th className="num">Última entrada</th><th>Estado</th></tr></thead>
          <tbody>
            {data?.map((u) => (
              <tr key={u.id} className={u.active ? undefined : "inactive"} onClick={() => setF({ id: u.id, username: u.username, name: u.name ?? "", email: u.email ?? "", role_id: u.role_id ?? "", department_id: u.department_id ?? "", active: u.active, company_ids: u.company_ids ?? [] })}>
                <td>{u.name}</td><td><Code>{u.username}</Code></td><td>{u.role_name ?? <span className="muted">Sin rol</span>}</td><td>{u.department_name}</td>
                <td className="wrap">{u.company_ids?.length ? u.company_ids.map(cname).join(", ") : <span className="muted">Todas</span>}</td>
                <td className="num">{fecha(u.last_login_at)}</td><td>{u.active ? "Activo" : "Desactivado"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}

type RF = { id?: string; name: string; description: string; permissions: Record<string, "ver" | "editar"> };

function Roles() {
  const { data, reload } = useData<any[]>("/roles");
  const [f, setF] = useState<RF | null>(null);
  const { run, error, busy } = useAction();
  const save = () =>
    run(async () => {
      const { id, ...b } = f!;
      const body = { ...b, description: b.description || null };
      if (id) await patch(`/roles/${id}`, body);
      else await post("/roles", body);
      setF(null);
      await reload();
    });
  const remove = (id: string) => run(async () => { await del(`/roles/${id}`); setF(null); await reload(); });
  const setPerm = (m: string, v: string) => {
    const p = { ...f!.permissions };
    if (v) p[m] = v as "ver" | "editar";
    else delete p[m];
    setF({ ...f!, permissions: p });
  };
  const resumen = (p: Record<string, string>) => {
    const e = MODULOS.filter((m) => p[m.id] === "editar").length;
    const v = MODULOS.filter((m) => p[m.id] === "ver").length;
    return [e && `edita ${e}`, v && `consulta ${v}`].filter(Boolean).join(", ") || "solo Inicio";
  };
  return (
    <>
      <p className="hint">Un rol dice qué partes de Sindri ve cada persona y en cuáles puede cambiar cosas. Quien tiene «Usuarios: puede cambiar» administra Sindri.</p>
      {f ? (
        <div className="card">
          <h2>{f.id ? `Rol ${f.name}` : "Nuevo rol"}</h2>
          <div className="form">
            <Field label="Nombre *"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Descripción"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          </div>
          <Table>
            <thead><tr><th>Parte de Sindri</th><th>Sin acceso</th><th>Ver</th><th>Ver y cambiar</th></tr></thead>
            <tbody>
              {MODULOS.map((m) => (
                <tr key={m.id}>
                  <td><m.icon size={16} aria-hidden className="ico" /> {m.label}</td>
                  {(["", "ver", "editar"] as const).map((v) => (
                    <td key={v}>
                      <input type="radio" name={`perm-${m.id}`} aria-label={`${m.label}: ${v || "sin acceso"}`} disabled={m.id === "inicio" && v === ""}
                        checked={(f.permissions[m.id] ?? (m.id === "inicio" ? "ver" : "")) === v} onChange={() => setPerm(m.id, v)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
          <ErrorBox error={error} />
          <div className="row">
            <button className="primary" onClick={save} disabled={busy || !f.name}>Guardar rol</button>
            <button onClick={() => setF(null)}>Cancelar</button>
            {f.id && <button className="danger" onClick={() => remove(f.id!)} disabled={busy}>Borrar rol</button>}
          </div>
        </div>
      ) : (
        <div className="row"><button className="primary" onClick={() => setF({ name: "", description: "", permissions: { inicio: "ver" } })}>Nuevo rol</button></div>
      )}
      <Table clickable>
        <thead><tr><th>Rol</th><th>Descripción</th><th>Permisos</th><th className="num">Personas</th></tr></thead>
        <tbody>
          {data?.map((r) => (
            <tr key={r.id} onClick={() => setF({ id: r.id, name: r.name, description: r.description ?? "", permissions: r.permissions ?? {} })}>
              <td>{r.name}</td><td className="wrap">{r.description}</td><td>{resumen(r.permissions ?? {})}</td><td className="num">{r.users}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

function Departments() {
  const { data, reload } = useData<any[]>("/departments");
  const [name, setName] = useState("");
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
  const { run, error, busy } = useAction();
  const go = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  return (
    <>
      <div className="row">
        <Field label="Nuevo departamento"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <button className="primary" disabled={busy || !name.trim()} onClick={() => go(async () => { await post("/departments", sinVacios({ name })); setName(""); })}>Añadir</button>
      </div>
      <ErrorBox error={error} />
      <Table>
        <thead><tr><th>Departamento</th><th className="num">Personas</th><th /></tr></thead>
        <tbody>
          {data?.map((d) => (
            <tr key={d.id}>
              <td>{edit && edit.id === d.id ? <input value={edit.name} autoFocus onChange={(e) => setEdit({ id: edit.id, name: e.target.value })} /> : d.name}</td>
              <td className="num">{d.users}</td>
              <td className="acts">
                {edit && edit.id === d.id ? (
                  <>
                    <button className="link" onClick={() => go(async () => { await patch(`/departments/${d.id}`, { name: edit.name }); setEdit(null); })}>Guardar</button>
                    <button className="link" onClick={() => setEdit(null)}>Cancelar</button>
                  </>
                ) : (
                  <>
                    <button className="link" onClick={() => setEdit({ id: d.id, name: d.name })}>Cambiar nombre</button>
                    <button className="link" onClick={() => go(() => del(`/departments/${d.id}`))}>Borrar</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
