# Sindri con el Report Server

Sindri saca facturas, pedidos, albaranes y hojas de ruta en PDF con vuestro Report Server
(`larceing/report-server`). Sindri arma los datos del documento y se los manda con su llave; el
Report Server los pinta con la plantilla y devuelve el PDF. Sin Report Server, los mismos botones
imprimen la pantalla con el navegador.

## Ponerlo en marcha (una vez por entorno, primero DEV)

1. **Importar las plantillas.** En el Report Server → Plantillas → **Importar .json**, sube los
   cuatro ficheros de esta carpeta: `sindri-factura.json`, `sindri-pedido.json`,
   `sindri-albaran.json` y `sindri-hoja-ruta.json`. Cada uno trae datos de ejemplo, así que en el
   diseñador se ve el documento tal como saldrá. Se pueden retocar a gusto (logo, colores,
   textos); lo único que hay que respetar es el **nombre** de la plantilla y de las tablas
   (`lineas`, `desglose`, `paradas`) y del QR (`qr`).
2. **Crear la llave.** En el Report Server → Llaves, crea una para la app `sindri`.
3. **Decírselo a Sindri.** En el `app.env` de Sindri del entorno (a mano, mientras Ajustes no
   tenga secretos por app) añade:

   ```
   REPORT_URL=<dirección interna del Report Server, la que se ve desde el contenedor de Sindri>
   REPORT_LLAVE=<la llave del paso 2>
   ```

   y reinicia Sindri. La llave no va nunca al repositorio ni a un chat.
4. **Comprobarlo.** En Sindri → Informes, el recuadro «Documentos en PDF» dice si llega al
   Report Server y qué plantillas tiene. Los botones de factura, pedido, albarán y hoja de ruta
   pasan a decir «(PDF)».

Para PRO se repite lo mismo con el Report Server de PRO: en el de DEV, **Descargar** cada
plantilla ya retocada y en el de PRO **Importar .json**.

## Qué datos recibe cada plantilla

Los importes y cantidades van como números y las fechas como `AAAA-MM-DD`; el formato lo pone la
plantilla con las marcas del Report Server (`{enEuros(total)}`, `{comoFecha(fecha)}`…). Los datos
exactos de cada documento están en [`ejemplos/`](ejemplos/) y se pueden ver para cualquier
documento en `GET /api/v1/documentos/<tipo>/<id>/datos` (tipo: `factura`, `pedido`, `albaran`,
`hoja_ruta`).

| Plantilla | Datos principales |
|---|---|
| `sindri-factura` | `empresa`, `numero`, `fecha`, `pedido`, `forma_pago`, `cliente`, `lineas[]`, `desglose[]` (IVA y recargo por tipo), `base`, `iva`, `recargo`, `retencion`, `total`, `cobrado`, `pendiente`, `qr` (URL de cotejo VERI*FACTU), `verifactu` |
| `sindri-pedido` | `empresa`, `numero`, `fecha`, `fecha_entrega`, `comercial`, `cliente`, `entrega` (dirección, horario, teléfono), `lineas[]` con `referencia` y `unidad`, `base`, `iva`, `total`, `notas` |
| `sindri-albaran` | Lo del pedido, con el número y la fecha del albarán y `pedido` |
| `sindri-hoja-ruta` | `empresa`, `numero`, `fecha`, `conductor`, `vehiculo`, `zona`, `notas`, `paradas[]` (`orden`, `cliente`, `direccion`, `telefono`, `horario`, `pedido`, `mercancia`, `notas`), `total_paradas` |

`muestra-factura.pdf` y `muestra-hoja-ruta.pdf` son cómo salen con los datos de ejemplo.

## Regenerar las plantillas de partida

`node docs/report-server/generar-plantillas.mjs` vuelve a escribir los cuatro `.json` desde el
script. Solo hace falta si se cambian aquí; lo retocado en el diseñador vive en el Report Server.

## Datos para otras herramientas de informes

Aparte de los PDF, Sindri da sus datos en solo lectura para Excel, Power BI, Metabase… en
`<dirección de Sindri>/api/informes/v1/<datos>?formato=csv|xml|json&desde=&hasta=`, con un token
de lector que se crea en Sindri → Informes (uno por herramienta, se puede revocar). Datos:
`clientes`, `pedidos`, `lineas_pedido`, `facturas`, `comerciales`, `hojas_ruta`, `stock`.
