import { useData } from "../hooks";
import { Badge, Empty, Page } from "../ui";

export function VerifactuPage() {
  const { data } = useData<any[]>("/verifactu/records");
  const { data: check } = useData("/verifactu/verify");
  return (
    <Page title="VERI*FACTU">
      <p className="hint">
        Cada factura emitida genera un registro con una huella encadenada a la anterior. Los envíos a la AEAT se
        guardan en la bandeja de salida y se hacen cuando hay conexión.
      </p>
      {check && (
        <div className={check.ok ? "ok-box" : "error"}>
          {check.ok ? `Cadena íntegra: ${check.records} registros verificados.` : `Cadena rota en el registro ${check.firstBrokenSeq}.`}
        </div>
      )}
      {data && data.length === 0 ? <Empty>Aún no hay registros.</Empty> : (
        <table>
          <thead><tr><th>#</th><th>Factura</th><th>Tipo</th><th>Huella</th><th>Envío AEAT</th></tr></thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.seq}><td>{r.seq}</td><td>{r.number}</td><td>{r.kind}</td><td className="mono">{r.hash.slice(0, 16)}…</td><td><Badge state={r.send_state ?? "pending"} /></td></tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
