import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { BarChart3, Boxes, Briefcase, Building2, Factory, FileSignature, FileText, Home, Network, Package, ShieldCheck, ShoppingCart, Target, Truck, UserCog, Users, type LucideIcon } from "lucide-react";
import { api, put } from "./api";

export type Level = "ver" | "editar";
export type Posicion = "lateral" | "superior" | "inferior";
export interface Menu {
  posicion: Posicion;
  orden: string[];
  ocultos: string[];
}
export interface Company {
  id: string;
  name: string;
  trade_name: string | null;
  tax_id: string;
  code: string | null;
  demo: boolean;
}
export interface Me {
  user: string;
  name: string;
  email: string;
  admin: boolean;
  role: string | null;
  department: string | null;
  perms: Record<string, Level>;
  menu: Menu | null;
  companies: Company[];
  company: string | null;
  last_company: string | null;
  needs_company: boolean;
  logout: string | null;
}

/** Cada módulo del menú: su ruta, nombre e icono. El permiso lleva el mismo id. */
export const MODULOS: { id: string; path: string; label: string; icon: LucideIcon }[] = [
  { id: "inicio", path: "/inicio", label: "Inicio", icon: Home },
  { id: "relaciones", path: "/relaciones", label: "Relaciones", icon: Network },
  { id: "crm", path: "/oportunidades", label: "Oportunidades", icon: Target },
  { id: "presupuestos", path: "/presupuestos", label: "Presupuestos", icon: FileSignature },
  { id: "pedidos", path: "/pedidos", label: "Pedidos", icon: ShoppingCart },
  { id: "rutas", path: "/rutas", label: "Hojas de ruta", icon: Truck },
  { id: "facturas", path: "/facturas", label: "Facturas", icon: FileText },
  { id: "clientes", path: "/clientes", label: "Clientes", icon: Users },
  { id: "comerciales", path: "/comerciales", label: "Comerciales", icon: Briefcase },
  { id: "productos", path: "/productos", label: "Productos", icon: Package },
  { id: "almacen", path: "/almacen", label: "Almacén", icon: Boxes },
  { id: "planta", path: "/planta", label: "Planta", icon: Factory },
  { id: "verifactu", path: "/verifactu", label: "VERI*FACTU", icon: ShieldCheck },
  { id: "informes", path: "/informes", label: "Informes", icon: BarChart3 },
  { id: "empresa", path: "/empresa", label: "Empresa", icon: Building2 },
  { id: "usuarios", path: "/usuarios", label: "Usuarios", icon: UserCog },
];

export const MENU_DEFECTO: Menu = { posicion: "lateral", orden: MODULOS.map((m) => m.id), ocultos: [] };

/** Los módulos que esta persona ve, en su orden y sin los que ha ocultado. */
export function menuDe(me: Me, menu: Menu = me.menu ?? MENU_DEFECTO, conOcultos = false) {
  const permitidos = MODULOS.filter((m) => me.perms[m.id]);
  const pos = (id: string) => {
    const i = menu.orden.indexOf(id);
    return i < 0 ? 1000 + MODULOS.findIndex((m) => m.id === id) : i;
  };
  return permitidos.sort((a, b) => pos(a.id) - pos(b.id)).filter((m) => conOcultos || !menu.ocultos.includes(m.id) || m.id === "inicio");
}

interface SessionValue {
  me: Me | null;
  error: string | null;
  reload: () => Promise<void>;
  saveMenu: (m: Menu) => Promise<void>;
  /** Puede cambiar cosas en ese módulo (no solo verlas). */
  puede: (modulo: string) => boolean;
  empresa: Company | null;
}

const Ctx = createContext<SessionValue>(null as never);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setMe(await api<Me>("/me"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void reload();
    // Si la API dice que falta elegir empresa (sesión nueva), se recarga la sesión y sale el selector.
    const on = () => void reload();
    window.addEventListener("sindri:empresa", on);
    return () => window.removeEventListener("sindri:empresa", on);
  }, [reload]);
  const saveMenu = useCallback(async (m: Menu) => {
    await put("/me/menu", m);
    setMe((old) => (old ? { ...old, menu: m } : old));
  }, []);
  const puede = (modulo: string) => me?.perms[modulo] === "editar";
  const empresa = me?.companies.find((c) => c.id === me.company) ?? null;
  return <Ctx.Provider value={{ me, error, reload, saveMenu, puede, empresa }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);

/** «001 · Mi empresa»: el código delante, para reconocerla y filtrar. */
export const nombreEmpresa = (c: Company) => `${c.code ? `${c.code} · ` : ""}${c.trade_name || c.name}`;
