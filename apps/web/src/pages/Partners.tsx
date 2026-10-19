import { useEffect, useState } from "react";
import { del, eur, fecha, patch, post, put, sinVacios, vaciosANull } from "../api";
import { navigate } from "../router";
import { useAction, useData } from "../hooks";
import { useSession } from "../session";
import { Alert, Badge, Code, Empty, ErrorBox, Field, Page, Table } from "../ui";
import { RelacionesBoton } from "./Relaciones";

const KIND: Record<string, string> = { customer: "Cliente", supplier: "Proveedor", both: "Cliente y proveedor" };
export const FORMAS_PAGO = ["Transferencia", "Recibo domiciliado", "Contado", "Confirming", "Pagaré", "Tarjeta"];

const BLANK = {
  kind: "customer", code: "", name: "", trade_name: "", tax_id: "", email: "", phone: "", mobile: "", website: "",
  address: "", postal_code: "", city: "", province: "", country: "ES",
  sales_rep_id: "", payment_method: "", payment_days: "", credit_limit: "", discount_pct: "", iban: "",
  surcharge_regime: false, withholding_rate: "0", route_zone: "", delivery_notes: "", notes: "",
};
type PF = typeof BLANK;

const toForm = (p: Record<string, any>): PF =>
  Object.fromEntries(
    Object.entries(BLANK).map(([k, d]) => {
      const v = p[k];
      if (typeof d === "boolean") return [k, !!v];
      if (v === null || v === undefined) return [k, d === "ES" || d === "0" || d === "customer" ? d : ""];
      // Los importes llegan con 2-4 decimales («5.00»): en el formulario, sin ceros de más.
      if (["credit_limit", "discount_pct", "withholding_rate"].includes(k)) return [k, String(Number(v))];
      return [k, String(v)];
    }),
  ) as PF;

/** Lo que se manda: los días de pago como número; en alta sin vacíos, en edición vacío = borrar. */
const toBody = (f: PF, alta: boolean) => {
  const b: Record<string, unknown> = { ...f, payment_days: f.payment_days === "" ? "" : Number(f.payment_days), withholding_rate: f.withholding_rate || "0" };
  if (!b.country) delete b.country;
  return alta ? sinVacios(b) : vaciosANull(b);
};

