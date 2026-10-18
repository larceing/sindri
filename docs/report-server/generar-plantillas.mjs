#!/usr/bin/env node
/**
 * Genera las plantillas de Sindri para el Report Server (formato «Importar .json»):
 *   node docs/report-server/generar-plantillas.mjs
 * Escribe sindri-factura.json, sindri-pedido.json, sindri-albaran.json y sindri-hoja-ruta.json
 * en apps/server/plantillas/: Sindri las lleva dentro y las instala él solo en el Report Server. Los datos de ejemplo son los que manda Sindri (ejemplos/*.json), así el
 * diseñador del Report Server enseña el documento tal como saldrá.
 *
 * Después de retocar una plantilla en el diseñador, lo que vale es la del Report Server
 * (Descargar la guarda en .json). Este script es solo el punto de partida.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const SALIDA = join(DIR, "..", "..", "apps", "server", "plantillas");
const ejemplo = (n) => JSON.parse(readFileSync(join(DIR, "ejemplos", `${n}.json`), "utf8"));

const OSCURO = "#15202b";
const GRIS = "#5b6675";
const RAYA = "#dde3ea";
const FONDO = "#f3f5f7";
const MARCA = "#1f3a68";
const sinBorde = { top: 0, right: 0, bottom: 0, left: 0 };

let n = 0;
/** Texto fijo con marcas ({cliente.nombre}, {enEuros(total)}…). */
const texto = (content, x, y, w, h, o = {}) => ({
  name: o.name ?? `t${++n}`,
  type: "text",
  content,
  position: { x, y },
  width: w,
  height: h,
  rotate: 0,
  alignment: o.align ?? "left",
  verticalAlignment: "top",
  fontSize: o.size ?? 9.5,
  textFormat: "plain",
  overflow: "visible",
  fontVariantFallback: "synthetic",
  lineHeight: o.lh ?? 1.25,
  characterSpacing: o.spacing ?? 0,
  fontColor: o.color ?? OSCURO,
  backgroundColor: "",
  borderColor: "#000000",
  borderWidth: sinBorde,
  padding: sinBorde,
  opacity: 1,
  strikethrough: false,
  underline: false,
  readOnly: true,
});
const caja = (x, y, w, h, o = {}) => ({
  name: o.name ?? `r${++n}`,
  type: "rectangle",
  position: { x, y },
  width: w,
  height: h,
  rotate: 0,
  opacity: 1,
  borderWidth: o.border ?? 0.3,
  borderColor: o.borderColor ?? RAYA,
  color: o.fill ?? "",
  readOnly: true,
  radius: o.radius ?? 1.5,
});
const raya = (x, y, w, o = {}) => ({ name: o.name ?? `l${++n}`, type: "line", position: { x, y }, width: w, height: 0.3, rotate: 0, opacity: 1, readOnly: true, color: o.color ?? RAYA });
/** Tabla: se llama como la lista de los datos; la fila modelo lleva las marcas de cada columna. */
const tabla = (name, y, cols, o = {}) => ({
  name,
  type: "table",
  position: { x: o.x ?? 15, y },
  width: o.width ?? 180,
  height: o.height ?? 20,
  content: JSON.stringify([cols.map((c) => c.marca)]),
  showHead: true,
  repeatHead: true,
  head: cols.map((c) => c.titulo),
  headWidthPercentages: cols.map((c) => c.ancho),
  tableStyles: { borderColor: RAYA, borderWidth: 0.2 },
  headStyles: {
    alignment: "left", verticalAlignment: "middle", fontSize: o.size ?? 8.5, lineHeight: 1, characterSpacing: 0,
    fontColor: "#ffffff", backgroundColor: MARCA, borderColor: MARCA, borderWidth: sinBorde,
    padding: { top: 2.2, right: 2.5, bottom: 2.2, left: 2.5 },
  },
  bodyStyles: {
    alignment: "left", verticalAlignment: "middle", fontSize: o.size ?? 8.5, lineHeight: 1.15, characterSpacing: 0,
    fontColor: OSCURO, backgroundColor: "", borderColor: RAYA, borderWidth: { top: 0.1, right: 0, bottom: 0.1, left: 0 },
    padding: { top: o.pad ?? 2, right: 2.5, bottom: o.pad ?? 2, left: 2.5 }, alternateBackgroundColor: o.zebra === false ? "" : FONDO,
  },
  columnStyles: { alignment: Object.fromEntries(cols.map((c, i) => [i, c.derecha ? "right" : "left"]).filter(([, a]) => a === "right")) },
  readOnly: true,
});
const qr = (x, y, size) => ({
  name: "qr", type: "qrcode", content: "https://www2.agenciatributaria.gob.es/", position: { x, y }, width: size, height: size,
  rotate: 0, opacity: 1, backgroundColor: "#ffffff", barColor: "#000000", readOnly: false,
});

