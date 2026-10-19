import { useState } from "react";
import { eur, fecha, post, qty } from "../api";
import { navigate } from "../router";
import { useAction, useData } from "../hooks";
import { useSession } from "../session";
import { Alert, Code, Empty, ErrorBox, Page, Table } from "../ui";

/**
 * Lo que mandan otras apps (horas de incidencias, de tareas…) para facturar. Se elige lo de un
 * cliente y se pasa a un pedido en borrador; de ahí sigue el camino de siempre hasta la factura.
 */
export function ToInvoicePage() {
  const [vista, setVista] = useState<"pending" | "discarded">("pending");
  const { data, reload } = useData<any[]>(`/por-facturar${vista === "discarded" ? "?state=discarded" : ""}`);
  const { puede } = useSession();
  const editar = puede("pedidos");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const { run, error, busy } = useAction();
  const elegidos = data?.filter((i) => sel.has(i.id)) ?? [];
  const clientes = new Set(elegidos.map((i) => i.partner_id));
  const total = elegidos.reduce((a, i) => a + Number(i.amount), 0);
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const deCliente = (pid: string) => setSel(new Set(data!.filter((i) => i.partner_id === pid).map((i) => i.id)));
  const accion = (que: "pedido" | "descartar" | "recuperar") =>
    run(async () => {
      const r = await post(`/por-facturar/${que}`, { ids: [...sel] });
      setSel(new Set());
      if (que === "pedido") navigate(`/pedidos/${r.id}`);
      else await reload();
    });
  // Agrupado por cliente, con su total.
  const grupos = new Map<string, any[]>();
  data?.forEach((i) => grupos.set(i.partner_id, [...(grupos.get(i.partner_id) ?? []), i]));
  return (
    <Page title="Por facturar" actions={<button onClick={() => navigate("/pedidos")}>Pedidos</button>}>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={vista === "pending"} className={vista === "pending" ? "active" : ""} onClick={() => { setSel(new Set()); setVista("pending"); }}>Pendiente</button>
        <button role="tab" aria-selected={vista === "discarded"} className={vista === "discarded" ? "active" : ""} onClick={() => { setSel(new Set()); setVista("discarded"); }}>Descartado</button>
      </div>
      <p className="hint">Lo mandan otras apps conectadas a esta empresa (Empresa → Integraciones). Elige lo de un cliente y pásalo a un pedido.</p>
      <ErrorBox error={error} />
      {editar && sel.size > 0 && (
        <div className="row">
          {vista === "pending" ? (
            <>
              <button className="primary" disabled={busy || clientes.size !== 1} onClick={() => accion("pedido")}>Crear pedido ({sel.size} · {eur(total)})</button>
              <button className="danger" disabled={busy} onClick={() => accion("descartar")}>Descartar</button>
            </>
          ) : (
            <button disabled={busy} onClick={() => accion("recuperar")}>Volver a pendiente</button>
          )}
          {clientes.size > 1 && <Alert tone="aviso">Has elegido de varios clientes: cada pedido es de uno.</Alert>}
        </div>
      )}
      {data && data.length === 0 ? <Empty>{vista === "pending" ? "No hay nada pendiente de facturar." : "No hay nada descartado."}</Empty> : (
        [...grupos.entries()].map(([pid, items]) => (
          <section key={pid}>
            <h2>
              {items[0].partner_name} · {eur(items.reduce((a, i) => a + Number(i.amount), 0))}
              {editar && <> <button className="link" onClick={() => deCliente(pid)}>Elegir todo</button></>}
            </h2>
            <Table>
              <thead><tr><th /><th className="num">Fecha</th><th>Origen</th><th>Concepto</th><th>Producto</th><th className="num">Cantidad</th><th className="num">Precio</th><th className="num">Importe</th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} onClick={() => editar && toggle(i.id)}>
                    <td>{editar && <input type="checkbox" aria-label="Elegir" checked={sel.has(i.id)} onChange={() => toggle(i.id)} onClick={(e) => e.stopPropagation()} />}</td>
                    <td className="num">{fecha(i.item_date)}</td><td>{i.source} <Code>{i.external_ref}</Code></td><td className="wrap">{i.description}</td>
                    <td><Code>{i.sku}</Code></td><td className="num">{qty(i.quantity, 2)} {i.uom}</td><td className="num">{eur(i.price)}</td><td className="num">{eur(i.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </section>
        ))
      )}
    </Page>
  );
}
