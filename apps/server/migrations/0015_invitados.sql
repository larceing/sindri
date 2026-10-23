-- Invitar a otra persona a la empresa en uso con el rol que se elija (como en un ERP): quien
-- administra la empresa decide qué ve y qué toca quien invita. El rol de la invitación manda
-- dentro de esa empresa; fuera de ella, cada uno sigue con lo suyo.
alter table user_company add column role_id uuid references role (id);
alter table user_company add column invited_by text;
alter table user_company add column invited_at timestamptz;
