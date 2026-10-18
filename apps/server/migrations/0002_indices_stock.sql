-- Índices para que el cálculo de existencias no recorra todo el libro de movimientos.
create index stock_move_product_lot_idx on stock_move (product_id, lot_id);
create index stock_move_to_idx on stock_move (to_location_id, product_id);
create index stock_move_from_idx on stock_move (from_location_id, product_id);
create index stock_move_reference_idx on stock_move (reference_type, reference_id);
create index sales_order_partner_idx on sales_order (partner_id);
create index invoice_partner_idx on invoice (partner_id);
create index event_log_entity_idx on event_log (entity, entity_id);
