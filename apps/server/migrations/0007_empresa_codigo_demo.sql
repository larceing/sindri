-- Código de empresa (001, 002…) para reconocerla y filtrar, y marca de empresa de demostración.
-- Las de demo están abiertas a cualquiera que entre en Sindri; la real, solo a quien se le asigne.
alter table company add column code text;
alter table company add column demo boolean not null default false;

update company c set code = lpad(n::text, 3, '0')
from (select id, row_number() over (order by created_at, id) as n from company) o
where o.id = c.id and c.code is null;

create unique index company_code_idx on company (code) where not archived;

-- Las empresas que carga el sistema de prueba (demo.ts) llevan NIF inventados: son de demo.
update company set demo = true where tax_id in ('B20128567', 'B41234568');
