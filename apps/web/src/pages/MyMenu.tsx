import { useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff } from "lucide-react";
import { useAction } from "../hooks";
import { MENU_DEFECTO, menuDe, useSession, type Menu, type Posicion } from "../session";
import { ErrorBox, Page } from "../ui";

const POSICIONES: { id: Posicion; label: string; hint: string }[] = [
  { id: "lateral", label: "A la izquierda", hint: "Menú vertical, el de siempre" },
  { id: "superior", label: "Arriba", hint: "Barra de menú superior: más ancho para las tablas" },
  { id: "inferior", label: "Abajo", hint: "Barra inferior, cómoda en tablet y en planta" },
];

/** Cada persona coloca su menú donde quiere, lo ordena y oculta lo que no usa. */
export function MyMenuPage() {
  const { me, saveMenu } = useSession();
  const [m, setM] = useState<Menu>(me?.menu ?? MENU_DEFECTO);
  const [saved, setSaved] = useState(false);
  const { run, error, busy } = useAction();
  if (!me) return null;
  const items = menuDe(me, m, true);
  const change = (next: Menu) => {
    setM(next);
    setSaved(false);
  };
  const move = (i: number, d: number) => {
    const ids = items.map((x) => x.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    change({ ...m, orden: ids });
  };
  const toggle = (id: string) => change({ ...m, ocultos: m.ocultos.includes(id) ? m.ocultos.filter((x) => x !== id) : [...m.ocultos, id] });
  const save = (menu = m) => run(async () => { await saveMenu(menu); setM(menu); setSaved(true); });
  return (
    <Page title="Mi menú">
      <p className="hint">Así ves tú Sindri en cualquier equipo. Solo salen las partes a las que te da acceso tu rol.</p>
      <h2>Dónde va el menú</h2>
      <div className="posiciones" role="radiogroup" aria-label="Posición del menú">
        {POSICIONES.map((p) => (
          <button key={p.id} role="radio" aria-checked={m.posicion === p.id} className={`posicion ${m.posicion === p.id ? "active" : ""}`} onClick={() => change({ ...m, posicion: p.id })}>
            <span className={`mini mini-${p.id}`} aria-hidden><i /><b /></span>
            <span><b>{p.label}</b><small>{p.hint}</small></span>
          </button>
        ))}
      </div>
      <h2>Orden y qué se ve</h2>
      <ol className="menu-edit">
        {items.map((it, i) => {
          const oculto = m.ocultos.includes(it.id) && it.id !== "inicio";
          return (
            <li key={it.id} className={oculto ? "oculto" : undefined}>
              <it.icon size={18} aria-hidden />
              <span className="grow">{it.label}{oculto && <small className="muted"> · oculto</small>}</span>
              <button aria-label={`Subir ${it.label}`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={16} aria-hidden /></button>
              <button aria-label={`Bajar ${it.label}`} disabled={i === items.length - 1} onClick={() => move(i, 1)}><ArrowDown size={16} aria-hidden /></button>
              <button aria-label={oculto ? `Mostrar ${it.label}` : `Ocultar ${it.label}`} disabled={it.id === "inicio"} onClick={() => toggle(it.id)}>
                {oculto ? <><EyeOff size={16} aria-hidden /> Mostrar</> : <><Eye size={16} aria-hidden /> Ocultar</>}
              </button>
            </li>
          );
        })}
      </ol>
      <ErrorBox error={error} />
      <div className="row">
        <button className="primary" onClick={() => save()} disabled={busy}>Guardar mi menú</button>
        <button onClick={() => save(MENU_DEFECTO)} disabled={busy}>Volver al de serie</button>
        {saved && <span className="ok">Guardado</span>}
      </div>
    </Page>
  );
}
