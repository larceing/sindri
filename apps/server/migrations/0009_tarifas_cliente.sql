-- Tarifa propia de un cliente para un producto o servicio (p. ej. su precio por hora). Es el precio
-- que sale en sus presupuestos y pedidos, y en lo que llega por facturar sin precio. El descuento
-- habitual sigue en la ficha del cliente y se aplica encima. Solo se añade: compatible con 0008.
create table partner_price (
  partner_id uuid not null references partner (id) on delete cascade,
  product_id uuid not null references product (id) on delete cascade,
  unit_price numeric(18, 6) not null check (unit_price >= 0),
  updated_at timestamptz not null default now(),
  primary key (partner_id, product_id)
);
