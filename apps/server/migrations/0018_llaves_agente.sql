-- Llaves de agente (sda_…): un programa (p. ej. un hilo de Claude) trabaja en UNA empresa con la
-- API de siempre, sin Keycloak y sin la contraseña de la empresa. Solo consultar, o consultar y
-- cambiar; nunca usuarios, roles, contraseñas ni llaves. Aquí solo queda la huella (sha256).
create table agent_key (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company (id),
  name text not null,
  level text not null check (level in ('consultar', 'cambiar')),
  key_hash text not null unique,
  key_end text not null,
  created_by text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index agent_key_company_idx on agent_key (company_id);
