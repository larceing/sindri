-- Conexión con planta (docs/INSTRUCCIONES.md, parte C).
-- El agente de planta abre la conexión desde la fábrica y solo manda lecturas: el ERP nunca
-- entra en la red de máquinas ni escribe en ella.

-- Agentes: uno por instalación y entorno. Del token solo se guarda el hash.
create table plant_agent (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  token_hash text not null unique,
  token_hint text not null,
  created_at timestamptz not null default now(),
  created_by text,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  last_version text,
  last_status jsonb
);

-- Máquinas y tags: es la configuración que el agente descarga (GET /api/planta/v1/config).
create table plant_machine (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  agent_id uuid references plant_agent(id),
  -- Espacio de nombres OPC UA donde están sus tags (p. ej. urn:sindri:simulador).
  namespace_uri text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table plant_tag (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references plant_machine(id) on delete cascade,
  key text not null,
  -- Camino desde Objects, separado por "/": Planta/Linea1/Estado.
  source text not null,
  -- state y text: se manda cada cambio. counter y value: un resumen por minuto.
  kind text not null check (kind in ('state', 'counter', 'value', 'text')),
  label text,
  unit text,
  unique (machine_id, key)
);

-- Lecturas. El id lo pone el agente, así un reenvío no cuenta dos veces.
create table plant_reading (
  agent_id uuid not null references plant_agent(id),
  reading_id text not null,
  machine_code text not null,
  tag_key text not null,
  kind text not null check (kind in ('change', 'minute')),
  ts timestamptz not null,
  value double precision,
  text_value text,
  min_value double precision,
  max_value double precision,
  avg_value double precision,
  samples int,
  received_at timestamptz not null default now(),
  primary key (agent_id, reading_id)
);
create index plant_reading_machine_ts on plant_reading (machine_code, tag_key, ts desc);
create index plant_reading_kind_ts on plant_reading (kind, ts);
