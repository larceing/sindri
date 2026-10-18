import { useEffect, useState } from "react";
import { FileDown, Printer } from "lucide-react";
import { api } from "./api";

/** Plantilla del Report Server para cada documento (docs/report-server/). */
const PLANTILLA = { factura: "sindri-factura", pedido: "sindri-pedido", albaran: "sindri-albaran", hoja_ruta: "sindri-hoja-ruta" } as const;
export type TipoDocumento = keyof typeof PLANTILLA;

let estado: Promise<{ report_server: boolean; plantillas: string[] }> | null = null;
const cargar = () => (estado ??= api("/documentos").catch(() => ({ report_server: false, plantillas: [] })));

/**
 * Botón de documento: con el Report Server configurado y su plantilla importada saca el PDF;
 * si no, imprime la pantalla con el navegador.
 */
export function DocButton({ tipo, id, label, primary }: { tipo: TipoDocumento; id: string; label: string; primary?: boolean }) {
  const [pdf, setPdf] = useState(false);
  useEffect(() => {
    void cargar().then((e) => setPdf(e.report_server && e.plantillas.includes(PLANTILLA[tipo])));
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
