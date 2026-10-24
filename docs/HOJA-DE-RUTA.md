# Hoja de ruta propuesta

El orden sigue el ciclo de negocio y los huecos detectados en la investigación: integración con planta, normativa española nativa, y taller, calidad y PDA incluidos sin coste.

> Lo que falta, en orden y con las decisiones pendientes, está en [PLAN-DESARROLLO.md](PLAN-DESARROLLO.md) (24-10-2026).

## Fase 0 · Esqueleto (hecho, v0.1)

- [x] Monorepo con TypeScript, pruebas y licencia AGPL.
- [x] Modo escritorio sin servidor y modo servidor de empresa con PostgreSQL.
- [x] Clientes, productos, almacén con lotes y FEFO, pedido, albarán, factura y cobro.
- [x] VERI\*FACTU: huella encadenada, QR, inmutabilidad y bandeja de salida.

## Fase 1 · MVP vendible

1. **Usuarios, roles y permisos** (todo / equipo / propio, y por campo), con inicio de sesión.
2. **Envío VERI\*FACTU a la AEAT**: SOAP con certificado, subsanación, anulación y facturas rectificativas (R1-R5). Factura simplificada (F2).
3. **Compras**: pedido, recepción parcial, factura de proveedor y pago.
4. **Fabricación**:
   - listas de materiales multinivel;
   - órdenes de fabricación con consumo por lote y lote de salida;
   - coste real (materiales + tiempo);
   - trazabilidad registrada lote a lote.
5. **Pantalla de taller y PDA** (web progresiva con modo sin conexión): fichar operaciones, consumir y producir leyendo códigos de barras.
6. **Etiquetas ZPL** (producto, lote, SSCC/GS1-128) impresas desde el servidor a las Zebra de la red.
7. **Báscula** por RS-232/TCP a través del gateway.
8. **Expediciones**:
   - bultos y palés con SSCC;
   - albarán valorado y DeCA;
   - conector con un agregador de transportistas.
9. **CRM ligero**: oportunidades → presupuesto → pedido (hecho); falta la agenda de visitas y el PDF del presupuesto en el Report Server.
10. **Copias de seguridad** automáticas y restauración con un clic.

## Fase 2

- Factura electrónica B2B (Crea y Crece) con estados de pago, Facturae + FACe, y SII.
- EDI AECOC/GS1: ORDERS, DESADV, RECADV, INVOIC.
- Calidad: planes de control, cuarentena de lote y no conformidades.
- Mantenimiento preventivo por calendario y por contador de máquina.
- MRP (necesidades) y planificación con capacidad finita.
- Gateway de planta con OPC UA, Modbus TCP, S7 y MQTT/Sparkplug.
- Contabilidad: asientos automáticos, modelos 303/390/347/349, conciliación bancaria (Norma 43) y remesas SEPA.
- Sincronización de varios puestos de escritorio que trabajan desconectados.

## Futuro

- Proyectos, RRHH básico y portal de clientes.
- Versión en la nube gestionada.
- TicketBAI / Batuz para clientes del País Vasco.
