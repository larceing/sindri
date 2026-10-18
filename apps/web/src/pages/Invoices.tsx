import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { eur, post, qty } from "../api";
import { navigate } from "../router";
import { useAction, useData } from "../hooks";
import { Badge, Empty, ErrorBox, Field, Page } from "../ui";
import { Totals } from "./Orders";

export function InvoicesPage() {
  const { data } = useData<any[]>("/invoices");
  return (
    <Page title="Facturas">
      {data && data.length === 0 ? <Empty>Las facturas se crean desde un pedido entregado.</Empty> : (
        <table className="clickable">
          <thead><tr><th>Número</th><th>Fecha</th><th>Cliente</th><th className="num">Total</th><th>Estado</th></tr></thead>
          <tbody>
            {data?.map((i) => (
              <tr key={i.id} onClick={() => navigate(`/facturas/${i.id}`)}>
                <td>{i.number ?? "(borrador)"}</td><td>{i.issue_date}</td><td>{i.partner_name}</td><td className="num">{eur(i.amount_due)}</td><td><Badge state={i.state} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

function Qr({ url }: { url: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    // El QR se genera en local: no hace falta internet.
    void QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 1, width: 160 }).then(setSrc);
  }, [url]);
  return src ? <img src={src} alt="QR VERI*FACTU" width={160} height={160} /> : null;
}

export function InvoicePage({ id }: { id: string }) {
  const { data: inv, reload, error: loadError } = useData(`/invoices/${id}`);
  const { data: company } = useData("/company");
  const { run, error, busy } = useAction();
  const [amount, setAmount] = useState("");
  if (!inv) return <Page title="Factura"><ErrorBox error={loadError} /></Page>;
  const issue = () => run(async () => { await post(`/invoices/${id}/issue`); await reload(); });
  const pay = () => run(async () => { await post(`/invoices/${id}/payments`, { amount: amount || inv.pending }); setAmount(""); await reload(); });
  return (
    <Page
      title={inv.number ? `Factura ${inv.number}` : "Factura (borrador)"}
      actions={<>
        {inv.actions.includes("issue") && <button className="primary" disabled={busy} onClick={issue}>Emitir factura</button>}
        <button onClick={() => window.print()}>Imprimir</button>
      </>}
    >
      <div className="invoice">
        <div className="invoice-head">
          <div>
            {company && (
              <p className="issuer">
                <b>{company.name}</b><br />NIF {company.tax_id}
                {company.address && <><br />{company.address}</>}
                {(company.postal_code || company.city) && <><br />{[company.postal_code, company.city].filter(Boolean).join(" ")}</>}
              </p>
            )}
            <p><Badge state={inv.state} /> {inv.issue_date && `· Fecha de expedición ${inv.issue_date}`}</p>
            <p>Cliente:<br /><b>{inv.partner_snapshot?.name ?? inv.partner_name}</b><br />{inv.partner_snapshot?.tax_id && `NIF ${inv.partner_snapshot.tax_id}`}
              {inv.partner_snapshot?.address && <><br />{inv.partner_snapshot.address}</>}
              {(inv.partner_snapshot?.postal_code || inv.partner_snapshot?.city) && <><br />{[inv.partner_snapshot?.postal_code, inv.partner_snapshot?.city].filter(Boolean).join(" ")}</>}
            </p>
          </div>
          {inv.verifactu && (
            <div className="qr">
              <Qr url={inv.verifactu.qr_url} />
              <small>VERI*FACTU</small>
            </div>
          )}
        </div>
        <table>
          <thead><tr><th>Descripción</th><th className="num">Cantidad</th><th className="num">Precio</th><th className="num">Dto.</th><th className="num">IVA</th><th className="num">Base</th></tr></thead>
          <tbody>
            {inv.lines.map((l: any) => (
              <tr key={l.id}>
                <td>{l.description}</td><td className="num">{qty(l.quantity)}</td><td className="num">{eur(l.unit_price)}</td>
                <td className="num">{Number(l.discount_pct) ? `${Number(l.discount_pct)}%` : ""}</td><td className="num">{Number(l.vat_rate)}%</td><td className="num">{eur(l.base)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Totals t={{ untaxed: inv.untaxed, withholding: inv.withholding, total: inv.total, amountDue: inv.amount_due, breakdown: inv.tax_breakdown }} />
      </div>
      <ErrorBox error={error} />
      {inv.verifactu && (
        <p className="hint mono">Huella: {inv.verifactu.hash}<br />Anterior: {inv.verifactu.previous_hash || "(primer registro)"}</p>
      )}
      {inv.state !== "draft" && (
        <div className="card">
          <h2>Cobros</h2>
          {inv.payments.length === 0 ? <Empty>Sin cobros.</Empty> : (
            <ul>{inv.payments.map((p: any) => <li key={p.id}>{p.paid_on}: {eur(p.amount)}</li>)}</ul>
          )}
          <p>Pendiente: <b>{eur(inv.pending)}</b></p>
          {inv.state === "issued" && (
            <div className="row">
              <Field label="Importe"><input value={amount} placeholder={inv.pending} onChange={(e) => setAmount(e.target.value)} /></Field>
              <button className="primary" onClick={pay} disabled={busy}>Registrar cobro</button>
            </div>
          )}
        </div>
      )}
    </Page>
  );
}
