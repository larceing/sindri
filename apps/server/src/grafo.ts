/**
 * Relaciones: el grafo de registros de Sindri.
 *
 * Cada registro (cliente, oportunidad, presupuesto, pedido, albarán, hoja de ruta, factura,
 * cobro, lote) es un nodo, y cada vínculo entre ellos (este presupuesto se convirtió en este
 * pedido, este albarán sacó este lote…) es una arista que va en el sentido del negocio:
 * cliente → oportunidad → presupuesto → pedido → albarán → factura → cobro.
 *
 * Desde cualquier nodo se recorre la cadena hacia atrás y hacia delante. Los nodos «centro»
 * (cliente, lote, hoja de ruta) juntan muchas cadenas que no tienen que ver entre sí, así que
 * solo se abren cuando son el punto de partida: desde un pedido se ve su cliente, pero no
 * todos los demás pedidos del cliente. Desde un lote se ve a qué albaranes y clientes llegó
 * (la consulta de una retirada de producto).
 *
 * Cada tipo vive en el registro TIPOS: para añadir otro (fabricación, tareas, correos…) basta
 * con decir cómo se carga y quiénes son sus vecinos. Solo se ven los tipos de los módulos a los
 * que la persona tiene acceso, y siempre de la empresa en uso.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db, Queryable } from "./db.js";
import { BusinessError, OWN_LOCATION, type Ctx } from "./services.js";

/** SQL: el lote `l` ha pasado por algún almacén de la empresa `param` (los productos pueden ser comunes; los lotes de cada una, no). */
const LOTE_PROPIO = (param: string) =>
  `exists (select 1 from stock_move m join location a on a.id = m.from_location_id join location b on b.id = m.to_location_id
           where m.lot_id = l.id and (${OWN_LOCATION("a", param)} or ${OWN_LOCATION("b", param)}))`;
import { ctxOf } from "./usuarios.js";

export interface Nodo {
  /** «tipo:uuid», único en el grafo. */
  key: string;
  tipo: string;
  id: string;
  titulo: string;
  subtitulo: string | null;
  estado: string | null;
  importe: string | null;
  fecha: string | null;
  /** Pantalla de la web donde se abre (ruta del hash), si tiene. */
  ruta: string | null;
}
export interface Arista {
  from: string;
  to: string;
  rel: string;
}
interface Ref {
  tipo: string;
  id: string;
}
interface Vecino {
  /** El vecino. */
  ref: Ref;
  /** «antes» si el vecino va antes en la cadena (la arista sale de él), «despues» si va después. */
  lado: "antes" | "despues";
  rel: string;
}
type Fila = Record<string, unknown>;

interface Tipo {
  etiqueta: string;
  /** Módulo (permiso) que hace falta para verlo. */
  modulo: string;
  /** Junta muchas cadenas: solo se abre si es el punto de partida. */
  centro?: boolean;
  /** Carga los datos del nodo; null si no existe o es de otra empresa. */
  cargar(q: Queryable, ctx: Ctx, id: string): Promise<Omit<Nodo, "key" | "tipo" | "id"> | null>;
  vecinos(q: Queryable, ctx: Ctx, id: string): Promise<Vecino[]>;
  /** Búsqueda por número, código o nombre. */
  buscar(q: Queryable, ctx: Ctx, texto: string): Promise<{ id: string }[]>;
}

/** Hasta cuántos vecinos de un mismo tipo se traen por nodo (un cliente con 5.000 pedidos no se dibuja entero). */
const POR_RELACION = 60;
const MAX_NODOS = 250;
const MAX_PROFUNDIDAD = 8;

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const dia = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const like = (t: string) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const ids = (rows: Fila[], tipo: string, lado: Vecino["lado"], rel: string, col = "id"): Vecino[] =>
  rows.map((r) => ({ ref: { tipo, id: String(r[col]) }, lado, rel }));

/** Base imponible de unas líneas (cantidad × precio − descuento), redondeada a céntimos. */
const BASE = (tabla: string, fk: string, alias: string) =>
  `(select round(coalesce(sum(l.quantity * l.unit_price * (1 - l.discount_pct / 100)), 0), 2) from ${tabla} l where l.${fk} = ${alias}.id)`;

