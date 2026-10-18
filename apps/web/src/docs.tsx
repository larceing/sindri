import { useEffect, useState } from "react";
import { FileDown, Printer } from "lucide-react";
import { api } from "./api";

export type TipoDocumento = "factura" | "pedido" | "albaran" | "hoja_ruta" | "presupuesto";

type Estado = { report_server: boolean; documentos?: Partial<Record<TipoDocumento, { lista: boolean }>> };
let estado: Promise<Estado> | null = null;
/** Tras conectar o desconectar el Report Server, los botones vuelven a preguntar. */
export const olvidarDocumentos = () => {
  estado = null;
};
const cargar = () => (estado ??= api("/documentos").catch(() => ({ report_server: false })));

/**
 * Botón de documento: con el Report Server conectado y la plantilla elegida en Informes, saca el
 * PDF; si no, imprime la pantalla con el navegador.
 */
export function DocButton({ tipo, id, label, primary }: { tipo: TipoDocumento; id: string; label: string; primary?: boolean }) {
  const [pdf, setPdf] = useState(false);
  useEffect(() => {
    void cargar().then((e) => setPdf(e.report_server && !!e.documentos?.[tipo]?.lista));
  }, [tipo]);
  return pdf ? (
    <a className={`button ${primary ? "primary" : ""}`} href={`./api/v1/documentos/${tipo}/${id}/pdf`} target="_blank" rel="noopener">
      <FileDown size={16} aria-hidden /> {label} (PDF)
    </a>
  ) : (
    <button className={primary ? "primary" : undefined} onClick={() => window.print()}>
      <Printer size={16} aria-hidden /> {label}
    </button>
  );
}
