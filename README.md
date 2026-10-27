# Sindri ERP

ERP + CRM **open source** para pymes industriales españolas. Funciona **sin depender de internet**:

- **Aplicación de escritorio** (Windows, macOS, Linux). Lleva dentro el servidor y la base de datos. Se instala y funciona, sin conexión.
- **Aplicación web**. La sirve un servidor instalado en la red local de la fábrica, y la usan desde cualquier navegador los PCs, las tablets y las PDA de la planta.
- **Internet solo hace falta para enviar a terceros** (AEAT, FACe, transportistas, EDI). Esos envíos se guardan en una bandeja de salida y salen solos cuando hay conexión.

> **¿Por qué Sindri?** En la mitología nórdica, Sindri es el herrero maestro que forjó el martillo de Thor. Sindri ERP está hecho para quienes fabrican: la oficina y la planta de una fábrica, en un solo sistema.

Licencia: **AGPL-3.0-or-later** (ver `LICENSE`).

## Qué hace ya (versión 0.2)

**Ciclo completo:** cliente → pedido → hoja de ruta → albarán → factura → cobro.

**Usuarios y empresas**
- Varias empresas, cada una con sus datos, numeración y cadena VERI*FACTU. Quien trabaja en varias elige al entrar y puede cambiar sin salir.
- Roles con permisos por parte de Sindri (sin acceso, ver, ver y cambiar) y departamentos.
- Cada persona coloca su menú a la izquierda, arriba o abajo, lo ordena y oculta lo que no usa.

**Comercial**
- Ficha de cliente completa: datos, dirección fiscal, condiciones (forma y días de pago, límite de crédito, descuento, IBAN), comercial, contactos, direcciones de entrega con horario, y sus pedidos y facturas.
- Comerciales de plantilla y representantes externos, con zona, comisión y lo facturado y su comisión del mes y del año.
- Pedidos con comercial, dirección y fecha de entrega. Separar un pedido: pasar cantidades a un pedido nuevo.
- Hojas de ruta: pedidos por zona, orden de paradas, salida, entregado o incidencia por parada y cierre.

**CRM y presupuestos**
- Oportunidades en un embudo (nueva, contactada, propuesta, ganada, perdida) con importe, probabilidad, previsión ponderada y motivo de pérdida. Pueden ser de alguien que todavía no es cliente; se da de alta con un botón.
- Seguimiento: llamadas, correos, reuniones, tareas y notas, con lo pendiente de hoy a la vista.
- Presupuestos desde modelos editables (de partida: Proyecto, Soporte y Servicios) con título, presentación, condiciones y validez. Se envían, se aceptan o se rechazan; aceptar crea el pedido confirmado y gana la oportunidad.

**Empresas**
- Cada empresa lleva un código (001, 002…) que se ve al elegirla y sirve para buscarla. Las de demostración llevan la marca DEMO, una franja en todas las pantallas y están abiertas a cualquiera que entre en Sindri; las reales, solo a quien se le asignen.

**Integraciones y correo**
- Otras apps (incidencias, tareas…) se conectan a una empresa con su llave: leen clientes y productos y mandan horas o servicios a **Pedidos → Por facturar** ([docs/INTEGRACIONES.md](docs/INTEGRACIONES.md)).
- Confirmación de pedidos por correo con el PDF, con el Mail del servidor: automática al confirmar (si la empresa lo activa) o a mano desde el pedido.

**Informes**
- Facturas, pedidos, albaranes y hojas de ruta en PDF con el Report Server ([docs/report-server](docs/report-server/README.md)); sin él, se imprimen con el navegador.
- Datos en CSV, XML o JSON para Excel o cualquier herramienta de informes, con lectores de solo lectura que se pueden revocar. Entre ellos, los cobros recibidos por fecha de cobro (Informes → «Cobros recibidos»).

**Datos maestros**
- Empresa, clientes y proveedores con validación de NIF/NIE/CIF.
- Recargo de equivalencia y retención de IRPF.
- Productos almacenables, consumibles y servicios, con EAN/GTIN.

**Almacén**
- Libro de movimientos inmutable. Las existencias se calculan a partir de los movimientos, nunca se guardan a mano.
- Lotes con caducidad.
- Las salidas toman primero el lote que caduca antes (FEFO).
- Bloqueo para no vender dos veces la misma unidad.

**Pedidos**
- Máquina de estados estricta: borrador → confirmado → entregado → facturado.

**PDA del almacén** ([docs/PDA.md](docs/PDA.md))
- `#/pda` en el Chrome de la PDA: consultar, recibir y ubicar leyendo la etiqueta del proveedor, traspasar entre ubicaciones, preparar pedidos con el lote y la ubicación leídos (reservados a quien los prepara), recuento de inventario a ciegas y lo pendiente. Sigue sin conexión y lo manda al volver sin duplicar.
- Entiende GS1-128, DataMatrix, QR, Digital Link y EAN (lote, caducidad, SSCC, cantidad, peso).
- `#/pda-simulador`: prueba la PDA sin aparato, con el escáner de DataWedge, Honeywell o una pistola USB y sus fallos.
- [`pda-android/`](pda-android/README.md): app Android que recibe el escáner por Intent (DataWedge, Honeywell), con gatillo y cámara, y scripts para probar lecturas en el emulador de Android Studio.

