import { useData } from "../hooks";
import { Alert, Badge, Empty, Page, Table, Code } from "../ui";

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
        <Alert tone={check.ok ? "ok" : "error"}>
          {check.ok ? `Cadena íntegra: ${check.records} registros verificados.` : `Cadena rota en el registro ${check.firstBrokenSeq}.`}
        </Alert>
      )}
      {data && data.length === 0 ? <Empty>Aún no hay registros.</Empty> : (
        <Table>
          <thead><tr><th className="num">Nº</th><th>Factura</th><th>Tipo</th><th>Huella</th><th>Envío AEAT</th></tr></thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.seq}><td className="num">{r.seq}</td><td><Code>{r.number}</Code></td><td>{r.kind === "alta" ? "Alta" : "Anulación"}</td><td><Code>{r.hash.slice(0, 16)}…</Code></td><td><Badge state={r.send_state ?? "pending"} /></td></tr>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}
