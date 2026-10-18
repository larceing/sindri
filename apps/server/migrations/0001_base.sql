-- Sindri ERP · esquema base
-- Principios: libros inmutables (stock, registros fiscales, auditoría), importes en NUMERIC,
-- identificadores UUID (preparados para sincronizar varios puestos sin conflictos).

create function sindri_forbid_change() returns trigger language plpgsql as $$
begin
  raise exception 'Registro inmutable en %: no se puede % ', TG_TABLE_NAME, lower(TG_OP);
end
$$;

-- Empresa ----------------------------------------------------------------
create table company (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tax_id text not null,
  address text,
  city text,
  postal_code text,
  country text not null default 'ES',
  gs1_prefix text,
  created_at timestamptz not null default now()
);

-- Numeración sin huecos (series fiscales y documentos) ---------------------
create table sequence (
  code text not null,
  year int not null,
  prefix text not null,
  next_number int not null default 1,
  padding int not null default 5,
  primary key (code, year)
);

-- Terceros -----------------------------------------------------------------
create table partner (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'customer' check (kind in ('customer', 'supplier', 'both')),
  name text not null,
  tax_id text,
  email text,
  phone text,
  address text,
  city text,
  postal_code text,
  country text not null default 'ES',
  surcharge_regime boolean not null default false, -- recargo de equivalencia
  withholding_rate numeric(5, 2) not null default 0, -- retención IRPF %
  notes text,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create index partner_name_idx on partner (lower(name));

-- Productos ----------------------------------------------------------------
create table product (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  kind text not null default 'stockable' check (kind in ('stockable', 'consumable', 'service')),
  uom text not null default 'ud',
  gtin text,
  sale_price numeric(18, 6) not null default 0,
  cost_price numeric(18, 6) not null default 0,
  vat_rate numeric(5, 2) not null default 21,
  track_lots boolean not null default false,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

-- Ubicaciones y lotes -------------------------------------------------------
create table location (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  kind text not null check (kind in ('internal', 'supplier', 'customer', 'production', 'adjustment')),
  parent_id uuid references location (id)
);

create table lot (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references product (id),
  code text not null,
  expiry_date date,
  created_at timestamptz not null default now(),
  unique (product_id, code)
);

-- Libro de movimientos de stock: única fuente de verdad, nunca se modifica ---
create table stock_move (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references product (id),
  lot_id uuid references lot (id),
  from_location_id uuid not null references location (id),
  to_location_id uuid not null references location (id),
  quantity numeric(18, 4) not null check (quantity > 0),
  unit_cost numeric(18, 6),
  reference_type text,
  reference_id uuid,
  note text,
  done_at timestamptz not null default now(),
  created_by text not null default 'system',
  check (from_location_id <> to_location_id)
);
create index stock_move_product_idx on stock_move (product_id);
create trigger stock_move_immutable before update or delete on stock_move
  for each row execute function sindri_forbid_change();

-- Saldos calculados a partir del libro (solo ubicaciones internas)
create view stock_balance as
select m.product_id, m.lot_id, l.id as location_id, sum(m.qty) as quantity
from (
  select product_id, lot_id, to_location_id as location_id, quantity as qty from stock_move
  union all
  select product_id, lot_id, from_location_id, -quantity from stock_move
) m
join location l on l.id = m.location_id and l.kind = 'internal'
group by m.product_id, m.lot_id, l.id
having sum(m.qty) <> 0;

-- Ventas --------------------------------------------------------------------
create table sales_order (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  partner_id uuid not null references partner (id),
  state text not null default 'draft'
    check (state in ('draft', 'confirmed', 'delivered', 'invoiced', 'cancelled')),
  order_date date not null default current_date,
  notes text,
  created_at timestamptz not null default now()
);

create table sales_order_line (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references sales_order (id) on delete cascade,
  position int not null,
  product_id uuid not null references product (id),
  description text not null,
  quantity numeric(18, 4) not null check (quantity > 0),
  unit_price numeric(18, 6) not null,
  discount_pct numeric(5, 2) not null default 0,
  vat_rate numeric(5, 2) not null
);

-- Albaranes de salida --------------------------------------------------------
create table delivery (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  order_id uuid not null references sales_order (id),
  from_location_id uuid not null references location (id),
  done_at timestamptz not null default now()
);

-- Facturas -------------------------------------------------------------------
create table invoice (
  id uuid primary key default gen_random_uuid(),
  number text unique, -- se asigna al emitir, nunca en borrador
  series text not null default 'F',
  invoice_type text not null default 'F1',
  state text not null default 'draft' check (state in ('draft', 'issued', 'paid', 'discarded')),
  partner_id uuid not null references partner (id),
  order_id uuid references sales_order (id),
  issue_date date,
  partner_snapshot jsonb, -- datos fiscales del cliente congelados al emitir
  tax_breakdown jsonb not null default '[]',
  untaxed numeric(18, 2) not null default 0,
  vat_total numeric(18, 2) not null default 0,
  surcharge_total numeric(18, 2) not null default 0,
  withholding numeric(18, 2) not null default 0,
  total numeric(18, 2) not null default 0,
  amount_due numeric(18, 2) not null default 0,
  created_at timestamptz not null default now(),
  issued_at timestamptz
);

create table invoice_line (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoice (id) on delete cascade,
  position int not null,
  product_id uuid references product (id),
  description text not null,
  quantity numeric(18, 4) not null,
  unit_price numeric(18, 6) not null,
  discount_pct numeric(5, 2) not null default 0,
  vat_rate numeric(5, 2) not null,
  surcharge_rate numeric(5, 2) not null default 0,
  base numeric(18, 2) not null
);

-- Una factura emitida no se borra ni cambia sus datos fiscales: solo puede pasar a "pagada".
create function sindri_invoice_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.state <> 'draft' then raise exception 'Factura % emitida: no se puede borrar', old.number; end if;
    return old;
  end if;
  if old.state <> 'draft' and (
       new.number is distinct from old.number or new.issue_date is distinct from old.issue_date
    or new.partner_id is distinct from old.partner_id or new.total is distinct from old.total
    or new.untaxed is distinct from old.untaxed or new.vat_total is distinct from old.vat_total
    or new.tax_breakdown is distinct from old.tax_breakdown or new.partner_snapshot is distinct from old.partner_snapshot
    or new.invoice_type is distinct from old.invoice_type
    or (new.state = 'draft')) then
    raise exception 'Factura % emitida: es inmutable (use una rectificativa)', old.number;
  end if;
  return new;
end
$$;
create trigger invoice_guard before update or delete on invoice
  for each row execute function sindri_invoice_guard();

create function sindri_invoice_line_guard() returns trigger language plpgsql as $$
declare st text;
begin
  select state into st from invoice where id = coalesce(new.invoice_id, old.invoice_id);
  if st is not null and st <> 'draft' then
    raise exception 'Las líneas de una factura emitida no se pueden modificar';
  end if;
  return coalesce(new, old);
end
$$;
create trigger invoice_line_guard before insert or update or delete on invoice_line
  for each row execute function sindri_invoice_line_guard();

create table payment (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoice (id),
  amount numeric(18, 2) not null check (amount > 0),
  paid_on date not null default current_date,
  method text not null default 'transfer',
  created_at timestamptz not null default now()
);

-- VERI*FACTU: registros de facturación encadenados ----------------------------
create table verifactu_record (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company (id),
  seq bigint not null,
  kind text not null check (kind in ('alta', 'anulacion')),
  invoice_id uuid not null references invoice (id),
  fields jsonb not null, -- campos exactos usados para la huella
  previous_hash text not null,
  hash text not null,
  qr_url text,
  created_at timestamptz not null default now(),
  unique (company_id, seq)
);
create trigger verifactu_record_immutable before update or delete on verifactu_record
  for each row execute function sindri_forbid_change();

-- Bandeja de salida: envíos a AEAT, FACe, EDI... con reintentos e idempotencia --
create table outbox (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  aggregate_id uuid,
  payload jsonb not null,
  state text not null default 'pending' check (state in ('pending', 'sent', 'error')),
  attempts int not null default 0,
  last_error text,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index outbox_pending_idx on outbox (state, available_at);

-- Auditoría ---------------------------------------------------------------------
create table event_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null default 'system',
  entity text not null,
  entity_id uuid,
  action text not null,
  data jsonb
);
create trigger event_log_immutable before update or delete on event_log
  for each row execute function sindri_forbid_change();

-- Datos iniciales ----------------------------------------------------------------
insert into location (code, name, kind) values
  ('WH/STOCK', 'Almacén principal', 'internal'),
  ('PARTNER/SUPPLIER', 'Proveedores', 'supplier'),
  ('PARTNER/CUSTOMER', 'Clientes', 'customer'),
  ('VIRTUAL/PRODUCTION', 'Producción', 'production'),
  ('VIRTUAL/ADJUST', 'Ajustes de inventario', 'adjustment');
