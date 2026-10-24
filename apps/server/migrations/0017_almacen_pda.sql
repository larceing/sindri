-- Fase 2 de la PDA (docs/PDA.md §9): ubicaciones, reserva del pedido al prepararlo y
-- recuentos de inventario a ciegas con ajuste aprobado.

-- Ubicaciones hijas (estanterías, huecos) bajo el almacén de cada empresa. El código es lo que
-- lleva la etiqueta de la ubicación y lo que lee la PDA.
alter table location add column archived boolean not null default false;
create index location_parent_idx on location (parent_id);

-- Quién está preparando el pedido, para que dos personas no hagan el mismo.
alter table sales_order add column picked_by text;
alter table sales_order add column picking_since timestamptz;

-- Recuentos de inventario. Mientras está abierto, quien cuenta no ve lo que dice Sindri (a ciegas).
-- Al aprobarlo se guardan las diferencias y se crean los movimientos de ajuste.
create table stock_count (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company (id),
  number text not null,
  state text not null default 'open' check (state in ('open', 'counted', 'approved', 'cancelled')),
  -- Ubicación que se cuenta (y todas las que cuelgan de ella). Nula: todo el almacén.
  location_id uuid references location (id),
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  counted_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  unique (company_id, number)
);

-- Cada lectura de la PDA es una entrada con su id: reenviarla sin conexión no la cuenta dos veces.
create table stock_count_entry (
  id uuid primary key,
  count_id uuid not null references stock_count (id),
  product_id uuid not null references product (id),
  lot_id uuid references lot (id),
  location_id uuid not null references location (id),
  quantity numeric(18, 4) not null check (quantity >= 0),
  counted_by text not null,
  counted_at timestamptz not null default now()
);
create index stock_count_entry_count_idx on stock_count_entry (count_id);
create trigger stock_count_entry_immutable before update or delete on stock_count_entry
  for each row execute function sindri_forbid_change();

-- Foto de las diferencias al aprobar: lo que decía Sindri, lo contado y el ajuste.
create table stock_count_line (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references stock_count (id),
  product_id uuid not null references product (id),
  lot_id uuid references lot (id),
  location_id uuid not null references location (id),
  expected numeric(18, 4) not null,
  counted numeric(18, 4) not null,
  difference numeric(18, 4) not null
);
create index stock_count_line_count_idx on stock_count_line (count_id);
