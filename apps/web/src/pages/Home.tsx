import { eur } from "../api";
import { navigate } from "../router";
import { useData } from "../hooks";
import { useSession } from "../session";
import { Alert, Badge, Code, Empty, Page, Table } from "../ui";

/** Inicio: "lo que me toca hoy". Cifras grandes solo para lo que exige acción. */
export function HomePage() {
  const { me, empresa } = useSession();
  const can = (m: string) => !!me?.perms[m];
  const { data: orders } = useData<any[]>(can("pedidos") ? "/sales-orders" : null);
  const { data: invoices } = useData<any[]>(can("facturas") ? "/invoices" : null);
  const { data: vf } = useData<any[]>(can("verifactu") ? "/verifactu/records" : null);
  const { data: routes } = useData<any[]>(can("rutas") ? "/routes" : null);
  const today = new Date().toISOString().slice(0, 10);
  const routesToday = routes?.filter((r) => r.state !== "closed" && r.route_date?.slice(0, 10) <= today) ?? [];
  const toDeliver = orders?.filter((o) => o.state === "confirmed") ?? [];
  const toInvoice = orders?.filter((o) => o.state === "delivered") ?? [];
  const unpaid = invoices?.filter((i) => i.state === "issued") ?? [];
  const pendingAmount = unpaid.reduce((a, i) => a + Number(i.pending ?? i.amount_due), 0);
  const month = new Date().toISOString().slice(0, 7);
  const billed = (invoices ?? []).filter((i) => (i.state === "issued" || i.state === "paid") && i.issue_date?.startsWith(month)).reduce((a, i) => a + Number(i.untaxed), 0);
  const unsent = vf?.filter((r) => r.send_state !== "sent").length ?? 0;
  const tasks = [...toDeliver.map((o) => ({ ...o, task: "Entregar" })), ...toInvoice.map((o) => ({ ...o, task: "Facturar" }))];
  return (
    <Page title={empresa ? `Inicio · ${empresa.trade_name || empresa.name}` : "Inicio"}>
      <div className="kpis">
        {invoices && <div className="kpi"><span>Facturado este mes (base)</span><b>{eur(billed)}</b></div>}
        {invoices && <div className="kpi"><span>Pendiente de cobro</span><b>{eur(pendingAmount)}</b></div>}
        {orders && <div className="kpi"><span>Pedidos por entregar</span><b>{toDeliver.length}</b></div>}
        {orders && <div className="kpi"><span>Pedidos por facturar</span><b>{toInvoice.length}</b></div>}
        {routes && <div className="kpi"><span>Hojas de ruta abiertas</span><b>{routesToday.length}</b></div>}
      </div>
      {unsent > 0 && (
        <Alert tone="info">
          {unsent} registro(s) VERI*FACTU esperan envío a la AEAT. Se enviarán solos cuando haya conexión.
        </Alert>
      )}
      {routesToday.length > 0 && (
        <>
          <h2>Repartos</h2>
          <Table clickable>
            <thead><tr><th>Hoja</th><th>Conductor</th><th>Zona</th><th className="num">Paradas</th><th>Estado</th></tr></thead>
            <tbody>
              {routesToday.map((r) => (
                <tr key={r.id} tabIndex={0} onClick={() => navigate(`/rutas/${r.id}`)}>
                  <td><Code>{r.number}</Code></td><td>{r.driver}</td><td>{r.zone}</td><td className="num">{r.delivered}/{r.stops}</td>
                  <td>{r.state === "on_route" ? "En ruta" : "Preparando"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
      {!orders && !invoices && !routes && <Empty>Tu rol no tiene tareas que enseñar aquí. Usa el menú para ir a tu parte de Sindri.</Empty>}
      {orders && <h2>Lo que toca hoy</h2>}
      {!orders ? null : tasks.length === 0 ? (
        <Empty>No hay pedidos pendientes de entregar ni de facturar.</Empty>
      ) : (
        <Table clickable>
          <thead><tr><th>Tarea</th><th>Pedido</th><th>Cliente</th><th className="num">Base</th><th>Estado</th></tr></thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id + t.task} tabIndex={0} onClick={() => navigate(`/pedidos/${t.id}`)} onKeyDown={(e) => e.key === "Enter" && navigate(`/pedidos/${t.id}`)}>
                <td>{t.task}</td><td><Code>{t.number}</Code></td><td>{t.partner_name}</td><td className="num">{eur(t.untaxed)}</td><td><Badge state={t.state} /></td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}