/** Cabecera común: emisor a la izquierda, tipo de documento y número a la derecha. */
const cabecera = (titulo, lineas) => [
  texto("{siVacio(empresa.nombre_comercial, empresa.nombre)}", 15, 12, 110, 8, { size: 15, name: "emisor-nombre" }),
  texto("{empresa.nombre_comercial ? empresa.nombre + ' · ' : ''}NIF {empresa.nif}\n{empresa.linea_direccion}", 15, 21, 110, 10, { size: 8.5, color: GRIS, name: "emisor-datos" }),
  texto(titulo, 125, 12, 70, 8, { size: 15, align: "right", color: MARCA, name: "doc-titulo" }),
  texto(lineas, 125, 21, 70, 14, { size: 9, align: "right", name: "doc-numero" }),
  raya(15, 37, 180, { color: MARCA, name: "raya-cabecera" }),
];
/**
 * Pie fijo en todas las páginas (basePdf.staticSchema): no se mueve aunque la tabla crezca.
 * Lo fijo no lleva datos, solo el número de página.
 */
const PIE = [
  raya(15, 282, 180, { name: "raya-pie" }),
  texto("Página {currentPage} de {totalPages}", 15, 284, 180, 4, { size: 7, color: GRIS, align: "right", name: "pie-pagina" }),
];
const bloque = (titulo, contenido, x, y, w, h, name) => [
  caja(x, y, w, h, { name: `${name}-caja` }),
  texto(titulo, x + 3, y + 2.5, w - 6, 4, { size: 7, color: GRIS, spacing: 0.5, name: `${name}-titulo` }),
  texto(contenido, x + 3, y + 7, w - 6, h - 9, { size: 9.5, name }),
];
const doc = (schemas) => ({ basePdf: { width: 210, height: 297, padding: [12, 15, 18, 15], staticSchema: PIE }, schemas: [schemas] });