function PartnerForm({ f, setF, disabled }: { f: PF; setF: (f: PF) => void; disabled?: boolean }) {
  const { data: reps } = useData<any[]>("/sales-reps");
  const set = (k: keyof PF) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <fieldset className="plain" disabled={disabled}>
      <h3>Datos generales</h3>
      <div className="form">
        <Field label="Código"><input value={f.code} onChange={set("code")} placeholder="Opcional" /></Field>
        <Field label="Razón social *"><input value={f.name} onChange={set("name")} /></Field>
        <Field label="Nombre comercial"><input value={f.trade_name} onChange={set("trade_name")} /></Field>
        <Field label="NIF / CIF"><input value={f.tax_id} onChange={set("tax_id")} /></Field>
        <Field label="Tipo">
          <select value={f.kind} onChange={set("kind")}>
            {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Teléfono"><input value={f.phone} onChange={set("phone")} inputMode="tel" /></Field>
        <Field label="Móvil"><input value={f.mobile} onChange={set("mobile")} inputMode="tel" /></Field>
        <Field label="Email"><input value={f.email} onChange={set("email")} type="email" /></Field>
        <Field label="Web"><input value={f.website} onChange={set("website")} /></Field>
      </div>
      <h3>Dirección fiscal</h3>
      <div className="form">
        <Field label="Dirección"><input value={f.address} onChange={set("address")} /></Field>
        <Field label="Código postal"><input value={f.postal_code} onChange={set("postal_code")} inputMode="numeric" /></Field>
        <Field label="Población"><input value={f.city} onChange={set("city")} /></Field>
        <Field label="Provincia"><input value={f.province} onChange={set("province")} /></Field>
        <Field label="País (código)"><input value={f.country} onChange={set("country")} maxLength={2} /></Field>
      </div>
      <h3>Condiciones comerciales</h3>
      <div className="form">
        <Field label="Comercial / representante">
          <select value={f.sales_rep_id} onChange={set("sales_rep_id")}>
            <option value="">Sin asignar</option>
            {reps?.map((r) => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}
          </select>
        </Field>
        <Field label="Forma de pago">
          <select value={f.payment_method} onChange={set("payment_method")}>
            <option value="">—</option>
            {FORMAS_PAGO.map((m) => <option key={m}>{m}</option>)}
            {f.payment_method && !FORMAS_PAGO.includes(f.payment_method) && <option>{f.payment_method}</option>}
          </select>
        </Field>
        <Field label="Días de pago"><input value={f.payment_days} onChange={set("payment_days")} inputMode="numeric" placeholder="p. ej. 30" /></Field>
        <Field label="Límite de crédito (€)"><input value={f.credit_limit} onChange={set("credit_limit")} inputMode="decimal" /></Field>
        <Field label="Descuento habitual %"><input value={f.discount_pct} onChange={set("discount_pct")} inputMode="decimal" /></Field>
        <Field label="IBAN (domiciliación)"><input value={f.iban} onChange={set("iban")} /></Field>
        <Field label="Retención IRPF %"><input value={f.withholding_rate} onChange={set("withholding_rate")} inputMode="decimal" /></Field>
        <label className="check">
          <input type="checkbox" checked={f.surcharge_regime} onChange={(e) => setF({ ...f, surcharge_regime: e.target.checked })} />
          Recargo de equivalencia
        </label>
      </div>
      <h3>Reparto y notas</h3>
      <div className="form">
        <Field label="Zona de reparto"><input value={f.route_zone} onChange={set("route_zone")} placeholder="Para agrupar en hojas de ruta" /></Field>
        <Field label="Indicaciones para el reparto"><input value={f.delivery_notes} onChange={set("delivery_notes")} placeholder="Muelle, horario, avisar antes…" /></Field>
      </div>
      <Field label="Notas internas"><textarea value={f.notes} onChange={set("notes")} rows={3} /></Field>
    </fieldset>
  );
}

export function PartnersPage() {
  const [q, setQ] = useState("");
  const { data } = useData<any[]>(`/partners${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  const [f, setF] = useState(BLANK);
  const [open, setOpen] = useState(false);
  const { run, error, busy } = useAction();
  const { puede } = useSession();
  const create = () =>
    run(async () => {
      const p = await post("/partners", toBody(f, true));
      navigate(`/clientes/${p.id}`);
    });
  return (
    <Page title="Clientes y proveedores" actions={puede("clientes") && !open && <button className="primary" onClick={() => setOpen(true)}>Nuevo cliente</button>}>
      {open && (
        <div className="card">
          <h2>Nueva ficha</h2>
          <PartnerForm f={f} setF={setF} />
          <ErrorBox error={error} />
          <div className="row">
            <button className="primary" onClick={create} disabled={busy || !f.name}>Crear ficha</button>
            <button onClick={() => { setOpen(false); setF(BLANK); }}>Cancelar</button>
          </div>
        </div>
      )}
      <input className="search" placeholder="Buscar por nombre, código o NIF" value={q} onChange={(e) => setQ(e.target.value)} />
      {data && data.length === 0 ? (
        <Empty>{q ? "Nada coincide con la búsqueda." : "Todavía no hay clientes."}</Empty>
      ) : (
        <Table clickable>
          <thead><tr><th>Código</th><th>Nombre</th><th>NIF</th><th>Tipo</th><th>Población</th><th>Teléfono</th><th>Comercial</th></tr></thead>
          <tbody>
            {data?.map((p) => (
              <tr key={p.id} tabIndex={0} onClick={() => navigate(`/clientes/${p.id}`)} onKeyDown={(e) => e.key === "Enter" && navigate(`/clientes/${p.id}`)}>
                <td><Code>{p.code}</Code></td>
                <td>{p.trade_name ? <>{p.trade_name} <small className="muted">{p.name}</small></> : p.name}</td>
                <td><Code>{p.tax_id}</Code></td>
                <td>{KIND[p.kind]}</td>
                <td>{p.city}</td>
                <td>{p.phone ?? p.mobile}</td>
                <td>{p.sales_rep_name}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}

const C_BLANK = { name: "", position: "", email: "", phone: "", notes: "" };
const A_BLANK = { label: "", address: "", postal_code: "", city: "", province: "", phone: "", schedule: "", is_default: false };

/** Precio propio del cliente para algunos productos o servicios (p. ej. su tarifa por hora). */
function TarifasCliente({ p, editar, reload }: { p: any; editar: boolean; reload: () => Promise<unknown> }) {
  const { data: productos } = useData<any[]>(editar ? "/products" : null);
  const [nueva, setNueva] = useState<{ product_id: string; unit_price: string } | null>(null);
  const { run, error, busy } = useAction();
  const guardar = (productId: string, precio: string) =>
    run(async () => {
      await put(`/partners/${p.id}/prices/${productId}`, { unit_price: precio });
      setNueva(null);
      await reload();
    });
  const quitar = (productId: string) =>
    run(async () => {
      await del(`/partners/${p.id}/prices/${productId}`);
      await reload();
    });
  return (
    <div className="card">
      <div className="card-head">
        <h2>Tarifas propias</h2>
        {editar && !nueva && <button onClick={() => setNueva({ product_id: "", unit_price: "" })}>Añadir tarifa</button>}
      </div>
      <p className="hint">
        El precio de este cliente para un producto o servicio: sale solo en sus presupuestos, pedidos y en lo que llega por facturar sin precio.
        {p.discount_pct ? ` Encima se aplica su descuento habitual (${Number(p.discount_pct)} %).` : " Su descuento habitual, si le pones uno en la ficha, se aplica encima."}
      </p>
      <ErrorBox error={error} />
      {nueva && (
        <div className="subform">
          <div className="form">
            <Field label="Producto o servicio *">
              <select value={nueva.product_id} onChange={(e) => setNueva({ ...nueva, product_id: e.target.value })}>
                <option value="">Elige…</option>
                {(productos ?? []).map((x) => <option key={x.id} value={x.id}>{x.sku} · {x.name}</option>)}
              </select>
            </Field>
            <Field label="Precio para este cliente *"><input value={nueva.unit_price} onChange={(e) => setNueva({ ...nueva, unit_price: e.target.value })} inputMode="decimal" /></Field>
          </div>
          <div className="row">
            <button className="primary" onClick={() => guardar(nueva.product_id, nueva.unit_price)} disabled={busy || !nueva.product_id || !nueva.unit_price}>Guardar tarifa</button>
            <button onClick={() => setNueva(null)}>Cancelar</button>
          </div>
        </div>
      )}
      {p.prices.length === 0 ? <Empty>Usa la tarifa general de cada producto.</Empty> : (
        <Table>
          <thead><tr><th>Producto o servicio</th><th className="num">Tarifa general</th><th className="num">Para este cliente</th>{editar && <th />}</tr></thead>
          <tbody>
            {p.prices.map((t: any) => (
              <tr key={t.product_id}>
                <td><Code>{t.sku}</Code> {t.name}</td>
                <td className="num">{eur(t.sale_price)}{t.uom && t.uom !== "ud" ? ` / ${t.uom}` : ""}</td>
                <td className="num"><b>{eur(t.unit_price)}</b>{t.uom && t.uom !== "ud" ? ` / ${t.uom}` : ""}</td>
                {editar && <td className="acts">
                  <button className="link" onClick={() => setNueva({ product_id: t.product_id, unit_price: String(Number(t.unit_price)) })}>Cambiar</button>
                  <button className="link" onClick={() => quitar(t.product_id)}>Quitar</button>
                </td>}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

export function PartnerPage({ id }: { id: string }) {
  const { data: p, reload, error: loadError } = useData(`/partners/${id}`);
  const { puede } = useSession();
  const editar = puede("clientes");
  const [f, setF] = useState(BLANK);
  const [saved, setSaved] = useState(false);
  const [contact, setContact] = useState<(typeof C_BLANK & { id?: string }) | null>(null);
  const [addr, setAddr] = useState<(typeof A_BLANK & { id?: string }) | null>(null);
  const { run, error, busy } = useAction();
  useEffect(() => {
    if (p) setF(toForm(p));
  }, [p]);
  if (!p) return <Page title="Ficha de cliente"><ErrorBox error={loadError} /></Page>;

  const save = () =>
    run(async () => {
      await patch(`/partners/${id}`, toBody(f, false));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      await reload();
    });
  const archive = () =>
    run(async () => {
      if (!confirm(`¿Archivar la ficha de ${p.name}? Deja de salir en listas y pedidos nuevos; su historial se conserva.`)) return;
      await post(`/partners/${id}/archive`);
      navigate("/clientes");
    });
  const saveContact = () =>
    run(async () => {
      const { id: cid, ...body } = contact!;
      if (cid) await patch(`/partners/${id}/contacts/${cid}`, vaciosANull(body));
      else await post(`/partners/${id}/contacts`, sinVacios(body));
      setContact(null);
      await reload();
    });
  const saveAddr = () =>
    run(async () => {
      const { id: aid, ...body } = addr!;
      if (aid) await patch(`/partners/${id}/addresses/${aid}`, vaciosANull(body));
      else await post(`/partners/${id}/addresses`, sinVacios(body));
      setAddr(null);
      await reload();
    });
  const remove = (what: "contacts" | "addresses", sub: string) =>
    run(async () => {
      await del(`/partners/${id}/${what}/${sub}`);
      await reload();
    });
  const pick = <T extends Record<string, unknown>>(blank: T, row: Record<string, any>) =>
    ({ ...Object.fromEntries(Object.keys(blank).map((k) => [k, row[k] ?? blank[k]])), id: row.id }) as T & { id: string };

  return (
    <Page
      title={p.trade_name || p.name}
      actions={<>
        <RelacionesBoton tipo="cliente" id={id} />
        {p.kind !== "supplier" && puede("pedidos") && <button className="primary" onClick={() => navigate(`/pedidos/nuevo?cliente=${id}`)}>Nuevo pedido</button>}
        {editar && <button className="danger" onClick={archive} disabled={busy}>Archivar</button>}
      </>}
    >
      <p className="sub">
        {p.code && <><Code>{p.code}</Code> · </>}{p.name}{p.tax_id && <> · NIF <Code>{p.tax_id}</Code></>}
        {p.sales_rep_name && <> · Comercial: {p.sales_rep_name}</>}
      </p>
      <div className="kpis">
        <div className="kpi"><span>Pedidos</span><b>{p.stats.orders}</b></div>
        <div className="kpi"><span>Facturado este año (base)</span><b>{eur(p.stats.billed_year)}</b></div>
        <div className="kpi"><span>Pendiente de cobro</span><b>{eur(p.stats.pending)}</b></div>
        {p.credit_limit && <div className="kpi"><span>Límite de crédito</span><b>{eur(p.credit_limit)}</b></div>}
      </div>
      {p.credit_limit && Number(p.stats.pending) > Number(p.credit_limit) && (
        <Alert tone="aviso">El pendiente de cobro supera el límite de crédito.</Alert>
      )}
      <ErrorBox error={error} />

      <div className="card">
        <h2>Datos de la ficha</h2>
        <PartnerForm f={f} setF={setF} disabled={!editar} />
        {editar && (
          <div className="row">
            <button className="primary" onClick={save} disabled={busy || !f.name}>Guardar cambios</button>
            {saved && <span className="ok">Guardado</span>}
          </div>
        )}
      </div>

      {p.kind !== "supplier" && <TarifasCliente p={p} editar={editar} reload={reload} />}

      <div className="card">
        <div className="card-head">
          <h2>Personas de contacto</h2>
          {editar && !contact && <button onClick={() => setContact({ ...C_BLANK })}>Añadir contacto</button>}
        </div>
        {contact && (
          <div className="subform">
            <div className="form">
              <Field label="Nombre *"><input value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} /></Field>
              <Field label="Cargo"><input value={contact.position} onChange={(e) => setContact({ ...contact, position: e.target.value })} /></Field>
              <Field label="Teléfono"><input value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} /></Field>
              <Field label="Email"><input value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} /></Field>
              <Field label="Notas"><input value={contact.notes} onChange={(e) => setContact({ ...contact, notes: e.target.value })} /></Field>
            </div>
            <div className="row">
              <button className="primary" onClick={saveContact} disabled={busy || !contact.name}>Guardar contacto</button>
              <button onClick={() => setContact(null)}>Cancelar</button>
            </div>
          </div>
        )}
        {p.contacts.length === 0 ? <Empty>Sin contactos.</Empty> : (
          <Table>
            <thead><tr><th>Nombre</th><th>Cargo</th><th>Teléfono</th><th>Email</th><th>Notas</th>{editar && <th />}</tr></thead>
            <tbody>
              {p.contacts.map((c: any) => (
                <tr key={c.id}>
                  <td>{c.name}</td><td>{c.position}</td><td>{c.phone}</td><td>{c.email}</td><td className="wrap">{c.notes}</td>
                  {editar && <td className="acts"><button className="link" onClick={() => setContact(pick(C_BLANK, c))}>Editar</button><button className="link" onClick={() => remove("contacts", c.id)}>Quitar</button></td>}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Direcciones de entrega</h2>
          {editar && !addr && <button onClick={() => setAddr({ ...A_BLANK, is_default: p.addresses.length === 0 })}>Añadir dirección</button>}
        </div>
        <p className="hint">La dirección habitual sale sola en los pedidos nuevos. Sin ninguna, se entrega en la dirección fiscal.</p>
        {addr && (
          <div className="subform">
            <div className="form">
              <Field label="Nombre *"><input value={addr.label} onChange={(e) => setAddr({ ...addr, label: e.target.value })} placeholder="Almacén central, Tienda…" /></Field>
              <Field label="Dirección"><input value={addr.address} onChange={(e) => setAddr({ ...addr, address: e.target.value })} /></Field>
              <Field label="Código postal"><input value={addr.postal_code} onChange={(e) => setAddr({ ...addr, postal_code: e.target.value })} /></Field>
              <Field label="Población"><input value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} /></Field>
              <Field label="Provincia"><input value={addr.province} onChange={(e) => setAddr({ ...addr, province: e.target.value })} /></Field>
              <Field label="Teléfono"><input value={addr.phone} onChange={(e) => setAddr({ ...addr, phone: e.target.value })} /></Field>
              <Field label="Horario de descarga"><input value={addr.schedule} onChange={(e) => setAddr({ ...addr, schedule: e.target.value })} placeholder="L-V 8:00-13:00" /></Field>
              <label className="check"><input type="checkbox" checked={addr.is_default} onChange={(e) => setAddr({ ...addr, is_default: e.target.checked })} /> Dirección habitual</label>
            </div>
            <div className="row">
              <button className="primary" onClick={saveAddr} disabled={busy || !addr.label}>Guardar dirección</button>
              <button onClick={() => setAddr(null)}>Cancelar</button>
            </div>
          </div>
        )}
        {p.addresses.length === 0 ? <Empty>Sin direcciones de entrega.</Empty> : (
          <Table>
            <thead><tr><th>Nombre</th><th>Dirección</th><th>Población</th><th>Teléfono</th><th>Horario</th>{editar && <th />}</tr></thead>
            <tbody>
              {p.addresses.map((a: any) => (
                <tr key={a.id}>
                  <td>{a.label}{a.is_default && <span className="tag">Habitual</span>}</td><td className="wrap">{a.address}</td>
                  <td>{[a.postal_code, a.city].filter(Boolean).join(" ")}</td><td>{a.phone}</td><td>{a.schedule}</td>
                  {editar && <td className="acts"><button className="link" onClick={() => setAddr(pick(A_BLANK, a))}>Editar</button><button className="link" onClick={() => remove("addresses", a.id)}>Quitar</button></td>}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      <div className="split2">
        <div>
          <h2>Últimos pedidos</h2>
          {p.orders.length === 0 ? <Empty>Sin pedidos.</Empty> : (
            <Table clickable>
              <thead><tr><th>Número</th><th className="num">Fecha</th><th className="num">Base</th><th>Estado</th></tr></thead>
              <tbody>
                {p.orders.map((o: any) => (
                  <tr key={o.id} onClick={() => navigate(`/pedidos/${o.id}`)}>
                    <td><Code>{o.number}</Code></td><td className="num">{fecha(o.order_date)}</td><td className="num">{eur(o.untaxed)}</td><td><Badge state={o.state} /></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
        <div>
          <h2>Últimas facturas</h2>
          {p.invoices.length === 0 ? <Empty>Sin facturas.</Empty> : (
            <Table clickable>
              <thead><tr><th>Número</th><th className="num">Fecha</th><th className="num">Total</th><th>Estado</th></tr></thead>
              <tbody>
                {p.invoices.map((i: any) => (
                  <tr key={i.id} onClick={() => navigate(`/facturas/${i.id}`)}>
                    <td><Code>{i.number ?? "Borrador"}</Code></td><td className="num">{fecha(i.issue_date)}</td><td className="num">{eur(i.total)}</td><td><Badge state={i.state} /></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </div>
    </Page>
  );
}
