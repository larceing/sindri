-- Contraseña de la empresa: además de entrar con Keycloak, para trabajar en una empresa que la
-- tenga hay que escribirla al elegirla. Va en su propia tabla para que nunca salga con la ficha.
create table company_access (
  company_id uuid primary key references company (id),
  password_hash text not null,
  changed_at timestamptz not null default now(),
  changed_by text
);
