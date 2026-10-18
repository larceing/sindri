# Arquitectura de Sindri ERP

## 1. Objetivo: que la fábrica no dependa de internet

```
                ┌──────────────────── Red local de la fábrica ───────────────────┐
                │                                                                 │
 PCs oficina ───┤                                                                 │
 Tablets taller ┼──► Servidor Sindri (Node) ──► PostgreSQL                          │
 PDAs almacén ──┤        │  API REST + web                                        │
                │        │                                                        │
                │        ├──► Bandeja de salida ──(cuando hay internet)──► AEAT, FACe, transportistas, EDI
                │        │                                                        │
                │        └──◄ Gateway de planta (fase 2) ◄── PLC (OPC UA / Modbus), básculas, impresoras ZPL
                └─────────────────────────────────────────────────────────────────┘

 Puesto aislado / comercial de viaje:  App de escritorio = servidor + base de datos embebida (PGlite)
```

Hay tres formas de usarlo, y en las tres el código es el mismo:

| Modo | Para quién | Base de datos | ¿Internet? |
|---|---|---|---|
| **Escritorio local** | Un puesto, demo, autónomo | PGlite (PostgreSQL en WebAssembly) dentro de la app | No |
| **Servidor de empresa** | Varios usuarios en la fábrica, PDAs | PostgreSQL en un PC o servidor de la red | No (solo para envíos a terceros) |
| **Nube (futuro)** | Quien no quiera servidor propio | PostgreSQL gestionado | Sí |

En la app de escritorio, el menú "Conexión" cambia entre modo local y servidor de empresa.

## 2. Decisiones y por qué

Las decisiones salen de lo aprendido al analizar Odoo, ERPNext, Dolibarr, Tryton, Axelor, iDempiere y metasfresh (ver `/investigacion-erp-opensource/` del proyecto).

| Decisión | Motivo |
|---|---|
| **TypeScript de punta a punta** (servidor, web, escritorio) | Un solo lenguaje y las mismas reglas de negocio (`@sindri/core`) en servidor y pantalla. Así se evita lo que hacen Odoo y ERPNext, que duplican el cálculo de impuestos en Python y en JS. |
| **PostgreSQL, y el mismo SQL en PGlite** | El modo local no es una versión rebajada: usa el mismo motor y las mismas migraciones. |
| **SQL explícito y migraciones versionadas** (`apps/server/migrations`) | En Odoo el esquema se deriva de las clases y migrar entre versiones es de pago. Aquí cada cambio de esquema es un fichero revisable. |
| **Libro de movimientos inmutable** para el stock; existencias calculadas | Una sola fuente de verdad (idea de Tryton y ERPNext). Así se evitan los saldos sin bloqueo de Dolibarr y Axelor. |
| **Decimal exacto con BigInt** para importes y cantidades | Tryton guarda cantidades en float. Aquí nunca se usa coma flotante. |
| **Máquinas de estado declarativas** y error explícito ante una transición ilegal | Tryton ignora en silencio algunos cambios de estado no válidos. Aquí siempre hay error. |
| **Factura: número al emitir, inmutable, corrección por rectificativa** | ERPNext numera en borrador y permite cancelar facturas emitidas, y Dolibarr deja borrarlas. Las dos cosas chocan con VERI\*FACTU. |
| **Registro VERI\*FACTU en la misma transacción que la emisión, sin red** | En Odoo el registro no se crea al validar y exige descargar el WSDL de la AEAT. |
| **Bandeja de salida (outbox)** con reintentos | La fábrica sigue facturando aunque se caiga internet. Los envíos son idempotentes y respetan el orden de la cadena. |
| **Protección en la base de datos** (triggers) del libro de stock, las facturas emitidas, los registros fiscales y la auditoría | Aunque alguien entre directamente a la base de datos, no puede alterar lo legal sin dejar error. |
| **API REST como única vía** (la web, el escritorio, las PDA y la planta usan la misma) | ERPNext tiene lógica que solo existe en el formulario JS. Aquí la PDA o la báscula pueden hacer todo lo que hace la pantalla. |
| **Identificadores UUID** | Preparados para sincronizar puestos que trabajen desconectados. |
| **Router por hash en la web** | La misma web funciona servida por el servidor, dentro de Electron o abierta desde un fichero. |
| **AGPL-3.0** | Es open source y obliga a publicar las mejoras incluso a quien lo ofrezca como servicio en la nube. Como autor, Luis puede además ofrecer licencias comerciales (doble licencia). |

## 3. Paquetes

### `@sindri/core` (sin entrada/salida, 100 % probado con tests)

| Fichero | Contenido |
|---|---|
| `decimal.ts` | Clase `Dec` exacta, con redondeo comercial |
| `tax.ts` | Totales con desglose por tipo de IVA, recargo de equivalencia e IRPF |
| `states.ts` | Máquinas de estado de pedido y factura |
| `identifiers.ts` | NIF/NIE/CIF, dígito de control GS1, SSCC-18 |
| `verifactu.ts` | Huella de alta y de anulación, verificación de cadena, URL del QR, fecha con huso de Madrid |

### `@sindri/server`

| Fichero | Contenido |
|---|---|
| `db.ts` | Adaptador común para PostgreSQL y PGlite |
| `migrate.ts` | Migraciones versionadas |
| `services.ts` | Casos de uso en transacción, con auditoría |
| `app.ts` | Rutas REST, validación con zod y errores en español |
| `grafo.ts` | Relaciones: cada registro es un nodo y cada vínculo una arista (cliente → oportunidad → presupuesto → pedido → albarán / hoja de ruta / factura → lote / cobro). `GET /api/v1/grafo?tipo=&id=` recorre la cadena; `GET /api/v1/grafo/buscar?q=` busca en todos los tipos. Un tipo nuevo (fabricación, tareas, correos…) se añade en el registro `TIPOS` |

### `@sindri/web`

React. Pantallas de pedidos, facturas (con QR), clientes, productos, almacén, VERI\*FACTU y empresa. **Relaciones** dibuja el grafo de cualquier registro (diagrama por columnas con su traza al pulsar un nodo, o lista) y se abre desde el menú, desde el botón «Relaciones» de cada ficha y desde los lotes de Almacén.

### `@sindri/escritorio`

Electron. Una ventana sobre la web de Sindri (DEV o PRO): sin base de datos ni secretos en el PC. Ver `escritorio/README.md`.

## 4. Pendiente de validar antes de producción

- **VERI\*FACTU:** falta probar el envío real contra el entorno de pruebas de la AEAT (SOAP con certificado). La huella ya reproduce los dos ejemplos oficiales. Hay que confirmar cómo se calcula `ImporteTotal` cuando hay retención de IRPF.
- **Calendario:** el BOE fija el 1-1-2027 (sociedades) y el 1-7-2027 (resto). Hacienda anunció un aplazamiento a 2028 que aún no está publicado en el BOE.
- **Declaración responsable:** como productor del software, Luis tiene que emitirla antes de comercializarlo.
