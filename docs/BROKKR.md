# Brokkr: el CRM de Sindri

## Decisión

Brokkr será un **módulo oficial de Sindri con su propio repositorio** (`larceing/brokkr`), no una app aparte como Odin.

Por qué: comparte con Sindri los clientes (terceros), los artículos, los presupuestos, los pedidos, las facturas, la empresa en uso y los permisos de Keycloak. Como app aparte habría que copiar y sincronizar todo eso, y en el análisis de 15 CRM libres los que se integran con el ERP por sincronización son los que más fallan (estados desfasados y clientes duplicados).

Lo que implica: Brokkr hereda la licencia AGPL de Sindri y, hasta que exista el cargador de módulos (Fase 5 del plan de desarrollo), vive dentro de este repositorio como un área separada.

## Cómo está hoy

- Lógica: `apps/server/src/crm.ts` (oportunidades, actividades, modelos de presupuesto y presupuestos).
- Rutas HTTP: `apps/server/src/crm-rutas.ts`, registradas desde `app.ts` con `registerCrm`. Están separadas del resto de la API para poder sacarlas del repositorio sin tocar nada más.
- Rutas actuales: `/api/v1/opportunities`, `/api/v1/crm/...`, `/api/v1/quotation-templates`, `/api/v1/quotations`.

## Pasos

1. **Paso 0 (hecho en este cambio):** separar las rutas del CRM en su propio fichero, sin cambiar el comportamiento.
2. **Fase 1 · MVP:** etapas configurables por empresa, con un tipo fijo (abierta, ganada o perdida) y una probabilidad por etapa; motivos de pérdida; oportunidad con líneas de artículo, control de versión y siguiente paso. La oportunidad se gana sola al aceptar el presupuesto o confirmar el pedido. También: contactos N:M con rol, detección de duplicados al escribir, vistas *Hoy* y *Embudo*, línea de tiempo por cuenta con eventos de Sindri y de Odin, permisos todo/equipo/propio por empresa, e importación CSV con duplicados. La API acepta lotes, claves de idempotencia y control de versión.
3. **Fase 2 · Campo:** móvil y PDA sin conexión, clientes fríos, informes del embudo y email entrante como actividad.
4. **Fase 3 · Automatizar:** reglas sencillas, formularios web, asignación por territorio, autocompletar por NIF/VIES y asistente por MCP.
5. **Cuando exista el cargador de módulos:** mover `crm.ts` y `crm-rutas.ts` a `larceing/brokkr` y servir la API en `/api/m/brokkr/v1`, manteniendo `/api/v1/...` como alias durante una versión.

El análisis completo está en la carpeta compartida del proyecto, en `analisis-crm/`: el informe, las fichas de los 15 CRM, la comparativa en Excel, las simulaciones y el simulador de PDA.
