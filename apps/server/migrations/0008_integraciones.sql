-- Integraciones: otras apps (gestor de incidencias, gestor de tareas…) hablan con Sindri con una
-- llave de una empresa. Leen sus clientes y productos y le mandan lo que hay que facturar.
-- Solo se añade: compatible con 0007.

create table integration_key (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company (id),
  -- Nombre de la app que la usa (incidencias, tareas…): es también el origen de lo que manda.
  name text not null,
  key_hash text not null unique,
  key_end text not null,
  created_by text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index integration_key_company_idx on integration_key (company_id);

-- Lo que otra app manda para facturar (horas, servicios…). Queda pendiente hasta que alguien
-- lo pasa a un pedido. La app lo identifica con su propia referencia: mandarlo otra vez lo
-- actualiza mientras siga pendiente, nunca lo duplica.
create table billable_item (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company (id),
  source text not null,
  external_ref text not null,
  key_id uuid references integration_key (id),
  partner_id uuid not null references partner (id),
  product_id uuid not null references product (id),
  description text not null,
  item_date date not null,
  quantity numeric(18, 4) not null check (quantity > 0),
  unit_price numeric(18, 6),
  state text not null default 'pending' check (state in ('pending', 'ordered', 'discarded')),
  order_id uuid references sales_order (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, source, external_ref)
);
create index billable_item_pending_idx on billable_item (company_id, state, partner_id);

-- Confirmación de pedidos por correo (con el PDF del pedido), por empresa.
alter table company add column order_mail boolean not null default false;
alter table sales_order add column mailed_at timestamptz;
