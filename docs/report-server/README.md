# Sindri con el Report Server

Sindri saca facturas, pedidos, albaranes y hojas de ruta en PDF con vuestro Report Server
(`larceing/report-server`). Sindri arma los datos del documento y se los manda con su llave; el
Report Server los pinta con la plantilla y devuelve el PDF. Sin Report Server, los mismos botones
imprimen la pantalla con el navegador.

## Ponerlo en marcha (una vez por entorno, primero DEV)

1. **Crear la llave.** En el Report Server → Llaves, crea una para la app `sindri`.
2. **Conectar Sindri.** En Sindri → Informes → **Conectar** (hace falta ser administrador), pon la
   dirección del Report Server y la llave, y pulsa **Probar y guardar**. Sindri prueba la llave
   antes de guardarla y **instala él solo sus cuatro plantillas** en el Report Server
   (`sindri-factura`, `sindri-pedido`, `sindri-albaran`, `sindri-hoja-ruta`). Las que ya estén
   allí no las toca, para no perder lo retocado. La llave se guarda en la base de Sindri, no se
   vuelve a enseñar y nunca va al repositorio ni a un chat. La dirección buena es la interna del
   servidor (la que pone el README del Report Server, en «Cómo genera una app»).

   Si se prefiere, también vale ponerlo en el `app.env` de Sindri como `REPORT_URL` y
   `REPORT_LLAVE`; entonces mandan esas variables y la pantalla solo las enseña.
3. **Elegir plantillas (si se quiere).** En Sindri → Informes, cada documento tiene su
   desplegable con las plantillas del Report Server (primero las de su grupo: `factura`, `pedido`,
   `albaran`, `hoja-ruta`) o «Imprimir con el navegador». Por defecto, la de Sindri. Así se puede
   diseñar en el Report Server una «Factura con logo» y elegirla aquí sin tocar código.
4. **Comprobarlo.** Los botones de factura, pedido, albarán y hoja de ruta pasan a decir «(PDF)».

En Informes también están **Instalar las plantillas de Sindri** (si falta alguna), **Volver a las de
partida** (las deja como vienen, perdiendo lo retocado) y **Descargar las de partida** (las cuatro
en un `.json` que acepta «Importar .json» del Report Server, por si se quieren guardar o importar
a mano). Instalar desde Sindri necesita un Report Server que lo permita (`POST /api/plantillas`);
con uno anterior, Sindri conecta igual y avisa de que hay que importarlas a mano.

Para PRO se repite lo mismo con el Sindri y el Report Server de PRO. Si se han retocado en DEV, en el
Report Server de DEV **Descargar** cada plantilla y en el de PRO **Importar .json**.

En la aplicación de escritorio, los PDF se guardan en Descargas y se abren con el visor del sistema.

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

`node docs/report-server/generar-plantillas.mjs` vuelve a escribir los cuatro `.json` de
`apps/server/plantillas/` (las que Sindri lleva dentro e instala) desde el script. Solo hace falta si se cambian aquí; lo retocado en el diseñador vive en el Report Server.

## Datos para otras herramientas de informes

Aparte de los PDF, Sindri da sus datos en solo lectura para Excel, Power BI, Metabase… en
`<dirección de Sindri>/api/informes/v1/<datos>?formato=csv|xml|json&desde=&hasta=`, con un token
de lector que se crea en Sindri → Informes (uno por herramienta, se puede revocar). Datos:
`clientes`, `pedidos`, `lineas_pedido`, `facturas`, `comerciales`, `hojas_ruta`, `stock`.
