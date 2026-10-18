import { useEffect, useRef, useState } from "react";
import { Building2, ChevronDown, LogOut, Menu as MenuIcon } from "lucide-react";
import { post } from "./api";
import { useData } from "./hooks";
import { navigate, useRoute } from "./router";
import { usePrefs, type Densidad, type Modo, type Tema } from "./prefs";
import { menuDe, nombreEmpresa, SessionProvider, useSession, type Me } from "./session";
import { Alert, Page } from "./ui";
import { HomePage } from "./pages/Home";
import { CompanyPage } from "./pages/Company";
import { PartnerPage, PartnersPage } from "./pages/Partners";
import { ProductsPage } from "./pages/Products";
import { StockPage } from "./pages/Stock";
import { NewOrderPage, OrderPage, OrdersPage } from "./pages/Orders";
import { InvoicePage, InvoicesPage } from "./pages/Invoices";
import { VerifactuPage } from "./pages/Verifactu";
import { PlantPage } from "./pages/Plant";
import { RepsPage } from "./pages/Reps";
import { RoutePage, RoutesPage } from "./pages/Routes";
import { UsersPage } from "./pages/Users";
import { ReportsPage } from "./pages/Reports";
import { MyMenuPage } from "./pages/MyMenu";
import { OpportunitiesPage, OpportunityPage } from "./pages/Opportunities";
import { NewQuotationPage, QuotationPage, QuotationsPage, TemplatesPage } from "./pages/Quotations";

/** Qué módulo (permiso) necesita cada pantalla. */
const SECCION_MODULO: Record<string, string> = {
  oportunidades: "crm", presupuestos: "presupuestos", pedidos: "pedidos", rutas: "rutas", facturas: "facturas", clientes: "clientes", comerciales: "comerciales",
  productos: "productos", almacen: "almacen", planta: "planta", verifactu: "verifactu", informes: "informes",
  empresa: "empresa", usuarios: "usuarios",
};

function Screen({ route, me }: { route: string; me: Me }) {
  const [, section = "", id] = route.split("?")[0]!.split("/");
  const mod = SECCION_MODULO[section];
  if (mod && !me.perms[mod])
    return (
      <Page title="Sin acceso">
        <Alert tone="aviso">Tu rol ({me.role ?? "sin rol"}) no da acceso a esta parte de Sindri. Si la necesitas, pídeselo a administración.</Alert>
      </Page>
    );
  switch (section) {
    case "oportunidades":
      return id ? <OpportunityPage id={id} /> : <OpportunitiesPage />;
    case "presupuestos":
      return id === "nuevo" ? <NewQuotationPage /> : id === "modelos" ? <TemplatesPage /> : id ? <QuotationPage id={id} /> : <QuotationsPage />;
    case "pedidos":
      return id === "nuevo" ? <NewOrderPage /> : id ? <OrderPage id={id} /> : <OrdersPage />;
    case "rutas":
      return id ? <RoutePage id={id} /> : <RoutesPage />;
    case "facturas":
      return id ? <InvoicePage id={id} /> : <InvoicesPage />;
    case "clientes":
      return id ? <PartnerPage id={id} /> : <PartnersPage />;
    case "comerciales":
      return <RepsPage />;
    case "productos":
      return <ProductsPage />;
    case "almacen":
      return <StockPage />;
    case "planta":
      return <PlantPage />;
    case "verifactu":
      return <VerifactuPage />;
    case "informes":
      return <ReportsPage />;
    case "empresa":
      return <CompanyPage />;
    case "usuarios":
      return <UsersPage tab={id} />;
    case "mi-menu":
      return <MyMenuPage />;
    default:
      return <HomePage />;
  }
}

/** Marca: un yunque estilizado. Monocromo, legible a 16 px y en impresión térmica. */
export const BrandMark = () => (
  <svg className="brand-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
    {/* Yunque: Sindri, el herrero que forjó el martillo de Thor */}
    <path d="M3 6h14a4 4 0 0 1-4 4h-1v3l3 4H7l3-4v-3H6.5A3.5 3.5 0 0 1 3 6.5z" />
    <path d="M6 20h12" strokeLinecap="round" />
  </svg>
);

