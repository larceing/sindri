import { Boxes, Building2, Factory, FileText, Home, Package, ShieldCheck, ShoppingCart, Users } from "lucide-react";
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
import { PlantPage } from "./pages/Plant";

const NAV = [
  ["/inicio", "Inicio", Home],
  ["/pedidos", "Pedidos", ShoppingCart],
  ["/facturas", "Facturas", FileText],
  ["/clientes", "Clientes", Users],
  ["/productos", "Productos", Package],
  ["/almacen", "Almacén", Boxes],
  ["/planta", "Planta", Factory],
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
    case "planta":
      return <PlantPage />;
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
    {/* Yunque: Sindri, el herrero que forjó el martillo de Thor */}
    <path d="M3 6h14a4 4 0 0 1-4 4h-1v3l3 4H7l3-4v-3H6.5A3.5 3.5 0 0 1 3 6.5z" />
    <path d="M6 20h12" strokeLinecap="round" />
  </svg>
);

export function App() {
  const route = useRoute();
  const [prefs, setPrefs] = usePrefs();
  const { data: health } = useData("/health");
  const { data: me } = useData("/me");
  const { data: company, loading } = useData(`/company?v=${route === "/empresa" ? 1 : 0}`);
  return (
    <div className="shell">
      <nav className="side" aria-label="Menú principal">
        <div className="brand"><BrandMark /> Sindri</div>
        {NAV.map(([path, label, Icon]) => (
          <a key={path} href={`#${path}`} className={route.startsWith(path) || (path === "/inicio" && route === "/") ? "active" : ""}>
            <Icon size={18} aria-hidden /> {label}
          </a>
        ))}
        <div className="prefs">
          {me && (
            <div className="conn">
              {me.name} · <a className="salir" href="./logout">Salir</a>
            </div>
          )}
          <div className="conn">
            {health ? <><span className="dot" /> {health.db === "embedded" ? "Base de datos integrada" : "Servidor de la empresa"}</> : "Conectando…"}
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