export const TIPOS: Record<string, Tipo> = {
  cliente: {
    etiqueta: "Cliente",
    modulo: "clientes",
    centro: true,
    async cargar(q, ctx, id) {
      const [p] = await q.query("select * from partner where id = $1 and company_id = maestro($2)", [id, ctx.company]);
      if (!p) return null;
      return {
        titulo: String(p.trade_name ?? p.name),
        subtitulo: [p.code, p.tax_id].filter(Boolean).join(" · ") || null,
        estado: p.archived ? "archived" : null,
        importe: null,
        fecha: null,
        ruta: `/clientes/${id}`,
      };
    },
    async vecinos(q, ctx, id) {
      const c = ctx.company;
      const [opps, quotes, orders, invoices] = await Promise.all([
        q.query("select id from opportunity where partner_id = $1 and company_id = $2 order by created_at desc limit $3", [id, c, POR_RELACION]),
        // Los presupuestos que vienen de una oportunidad cuelgan de ella, no del cliente.
        q.query("select id from quotation where partner_id = $1 and company_id = $2 and opportunity_id is null order by created_at desc limit $3", [id, c, POR_RELACION]),
        // Igual con los pedidos: si salen de un presupuesto o de otro pedido, cuelgan de ellos.
        q.query(
          `select o.id from sales_order o where o.partner_id = $1 and o.company_id = $2 and o.split_from_id is null and o.quotation_id is null
             and not exists (select 1 from quotation qt where qt.order_id = o.id)
           order by o.created_at desc limit $3`,
          [id, c, POR_RELACION],
        ),
        q.query("select id from invoice where partner_id = $1 and company_id = $2 and order_id is null order by created_at desc limit $3", [id, c, POR_RELACION]),
      ]);
      return [
        ...ids(opps, "oportunidad", "despues", "oportunidad"),
        ...ids(quotes, "presupuesto", "despues", "presupuesto"),
        ...ids(orders, "pedido", "despues", "pedido"),
        ...ids(invoices, "factura", "despues", "factura"),
      ];
    },
    buscar: (q, ctx, t) =>
      q.query(
        `select id from partner where company_id = maestro($1) and (name ilike $2 or trade_name ilike $2 or code ilike $2 or tax_id ilike $2)
         order by archived, name limit 8`,
        [ctx.company, like(t)],
      ),
  },

  oportunidad: {
    etiqueta: "Oportunidad",
    modulo: "crm",
    async cargar(q, ctx, id) {
      const [o] = await q.query(
        `select o.*, coalesce(p.trade_name, p.name, o.prospect_name) as cliente from opportunity o left join partner p on p.id = o.partner_id
         where o.id = $1 and o.company_id = $2`,
        [id, ctx.company],
      );
      if (!o) return null;
      return { titulo: String(o.number), subtitulo: [o.title, o.cliente].filter(Boolean).join(" · "), estado: str(o.stage), importe: str(o.amount), fecha: dia(o.expected_close), ruta: `/oportunidades/${id}` };
    },
    async vecinos(q, ctx, id) {
      const [o] = await q.query("select partner_id from opportunity where id = $1 and company_id = $2", [id, ctx.company]);
      if (!o) return [];
      const quotes = await q.query("select id from quotation where opportunity_id = $1 and company_id = $2 order by created_at limit $3", [id, ctx.company, POR_RELACION]);
      return [
        ...(o.partner_id ? [{ ref: { tipo: "cliente", id: String(o.partner_id) }, lado: "antes" as const, rel: "oportunidad" }] : []),
        ...ids(quotes, "presupuesto", "despues", "presupuesto"),
      ];
    },
    buscar: (q, ctx, t) =>
      q.query(
        `select id from opportunity where company_id = $1 and (number ilike $2 or title ilike $2 or prospect_name ilike $2) order by created_at desc limit 8`,
        [ctx.company, like(t)],
      ),
  },

  presupuesto: {
    etiqueta: "Presupuesto",
    modulo: "presupuestos",
    async cargar(q, ctx, id) {
      const [p] = await q.query(
        `select qt.*, coalesce(p.trade_name, p.name) as cliente, ${BASE("quotation_line", "quotation_id", "qt")} as base
         from quotation qt join partner p on p.id = qt.partner_id where qt.id = $1 and qt.company_id = $2`,
        [id, ctx.company],
      );
      if (!p) return null;
      return { titulo: String(p.number), subtitulo: [p.title, p.cliente].filter(Boolean).join(" · "), estado: str(p.state), importe: str(p.base), fecha: dia(p.quote_date), ruta: `/presupuestos/${id}` };
    },
    async vecinos(q, ctx, id) {
      const [p] = await q.query("select partner_id, opportunity_id, order_id from quotation where id = $1 and company_id = $2", [id, ctx.company]);
      if (!p) return [];
      // El pedido puede estar apuntado en el presupuesto, en el pedido, o en los dos.
      const orders = await q.query(
        "select id from sales_order where company_id = $1 and (id = $2 or quotation_id = $3) limit $4",
        [ctx.company, p.order_id ?? null, id, POR_RELACION],
      );
      return [
        p.opportunity_id
          ? { ref: { tipo: "oportunidad", id: String(p.opportunity_id) }, lado: "antes" as const, rel: "presupuesto" }
          : { ref: { tipo: "cliente", id: String(p.partner_id) }, lado: "antes" as const, rel: "presupuesto" },
        ...ids(orders, "pedido", "despues", "pedido"),
      ];
    },
    buscar: (q, ctx, t) =>
      q.query(`select id from quotation where company_id = $1 and (number ilike $2 or title ilike $2) order by created_at desc limit 8`, [ctx.company, like(t)]),
  },

  pedido: {
    etiqueta: "Pedido",
    modulo: "pedidos",
    async cargar(q, ctx, id) {
      const [o] = await q.query(
        `select o.*, coalesce(p.trade_name, p.name) as cliente, ${BASE("sales_order_line", "order_id", "o")} as base
         from sales_order o join partner p on p.id = o.partner_id where o.id = $1 and o.company_id = $2`,
        [id, ctx.company],
      );
      if (!o) return null;
      return { titulo: String(o.number), subtitulo: str(o.cliente), estado: str(o.state), importe: str(o.base), fecha: dia(o.order_date), ruta: `/pedidos/${id}` };
    },
    async vecinos(q, ctx, id) {
      const c = ctx.company;
      const [o] = await q.query("select partner_id, quotation_id, split_from_id from sales_order where id = $1 and company_id = $2", [id, c]);
      if (!o) return [];
      const [quotes, splits, deliveries, routes, invoices] = await Promise.all([
        q.query("select id from quotation where company_id = $1 and (order_id = $2 or id = $3) limit $4", [c, id, o.quotation_id ?? null, POR_RELACION]),
        q.query("select id from sales_order where split_from_id = $1 and company_id = $2 order by created_at limit $3", [id, c, POR_RELACION]),
        q.query("select id from delivery where order_id = $1 and company_id = $2 order by done_at limit $3", [id, c, POR_RELACION]),
        q.query(
          "select distinct r.id from delivery_route_stop s join delivery_route r on r.id = s.route_id where s.order_id = $1 and r.company_id = $2 limit $3",
          [id, c, POR_RELACION],
        ),
        q.query("select id from invoice where order_id = $1 and company_id = $2 order by created_at limit $3", [id, c, POR_RELACION]),
      ]);
      // De dónde viene: de un presupuesto, de otro pedido (separado) o directamente del cliente.
      const antes: Vecino[] = quotes.length
        ? ids(quotes, "presupuesto", "antes", "pedido")
        : o.split_from_id
          ? [{ ref: { tipo: "pedido", id: String(o.split_from_id) }, lado: "antes", rel: "separado" }]
          : [{ ref: { tipo: "cliente", id: String(o.partner_id) }, lado: "antes", rel: "pedido" }];
      return [
        ...antes,
        ...ids(splits, "pedido", "despues", "separado"),
        ...ids(deliveries, "albaran", "despues", "albarán"),
        ...ids(routes, "ruta", "despues", "en ruta"),
        ...ids(invoices, "factura", "despues", "factura"),
      ];
    },
    buscar: (q, ctx, t) => q.query(`select id from sales_order where company_id = $1 and number ilike $2 order by created_at desc limit 8`, [ctx.company, like(t)]),
  },

  albaran: {
    etiqueta: "Albarán",
    modulo: "pedidos",
    async cargar(q, ctx, id) {
      const [d] = await q.query(
        `select d.*, o.number as pedido, coalesce(p.trade_name, p.name) as cliente from delivery d
         join sales_order o on o.id = d.order_id join partner p on p.id = o.partner_id where d.id = $1 and d.company_id = $2`,
        [id, ctx.company],
      );
      if (!d) return null;
      return { titulo: String(d.number), subtitulo: [d.cliente, `pedido ${d.pedido}`].join(" · "), estado: "delivered", importe: null, fecha: dia(d.done_at), ruta: `/pedidos/${d.order_id}` };
    },
    async vecinos(q, ctx, id) {
      const [d] = await q.query("select order_id from delivery where id = $1 and company_id = $2", [id, ctx.company]);
      if (!d) return [];
      const lots = await q.query(
        "select distinct lot_id from stock_move where reference_type = 'delivery' and reference_id = $1 and lot_id is not null limit $2",
        [id, POR_RELACION],
      );
      return [{ ref: { tipo: "pedido", id: String(d.order_id) }, lado: "antes", rel: "albarán" }, ...ids(lots, "lote", "despues", "lote", "lot_id")];
    },
    buscar: (q, ctx, t) => q.query(`select id from delivery where company_id = $1 and number ilike $2 order by done_at desc limit 8`, [ctx.company, like(t)]),
  },

  ruta: {
    etiqueta: "Hoja de ruta",
    modulo: "rutas",
    centro: true,
    async cargar(q, ctx, id) {
      const [r] = await q.query(
        "select r.*, (select count(*) from delivery_route_stop s where s.route_id = r.id)::int as paradas from delivery_route r where r.id = $1 and r.company_id = $2",
        [id, ctx.company],
      );
      if (!r) return null;
      const quien = [r.driver, r.zone].filter(Boolean).join(" · ");
      return { titulo: String(r.number), subtitulo: `${r.paradas} paradas${quien ? ` · ${quien}` : ""}`, estado: str(r.state), importe: null, fecha: dia(r.route_date), ruta: `/rutas/${id}` };
    },
    async vecinos(q, ctx, id) {
      const stops = await q.query(
        "select s.order_id from delivery_route_stop s join delivery_route r on r.id = s.route_id where s.route_id = $1 and r.company_id = $2 order by s.position limit $3",
        [id, ctx.company, POR_RELACION],
      );
      return ids(stops, "pedido", "antes", "en ruta", "order_id");
    },
    buscar: (q, ctx, t) =>
      q.query(`select id from delivery_route where company_id = $1 and (number ilike $2 or driver ilike $2 or zone ilike $2) order by route_date desc limit 8`, [ctx.company, like(t)]),
  },

  factura: {
    etiqueta: "Factura",
    modulo: "facturas",
    async cargar(q, ctx, id) {
      const [f] = await q.query(
        `select f.*, coalesce(p.trade_name, p.name) as cliente from invoice f join partner p on p.id = f.partner_id where f.id = $1 and f.company_id = $2`,
        [id, ctx.company],
      );
      if (!f) return null;
      const pendiente = f.state === "issued" && Number(f.amount_due) > 0 ? ` · pendiente ${f.amount_due}` : "";
      return { titulo: f.number ? String(f.number) : "Borrador", subtitulo: `${f.cliente}${pendiente}`, estado: str(f.state), importe: str(f.total), fecha: dia(f.issue_date ?? f.created_at), ruta: `/facturas/${id}` };
    },
    async vecinos(q, ctx, id) {
      const [f] = await q.query("select partner_id, order_id from invoice where id = $1 and company_id = $2", [id, ctx.company]);
      if (!f) return [];
      const pays = await q.query("select id from payment where invoice_id = $1 order by paid_on, created_at limit $2", [id, POR_RELACION]);
      return [
        f.order_id
          ? { ref: { tipo: "pedido", id: String(f.order_id) }, lado: "antes" as const, rel: "factura" }
          : { ref: { tipo: "cliente", id: String(f.partner_id) }, lado: "antes" as const, rel: "factura" },
        ...ids(pays, "cobro", "despues", "cobro"),
      ];
    },
    buscar: (q, ctx, t) => q.query(`select id from invoice where company_id = $1 and number ilike $2 order by created_at desc limit 8`, [ctx.company, like(t)]),
  },

  cobro: {
    etiqueta: "Cobro",
    modulo: "facturas",
    async cargar(q, ctx, id) {
      const [c] = await q.query(
        "select c.*, f.number as factura from payment c join invoice f on f.id = c.invoice_id where c.id = $1 and f.company_id = $2",
        [id, ctx.company],
      );
      if (!c) return null;
      return { titulo: `Cobro ${dia(c.paid_on)?.split("-").reverse().join("/")}`, subtitulo: [METODO[String(c.method)] ?? c.method, c.factura && `factura ${c.factura}`].filter(Boolean).join(" · "), estado: "paid", importe: str(c.amount), fecha: dia(c.paid_on), ruta: `/facturas/${c.invoice_id}` };
    },
    async vecinos(q, ctx, id) {
      const [c] = await q.query("select c.invoice_id from payment c join invoice f on f.id = c.invoice_id where c.id = $1 and f.company_id = $2", [id, ctx.company]);
      return c ? [{ ref: { tipo: "factura", id: String(c.invoice_id) }, lado: "antes", rel: "cobro" }] : [];
    },
    buscar: async () => [],
  },

  lote: {
    etiqueta: "Lote",
    modulo: "almacen",
    centro: true,
    async cargar(q, ctx, id) {
      const [l] = await q.query(
        `select l.*, p.sku, p.name as producto,
           (select coalesce(sum(b.quantity), 0) from stock_balance b join location loc on loc.id = b.location_id
             where b.lot_id = l.id and ${OWN_LOCATION("loc", "$2")}) as existencias
         from lot l join product p on p.id = l.product_id where l.id = $1 and p.company_id = maestro($2) and ${LOTE_PROPIO("$2")}`,
        [id, ctx.company],
      );
      if (!l) return null;
      return {
        titulo: String(l.code),
        subtitulo: `${l.sku} ${l.producto}${l.expiry_date ? ` · caduca ${dia(l.expiry_date)!.split("-").reverse().join("/")}` : ""}`,
        estado: null,
        importe: null,
        fecha: dia(l.created_at),
        ruta: `/relaciones/lote/${id}`,
      };
    },
    async vecinos(q, ctx, id) {
      // Hacia delante: a qué albaranes (y por ellos, a qué clientes) llegó el lote.
      const dels = await q.query(
        `select distinct d.id, d.done_at from stock_move m join delivery d on d.id = m.reference_id
         where m.reference_type = 'delivery' and m.lot_id = $1 and d.company_id = $2 order by d.done_at limit $3`,
        [id, ctx.company, POR_RELACION],
      );
      return ids(dels, "albaran", "antes", "lote");
    },
    buscar: (q, ctx, t) =>
      q.query(`select l.id from lot l join product p on p.id = l.product_id where p.company_id = maestro($1) and ${LOTE_PROPIO("$1")} and l.code ilike $2 order by l.created_at desc limit 8`, [
        ctx.company,
        like(t),
      ]),
  },
};