const factura = doc([
  ...cabecera("FACTURA", "Nº {numero}\nFecha {comoFecha(fecha)}{pedido ? '\\nPedido ' + pedido : ''}"),
  ...bloque("CLIENTE", "{cliente.nombre}\nNIF {cliente.nif}\n{cliente.linea_direccion}", 15, 42, 95, 28, "bloque-cliente"),
  ...bloque("FORMA DE PAGO", "{siVacio(forma_pago, '—')}", 113, 42, 50, 28, "bloque-pago"),
  // VERI*FACTU: el QR va al principio de la factura, con la leyenda debajo.
  qr(168, 41, 27),
  texto("{verifactu ? 'VERI*FACTU' : ''}", 166, 68.5, 31, 4, { size: 7, align: "center", name: "verifactu-leyenda" }),
  tabla("lineas", 76, [
    { titulo: "Descripción", marca: "{descripcion}", ancho: 44 },
    { titulo: "Cantidad", marca: "{conDecimales(cantidad, 0)}", ancho: 11, derecha: true },
    { titulo: "Precio", marca: "{enEuros(precio)}", ancho: 12, derecha: true },
    { titulo: "Dto.", marca: "{descuento ? conDecimales(descuento) + ' %' : ''}", ancho: 9, derecha: true },
    { titulo: "IVA", marca: "{conDecimales(iva, 0)} %", ancho: 8, derecha: true },
    { titulo: "Base", marca: "{enEuros(base)}", ancho: 16, derecha: true },
  ]),
  tabla("desglose", 102, [
    { titulo: "Tipo IVA", marca: "{conDecimales(iva, 0)} %", ancho: 18, derecha: true },
    { titulo: "Base imponible", marca: "{enEuros(base)}", ancho: 28, derecha: true },
    { titulo: "Cuota IVA", marca: "{enEuros(cuota)}", ancho: 24, derecha: true },
    { titulo: "Recargo eq.", marca: "{recargo ? conDecimales(recargo_pct, 1) + ' % · ' + enEuros(recargo) : ''}", ancho: 30, derecha: true },
  ], { zebra: false, x: 85, width: 110 }),
  texto("Base imponible\nIVA{recargo ? '\\nRecargo de equivalencia' : ''}{retencion ? '\\nRetención IRPF' : ''}", 110, 122, 50, 18, { align: "right", name: "totales-etiquetas" }),
  texto("{enEuros(base)}\n{enEuros(iva)}{recargo ? '\\n' + enEuros(recargo) : ''}{retencion ? '\\n−' + enEuros(retencion) : ''}", 160, 122, 35, 18, { align: "right", name: "totales-importes" }),
  caja(110, 142, 85, 10, { fill: MARCA, borderColor: MARCA, name: "total-caja" }),
  texto("TOTAL FACTURA", 113, 144.5, 40, 6, { size: 10, color: "#ffffff", name: "total-etiqueta" }),
  texto("{enEuros(total)}", 150, 144, 42, 7, { size: 12, color: "#ffffff", align: "right", name: "total-importe" }),
  texto("{verifactu}", 15, 156, 180, 5, { size: 7.5, color: GRIS, name: "verifactu-texto" }),
]);

const lineasPedido = (precios) =>
  precios
    ? [
        { titulo: "Referencia", marca: "{referencia}", ancho: 15 },
        { titulo: "Descripción", marca: "{descripcion}", ancho: 39 },
        { titulo: "Cantidad", marca: "{conDecimales(cantidad, 0)} {unidad}", ancho: 12, derecha: true },
        { titulo: "Precio", marca: "{enEuros(precio)}", ancho: 11, derecha: true },
        { titulo: "Dto.", marca: "{descuento ? conDecimales(descuento) + ' %' : ''}", ancho: 8, derecha: true },
        { titulo: "Base", marca: "{enEuros(base)}", ancho: 15, derecha: true },
      ]
    : [
        { titulo: "Referencia", marca: "{referencia}", ancho: 18 },
        { titulo: "Descripción", marca: "{descripcion}", ancho: 52 },
        { titulo: "Cantidad", marca: "{conDecimales(cantidad, 0)}", ancho: 15, derecha: true },
        { titulo: "Unidad", marca: "{unidad}", ancho: 15 },
      ];

const pedido = doc([
  ...cabecera("PEDIDO", "Nº {numero}\nFecha {comoFecha(fecha)}{fecha_entrega ? '\\nEntrega ' + comoFecha(fecha_entrega) : ''}"),
  ...bloque("CLIENTE", "{cliente.nombre}\nNIF {cliente.nif}\n{cliente.linea_direccion}", 15, 42, 88, 26, "bloque-cliente"),
  ...bloque("ENTREGAR EN", "{entrega.nombre}\n{entrega.linea_direccion}\n{entrega.horario ? 'Horario ' + entrega.horario : ''}{entrega.telefono ? '  Tel. ' + entrega.telefono : ''}", 107, 42, 88, 26, "bloque-entrega"),
  texto("{comercial ? 'Comercial: ' + comercial : ''}", 15, 70, 180, 5, { size: 8.5, color: GRIS, name: "linea-comercial" }),
  tabla("lineas", 77, lineasPedido(true)),
  texto("Base imponible\nIVA", 110, 102, 50, 10, { align: "right", name: "totales-etiquetas" }),
  texto("{enEuros(base)}\n{enEuros(iva)}", 160, 102, 35, 10, { align: "right", name: "totales-importes" }),
  caja(110, 114, 85, 10, { fill: MARCA, borderColor: MARCA, name: "total-caja" }),
  texto("TOTAL", 113, 116.5, 40, 6, { size: 10, color: "#ffffff", name: "total-etiqueta" }),
  texto("{enEuros(total)}", 150, 116, 42, 7, { size: 12, color: "#ffffff", align: "right", name: "total-importe" }),
  texto("{notas ? 'Notas: ' + notas : ''}", 15, 128, 180, 10, { size: 8.5, name: "linea-notas" }),
]);

