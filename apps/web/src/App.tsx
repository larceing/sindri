import { useData } from "./hooks";
import { navigate, useRoute } from "./router";
import { CompanyPage } from "./pages/Company";
import { PartnersPage } from "./pages/Partners";
import { ProductsPage } from "./pages/Products";
import { StockPage } from "./pages/Stock";
import { NewOrderPage, OrderPage, OrdersPage } from "./pages/Orders";
import { InvoicePage, InvoicesPage } from "./pages/Invoices";
import { VerifactuPage } from "./pages/Verifactu";

const NAV = [
  ["/pedidos", "Pedidos"],
  ["/facturas", "Facturas"],
  ["/clientes", "Clientes"],
  ["/productos", "Productos"],
  ["/almacen", "Almacén"],
  ["/verifactu", "VERI*FACTU"],
  ["/empresa", "Empresa"],
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
      return <OrdersPage />;
  }
}

export function App() {
  const route = useRoute();
  const { data: health } = useData("/health");
  const { data: company } = useData(`/company?r=${route === "/empresa" ? Date.now() : 0}`);
  return (
    <div className="shell">
      <nav className="side">
        <div className="brand">Forja <small>ERP</small></div>
        {NAV.map(([path, label]) => (
          <a key={path} href={`#${path}`} className={route.startsWith(path) ? "active" : ""}>{label}</a>
        ))}
        <div className="status">
          {health ? (
            <>
              <span className="dot" /> {health.db === "embedded" ? "Modo local (sin servidor)" : "Servidor de la empresa"}
            </>
          ) : (
            <>Conectando…</>
          )}
        </div>
      </nav>
      <main>
        {company === null && route !== "/empresa" && (
          <div className="banner">
            Primero configure los datos de su empresa. <button className="link" onClick={() => navigate("/empresa")}>Configurar</button>
          </div>
        )}
        <Screen route={route} />
      </main>
    </div>
  );
}
