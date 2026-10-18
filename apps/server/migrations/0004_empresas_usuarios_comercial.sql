-- Varias empresas, usuarios con roles y departamentos, comerciales, ficha de cliente
-- completa, separar pedidos y hojas de ruta.
--
-- Compatible con la versión anterior: todas las columnas nuevas admiten nulo y los
-- documentos de la primera empresa conservan sus códigos (WH/STOCK, series sin sufijo).
-- Si una versión vieja escribe algo sin empresa, al arrancar se asigna a la primera.

-- Empresas --------------------------------------------------------------------------
alter table company add column trade_name text;
alter table company add column archived boolean not null default false;

-- Cada dato es de una empresa -------------------------------------------------------
alter table partner add column company_id uuid references company (id);
alter table product add column company_id uuid references company (id);
alter table location add column company_id uuid references company (id);
alter table sales_order add column company_id uuid references company (id);
alter table delivery add column company_id uuid references company (id);
alter table invoice add column company_id uuid references company (id);
alter table event_log add column company_id uuid;

update partner set company_id = (select id from company order by created_at limit 1) where company_id is null;
update product set company_id = (select id from company order by created_at limit 1) where company_id is null;
update location set company_id = (select id from company order by created_at limit 1) where company_id is null and kind = 'internal';
update sales_order set company_id = (select id from company order by created_at limit 1) where company_id is null;
update delivery set company_id = (select id from company order by created_at limit 1) where company_id is null;
update invoice set company_id = (select id from company order by created_at limit 1) where company_id is null;

-- Los números y códigos se repiten entre empresas, nunca dentro de una.
alter table sales_order drop constraint sales_order_number_key;
create unique index sales_order_company_number on sales_order (company_id, number);
alter table delivery drop constraint delivery_number_key;
create unique index delivery_company_number on delivery (company_id, number);
alter table invoice drop constraint invoice_number_key;
create unique index invoice_company_number on invoice (company_id, number);
alter table product drop constraint product_sku_key;
create unique index product_company_sku on product (company_id, sku);
alter table location drop constraint location_code_key;
create unique index location_company_code on location (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), code);

create index partner_company_idx on partner (company_id);
create index product_company_idx on product (company_id);
create index sales_order_company_idx on sales_order (company_id);
create index invoice_company_idx on invoice (company_id);

-- Usuarios, roles y departamentos ---------------------------------------------------
-- Quién entra lo dice Keycloak; qué puede hacer dentro lo dice su rol en Sindri.
create table department (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

-- permissions: {"clientes": "editar", "pedidos": "ver", ...}. Lo que no aparece, no se ve.
create table role (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  permissions jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table app_user (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  name text,
  email text,
  role_id uuid references role (id),
  department_id uuid references department (id),
  active boolean not null default true,
  -- Menú de cada persona: {"posicion": "lateral|superior|inferior", "orden": [...], "ocultos": [...]}
  menu jsonb,
  last_company_id uuid references company (id),
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

create table user_company (
  user_id uuid not null references app_user (id) on delete cascade,
  company_id uuid not null references company (id),
  primary key (user_id, company_id)
);

insert into department (name) values ('Dirección'), ('Administración'), ('Comercial'), ('Almacén'), ('Producción'), ('Logística');

insert into role (name, description, permissions) values
  ('Administración', 'Todo, incluidos usuarios y empresas',
   '{"clientes":"editar","comerciales":"editar","pedidos":"editar","rutas":"editar","facturas":"editar","productos":"editar","almacen":"editar","planta":"editar","verifactu":"editar","informes":"editar","empresa":"editar","usuarios":"editar"}'),
  ('Comercial', 'Clientes y pedidos; consulta productos y stock',
   '{"clientes":"editar","comerciales":"ver","pedidos":"editar","rutas":"ver","facturas":"ver","productos":"ver","almacen":"ver","informes":"ver"}'),
  ('Almacén', 'Stock, entregas y hojas de ruta',
   '{"clientes":"ver","pedidos":"editar","rutas":"editar","productos":"ver","almacen":"editar","planta":"ver"}'),
  ('Producción', 'Planta, stock y productos',
   '{"productos":"ver","almacen":"editar","planta":"editar","pedidos":"ver"}'),
  ('Consulta', 'Ve todo y no cambia nada',
   '{"clientes":"ver","comerciales":"ver","pedidos":"ver","rutas":"ver","facturas":"ver","productos":"ver","almacen":"ver","planta":"ver","verifactu":"ver","informes":"ver","empresa":"ver"}');

-- Comerciales y representantes ------------------------------------------------------
create table sales_rep (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company (id),
  code text not null,
  name text not null,
  kind text not null default 'internal' check (kind in ('internal', 'agent')), -- de plantilla o representante externo
  user_id uuid references app_user (id),
  email text,
  phone text,
  zone text,
  commission_pct numeric(5, 2) not null default 0,
  tax_id text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

-- Ficha de cliente --------------------------------------------------------------------
alter table partner add column code text;
alter table partner add column trade_name text;
alter table partner add column province text;
alter table partner add column mobile text;
alter table partner add column website text;
alter table partner add column sales_rep_id uuid references sales_rep (id);
alter table partner add column payment_method text;
alter table partner add column payment_days int;
alter table partner add column credit_limit numeric(18, 2);
alter table partner add column discount_pct numeric(5, 2);
alter table partner add column iban text;
alter table partner add column route_zone text;
alter table partner add column delivery_notes text;

create table partner_contact (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references partner (id) on delete cascade,
  name text not null,
  position text,
  email text,
  phone text,
  notes text,
  created_at timestamptz not null default now()
);

create table partner_address (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references partner (id) on delete cascade,
  label text not null,
  address text,
  city text,
  postal_code text,
  province text,
  country text not null default 'ES',
  phone text,
  schedule text, -- horario de descarga
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

-- Pedidos: comercial, dirección de entrega y de dónde salió al separarlo -----------------
alter table sales_order add column sales_rep_id uuid references sales_rep (id);
alter table sales_order add column delivery_address_id uuid references partner_address (id);
alter table sales_order add column split_from_id uuid references sales_order (id);
alter table sales_order add column delivery_date date;

-- Hojas de ruta -----------------------------------------------------------------------
create table delivery_route (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company (id),
  number text not null,
  route_date date not null default current_date,
  driver text,
  vehicle text,
  zone text,
  state text not null default 'draft' check (state in ('draft', 'on_route', 'closed')),
  notes text,
  created_at timestamptz not null default now(),
  unique (company_id, number)
);

create table delivery_route_stop (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references delivery_route (id) on delete cascade,
  position int not null,
  order_id uuid not null references sales_order (id),
  state text not null default 'pending' check (state in ('pending', 'delivered', 'incident')),
  note text,
  done_at timestamptz,
  unique (route_id, order_id)
);

-- Report server: lectores con token propio, solo lectura ----------------------------------
create table report_reader (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company (id),
  name text not null,
  token_hash text not null unique,
  token_hint text not null,
  created_by text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