export function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}

/** Al entrar, si trabaja en varias empresas, elige en cuál (como en cualquier ERP). */
function CompanyChooser({ me, onChosen, onCancel }: { me: Me; onChosen: () => void; onCancel?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preferida = me.company ?? me.last_company;
  const [filtro, setFiltro] = useState("");
  const f = filtro.trim().toLowerCase();
  // La preferida primero; el resto por código (001, 002…), las reales antes que las de demo.
  const ordenadas = [...me.companies]
    .filter((c) => !f || [c.code, c.name, c.trade_name, c.tax_id].some((v) => v?.toLowerCase().includes(f)))
    .sort((a, b) => (a.id === preferida ? -1 : b.id === preferida ? 1 : Number(a.demo) - Number(b.demo) || (a.code ?? "").localeCompare(b.code ?? "") || a.name.localeCompare(b.name)));
  const elegir = async (id: string) => {
    setBusy(true);
    try {
      await post("/session/company", { company_id: id });
      onChosen();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="chooser">
      <div className="chooser-box">
        <div className="brand brand-dark"><BrandMark /> Sindri</div>
        <h1>Hola, {me.name.split(" ")[0]}</h1>
        <p className="hint">¿Con qué empresa vas a trabajar?</p>
        {me.companies.length > 5 && <input className="chooser-filter" autoFocus placeholder="Buscar por código, nombre o NIF" value={filtro} onChange={(e) => setFiltro(e.target.value)} />}
        <div className="chooser-list">
          {ordenadas.map((c, i) => (
            <button key={c.id} className="chooser-item" disabled={busy} autoFocus={i === 0 && me.companies.length <= 5} onClick={() => elegir(c.id)}>
              <Building2 size={22} aria-hidden />
              <span>
                <b>{nombreEmpresa(c)}{c.demo && <span className="tag tag-aviso">DEMO</span>}</b>
                <small>{c.trade_name ? `${c.name} · ` : ""}NIF {c.tax_id}</small>
              </span>
              {c.id === preferida && <em>{c.id === me.company ? "En uso" : "La última vez"}</em>}
            </button>
          ))}
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        {onCancel && <button className="link" onClick={onCancel}>Seguir con la empresa actual</button>}
      </div>
    </div>
  );
}

function UserMenu({ me, onCambiarEmpresa, arriba }: { me: Me; onCambiarEmpresa: () => void; arriba?: boolean }) {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = usePrefs();
  const { empresa } = useSession();
  const { data: health } = useData("/health");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className={`usermenu ${arriba ? "up" : ""}`} ref={ref}>
      <button className="usermenu-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="avatar" aria-hidden>{me.name.slice(0, 1).toUpperCase()}</span>
        <span className="usermenu-txt">
          <b>{me.name}</b>
          <small>{empresa ? <>{nombreEmpresa(empresa)}{empresa.demo && " · DEMO"}</> : "Sin empresa"}</small>
        </span>
        <ChevronDown size={16} aria-hidden />
      </button>
      {open && (
        <div className="usermenu-panel" role="dialog" aria-label="Tu cuenta">
          <p className="usermenu-who">
            <b>{me.name}</b>
            <small>{[me.role, me.department].filter(Boolean).join(" · ") || "Sin rol"}</small>
          </p>
          {me.companies.length > 1 && (
            <button onClick={() => { setOpen(false); onCambiarEmpresa(); }}>
              <Building2 size={16} aria-hidden /> Cambiar de empresa
            </button>
          )}
          <button onClick={() => { setOpen(false); navigate("/mi-menu"); }}>
            <MenuIcon size={16} aria-hidden /> Mi menú
          </button>
          <div className="usermenu-prefs">
            <select aria-label="Modo" value={prefs.modo} onChange={(e) => setPrefs({ modo: e.target.value as Modo })}>
              <option value="oficina">Modo oficina</option>
              <option value="taller">Modo taller</option>
            </select>
            <select aria-label="Tema" value={prefs.tema} onChange={(e) => setPrefs({ tema: e.target.value as Tema })}>
              <option value="sistema">Tema del sistema</option>
              <option value="claro">Claro / día</option>
              <option value="oscuro">Oscuro / noche</option>
            </select>
            <select aria-label="Densidad" value={prefs.densidad} onChange={(e) => setPrefs({ densidad: e.target.value as Densidad })}>
              <option value="compacta">Densidad compacta</option>
              <option value="normal">Densidad normal</option>
              <option value="comoda">Densidad cómoda</option>
              <option value="tactil">Táctil</option>
              <option value="guantes">Con guantes</option>
            </select>
          </div>
          <p className="conn">
            {health ? <><span className="dot" /> {health.db === "embedded" ? "Base de datos integrada" : "Servidor de la empresa"}</> : "Conectando…"}
          </p>
          {me.logout && (
            <a className="usermenu-salir" href={`./${me.logout}`}>
              <LogOut size={16} aria-hidden /> Salir
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function Shell() {
  const route = useRoute();
  const { me, error, reload, empresa } = useSession();
  const [elegir, setElegir] = useState(false);
  // Al cambiar de empresa se vuelve a montar todo para que ninguna pantalla enseñe datos de la otra.
  const [gen, setGen] = useState(0);

  if (!me)
    return (
      <div className="chooser">
        <div className="chooser-box">
          <div className="brand brand-dark"><BrandMark /> Sindri</div>
          {error ? <Alert tone="error">{error}</Alert> : <p className="hint">Entrando…</p>}
        </div>
      </div>
    );
  if (me.needs_company || elegir)
    return (
      <CompanyChooser
        me={me}
        onCancel={elegir && me.company ? () => setElegir(false) : undefined}
        onChosen={async () => {
          setElegir(false);
          await reload();
          setGen((g) => g + 1);
          if (elegir) navigate("/inicio");
        }}
      />
    );

  const posicion = me.menu?.posicion ?? "lateral";
  const items = menuDe(me);
  const active = (path: string) => route.startsWith(path) || (path === "/inicio" && route === "/");
  const nav = items.map((m) => (
    <a key={m.id} href={`#${m.path}`} className={active(m.path) ? "active" : ""} aria-current={active(m.path) ? "page" : undefined}>
      <m.icon size={18} aria-hidden /> <span>{m.label}</span>
    </a>
  ));
  const userMenu = <UserMenu me={me} arriba={posicion === "lateral"} onCambiarEmpresa={() => setElegir(true)} />;

  return (
    <div className={`shell shell-${posicion}`}>
      {posicion === "lateral" ? (
        <nav className="side" aria-label="Menú principal">
          <div className="brand"><BrandMark /> Sindri</div>
          {nav}
          <div className="side-foot">{userMenu}</div>
        </nav>
      ) : (
        <header className="topbar">
          <div className="brand"><BrandMark /> Sindri</div>
          {posicion === "superior" ? <nav className="topnav" aria-label="Menú principal">{nav}</nav> : <div className="grow" />}
          {userMenu}
        </header>
      )}
      <main key={`${me.company}-${gen}`}>
        {empresa?.demo && <div className="demo-strip" role="note">Empresa de demostración: los datos son de prueba.</div>}
        {me.companies.length === 0 && route !== "/empresa" && (
          <Alert tone="aviso">
            Primero configura los datos de tu empresa. <button className="link" onClick={() => navigate("/empresa")}>Configurar</button>
          </Alert>
        )}
        <Screen route={route} me={me} />
      </main>
      {posicion === "inferior" && <nav className="bottomnav" aria-label="Menú principal">{nav}</nav>}
    </div>
  );
}
