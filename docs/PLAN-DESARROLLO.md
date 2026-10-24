# Plan de desarrollo de Sindri

24-10-2026. Estado de partida: `main` en `943ccb9` (PR #1 a #25). Recoge lo que **falta por implementar**, en orden, y las decisiones pendientes. El diseño de detalle de módulos, APIs y escritorio está en `docs/MODULOS-Y-ESCRITORIO.md` (PR #19).

Brook (el CRM) se planifica aparte, en su propio hilo. Este plan no decide nada sobre Brook.

## Sindri base y Sindri de cliente

- **Sindri base**: el Sindri de PRO que ya existe. Lo comparten Luis, Ivan (empresa 002, reservada con contraseña) y las empresas DEMO. Solo lleva el núcleo y **módulos oficiales** (báscula, etiquetas…), nunca personalizaciones de un cliente.
- **Sindri de cliente**: cada cliente que pague y pida personalizaciones tiene su propio Sindri (contenedor, PostgreSQL y módulos propios). Dentro de él, las varias empresas sirven para las sociedades de su grupo.

Por qué: las varias empresas (#18, #22, #23) separan los **datos**, pero no el **código**. Un módulo corre dentro del proceso de Sindri y ve su base, así que en un Sindri compartido la personalización de un cliente se cargaría también para los demás.

## Qué ya está hecho

- Ciclo cliente → pedido → hoja de ruta → albarán → factura → cobro.
- VERI\*FACTU generado al emitir (huella encadenada, QR, bandeja de salida) y anulación con rectificativa R1.
- Varias empresas, maestros compartidos, acceso por grupos de Keycloak, empresa reservada con contraseña, invitados con rol, administración por empresa.
- CRM dentro de Sindri (oportunidades, seguimiento, presupuestos).
- Report Server, Mail, API de integraciones (`/api/integracion/v1`, llave `sdi_…`), exportación CSV/XML/JSON, grafo de Relaciones, móvil y plantilla común de las apps.
- Escritorio Electron 0.1.0 y agente de planta OPC UA con simulador.

## Qué falta, por fases

Cada fase se prueba en local y en DEV antes de seguir.

### Fase 0 · Orden de la casa

- [ ] Fusionar el PR #19 (diseño de módulos en el repo).
- [ ] Partir `apps/server/src/services.ts` (unas 1.115 líneas) y `app.ts` por áreas: ventas, almacén, facturas y VERI\*FACTU, CRM, planta, empresas y usuarios, integraciones. Sin cambiar comportamiento; las pruebas actuales deben pasar igual.

### Fase 1 · Datos reales a salvo (bloquea PRO)

- [ ] Pasar Sindri PRO de PGlite a PostgreSQL cuando `larceing/servidor` dé PostgreSQL por app.
- [ ] Copia de `/datos` fuera del disco, con aviso si falla.
- [ ] Llevar los datos actuales de PRO a PostgreSQL sin romper la cadena VERI\*FACTU ni la numeración. Irreversible en PRO: solo con el sí de Luis.

### Fase 2 · VERI\*FACTU completo (fecha legal)

- [ ] Envío SOAP a la AEAT con certificado desde la bandeja de salida, respuestas y subsanación.
- [ ] Factura simplificada (F2) y rectificativas R2 a R5.
- [ ] Declaración responsable del productor del software.
- [ ] Repaso con la gestoría.

Fecha: según el RDL 15/2025, 1-1-2027 para sociedades y 1-7-2027 para el resto. Confirmar en el BOE que no ha cambiado. Hasta cerrar esta fase, no se emiten facturas reales a terceros.

### Fase 3 · Contrato de APIs

- [ ] OpenAPI de `/api/v1`, `/api/planta/v1` y `/api/integracion/v1`, generada desde los esquemas zod, en `.../openapi.json`.
- [ ] Errores siempre con `error` y un `codigo` estable (hoy llevan `error` y a veces `code`).
- [ ] Listas con `?limite=` y `?cursor=`.
- [ ] `Idempotency-Key` en los `POST` que crean cosas.

### Fase 4 · Actualización automática del escritorio

- [ ] `electron-updater` con canal DEV y canal PRO, instalador firmado y comprobación de `escritorio_minima` al arrancar.
- [ ] Prueba: `escritorio-v0.2.0` que se instala solo sobre el `0.1.0`.

### Fase 5 · Módulos: cargador, eventos y pantallas

- [ ] Manifiesto `sindri-modulo.json`, comprobación de versión del núcleo y de permisos.
- [ ] Migraciones con prefijo `m_<id>_` y rutas en `/api/m/<id>/v1`.
- [ ] Cola de eventos del núcleo (`pedido.confirmado`, `factura.emitida`, `stock.movido`, `planta.parada`) con reintentos.
- [ ] Pantallas de módulos en la web y el escritorio, dentro de los grupos del menú común (Ventas, Operación, Facturación, Informes, Empresa).
- [ ] Un módulo de ejemplo.

### Fase 6 · Compras y fabricación

- [ ] Compras: pedido, recepción parcial, factura de proveedor y pago.
- [ ] Fabricación: listas de materiales multinivel, órdenes con consumo y salida por lote, coste real, trazabilidad lote a lote.

### Fase 7 · Puente del PC, báscula y etiquetas

- [ ] `window.sindri.pc` en el escritorio y el primer auxiliar nativo.
- [ ] Báscula por puerto serie con simulador e impresión ZPL (producto, lote, SSCC/GS1-128), como módulos oficiales.

### Fase 8 · Herramientas para personalizaciones

- [ ] Plantilla de repositorio de módulo, `sindri modulo nuevo`, pruebas contra la versión mínima y máxima del núcleo, publicación firmada.
- [ ] Ajustes de módulos: instalar, actualizar, volver atrás y ver permisos, DEV primero.

### Después

Taller y PDA sin conexión, expediciones con SSCC y DeCA, copias con restauración en un clic, y la Fase 2 de `docs/HOJA-DE-RUTA.md` (factura electrónica B2B, EDI, calidad, mantenimiento, MRP, contabilidad).

## Decisiones pendientes

Las fases 0 a 4 no dependen de ninguna.

| # | Pregunta | Recomendación | Afecta a |
| --- | --- | --- | --- |
| 1 | ¿Sindri base compartido y un Sindri propio por cliente con personalizaciones? | Sí, como se describe arriba | Fase 5 en adelante |
| 2 | ¿Dónde viven los módulos de clientes? | Repos privados en `larceing`, uno por módulo, desde una plantilla | Fase 8 |
| 3 | ¿Módulos de clientes abiertos (AGPL) o cerrados? | Abiertos, entregando el código al cliente. Si se quieren cerrados, decidirlo antes de la fase 5 | Fase 5 |
| 4 | ¿Certificado de firma de Windows? | Sí, antes del primer cliente en PRO; DEV no lo necesita | Fase 4 |
| 5 | ¿Electron con auxiliares nativos o una app entera en Java? | Electron con auxiliares | Fases 4 y 7 |
| 6 | ¿Datos a salvo y VERI\*FACTU antes que la plataforma de módulos? | Sí, por la fecha legal | Orden general |

## Riesgos

- **VERI\*FACTU**: si se factura como sociedad, el envío a la AEAT tiene que estar en PRO antes del 1-1-2027.
- **PostgreSQL** depende de `larceing/servidor`; si tarda, se retrasan los datos reales.
- **Partir `services.ts`** toca casi todo el servidor; se hace sin cambiar comportamiento y con las pruebas actuales como red.
- **Firma de Windows**: el certificado tarda días o semanas; conviene pedirlo con tiempo.
