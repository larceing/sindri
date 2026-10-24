# PDA y su simulador

24-10-2026. Análisis, diseño y plan para usar Sindri desde las PDA del almacén y la planta, y para probarlo **sin hardware**. Lo de planta con máquinas (PLC, OPC UA) es **Efesto**; la PDA es la parte de las personas, y las dos acaban en los mismos movimientos de Sindri.

## Resumen en un minuto

- Una PDA de almacén (Zebra, Honeywell, Datalogic, Urovo…) es un Android con lector de códigos. El lector entrega lo que lee de dos formas: **tecleándolo** en la app que está delante (modo teclado) o **mandándolo como mensaje** a una app (Intent). Con el modo teclado, una web normal en Chrome ya funciona, sin instalar nada.
- Por eso la PDA de Sindri es **una pantalla más de la misma web** (`#/pda`), con la misma API. No hace falta app nativa para empezar.
- Ya hay un **prototipo** en este PR: lector de códigos GS1 en el núcleo, la PDA con *Consultar*, *Recibir*, *Preparar pedido* y *Pendientes*, trabajo **sin conexión** con cola que no duplica, y un **simulador** (`#/pda-simulador`) que hace de escáner como DataWedge, Honeywell o una pistola USB, y provoca los fallos típicos.
- Lo que falta para un almacén de verdad está en el [plan](#9-plan-por-fases): ubicaciones, que la salida respete el lote leído, inventario, la PWA sin conexión con HTTPS en la red de la fábrica, recepción contra pedido de compra, expedición con SSCC y los partes de fabricación.
- Decisiones tomadas: [§10](#10-decisiones-y-riesgos).

> «Aspectos de uso de aplicaciones»: lo he leído como **cómo usa la gente estas apps en la nave** (una mano, guantes, ruido, prisa) y qué conviene medir de ese uso. Está en el [§3](#3-cómo-se-usan-en-la-nave). Si querías decir otra cosa, dímelo.

---

## 1. Cómo funciona una PDA de verdad

### 1.1 El aparato

| Tipo | Ejemplos | Para qué |
|---|---|---|
| PDA táctil de 5-6" | Zebra TC2x/TC5x, Honeywell CT30/CT40/CT60 | Lo más común: recepción, picking, inventario |
| PDA con teclado físico y pistolete | Zebra MC33xx/MC94xx | Cámaras frigoríficas, guantes gruesos, mucha lectura a distancia |
| PDA económica | Urovo, Chainway, Newland | Pymes; mismo Android, lector algo peor |
| Anillo o pistola Bluetooth + móvil | Zebra RS, pistolas HID | Picking con las dos manos libres |
| Tablet de taller | Cualquier Android/Windows de 10" | Partes de fabricación en el puesto |

Todas llevan Android (las nuevas, 13-15) y el navegador Chrome. El lector lee 1D (EAN, Code 128, GS1-128) y 2D (QR, DataMatrix).

### 1.2 Cómo llega lo leído a la app

| Vía | Cómo es | Ventajas | Inconvenientes |
|---|---|---|---|
| **Modo teclado** (DataWedge «Keystroke output», Honeywell «Wedge as keys», pistolas HID) | El lector teclea el código muy deprisa en el campo que tenga el foco y termina con Intro o Tab | Funciona con **cualquier web** en Chrome, sin instalar nada | Los caracteres de control (el GS de GS1) pueden perderse; si el foco está en otro sitio, el código cae donde no debe |
| **Intent** (DataWedge «Intent output», Honeywell Data Collection Intent) | El lector manda un mensaje Android con el dato, la simbología y los datos en bruto | Llega entero, con su tipo de código | Solo lo recibe una app Android: una web necesita una app envoltorio o Enterprise Browser |
| **SDK nativo** (Zebra EMDK, Honeywell SDK) | La app controla el lector | Control total (gatillo, simbologías) | App nativa por fabricante |
| **Cámara** (BarcodeDetector del navegador o librería JS) | Se lee con la cámara del móvil | Sin PDA | Lento para trabajo continuo; no sirve para cientos de lecturas por hora |
| **Enterprise Browser** (Zebra) | Navegador de Zebra con acceso al lector desde JavaScript | Web con lector nativo | De pago con renovación anual, solo Zebra |

Datos comprobados en la documentación de Zebra (DataWedge 15.0):

- En modo teclado, el «Action key character» solo puede ser Tab, salto de línea o retorno de carro. El **GS (carácter 29)** se manda como texto salvo que se active «Send Control Characters as Events»; entonces llega como **Ctrl+]**. Los datos en bruto solo salen por Intent.
- En la opción GS1/Digital Link, DataWedge puede **trocear** el código por AI y mandarlo con un separador propio.
- Hay una orden «Soft Scan Trigger» (`com.symbol.datawedge.api.ACTION` con `com.symbol.datawedge.api.SOFT_SCAN_TRIGGER` = `START_SCANNING` / `STOP_SCANNING` / `TOGGLE_SCANNING`) para disparar el lector desde una app. En Android 14 los Intents que se mandan **a** DataWedge tardan unos 500 ms.
- Honeywell: confirmado que tiene modo teclado y modo Intent; **no he podido leer su documentación oficial** del Intent (está tras registro), así que no doy nombres de acciones.

**Conclusión:** empezar con **Chrome + modo teclado**. Es lo que funciona en cualquier PDA y cualquier pistola. El Intent queda para una app envoltorio opcional (fase 7), cuando haga falta el GS seguro, el gatillo por software o quitar el teclado de pantalla.

### 1.3 Lo que exige el navegador

Para trabajar sin conexión de verdad (service worker, IndexedDB con sincronización en segundo plano) y para `crypto.randomUUID`, Chrome exige **contexto seguro: HTTPS o `localhost`**. En el servidor DEV/PRO ya hay HTTPS. En el **servidor de la fábrica** (Sindri en la red local) habrá que servir HTTPS con un certificado que las PDA acepten. Es la decisión técnica más importante para la fase 3. El prototipo ya genera ids sin `randomUUID` para funcionar también por HTTP.

## 2. Códigos GS1 en la práctica

- **GTIN** (EAN-13, ITF-14): identifica el producto. Va solo en la caja o el envase.
- **GS1-128** (y GS1 DataMatrix / QR): varios datos en un código, cada uno con su **identificador de aplicación (AI)**: `(01)` GTIN, `(10)` lote, `(17)` caducidad, `(21)` serie, `(37)` unidades, `(310n)` peso neto, `(00)` SSCC del palé, `(414)` GLN de ubicación…
- Los campos de longitud **fija** van seguidos sin más. Los de longitud **variable** (lote, serie, cantidad) terminan con el carácter **GS** (FNC1), salvo el último.
- El escáner puede añadir delante el **identificador de simbología** (AIM): `]C1` GS1-128, `]d2` GS1 DataMatrix, `]Q3` GS1 QR, `]E0` EAN-13.
- **GS1 Digital Link**: el mismo dato como enlace web (`https://id.gs1.org/01/…/10/…?17=…`). Es lo que llevan los QR nuevos.
- **Sunrise 2027**: GS1 quiere que a finales de 2027 los TPV lean códigos 2D. Es una **meta del sector, no una ley**; las fuentes no se ponen de acuerdo en lo obligatoria que es. Para un ERP industrial lo práctico es leer ya GS1 DataMatrix, QR y Digital Link (el prototipo lo hace).

**Peligro real, comprobado en el simulador:** si el lector **pierde el GS** (pistolas baratas, DataWedge mal configurado) y la etiqueta lleva el lote **en medio**, el lote se pega con lo que sigue: `(10)LOTEX` + `(37)24` se lee como lote `LOTEX3724`, **sin error posible**. Defensas:
1. Al componer etiquetas propias, Sindri pone los campos variables **al final** (lo hace `componerGs1`).
2. Configurar el lector para mandar el GS (o la simbología `]C1`) y probarlo con el simulador antes de salir a la nave.
3. Comprobar el lote leído contra los lotes que existen (fase 2).

Para las demos, los productos de ejemplo llevan GTIN del rango **20…29**, que GS1 reserva para uso interno: no chocan con ningún producto real. Para SSCC y GTIN reales, la empresa necesita su **prefijo de empresa GS1** (en España, alta en AECOC).

## 3. Cómo se usan en la nave

Lo que distingue una app de PDA buena de una pantalla de ERP encogida:

| Situación | Qué pide a la app | Cómo lo hace el prototipo |
|---|---|---|
| Una mano en la PDA, la otra en la caja | Botones grandes abajo, nada pequeño arriba | Botones de 56 px, tareas en mosaico |
| Guantes, frío, prisa | No escribir: **leer en vez de teclear** | Cada pantalla avanza leyendo; teclear es la excepción |
| Ruido de carretillas, no se mira la pantalla | Pitido y vibración distintos para bien y mal; color de fondo | Pitido agudo = bien, grave doble = error, color en toda la franja |
| Leer dos veces sin querer | Que no cuente doble | Lecturas iguales en menos de 0,7 s cuentan una |
| Contar cajas | Leer otra vez el mismo producto suma uno; etiqueta con `(37)` suma su cantidad | Hecho en Recibir y Preparar |
| Zonas sin wifi (cámaras, muelles) | Seguir trabajando y que se mande solo | Copia local y cola; aviso «Sin conexión» siempre visible |
| Error que el operario no puede arreglar | Mensaje claro y qué hacer, sin bloquear la PDA | Las rechazadas quedan en *Pendientes* para reintentar o descartar |
| Aparato compartido entre turnos | Cambiar de persona rápido | Pendiente (fase 3): entrada con tarjeta o código de operario |
| Pantallas de 4" a 10" | Que todo quepa | Probado en 320×480, 360×720 y tablet |

Qué conviene **medir** del uso (fase 3, desde el registro de eventos): lecturas por hora y por persona, errores por tipo (producto que no está, lote distinto, código ilegible), tiempo por línea de pedido, operaciones hechas sin conexión y cuánto tardaron en llegar, y rechazos del servidor. Sirve para ver dónde se atasca el almacén y para vender Sindri con datos.

## 4. Flujos de almacén y de planta

| Flujo | Qué se lee, en orden | En Sindri hoy | Qué falta |
|---|---|---|---|
| **Consultar** | Cualquier código | ✅ Prototipo | Ubicaciones con hueco |
| **Recibir** | Etiqueta del proveedor (GTIN, lote, caducidad, cantidad) → confirmar | ✅ Prototipo (entrada libre) | Contra **pedido de compra** con recepción parcial (Compras, fase 6 del plan general) |
| **Ubicar** | Palé/producto → ubicación destino | ❌ Una sola ubicación por empresa (`WH/STOCK`) | Ubicaciones en árbol (almacén/pasillo/estantería/hueco) y traspaso |
| **Preparar pedido** | Pedido → cada artículo (y lote) → confirmar salida | ✅ Prototipo, salida por FEFO | Que la salida use **el lote leído**; preparar por ubicación; parcial |
| **Embalar y expedir** | Bultos → SSCC → etiqueta → carga | ❌ | Bultos/palés con SSCC, etiqueta ZPL, DeCA |
| **Inventario** | Ubicación → productos y cantidades (a ciegas) | ❌ | Documento de recuento y ajuste con aprobación |
| **Traspaso** | Origen → producto → destino | ❌ | Endpoint de movimiento interno |
| **Devolución** | Albarán → artículos → estado | ❌ | Devoluciones de cliente |
| **Parte de fabricación** | Orden → consumir lotes → declarar producción → etiquetar palé | ❌ | Fabricación (fase 6); aquí se une con **Efesto** |
| **Calidad** | Lote → resultado → cuarentena o liberado | ❌ | Estado de lote que respeten las salidas |

### Dónde fallan Odoo y ERPNext (y el hueco)

- **Odoo**: la app de PDA (*Barcode*) y la de taller (*Shop Floor*) son **Enterprise**. En Community no hay app de PDA; se usa el lector en modo teclado sobre formularios normales. Hay terceros que venden PWA sin conexión para Odoo 17-19 (vistos a 113 $ y 299 $, datos de sus propias páginas).
- **ERPNext**: se puede leer en los campos de código de barras de los formularios, pero no encontré una app oficial de PDA con trabajo sin conexión; los complementos de terceros venden la cola sin conexión (desde unos 399 $, según el vendedor).
- **El hueco para Sindri**: PDA **incluida**, que **trabaja sin conexión** sin duplicar, que entiende GS1 entero (lote, caducidad, SSCC, Digital Link) y que comparte la API con la planta (Efesto).

## 5. Formas de probar sin hardware

| Nivel | Qué | Coste (orientativo, sin consultar precios) | Para qué |
|---|---|---|---|
| 0 | Pruebas del lector GS1 (`packages/core/test/gs1.test.ts`) | 0 | Que los códigos se entiendan siempre igual |
| 1 | **Simulador web** `#/pda-simulador` (hecho) | 0 | Probar flujos y fallos desde el PC, enseñar demos |
| 2 | Pruebas automáticas con Playwright usando el mismo simulador | 0 | Que un cambio no rompa la PDA (fase 3, en CI) |
| 3 | Pistola USB de 25-40 € en el PC, o el QR del simulador leído con un móvil | Bajo | Probar el modo teclado real |
| 4 | **Android Emulator** (Android Studio) con la app `pda-android` o con Chrome; scripts `pda-android/scripts/escanear.*` que mandan lecturas por adb como Intent (igual que DataWedge) o como teclado (hecho, §8.1) | 0 | Probar la app Android, Chrome Android, el teclado de pantalla, la cámara y la falta de red. DataWedge **no** existe en el emulador: el script manda lo mismo que mandaría |
| 5 | Una PDA real de segunda mano o en préstamo del distribuidor | 150-600 € | Configurar DataWedge y validar antes del primer cliente |

No hacen falta mocks de API: el simulador usa **Sindri de verdad** contra una empresa DEMO o DEV.

## 6. Qué hay ya en Sindri y en Efesto

- **Almacén**: libro de movimientos inmutable, existencias calculadas, lotes con caducidad, salidas por FEFO y bloqueo por producto. Una ubicación interna por empresa.
- **Pedidos**: confirmar → entregar (albarán) → facturar. La entrega saca lotes por FEFO.
- **API única** (`/api/v1`): la PDA usa la misma que la web. Faltan Idempotency-Key general y listas con cursor (fase 3 del plan general).
- **Efesto** (planta): agente que lee OPC UA, solo lectura, con cola local y lecturas con id para no duplicar. Es el mismo patrón que la cola de la PDA: lo hecho fuera de línea lleva su id y el servidor lo cuenta una vez.

## 7. Diseño

```
  PDA (Chrome)                           Servidor Sindri (fábrica o DEV/PRO)
 ┌─────────────────────────────┐        ┌──────────────────────────────────┐
 │ Lector ─(teclado / evento)─►│        │ /api/v1  (la misma que la web)   │
 │  useEscaner → leerCodigo    │        │  stock/receipts  (id = no dup.)  │
 │  (GS1 en @sindri/core)      │  HTTPS │  sales-orders/:id/deliver        │
 │ Pantallas #/pda             ├───────►│  … ubicaciones, recuentos (plan) │
 │ Copia local (productos,     │        │ Libro de stock inmutable         │
 │  stock, pedidos)            │        └──────────────────────────────────┘
 │ Cola sin conexión ──────────┘                       ▲
 └─────────────────────────────┘                       │ mismos movimientos
                                          Efesto: agente de planta (OPC UA)
```

Reglas:

1. **La PDA es web.** Misma app, misma sesión, mismos permisos (Almacén). Sin lógica que no esté en la API.
2. **Leer primero.** Cada pantalla espera una lectura; el teclado es la excepción.
3. **El servidor manda.** La PDA no decide stock: propone y el servidor acepta o rechaza (sin stock, pedido ya entregado). Lo rechazado se enseña, no se pierde.
4. **Todo lo que se hace sin conexión lleva id.** Repetirlo no duplica. Ya lo hace la entrada de mercancía; la salida es segura porque un pedido entregado no se puede volver a entregar.
5. **Copia local con fecha.** Se ve de cuándo es; al volver la red se refresca y se manda la cola.
6. **El escáner, aislado** en `pda/escaner.ts`: cambiar de modo teclado a Intent o a cámara no toca las pantallas.

## 8. El prototipo de este PR

| Pieza | Fichero |
|---|---|
| Lector y compositor GS1 (GS1-128, DataMatrix, QR, DataBar, Digital Link, EAN; fechas con la regla de siglo de GS1; peso con decimales; avisos de dígito de control) | `packages/core/src/gs1.ts` + pruebas |
| Entrada de mercancía con `id` opcional (no duplica) | `apps/server/src/services.ts`, prueba `apps/server/test/pda.test.ts` |
| Captura del escáner (modo teclado por velocidad, prefijo opcional, evento `sindri:escaneo`, antirebote) | `apps/web/src/pda/escaner.ts` |
| Red, copia local, cola y avisos (pitido, vibración) | `apps/web/src/pda/datos.ts` |
| Pantallas de la PDA | `apps/web/src/pda/PdaApp.tsx` |
| Simulador | `apps/web/src/pda/Simulador.tsx` |
| Productos demo con GTIN interno | `apps/server/src/demo.ts` |

**Cómo probarlo:** Almacén → «Simulador de PDA» (o `#/pda-simulador`). A la izquierda está la PDA; a la derecha, los códigos de la empresa. Pulsa «Leer» en un código o compón una etiqueta de proveedor. Prueba «Sin red», «Red lenta», «Servidor falla 1 de 3», «Lectura doble», «Etiqueta dañada» y «Se pierde el GS». La cola de la PDA se ve en el panel; F2 hace de gatillo. **Lo que se hace en la PDA cambia el stock de verdad**: usar DEV o una empresa DEMO.

**En una PDA real:** abrir `https://<sindri>/#/pda` en Chrome. En DataWedge, perfil asociado a Chrome con *Keystroke output* activado, sufijo Intro, y si se usan etiquetas GS1 con lote en medio, «Send Control Characters as Events» activado (el GS llega como Ctrl+], que Sindri entiende).

Comprobado en el navegador (Chromium) contra un Sindri local con datos demo: recibir leyendo una etiqueta GS1, recibir sin red y que se mande sola al volver (sin duplicar), lectura doble que cuenta una, tecleo lento que no se toma por lectura, preparar un pedido completo y darle salida, y el lote pegado cuando se pierde el GS.

### 8.1 App Android y pruebas en el emulador

La fase P7 se ha adelantado para poder probar la captura con Android Studio y componentes virtuales, sin PDA. Está en [`pda-android/`](../pda-android/README.md):

- **App mínima** (Kotlin, sin librerías salvo el lector de cámara de Google): la PDA web a pantalla completa. Recibe el escáner **por Intent** con la acción `com.sindri.pda.ESCANEO` (extras de DataWedge, de Honeywell y de otras marcas), le pone el prefijo AIM según el tipo de código (`LABEL-TYPE-EAN128` → `]C1`…) y lo pasa a la web como `sindri:escaneo`. En una Zebra crea sola el perfil de DataWedge. Botón de **cámara** y **gatillo por software** que solo aparecen dentro de la app (`window.SindriAndroid`).
- **Scripts** `escanear.ps1` (Windows) y `escanear.sh`: mandan una lectura al emulador por adb, como Intent (con GS y simbología, en Base64) o como teclado (`input text` + Intro), con una lista de códigos de prueba para los datos demo (GS1-128, DataMatrix, EAN-13, SSCC, peso, GS perdido, dígito de control malo).
- La web acepta ahora el **Intro final hasta 1 s después** del código (lo que cuenta es que el código llegue deprisa). Lo necesitan `adb shell input` y algunos lectores Bluetooth.

Comprobado en la nube: la app compila, sus 7 pruebas pasan (lectura de extras de cada marca, prefijo AIM, GS en Base64, escapado seguro para JavaScript) y, en Chromium contra Sindri local, el JavaScript exacto que genera la app rellena «Recibir» con producto, lote, caducidad y 24 ud; el Intro tardío se lee; una persona tecleando despacio no; y los botones de gatillo y cámara llaman a la app. **Probada en el emulador** (PC de Luis, 24-10-2026, dispositivo virtual Pixel 4a con Android 15): por Intent y en modo teclado se rellenan bien «Recibir» (GS1-128 y DataMatrix con lote, caducidad y cantidad) y «Consultar» (EAN-13), y la etiqueta con dígito de control malo avisa. Salieron dos fallos, ya corregidos: con el GS perdido no había aviso (ahora `leerCodigo` avisa cuando un lote o serie final acaba en algo que parece otro campo, como `…3724` = (37) 24), y en Android 15 la cabecera quedaba bajo la barra de estado (ahora la app deja el hueco de las barras del sistema). También: página propia cuando Sindri no responde y cada lectura en logcat.

### El otro simulador (análisis de CRM)

El hilo de análisis de CRM hizo un simulador de PDA suelto (`analisis-crm/simulador-pda/index.html`) con servidor de mentira, modo comercial y modo almacén. Se ha unido aquí lo que aportaba al almacén, para que quede uno solo:

- **Red lenta** y **servidor que falla 1 de cada 3** en el simulador. En la PDA, un error 5xx ahora cuenta como fallo pasajero y se reintenta, en vez de quedar como rechazado.
- La **cola de la PDA a la vista** en el panel del simulador.
- **F2** como gatillo.

Lo que se queda para **Brokkr** (el CRM), porque necesita API que Sindri aún no tiene: el **modo comercial** (ruta del día, visita con entrada y salida, resultado en un toque, aviso de cliente frío) y el **control de versión** para ver conflictos cuando dos personas cambian la misma oportunidad. Cuando exista esa API, entra como otra tarea de esta misma PDA, no como una app aparte. Leer el SSCC del bulto al preparar ya está en la fase P5.

## 9. Plan por fases

| Fase | Qué | Depende de |
|---|---|---|
| **P1** (hecha) | Prototipo: GS1, PDA con 4 tareas, cola sin duplicar, simulador | — |
| **P2** | Ubicaciones en árbol y traspaso; ubicar al recibir; **salida con el lote leído** (entrega con líneas y lotes); recuento de inventario a ciegas con ajuste aprobado; comprobar lote leído contra los existentes | Partir `services.ts` (fase 0 del plan general) ayuda |
| **P3** | PWA de verdad: service worker, IndexedDB, instalar en la pantalla de inicio; **HTTPS en el servidor de la fábrica**; entrada rápida de operario; Idempotency-Key en todos los POST; pruebas Playwright del simulador en CI; métricas de uso | Fase 3 del plan general (contrato de APIs) |
| **P4** | Recepción contra **pedido de compra** (parcial, diferencias) | Compras (fase 6) |
| **P5** | Expedición: bultos y palés con **SSCC**, etiqueta ZPL, DeCA | Etiquetas (fase 7) y prefijo GS1 de la empresa |
| **P6** | **Partes de fabricación** desde PDA y tablet de taller: consumir lotes, declarar producción, etiquetar; unirlo con los eventos de máquina de **Efesto** | Fabricación (fase 6) |
| **P7** (empezada, §8.1) | App Android que recibe el Intent de DataWedge/Honeywell y lo pasa como `sindri:escaneo`; gatillo por software; cámara. Falta: probar en emulador y en PDA real, firmar el APK y repartirlo (MDM o instalación a mano) | Probar con una PDA real (decisión 3) |

## 10. Decisiones y riesgos

Decididas el 24-10-2026 (Luis dio el «adelante» a las recomendaciones):

| # | Decisión | Qué se ha hecho |
|---|---|---|
| 1 | **Chrome + modo teclado** ahora; app envoltorio solo si hace falta (P7). Enterprise Browser no | Es como funciona el prototipo. Luis pidió después probar la captura con Android Studio, así que la app (P7) ya existe como base: Chrome sigue valiendo y la app añade Intent, gatillo y cámara |
| 2 | **HTTPS en el servidor de la fábrica** | Sindri ya puede servir HTTPS él mismo: `SINDRI_TLS_CERT` y `SINDRI_TLS_CLAVE` (ficheros PEM). Si escucha en la red sin HTTPS, avisa al arrancar. Certificado: una CA interna instalada en las PDA, o un subdominio propio con certificado público. En DEV/PRO no hace falta: el HTTPS lo pone la entrada del servidor |
| 3 | **Comprar una PDA de pruebas** antes del primer cliente (Zebra TC2x o Honeywell CT30 de segunda mano) | Pendiente de Luis: es una compra |
| 4 | **Sin prefijo GS1 propio para demos**: los GTIN 20… sirven; cada cliente usa el suyo | Los productos demo ya llevan GTIN 20… |

Riesgos: el **GS perdido** que pega lotes (§2); trabajar mucho tiempo sin conexión con la copia vieja (se ve la fecha, y el servidor rechaza lo imposible); dos personas preparando el mismo pedido (P2: reservar el pedido a quien lo abre).

## Fuentes

- Zebra TechDocs, DataWedge 15.0: [APIs](https://techdocs.zebra.com/datawedge/15-0/guide/api) (retraso de 500 ms en Android 14) y [Keystroke Output](https://techdocs.zebra.com/datawedge/latest/guide/output/keystroke/) (caracteres de control, GS1/Digital Link). Consultado el 24-10-2026.
- Zebra TechDocs, [Soft Scan Trigger](https://techdocs.zebra.com/datawedge/8-0/guide/api/softscantrigger).
- Zebra TechDocs, [Enterprise Browser](https://techdocs.zebra.com/enterprise-browser/3-2/guide/about); renovaciones anuales en distribuidores (p. ej. [Barcode Factory](https://www.barcodefactory.com/zebra/software/enterprise-browser/renewals)).
- GS1 Sunrise 2027: [Videojet](https://www.videojet.com/us/homepage/resources/learn/gs1-sunrise-2027.html), [NACS, 5-10-2026](https://convenience.org/stay-current/news/2026/october/5/setting-up-for-sunrise-2027). Fuentes de proveedores; GS1 no publica una fecha obligatoria.
- Odoo: investigación propia del proyecto (`investigacion-erp-opensource/03-…`); complementos de terceros: [Odoo Apps, do_stock_barcode 19.0](https://apps.odoo.com/apps/modules/19.0/do_stock_barcode), [ECOSIRE PWA](https://ecosire.com/apps/odoo/inventory-manufacturing-pwa).
- ERPNext: [ECOSIRE, escáner para ERPNext](https://ecosire.com/apps/erpnext/erpnext-mobile-barcode-scanner) (datos del vendedor).
- Especificaciones generales de GS1 (AI, FNC1, fechas YYMMDD con día 00, regla de siglo): conocimiento previo, no reconsultado hoy.
