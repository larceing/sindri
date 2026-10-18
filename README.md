# Ergane ERP

ERP + CRM **open source** para pymes industriales españolas. Funciona **sin depender de internet**:

- **Aplicación de escritorio** (Windows, macOS, Linux). Lleva dentro el servidor y la base de datos. Se instala y funciona, sin conexión.
- **Aplicación web**. La sirve un servidor instalado en la red local de la fábrica, y la usan desde cualquier navegador los PCs, las tablets y las PDA de la planta.
- **Internet solo hace falta para enviar a terceros** (AEAT, FACe, transportistas, EDI). Esos envíos se guardan en una bandeja de salida y salen solos cuando hay conexión.

> **¿Por qué Ergane?** En la antigua Grecia, Atenea Ergane era la protectora de los artesanos y del trabajo en el taller. Ergane ERP está hecho para eso mismo: la oficina y la planta de una fábrica, en un solo sistema.

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
apps/desktop      Aplicación de escritorio (Electron) con servidor y base de datos embebidos
docs/             Arquitectura y hoja de ruta
```

## Empezar

Requisitos: Node.js 22 o superior y pnpm 10.

```bash
pnpm install
pnpm build
pnpm test                 # pruebas del núcleo y del servidor

# Opción 1: escritorio (base de datos local, sin servidor)
pnpm desktop

# Opción 2: servidor + web en el navegador
pnpm --filter @ergane/server start      # http://127.0.0.1:3210  (datos en ./.data)

# Servidor de empresa con PostgreSQL, accesible desde la red local
DATABASE_URL=postgres://usuario:clave@localhost/ergane ERGANE_HOST=0.0.0.0 pnpm --filter @ergane/server start

# Desarrollo de la interfaz con recarga en caliente
pnpm dev:server   # en una terminal
pnpm dev:web      # en otra: http://localhost:5173
```

Para generar los instaladores de escritorio: `pnpm --filter @ergane/desktop dist`.

Las pruebas contra PostgreSQL real se activan con `TEST_DATABASE_URL=postgres://...`.

## Sistema de prueba en un servidor

Con Docker, en un servidor Linux: ver [despliegue/README.md](despliegue/README.md). Monta la web, la API y PostgreSQL, con usuario y clave y datos de demostración.

## Documentación

- [Arquitectura](docs/ARQUITECTURA.md)
- [Hoja de ruta](docs/HOJA-DE-RUTA.md)
- [Sistema de diseño](docs/SISTEMA-DE-DISENO.md)
