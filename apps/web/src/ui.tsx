import type { ReactNode } from "react";
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

export const ErrorBox = ({ error }: { error: string | null | undefined }) => (error ? <div className="error">{error}</div> : null);

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
