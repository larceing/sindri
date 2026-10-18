import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from "lucide-react";
import { STATE_LABEL } from "./api";

export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="page">
      <header className="page-head">
        <h1>{title}</h1>
        <div className="row">{actions}</div>
      </header>
      {children}
    </section>
  );
}

type Tone = "error" | "ok" | "aviso" | "info";
const ICON = { error: OctagonAlert, ok: CheckCircle2, aviso: AlertTriangle, info: Info } as const;

/** Mensaje con color + forma de icono + texto: el color nunca es el único canal. */
export function Alert({ tone, children }: { tone: Tone; children: ReactNode }) {
  const Icon = ICON[tone];
  return (
    <div className={`alert alert-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon size={18} aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export const ErrorBox = ({ error }: { error: string | null | undefined }) => (error ? <Alert tone="error">{error}</Alert> : null);

export const Badge = ({ state }: { state: string }) => <span className={`badge badge-${state}`}>{STATE_LABEL[state] ?? state}</span>;

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;

export const Table = ({ children, clickable }: { children: ReactNode; clickable?: boolean }) => (
  <div className="table-wrap">
    <table className={clickable ? "clickable" : undefined}>{children}</table>
  </div>
);

/** Códigos (referencias, lotes, NIF, números de documento): monoespaciada y sin agrupar. */
export const Code = ({ children }: { children: ReactNode }) => <span className="code">{children}</span>;
