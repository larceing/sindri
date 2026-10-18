# Sindri en el servidor DEV/PRO

Sindri se registra como cualquier app del servidor común ([larceing/servidor](https://github.com/larceing/servidor)), con la receta A: tipo `servidor`, sin scripts ni claves SSH en GitHub. La guía de ese repositorio es la que manda; aquí solo está lo propio de Sindri. Las instrucciones completas están en [INSTRUCCIONES.md](INSTRUCCIONES.md).

## Estado

- **Local:** listo (ver «Desarrollo en local» en el README).
- **DEV:** espera a que el servidor sepa dar una base PostgreSQL a una app (punto 1 de la Parte D, lo hace el proyecto del servidor). No hay paso a mano: no se crea ninguna base ni se toca `app.env` desde aquí.
- **PRO:** nada hasta que Luis lo diga.

| | DEV | PRO |
|---|---|---|
| Dirección | `dev.<dominio>/sindri/` | `pro.<dominio>/sindri/` |
| Quién entra | `/DEV/Sindri` y subgrupos, e `/IT` | `/PRO/Sindri` y subgrupos, e `/IT` |
| Quién administra | `/DEV/Sindri/Admin` e `/IT` | `/PRO/Sindri/Admin` e `/IT` |
| Datos de demostración | Sí, la primera vez (se quitan con `SINDRI_DEMO=0`) | No |

## Qué hay en este repositorio para el servidor

- `servidor.json`: ruta `sindri`, grupo `Sindri`, puerto 8000, prefijo `quitar`, versión en `version/`, despliegue tipo `servidor` con la imagen `ghcr.io/larceing/sindri` y 1024 MB.
- `.github/workflows/imagen.yml`: pasa las pruebas (también contra PostgreSQL) y en cada push a `main` sube `ghcr.io/larceing/sindri:sha-xxxxxxx`; en cada release, `:vX.Y.Z`.
- `GET /version/` responde `{"version":"sha-xxxxxxx","escritorio_minima":"0.1.0"}`.
- `GET /api/v1/compat` dice la versión mínima del escritorio y del agente de planta.
- Entrada con Keycloak cuando `app.env` trae `AUTH_MODO=sso` (Authorization Code, cliente `sindri-<entorno>`, sesión en cookie firmada).
- Las direcciones salen de `X-Forwarded-Prefix` y del `Host`.
- Las migraciones se aplican solas al arrancar.

## API

- `/sindri/api/v1/...`: la web y el escritorio.
- `/sindri/api/planta/v1/...`: el agente de planta, con su token (ver [planta/README.md](../planta/README.md)).

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

Sin `DATABASE_URL`, Sindri usa su base integrada, pero gasta unos 460 MB frente a 40 MB con PostgreSQL. En el servidor tiene que ser PostgreSQL.

## Lo que todavía no está

- **Aviso por correo o campana** cuando un agente se calla. Hoy se ve en la pantalla de Planta.
- **Instalador del agente como servicio de Windows.** Hoy va en Docker.
- **Escritorio como ventana sobre la web** (opción A), con instalador de DEV aparte.
- **Permisos por rol dentro de Sindri.** Hoy, quien entra puede hacerlo todo; la marca de administrador ya llega en la sesión.
- **Envío a la AEAT.**