const METODO: Record<string, string> = { transfer: "Transferencia", cash: "Efectivo", card: "Tarjeta", direct_debit: "Domiciliación" };

const visible = (tipo: string, perms: Record<string, unknown>) => !!TIPOS[tipo] && !!perms[TIPOS[tipo]!.modulo];

/**
 * Recorre el grafo desde un registro. Los centros (cliente, lote, ruta) solo se abren si son el
 * punto de partida; los demás se abren hasta `profundidad` saltos.
 */
export async function grafoDesde(q: Queryable, ctx: Ctx, perms: Record<string, unknown>, tipo: string, id: string, profundidad = MAX_PROFUNDIDAD) {
  if (!TIPOS[tipo]) throw new BusinessError(`No hay registros de tipo «${tipo}»`, 404);
  if (!visible(tipo, perms)) throw new BusinessError("Tu rol no da acceso a esta parte de Sindri", 403);
  const inicio = `${tipo}:${id}`;
  const nodos = new Map<string, Nodo>();
  const aristas = new Map<string, Arista>();
  const cargar = async (r: Ref) => {
    const key = `${r.tipo}:${r.id}`;
    if (nodos.has(key)) return true;
    const datos = await TIPOS[r.tipo]!.cargar(q, ctx, r.id);
    if (!datos) return false;
    nodos.set(key, { key, tipo: r.tipo, id: r.id, ...datos });
    return true;
  };
  if (!(await cargar({ tipo, id }))) throw new BusinessError(`${TIPOS[tipo]!.etiqueta} no encontrado`, 404);

  let truncado = false;
  let frontera: { ref: Ref; nivel: number }[] = [{ ref: { tipo, id }, nivel: 0 }];
  const abiertos = new Set<string>();
  while (frontera.length) {
    const siguiente: typeof frontera = [];
    for (const { ref, nivel } of frontera) {
      const key = `${ref.tipo}:${ref.id}`;
      if (abiertos.has(key)) continue;
      abiertos.add(key);
      const t = TIPOS[ref.tipo]!;
      if (nivel >= profundidad || (t.centro && key !== inicio)) continue;
      const vecinos = await t.vecinos(q, ctx, ref.id);
      if (vecinos.length >= POR_RELACION) truncado = true;
      for (const v of vecinos) {
        const vk = `${v.ref.tipo}:${v.ref.id}`;
        if (!nodos.has(vk)) {
          if (nodos.size >= MAX_NODOS) {
            truncado = true;
            continue;
          }
          if (!(await cargar(v.ref))) continue;
        }
        const [from, to] = v.lado === "antes" ? [vk, key] : [key, vk];
        aristas.set(`${from}>${to}`, { from, to, rel: v.rel });
        siguiente.push({ ref: v.ref, nivel: nivel + 1 });
      }
    }
    frontera = siguiente;
  }

  // Lo que la persona no puede ver se quita, pero sin romper la cadena: si no ve el presupuesto,
  // ve «cliente → … → pedido» como una arista directa.
  const oculto = (k: string) => !visible(nodos.get(k)!.tipo, perms);
  const salen = new Map<string, Arista[]>();
  for (const a of aristas.values()) salen.set(a.from, [...(salen.get(a.from) ?? []), a]);
  const finales = new Map<string, Arista>();
  for (const k of nodos.keys()) {
    if (oculto(k)) continue;
    const pila = (salen.get(k) ?? []).map((a) => ({ to: a.to, via: false, rel: a.rel }));
    const vistos = new Set<string>();
    while (pila.length) {
      const { to, via, rel } = pila.pop()!;
      if (vistos.has(to)) continue;
      vistos.add(to);
      if (!oculto(to)) {
        const id2 = `${k}>${to}`;
        if (!finales.has(id2) || finales.get(id2)!.rel === "…") finales.set(id2, { from: k, to, rel: via ? "…" : rel });
        continue;
      }
      for (const a of salen.get(to) ?? []) pila.push({ to: a.to, via: true, rel: a.rel });
    }
  }
  for (const k of [...nodos.keys()]) if (oculto(k)) nodos.delete(k);

  return {
    inicio,
    nodos: [...nodos.values()],
    aristas: [...finales.values()],
    truncado,
    tipos: Object.fromEntries(Object.entries(TIPOS).map(([k, t]) => [k, { etiqueta: t.etiqueta, centro: !!t.centro }])),
  };
}

