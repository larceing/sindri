-- CRM y presupuestos: oportunidades en un embudo, actividades de seguimiento, modelos de
-- presupuesto editables y presupuestos que, al aceptarse, pasan a pedido.
--
-- Solo se añade: tablas nuevas y una columna que admite nulo en sales_order, así que la
-- versión anterior sigue funcionando sobre esta base.

-- Oportunidades ---------------------------------------------------------------------
-- Puede ser de un cliente ya dado de alta o de alguien que todavía no lo es (prospect_*).
create table opportunity (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company (id),
  number text not null,
  title text not null,
  partner_id uuid references partner (id),
  prospect_name text,
  contact_name text,
  email text,
  phone text,
  stage text not null default 'new' check (stage in ('new', 'contacted', 'proposal', 'won', 'lost')),
  amount numeric(18, 2),
  probability int check (probability between 0 and 100),
  expected_close date,
  sales_rep_id uuid references sales_rep (id),
  source text,
  notes text,
  lost_reason text,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, number),
  check (partner_id is not null or prospect_name is not null)
);
create index opportunity_company_stage_idx on opportunity (company_id, stage);
create index opportunity_partner_idx on opportunity (partner_id);

-- Actividades: llamadas, correos, reuniones, tareas y notas, con fecha para el seguimiento.
create table crm_activity (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company (id),
  opportunity_id uuid references opportunity (id) on delete cascade,
  partner_id uuid references partner (id),
  kind text not null default 'task' check (kind in ('call', 'email', 'meeting', 'task', 'note')),
  subject text not null,
  due_date date,
  done_at timestamptz,
  notes text,
  created_by text not null default 'system',
  created_at timestamptz not null default now()
);
create index crm_activity_company_due_idx on crm_activity (company_id, done_at, due_date);
create index crm_activity_opportunity_idx on crm_activity (opportunity_id);

-- Modelos de presupuesto (de proyecto, de soporte…): título y textos de partida que se
-- copian al presupuesto y allí se pueden retocar.
create table quotation_template (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company (id),
  name text not null,
  title text not null,
  intro text,
  conditions text,
  validity_days int not null default 30 check (validity_days between 1 and 365),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

-- Presupuestos -----------------------------------------------------------------------
create table quotation (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company (id),
  number text not null,
  partner_id uuid not null references partner (id),
  opportunity_id uuid references opportunity (id),
  template_id uuid references quotation_template (id),
  title text not null,
  intro text,
  conditions text,
  quote_date date not null default current_date,
  valid_until date,
  state text not null default 'draft' check (state in ('draft', 'sent', 'accepted', 'rejected', 'cancelled')),
  sales_rep_id uuid references sales_rep (id),
  order_id uuid references sales_order (id),
  notes text,
  reject_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, number)
);
create index quotation_company_state_idx on quotation (company_id, state);
create index quotation_partner_idx on quotation (partner_id);
create index quotation_opportunity_idx on quotation (opportunity_id);

create table quotation_line (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references quotation (id) on delete cascade,
  position int not null,
  product_id uuid not null references product (id),
  description text not null,
  quantity numeric(18, 4) not null check (quantity > 0),
  unit_price numeric(18, 6) not null,
  discount_pct numeric(5, 2) not null default 0,
  vat_rate numeric(5, 2) not null
);

-- El pedido que sale de un presupuesto aceptado sabe de dónde viene.
alter table sales_order add column quotation_id uuid references quotation (id);

-- Permisos de partida: lo que ya tenga cada rol no se toca.
update role set permissions = '{"crm":"editar","presupuestos":"editar"}'::jsonb || permissions where name in ('Administración', 'Comercial');
update role set permissions = '{"crm":"ver","presupuestos":"ver"}'::jsonb || permissions where name = 'Consulta';
