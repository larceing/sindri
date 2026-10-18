# Sindri ERP

ERP + CRM **open source** para pymes industriales españolas. Funciona **sin depender de internet**:

- **Aplicación de escritorio** (Windows, macOS, Linux). Lleva dentro el servidor y la base de datos. Se instala y funciona, sin conexión.
- **Aplicación web**. La sirve un servidor instalado en la red local de la fábrica, y la usan desde cualquier navegador los PCs, las tablets y las PDA de la planta.
- **Internet solo hace falta para enviar a terceros** (AEAT, FACe, transportistas, EDI). Esos envíos se guardan en una bandeja de salida y salen solos cuando hay conexión.

> **¿Por qué Sindri?** En la mitología nórdica, Sindri es el herrero maestro que forjó el martillo de Thor. Sindri ERP está hecho para quienes fabrican: la oficina y la planta de una fábrica, en un solo sistema.

Licencia: **AGPL-3.0-or-later** (ver `LICENSE`).

## Qué hace ya (versión 0.1)

**Ciclo completo:** cliente → pedido → albarán → factura → cobro.

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

**Facturas**
- Número sin huecos que se asigna al emitir.
- IVA desglosado por tipos.
- Una vez emitida es inmutable: la base de datos rechaza modificarla o borrarla.
- Cobros parciales.

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

# Desarrollo de la interfaz con recarga en caliente
pnpm dev:server   # en una terminal
pnpm dev:web      # en otra: http://localhost:5173
```

Escritorio contra tu Sindri local: `SINDRI_URL=http://localhost:8000/sindri/ SINDRI_ENTORNO=dev pnpm escritorio`. Detalle en [escritorio/README.md](escritorio/README.md).

Las pruebas contra PostgreSQL real se activan con `TEST_DATABASE_URL=postgres://...`.

## En el servidor DEV/PRO

Sindri se da de alta como una app más del servidor común (`servidor.json`, imagen en GHCR y entrada con Keycloak): ver [docs/SERVIDOR-DEV-PRO.md](docs/SERVIDOR-DEV-PRO.md).

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
- [Sistema de diseño](docs/SISTEMA-DE-DISENO.md)
