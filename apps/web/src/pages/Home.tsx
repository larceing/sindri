import { eur } from "../api";
import { navigate } from "../router";
import { useData } from "../hooks";
import { Alert, Badge, Code, Empty, Page, Table } from "../ui";

/** Inicio: "lo que me toca hoy". Cifras grandes solo para lo que exige acción. */
export function HomePage() {
  const { data: orders } = useData<any[]>("/sales-orders");
  const { data: invoices } = useData<any[]>("/invoices");
  const { data: vf } = useData<any[]>("/verifactu/records");
  const toDeliver = orders?.filter((o) => o.state === "confirmed") ?? [];
  const toInvoice = orders?.filter((o) => o.state === "delivered") ?? [];
  const unpaid = invoices?.filter((i) => i.state === "issued") ?? [];
  const pendingAmount = unpaid.reduce((a, i) => a + Number(i.amount_due), 0);
  const month = new Date().toISOString().slice(0, 7);
  const billed = (invoices ?? []).filter((i) => i.issue_date?.startsWith(month)).reduce((a, i) => a + Number(i.untaxed), 0);
  const unsent = vf?.filter((r) => r.send_state !== "sent").length ?? 0;
  const tasks = [...toDeliver.map((o) => ({ ...o, task: "Entregar" })), ...toInvoice.map((o) => ({ ...o, task: "Facturar" }))];
  return (
    <Page title="Inicio">
      <div className="kpis">
        <div className="kpi"><span>Facturado este mes (base)</span><b>{eur(billed)}</b></div>
        <div className="kpi"><span>Pendiente de cobro</span><b>{eur(pendingAmount)}</b></div>
        <div className="kpi"><span>Pedidos por entregar</span><b>{toDeliver.length}</b></div>
        <div className="kpi"><span>Pedidos por facturar</span><b>{toInvoice.length}</b></div>
      </div>
      {unsent > 0 && (
        <Alert tone="info">
          {unsent} registro(s) VERI*FACTU esperan envío a la AEAT. Se enviarán solos cuando haya conexión.
        </Alert>
      )}
      <h2>Lo que toca hoy</h2>
      {tasks.length === 0 ? (
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