**Facturas**
- Número sin huecos que se asigna al emitir.
- IVA desglosado por tipos.
- Una vez emitida es inmutable: la base de datos rechaza modificarla o borrarla.
- Cobros parciales.
- Una emitida se anula entera con **Anular con rectificativa**: serie R, tipo R1, las mismas líneas en negativo y su registro VERI\*FACTU. Las dos quedan «Rectificada» y ya no salen como pendientes. Si estaba cobrada, sus cobros se dan por devueltos: se quitan y quedan apuntados en el registro de cambios.

**VERI\*FACTU**
- Huella SHA-256 encadenada y URL del QR.
- Las pruebas reproducen los **ejemplos oficiales de la AEAT**.
- El QR se dibuja en local.
- El registro se genera **al emitir y sin red**. El envío queda en la bandeja de salida.

**Auditoría**
- Registro de eventos inmutable.

**Bibliotecas incluidas para lo que viene:** aritmética decimal exacta (nada de coma flotante en importes ni cantidades) y dígitos de control GS1 / SSCC-18.

## Estructura

```
packages/core     Reglas de negocio puras: decimales, impuestos, estados, NIF, GS1, VERI*FACTU
apps/server       API REST (Fastify) + PostgreSQL o PGlite + migraciones SQL versionadas
apps/web          Interfaz web (React + Vite)
escritorio/       Escritorio (Electron): una ventana sobre la web de Sindri, sin datos en el PC
planta/           Agente de planta (OPC UA) y simulador
docs/             Arquitectura y hoja de ruta
```

## Empezar

Requisitos: Node.js 22 o superior y pnpm 10.

```bash
pnpm install
pnpm build
pnpm test                 # pruebas del núcleo y del servidor

# Servidor + web en el navegador
pnpm --filter @sindri/server start      # http://127.0.0.1:8000  (datos en ./.data)

# Servidor de empresa con PostgreSQL, accesible desde la red local
DATABASE_URL=postgres://usuario:clave@localhost/sindri SINDRI_HOST=0.0.0.0 pnpm --filter @sindri/server start

# Con HTTPS propio (lo necesitan las PDA para trabajar sin conexión)
SINDRI_TLS_CERT=cert.pem SINDRI_TLS_CLAVE=clave.pem SINDRI_HOST=0.0.0.0 pnpm --filter @sindri/server start

# Desarrollo de la interfaz con recarga en caliente
pnpm dev:server   # en una terminal
pnpm dev:web      # en otra: http://localhost:5173
```

Escritorio contra tu Sindri local: `SINDRI_URL=http://localhost:8000/sindri/ SINDRI_ENTORNO=dev pnpm escritorio`. Detalle en [escritorio/README.md](escritorio/README.md).

Las pruebas contra PostgreSQL real se activan con `TEST_DATABASE_URL=postgres://...`.

## En el servidor DEV/PRO

Sindri se da de alta como una app más del servidor común (`servidor.json`, imagen en GHCR y entrada con Keycloak). La versión 0 ya se puede poner en DEV con la base integrada, sin esperar a PostgreSQL: ver [docs/SERVIDOR-DEV-PRO.md](docs/SERVIDOR-DEV-PRO.md).

## Desarrollo en local

Con Docker: la app, PostgreSQL, un Keycloak de pruebas y el simulador OPC UA de planta, detrás de una entrada que imita la del servidor (todo bajo `/sindri/`).

```bash
cp desarrollo/.env.ejemplo .env     # claves solo para este equipo
docker compose up --build
```

- Sindri: http://localhost:8000/sindri/ (usuarios de prueba `prueba`/`prueba` administrador, `comercial`/`comercial` de CRM, `fuera`/`fuera` sin acceso).
- Keycloak de pruebas: http://localhost:8080 (realm `general`, grupos `/DEV/Sindri/...` como en el servidor).
- Simulador OPC UA: `opc.tcp://localhost:4840/`, carpeta `Planta/Linea1`. Nunca se conecta a la planta de verdad.

Para ver datos de planta en Sindri → Planta:

1. Entra como `prueba`, crea un agente y guarda su token en `desarrollo/planta.token` (no se sube al repositorio).
2. En la misma pantalla, asigna la Línea 1 a ese agente.
3. `docker compose --profile planta up -d --build agente-planta`

Más detalle en [planta/README.md](planta/README.md).

## Documentación

- [Arquitectura](docs/ARQUITECTURA.md)
- [Hoja de ruta](docs/HOJA-DE-RUTA.md)
- [PDA y su simulador](docs/PDA.md)
- [Sistema de diseño](docs/SISTEMA-DE-DISENO.md)
