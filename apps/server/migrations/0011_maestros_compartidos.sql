-- Varias empresas en la misma base, cada una con lo suyo, pero con los datos maestros en común.
--
--  - master_company_id: la empresa que guarda los maestros (clientes con sus contactos,
--    direcciones y tarifas, productos y servicios, modelos de presupuesto). Si es nulo, la
--    empresa guarda los suyos. Un solo nivel: la empresa de los maestros no apunta a otra.
--  - restricted: empresa reservada. Solo la ven quienes estén en su grupo de Keycloak
--    (<grupo de la app>/Empresa/<código>), también los administradores.
--
-- Presupuestos, pedidos, albaranes, hojas de ruta, facturas, VERI*FACTU, stock, comerciales,
-- oportunidades e informes siguen siendo de cada empresa.
-- Compatible con la versión anterior: las dos columnas nuevas no cambian nada si no se tocan.

alter table company add column master_company_id uuid references company (id);
alter table company add column restricted boolean not null default false;

-- La empresa que guarda los maestros de otra (ella misma si no comparte).
create function maestro(empresa uuid) returns uuid
language sql stable as $$
  select coalesce((select master_company_id from company where id = empresa), empresa)
$$;

create index company_master_idx on company (master_company_id);
create index location_company_internal_idx on location (company_id) where kind = 'internal';