/** Busca registros por número, código o nombre en todos los tipos que la persona puede ver. */
export async function buscarNodos(q: Queryable, ctx: Ctx, perms: Record<string, unknown>, texto: string) {
  const t = texto.trim();
  if (t.length < 2) return [];
  const out: Nodo[] = [];
  for (const [tipo, def] of Object.entries(TIPOS)) {
    if (!visible(tipo, perms)) continue;
    for (const { id } of await def.buscar(q, ctx, t)) {
      const datos = await def.cargar(q, ctx, String(id));
      if (datos) out.push({ key: `${tipo}:${id}`, tipo, id: String(id), ...datos });
    }
  }
  return out;
}

const GrafoQuery = z.object({
  tipo: z.string().min(1),
  id: z.uuid(),
  profundidad: z.coerce.number().int().min(1).max(MAX_PROFUNDIDAD).optional(),
});

export function registerGrafo(app: FastifyInstance, db: Db) {
  app.get("/api/v1/grafo", async (req) => {
    const p = GrafoQuery.parse(req.query);
    return grafoDesde(db, ctxOf(req), req.sindri?.perms ?? {}, p.tipo, p.id, p.profundidad);
  });
  app.get<{ Querystring: { q?: string } }>("/api/v1/grafo/buscar", async (req) => buscarNodos(db, ctxOf(req), req.sindri?.perms ?? {}, req.query.q ?? ""));
}
