-- Rectificativas: una factura emitida y sin cobrar se anula entera con una rectificativa (serie R,
-- tipo R1) de importe negativo. Las dos quedan «rectificada» y dejan de salir como pendientes.
-- Solo se añade: compatible con la versión anterior.
alter table invoice drop constraint if exists invoice_state_check;
alter table invoice add constraint invoice_state_check check (state in ('draft', 'issued', 'paid', 'discarded', 'rectified'));
alter table invoice add column if not exists rectifies_id uuid references invoice (id);
alter table invoice add column if not exists rectification_reason text;
create unique index if not exists invoice_rectifies_once on invoice (rectifies_id) where rectifies_id is not null and state <> 'discarded';
