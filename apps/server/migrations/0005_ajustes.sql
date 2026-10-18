-- Ajustes de Sindri que se cambian desde la propia pantalla (p. ej. la conexión con el
-- Report Server), para no tener que tocar app.env a mano. Solo se añade: compatible con 0004.
create table if not exists app_setting (
  key text primary key,
  value jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);
