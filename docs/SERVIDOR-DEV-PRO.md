# Sindri en el servidor DEV/PRO

Sindri se registra como cualquier app del servidor común ([larceing/servidor](https://github.com/larceing/servidor)), con la receta A: tipo `servidor`, sin scripts ni claves SSH en GitHub. La guía de ese repositorio es la que manda; aquí solo está lo propio de Sindri. Las instrucciones completas están en [INSTRUCCIONES.md](INSTRUCCIONES.md).

## Estado

- **Local:** listo (ver «Desarrollo en local» en el README).
- **DEV:** versión 0 lista para ponerla ya, con la base integrada en `/datos` (ver «Versión 0 en DEV»). Cuando el servidor sepa dar PostgreSQL a una app (punto 1 de la Parte D), pasa a PostgreSQL sin tocar nada aquí.
- **PRO:** en marcha con la base integrada para ir probando (sin datos de demostración). Los datos se llevan con «Llevar y traer datos» (abajo).

| | DEV | PRO |
|---|---|---|
| Dirección | `dev.<dominio>/sindri/` | `pro.<dominio>/sindri/` |
| Quién entra | `/DEV/Sindri` y subgrupos, e `/IT` | `/PRO/Sindri` y subgrupos, e `/IT` |
| Quién administra | `/DEV/Sindri/Admin` e `/IT` | `/PRO/Sindri/Admin` e `/IT` |
| Datos de demostración | Sí, la primera vez (se quitan con `SINDRI_DEMO=0`) | No |

## Versión 0 en DEV

El servidor todavía no da PostgreSQL a las apps de tipo `servidor`. Para no esperar, la versión 0 corre en DEV con la **base integrada** (PGlite), guardada en el volumen `/datos` que el servidor ya da a cada app. Probado con la imagen igual que la monta el servidor (límite de 1024 MB, `/sindri` quitado por la entrada, Keycloak):

- Arranca y responde `version/` en unos 20 segundos la primera vez (migraciones y datos de demostración); después, en unos 5.
- Memoria: unos 700 MB en el primer arranque y unos 280 MB después. Cabe en los 1024 MB de `servidor.json`.
- Los datos sobreviven a reinicios y a «Poner» otra versión, porque están en `/datos`.

Lo que hay que saber:

- **El volumen `/datos` no entra hoy en las copias nocturnas** (punto 2 de la Parte D). En DEV solo hay datos de demostración, así que no importa; nada de datos de verdad ahí.
- **Cuando llegue `DATABASE_URL`**, Sindri pasa sola a PostgreSQL y empieza con una base nueva (otra vez con datos de demostración). Lo que se haya escrito a mano en DEV con la base integrada no se lleva.
- **En PRO sin `DATABASE_URL`** arranca con la base integrada en `/datos` para ir probando, y lo avisa en el registro. Los datos de verdad tienen que ir a PostgreSQL: cuando llegue `DATABASE_URL`, PRO empieza con una base nueva (sin datos de demostración).

Pasos (todos en GitHub y en Ajustes; desde aquí no se toca el servidor):

1. Unir a `main` el cambio que trae esta versión. GitHub pasa las pruebas y sube `ghcr.io/larceing/sindri:sha-xxxxxxx` (la etiqueta sale en la ejecución «Imagen» de Actions).
2. Si el paquete de GHCR es privado: ponerlo público (GitHub → Packages → sindri → Package settings) o hacer una vez `docker login ghcr.io` en el servidor.
3. Si el token de GitHub de Ajustes lleva lista de repositorios: añadir `larceing/sindri` (Actions, Contents y Deployments, lectura y escritura).
4. Ajustes → **Añadir una aplicación** → `larceing/sindri`, rama `main` → **Añadir**.
5. En la tarjeta, fila **DEV**: la versión `sha-xxxxxxx` → **Poner**.
6. Probar en `https://dev.<dominio>/sindri/`. IT entra sin más; a los demás, meterlos en `/DEV/Sindri` en Keycloak.
7. **No** pulsar «Pasar a PRO».

## Versión 0.2: usuarios, empresas y Report Server

- **Quién entra** lo sigue decidiendo Keycloak (grupo `/DEV/Sindri`). Dentro de Sindri, cada persona tiene rol, departamento, empresas y su menú (Sindri → Usuarios). Quien entra por primera vez queda con el rol «Consulta» (ve y no cambia). Los de `/DEV/Sindri/Admin` o IT lo pueden todo.
- **Varias empresas**: cada una con sus clientes, productos, pedidos, facturas, numeración y cadena VERI*FACTU. Quien trabaja en más de una elige al entrar. La base de DEV de la versión 0 se actualiza sola: lo que había pasa a la primera empresa y se añade una segunda empresa de demostración.
- **Report Server**: crear la llave para `sindri` y conectarlo en Sindri → Informes → Conectar; Sindri instala él solo sus plantillas (pasos en [report-server/README.md](report-server/README.md)). Sin eso, Sindri imprime con el navegador.

## Varias personas, cada una con lo suyo y los maestros en común

Para que dos personas (o dos negocios) usen el mismo Sindri sin ver lo del otro, pero con los
mismos clientes y servicios:

1. **Una empresa para cada una** (Empresa → Añadir empresa), cada una con su NIF, su numeración y
   su cadena VERI*FACTU. Las facturas de cada uno salen con su NIF.
2. **Maestros comunes**: en la empresa nueva (vacía), Empresa → Compartir y reservar →
   «Clientes, productos y tarifas: los de 001». Desde entonces clientes (con contactos, direcciones
   y tarifas), productos y servicios y modelos de presupuesto son los mismos en las dos: lo que da
   de alta una lo ve la otra. El precio de cada línea se sigue pudiendo cambiar en el documento
   (la tarifa solo se propone). Presupuestos, oportunidades, pedidos, albaranes, hojas de ruta,
   facturas, cobros, stock, comerciales, informes y llaves de integración siguen siendo de cada empresa.
3. **Keycloak manda quién ve qué** (subgrupos del grupo de la app, que se crean a mano en Keycloak):
   - `/<ENT>/Sindri/Empresa/<código>`: trabaja en esa empresa (p. ej. `/PRO/Sindri/Empresa/002`).
   - `/<ENT>/Sindri/Rol/<nombre>`: su rol en Sindri es ese (`Comercial`, `Consulta`… o uno propio
     creado en Usuarios); manda sobre el que tenga puesto en Usuarios.
   - El grupo de la app (`/<ENT>/Sindri`) sigue haciendo falta para entrar.
4. **Empresa reservada** (Compartir y reservar → Acceso: Reservada): solo la ve quien esté en su
   grupo `Empresa/<código>`, **también quien administra** (IT o `/Sindri/Admin`). Así ninguno ve las
   proformas, pedidos ni facturas del otro. Si la reservas sin estar en su grupo, dejas de verla
   (Sindri lo avisa); para volver a verla, entra en el grupo.
5. **Contraseña de la empresa** (Empresa → Contraseña de la empresa): además de entrar con
   Keycloak, quien elige esa empresa tiene que escribir su contraseña (vale 12 horas en ese
   navegador). La pone quien administra la empresa; para cambiarla o quitarla hace falta la actual,
   y al cambiarla todos los que la tenían abierta la vuelven a pedir. Si se olvida, administración
   general la quita sin saberla (Empresa → tabla de empresas → Quitar; queda en el registro).
6. **Administrar solo su empresa**: quien tiene un grupo `Empresa/<código>` y un rol con todo
   (`Rol/Administración`) administra **solo esas empresas**: datos, series, correo, contraseña y todos
   los módulos. No ve Usuarios ni roles (son de todo Sindri), no crea empresas ni toca «Compartir y
   reservar». Las personas de su empresa se dan de alta en Keycloak con su grupo `Empresa/<código>`.

Los grupos se leen al entrar: un cambio en Keycloak se nota al volver a entrar en Sindri.
Quien administra el servidor (root, la base de datos) sigue pudiendo llegar a todo: la separación
es dentro de la aplicación.

## Qué hay en este repositorio para el servidor

- `servidor.json`: ruta `sindri`, grupo `Sindri`, puerto 8000, prefijo `quitar`, versión en `version/`, despliegue tipo `servidor` con la imagen `ghcr.io/larceing/sindri` y 1024 MB.
- `.github/workflows/imagen.yml`: pasa las pruebas (también contra PostgreSQL) y en cada push a `main` sube `ghcr.io/larceing/sindri:sha-xxxxxxx`; en cada release, `:vX.Y.Z`.
- `GET /version/` responde `{"version":"sha-xxxxxxx","escritorio_minima":"0.1.0"}`.
- `GET /api/v1/compat` dice la versión mínima del escritorio y del agente de planta.
- Entrada con Keycloak cuando `app.env` trae `AUTH_MODO=sso` (Authorization Code, cliente `sindri-<entorno>`, sesión en cookie firmada).
- Las direcciones salen de `X-Forwarded-Prefix` y del `Host`.
- Las migraciones se aplican solas al arrancar.

## Llevar datos a PRO

En **Empresa → Llevar y traer datos** (solo administración):

1. En DEV (o en el Gestor de incidencias, Ajustes → «Descargar para Sindri»), descarga el `.json`.
2. En PRO, crea la empresa (la primera vez Sindri la pide) y entra en Empresa.
3. «Importar un fichero…»: Sindri enseña qué haría y no guarda nada hasta pulsar «Importar».

Viajan clientes (con contactos, direcciones y tarifas propias), productos y modelos de
presupuesto. Desde el Gestor de incidencias llegan además los servicios como artículos (por horas)
y las horas pendientes de cobrar, que quedan en **Pedidos → Por facturar** con las horas como
cantidad; antes de importar se ve la tabla por cliente y servicio. No se borra nada: lo que ya
existe se actualiza (clientes por NIF o por nombre, productos por referencia, modelos por nombre,
lo por facturar por su referencia mientras siga pendiente). Pedidos, facturas y VERI*FACTU no viajan: su numeración es de cada
instalación. API: `GET /api/v1/datos/exportar` y `POST /api/v1/datos/importar[?probar=1]`,
formato `sindri-datos` versión 1.

## API

- `/sindri/api/v1/...`: la web y el escritorio.
- `/sindri/api/planta/v1/...`: el agente de planta, con su token (ver [planta/README.md](../planta/README.md)).
- `/sindri/api/informes/v1/...`: datos en solo lectura (CSV, XML o JSON) para Excel, Power BI y otras herramientas de informes, con el token de un lector creado en Sindri → Informes.

Un cambio que rompa algo va a `v2`; `v1` sigue mientras haya clientes que la usen.

## Variables que lee Sindri

| Variable | De dónde viene | Para qué |
|---|---|---|
| `SERVIDOR_ENTORNO` | servidor | `dev` carga los datos de demostración la primera vez; además, Sindri se fía del proxy |
| `AUTH_MODO=sso`, `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` | servidor | Entrada con Keycloak |
| `KEYCLOAK_GRUPO_APP`, `KEYCLOAK_GRUPO_ADMIN_GLOBAL` | servidor | Quién entra y quién administra |
| `DATABASE_URL` | servidor (cuando exista el punto D1) | Base de datos del entorno |
| `APP_VERSION` | imagen | Lo que responde `/version/` |
| `KEYCLOAK_INTERNO` | opcional | Llamar a Keycloak por la red interna |
| `SINDRI_DEMO=0` | opcional | No cargar los datos de demostración en DEV |
| `SINDRI_CLAVE_SESION` | opcional | Clave de las cookies; sin ella se deriva del secreto del cliente |
| `REPORT_URL`, `REPORT_LLAVE` | opcional, a mano en `app.env` | Conexión con el Report Server. Lo normal es ponerla en Sindri → Informes → Conectar; si están estas variables, mandan ellas (ver [report-server/README.md](report-server/README.md)) |

Sin `DATABASE_URL`, Sindri usa su base integrada en `/datos` y gasta bastante más memoria que con PostgreSQL. Vale para la versión 0 en DEV y para probar en PRO; para datos de verdad, PostgreSQL.

## Lo que todavía no está

- **Aviso por correo o campana** cuando un agente se calla. Hoy se ve en la pantalla de Planta.
- **Instalador del agente como servicio de Windows.** Hoy va en Docker.
- **Actualización automática y firma del escritorio.** Hoy, si el servidor pide una versión más nueva, el escritorio lo dice y abre la página de descargas.
- **Envío a la AEAT.**
