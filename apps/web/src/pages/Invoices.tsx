import { DocButton } from "../docs";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { eur, fecha, pct, post, qty } from "../api";
import { navigate } from "../router";
import { useAction, useData } from "../hooks";
import { Badge, Empty, ErrorBox, Field, Page, Table, Code } from "../ui";
import { Totals } from "./Orders";
import { RelacionesBoton } from "./Relaciones";

export function InvoicesPage() {
  const { data } = useData<any[]>("/invoices");
  return (
    <Page title="Facturas">
      {data && data.length === 0 ? <Empty>Las facturas se crean desde un pedido entregado.</Empty> : (
        <Table clickable>
          <thead><tr><th>Número</th><th className="num">Fecha</th><th>Cliente</th><th className="num">Total</th><th>Estado</th></tr></thead>
          <tbody>
            {data?.map((i) => (
              <tr key={i.id} onClick={() => navigate(`/facturas/${i.id}`)}>
                <td>{i.number ? <Code>{i.number}</Code> : "(borrador)"}</td><td className="num">{fecha(i.issue_date)}</td><td>{i.partner_name}</td><td className="num">{eur(i.amount_due)}</td><td><Badge state={i.state} /></td>
              </tr>
            ))}
          </tbody>
        </Table>
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
  const rectify = () => run(async () => {
    const reason = window.prompt(`Se emitirá una rectificativa que anula entera la factura ${inv.number}.${inv.payments.length ? " Sus cobros se darán por devueltos." : ""} No se puede deshacer.\n\nMotivo:`, "Factura duplicada");
    if (!reason?.trim()) return;
    const r = await post<{ id: string }>(`/invoices/${id}/rectify`, { reason: reason.trim() });
    navigate(`/facturas/${r.id}`);
  });
  return (
    <Page
      title={inv.number ? `${inv.invoice_type?.startsWith("R") ? "Rectificativa" : "Factura"} ${inv.number}` : "Factura (borrador)"}
      actions={<>
        <RelacionesBoton tipo="factura" id={id} />
        {inv.actions.includes("issue") && <button className="primary" disabled={busy} onClick={issue}>Emitir factura</button>}
        {(inv.state === "issued" || inv.state === "paid") && !inv.invoice_type?.startsWith("R") && <button disabled={busy} onClick={rectify}>Anular con rectificativa</button>}
        {inv.state === "draft" ? <button onClick={() => window.print()}>Imprimir borrador</button> : <DocButton tipo="factura" id={id} label="Imprimir" />}
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
            <p><Badge state={inv.state} /> {inv.issue_date && `· Fecha de expedición ${fecha(inv.issue_date)}`}</p>
            {inv.rectifies && <p>Rectifica la factura <a href={`#/facturas/${inv.rectifies.id}`}><Code>{inv.rectifies.number}</Code></a> (tipo R1, por diferencias){inv.rectification_reason && <>: {inv.rectification_reason}</>}</p>}
            {inv.rectified_by && <p>Anulada por la rectificativa <a href={`#/facturas/${inv.rectified_by.id}`}><Code>{inv.rectified_by.number}</Code></a></p>}
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
        <Table>
          <thead><tr><th>Descripción</th><th className="num">Cantidad</th><th className="num">Precio</th><th className="num">Dto.</th><th className="num">IVA</th><th className="num">Base</th></tr></thead>
          <tbody>
            {inv.lines.map((l: any) => (
              <tr key={l.id}>
                <td className="wrap">{l.description}</td><td className="num">{qty(l.quantity)}</td><td className="num">{eur(l.unit_price)}</td>
                <td className="num">{Number(l.discount_pct) ? pct(l.discount_pct) : ""}</td><td className="num">{pct(l.vat_rate)}</td><td className="num">{eur(l.base)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Totals t={{ untaxed: inv.untaxed, withholding: inv.withholding, total: inv.total, amountDue: inv.amount_due, breakdown: inv.tax_breakdown }} />
      </div>
      <ErrorBox error={error} />
      {inv.verifactu && (
        <p className="mono-block">Huella: {inv.verifactu.hash}<br />Anterior: {inv.verifactu.previous_hash || "(primer registro)"}</p>
      )}
      {inv.state !== "draft" && (
        <div className="card">
          <h2>Cobros</h2>
          {inv.payments.length === 0 ? <Empty>Sin cobros.</Empty> : (
            <ul>{inv.payments.map((p: any) => <li key={p.id}>{fecha(p.paid_on)}: {eur(p.amount)}</li>)}</ul>
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
