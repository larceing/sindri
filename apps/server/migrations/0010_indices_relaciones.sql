-- Índices en las claves que unen documentos (líneas, cobros, albaranes, contactos…). Las listas de
-- pedidos y facturas y el grafo de relaciones las consultan por cada fila. Solo se añaden índices:
-- compatible con 0009.
create index if not exists sales_order_line_order_idx on sales_order_line (order_id);
create index if not exists invoice_line_invoice_idx on invoice_line (invoice_id);
create index if not exists payment_invoice_idx on payment (invoice_id);
create index if not exists delivery_order_idx on delivery (order_id);
create index if not exists delivery_route_stop_order_idx on delivery_route_stop (order_id);
create index if not exists partner_contact_partner_idx on partner_contact (partner_id);
create index if not exists partner_address_partner_idx on partner_address (partner_id);
create index if not exists quotation_line_quotation_idx on quotation_line (quotation_id);
create index if not exists invoice_order_idx on invoice (order_id);
create index if not exists verifactu_record_invoice_idx on verifactu_record (invoice_id);
create index if not exists stock_move_lot_idx on stock_move (lot_id);
create index if not exists billable_item_order_idx on billable_item (order_id);
create index if not exists outbox_aggregate_idx on outbox (aggregate_id);
