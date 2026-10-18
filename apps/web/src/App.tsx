import { Boxes, Building2, FileText, Home, Package, ShieldCheck, ShoppingCart, Users } from "lucide-react";
import { useData } from "./hooks";
import { navigate, useRoute } from "./router";
import { usePrefs, type Densidad, type Modo, type Tema } from "./prefs";
import { Alert } from "./ui";
import { HomePage } from "./pages/Home";
import { CompanyPage } from "./pages/Company";
import { PartnersPage } from "./pages/Partners";
import { ProductsPage } from "./pages/Products";
import { StockPage } from "./pages/Stock";
import { NewOrderPage, OrderPage, OrdersPage } from "./pages/Orders";
import { InvoicePage, InvoicesPage } from "./pages/Invoices";
import { VerifactuPage } from "./pages/Verifactu";

const NAV = [
  ["/inicio", "Inicio", Home],
  ["/pedidos", "Pedidos", ShoppingCart],
  ["/facturas", "Facturas", FileText],
  ["/clientes", "Clientes", Users],
  ["/productos", "Productos", Package],
  ["/almacen", "Almacén", Boxes],
  ["/verifactu", "VERI*FACTU", ShieldCheck],
  ["/empresa", "Empresa", Building2],
] as const;

function Screen({ route }: { route: string }) {
  const [, section, id] = route.split("/");
  switch (section) {
    case "pedidos":
      return id === "nuevo" ? <NewOrderPage /> : id ? <OrderPage id={id} /> : <OrdersPage />;
    case "facturas":
      return id ? <InvoicePage id={id} /> : <InvoicesPage />;
    case "clientes":
      return <PartnersPage />;
    case "productos":
      return <ProductsPage />;
    case "almacen":
      return <StockPage />;
    case "verifactu":
      return <VerifactuPage />;
    case "empresa":
      return <CompanyPage />;
    default:
      return <HomePage />;
  }
}

/** Marca: un crisol/lingote estilizado. Monocromo, legible a 16 px y en impresión térmica. */
export const BrandMark = () => (
  <svg className="brand-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
    {/* Tejido: Atenea Ergane, protectora del telar y de los oficios */}
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <path d="M9 3v18M15 3v18M3 9h6M15 9h6M9 15h6" />
  </svg>
);

export function App() {
  const route = useRoute();
  const [prefs, setPrefs] = usePrefs();
  const { data: health } = useData("/health");
  const { data: company, loading } = useData(`/company?v=${route === "/empresa" ? 1 : 0}`);
  return (
    <div className="shell">
      <nav className="side" aria-label="Menú principal">
        <div className="brand"><BrandMark /> Ergane</div>
        {NAV.map(([path, label, Icon]) => (
          <a key={path} href={`#${path}`} className={route.startsWith(path) || (path === "/inicio" && route === "/") ? "active" : ""}>
            <Icon size={18} aria-hidden /> {label}
          </a>
        ))}
        <div className="prefs">
          <div className="conn">
            {health ? <><span className="dot" /> {health.db === "embedded" ? "Modo local (sin servidor)" : "Servidor de la empresa"}</> : "Conectando…"}
          </div>
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
      </nav>
      <main>
        {!loading && company === null && route !== "/empresa" && (
          <Alert tone="aviso">
            Primero configura los datos de tu empresa. <button className="link" onClick={() => navigate("/empresa")}>Configurar</button>
          </Alert>
        )}
        <Screen route={route} />
      </main>
    </div>
  );
}
