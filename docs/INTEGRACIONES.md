# Integraciones: otras apps con Sindri

Sindri es la fuente de verdad de clientes, productos y facturación. Otras apps (gestor de
incidencias, gestor de tareas…) se conectan a **una empresa** de Sindri con una llave:

- leen sus **clientes** y **productos**, y pueden dar de alta el cliente o el servicio que les
  falte (nunca cambian ni borran los que hay);
- le mandan lo que hay que **facturar** (horas, servicios), que aparece en
  **Pedidos → Por facturar**. Ahí se pasa a un pedido y sigue el camino de siempre hasta la factura.

Ninguna app factura por su cuenta ni ve otra empresa ni otra parte de Sindri.

## Conectar una app

1. En Sindri, con la empresa elegida, **Empresa → Integraciones → Nueva llave**. El nombre es el
   de la app (`incidencias`, `tareas`…) y es también el *origen* de lo que mande. La llave
   (`sdi_…`) se ve una sola vez.
2. En el `app.env` de la otra app: `SINDRI_URL=<dirección de Sindri>` y `SINDRI_LLAVE=sdi_…`.
   Por la red interna del servidor, como el resto de apps.
3. Revocar la llave en la misma pantalla corta el acceso al momento.

## API (`/api/integracion/v1`, cabecera `Authorization: Bearer sdi_…`)

| Método y ruta | Qué hace |
|---|---|
| `GET /yo` | `{ app, empresa: { id, code, name, … } }`: para comprobar la llave |
| `GET /clientes?q=` | Clientes activos: `id`, `code`, `name`, `trade_name`, `tax_id`, `email`, `phone`, dirección |
| `POST /clientes` | Alta de un cliente si falta: `name` y, si se tienen, `trade_name`, `tax_id`, `email`, `phone`, `address`, `city`, `postal_code`, `province`, `notes`. Si ya hay uno con ese NIF o ese nombre, devuelve ese sin tocarlo. `{ id, creado }` (201 si se crea, 200 si ya estaba) |
| `GET /productos` | `id`, `sku`, `name`, `kind`, `uom`, `sale_price`, `vat_rate` |
| `POST /productos` | Alta de un **servicio** si falta: `sku`, `name` y, si se tienen, `uom` (por defecto `h`), `sale_price`, `vat_rate`. Si el `sku` ya está, devuelve ese sin tocarlo. `{ id, creado }` |
| `POST /por-facturar` | `{ "elementos": [ … ] }`, hasta 500 (abajo) |
| `GET /por-facturar?refs=a,b` | Estado de lo mandado: `pendiente`, `en_pedido` (con `pedido` y `estado_pedido`) o `descartado` |
| `DELETE /por-facturar/<ref>` | Quitar algo que sigue pendiente |

Cada elemento:

```json
{ "ref": "trabajo-1234", "cliente": "<id de Sindri o NIF>", "producto": "HORA",
  "fecha": "2026-10-18", "cantidad": "1.5", "precio": "40", "descripcion": "Incidencia 12: impresora" }
```

- `ref` es la referencia de la app: mandarla otra vez **actualiza** lo pendiente, nunca duplica.
  Si ya está en un pedido o descartado, no se toca y la respuesta lo dice.
- `producto` es el `sku` (o el id) de un producto de Sindri; `precio` es opcional (sin él, la tarifa del producto).
- La respuesta trae un estado por elemento: `creado`, `actualizado`, `en_pedido`, `descartado` o
  `error` (con el motivo: cliente o producto que no existe…). Un error no frena a los demás.

Errores generales: `401` (llave mala o revocada), `400` (datos mal, con el detalle), `422` (p. ej. un NIF no válido).

## Confirmación de pedidos por correo

Con el Mail del servidor (`MAIL_URL` y `MAIL_LLAVE` en el `app.env`, o **Empresa → Correo**), cada
empresa puede activar que al confirmar un pedido (también al aceptar un presupuesto) se mande la
confirmación al correo del cliente con el pedido en PDF (Report Server). En el pedido, **Enviar por
correo** la manda a mano, también a otra dirección.

## Llaves de agente (`sda_…`): un programa trabaja en la empresa con la API de siempre

Para que un programa, por ejemplo un hilo de Claude, consulte o cambie cosas de **una** empresa sin
entrar con Keycloak y sin escribir la contraseña de la empresa (`agente.ts`, migración `0018`).

1. Con la empresa elegida, **Empresa → Llaves de agente → Nueva llave de agente**: quién la usa
   (`claude`), qué puede (**Consultar** o **Consultar y cambiar**) y cuándo caduca (por defecto,
   nunca). La llave entera se ve una sola vez; en la base solo queda su sha256.
2. Quien la usa la manda como `Authorization: Bearer sda_…` contra la misma dirección que la web.
   Para Claude en la nube va como secreto del entorno (lo inyecta el proxy); nunca en un chat ni en
   un repo.

Qué puede:

- La API de la web, `/api/v1/…`, con la empresa ya abierta: sin elegir empresa ni contraseña.
- **Consultar**: solo `GET`. **Consultar y cambiar**: lo de un rol con todo, menos Empresa,
  Planta y VERI*FACTU, que se quedan en consultar.
- **Nunca**: usuarios, roles, departamentos, invitaciones, contraseñas de empresa, llaves
  (de integración o de agente), el correo, crear empresas ni cambiar de empresa (`403`).
- Todo queda en el registro con `agente:<nombre>`. «Revocar» la deja sin valor al momento (`401`).

Lo propio del agente, en `/api/agente/v1/`:

| Método y camino | Qué hace |
|---|---|
| `GET /yo` | Empresa, nivel y permisos de la llave |
| `GET /rutas` | Rutas de `/api/v1` y si la llave puede usarlas |
| `GET /traspaso` | Instrucciones en Markdown para quien vaya a usar la llave, con sus rutas |
| `POST /mcp` | Servidor MCP (JSON-RPC por HTTP, sin estado): `sindri_yo`, `sindri_rutas`, `sindri_consultar` y `sindri_cambiar` (este último solo con «cambiar») |

```bash
B="https://<dominio>/sindri"
curl -fsS "$B/api/agente/v1/traspaso"          # lo primero: qué puede y cómo
curl -fsS "$B/api/v1/partners?q=taller"
```