const albaran = doc([
  ...cabecera("ALBARÁN", "Nº {numero}\nFecha {comoFecha(fecha)}\nPedido {pedido}"),
  ...bloque("CLIENTE", "{cliente.nombre}\nNIF {cliente.nif}\n{cliente.linea_direccion}", 15, 42, 88, 26, "bloque-cliente"),
  ...bloque("ENTREGAR EN", "{entrega.nombre}\n{entrega.linea_direccion}\n{entrega.horario ? 'Horario ' + entrega.horario : ''}{entrega.telefono ? '  Tel. ' + entrega.telefono : ''}", 107, 42, 88, 26, "bloque-entrega"),
  tabla("lineas", 74, lineasPedido(false)),
  texto("{notas ? 'Notas: ' + notas : ''}", 15, 100, 180, 8, { size: 8.5, name: "linea-notas" }),
  ...bloque("RECIBÍ CONFORME", "Nombre y DNI:\n\n\nFecha y firma:", 107, 110, 88, 36, "bloque-firma"),
]);

const hojaRuta = doc([
  ...cabecera("HOJA DE RUTA", "Nº {numero}\nFecha {comoFecha(fecha)}\n{total_paradas} paradas"),
  texto("Conductor: {siVacio(conductor, '—')}     Vehículo: {siVacio(vehiculo, '—')}     Zona: {siVacio(zona, '—')}", 15, 41, 180, 6, { size: 10, name: "linea-ruta" }),
  texto("{notas}", 15, 47, 180, 6, { size: 8.5, color: GRIS, name: "linea-notas" }),
  tabla("paradas", 54, [
    { titulo: "#", marca: "{orden}", ancho: 5, derecha: true },
    { titulo: "Cliente y dirección", marca: "{cliente}\n{direccion}{notas ? '\\n' + notas : ''}", ancho: 30 },
    { titulo: "Teléfono / horario", marca: "{telefono}{horario ? '\\n' + horario : ''}", ancho: 15 },
    { titulo: "Pedido / albarán", marca: "{pedido}", ancho: 16 },
    { titulo: "Mercancía", marca: "{mercancia}", ancho: 19 },
    { titulo: "Firma y DNI", marca: " ", ancho: 15 },
  ], { size: 8, zebra: false, pad: 4 }),
]);

// El grupo es el tipo de documento: en el Report Server, otras plantillas del mismo grupo
// salen como alternativas al elegir en Sindri.
const PLANTILLAS = [
  ["sindri-factura", "Sindri · Factura", factura, "factura", "factura"],
  ["sindri-pedido", "Sindri · Pedido", pedido, "pedido", "pedido"],
  ["sindri-albaran", "Sindri · Albarán", albaran, "albaran", "albaran"],
  ["sindri-hoja-ruta", "Sindri · Hoja de ruta", hojaRuta, "hoja_ruta", "hoja-ruta"],
];

for (const [nombre, titulo, plantilla, ej, grupo] of PLANTILLAS) {
  writeFileSync(join(SALIDA, `${nombre}.json`), JSON.stringify({ nombre, titulo, grupo, ejemplo: ejemplo(ej), plantilla }, null, 2) + "\n");
  console.log(`${nombre}.json`);
}
