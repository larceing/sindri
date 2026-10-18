# Sindri en el servidor DEV/PRO

Sindri se da de alta como cualquier app del servidor común ([larceing/servidor](https://github.com/larceing/servidor)). Se usa la receta A: el tipo `servidor`, que no necesita scripts ni claves SSH en GitHub. La guía de ese repositorio es la que manda. Esto solo dice lo propio de Sindri.

| | DEV | PRO |
|---|---|---|
| Dirección | `dev.<dominio>/sindri/` | `pro.<dominio>/sindri/` |
| Contenedor de la app (lo crea el servidor) | `sindri-dev` | `sindri-pro` |
| Base de datos (la creas tú, una vez) | `sindri-bd-dev`, en `/opt/apps/sindri-bd-dev` | `sindri-bd-pro`, en `/opt/apps/sindri-bd` |
| Quién entra | `/DEV/Sindri` y subgrupos, e `/IT` | `/PRO/Sindri` y subgrupos, e `/IT` |
| Quién administra | `/DEV/Sindri/Admin` e `/IT` | `/PRO/Sindri/Admin` e `/IT` |
| Datos de demostración | Sí, la primera vez (se quitan con `SINDRI_DEMO=0`) | No |

## Qué hay en este repositorio para el servidor

- `servidor.json`: la ruta es `sindri`, el grupo `Sindri`, el puerto 3210 y el prefijo `quitar`. La versión se lee en `version/` y el despliegue es de tipo `servidor`, con la imagen `ghcr.io/larceing/sindri` y 384 MB de memoria.
- `.github/workflows/imagen.yml`: pasa las pruebas, también contra PostgreSQL. Después, en cada push a `main`, sube `ghcr.io/larceing/sindri:sha-xxxxxxx`, y en cada release, `:vX.Y.Z`.
- `GET /version/` responde `{"version":"sha-xxxxxxx"}`.
- Entrada con Keycloak cuando el `app.env` trae `AUTH_MODO=sso`. Lo pone el servidor. Usa el flujo Authorization Code con el cliente `sindri-<entorno>`, y la sesión va en una cookie firmada.
- Las direcciones salen de `X-Forwarded-Prefix` y del `Host`, así que sirve igual en `pro…/sindri/` que en un dominio propio.
- Las migraciones se aplican solas al arrancar.
- `despliegue/servidor-dev-pro/`: el compose de PostgreSQL de cada entorno, con una copia diaria comprimida que se guarda 14 días.

## Paso a mano: la base de datos de cada entorno

Es la misma excepción que en Soporte con MariaDB: el tipo `servidor` solo da un volumen `/datos`. Sin `DATABASE_URL`, Sindri usaría su base integrada, pero esa necesita unos 460 MB de memoria frente a los 40 MB de la app con PostgreSQL. En una máquina compartida de 3,7 GB, PostgreSQL es lo que toca.

Para DEV (para PRO, lo mismo en `/opt/apps/sindri-bd` con `ENTORNO=pro`):

```bash
ssh servidor
sudo mkdir -p /opt/apps/sindri-bd-dev && cd /opt/apps/sindri-bd-dev
sudo curl -fsSLO https://raw.githubusercontent.com/larceing/sindri/main/despliegue/servidor-dev-pro/docker-compose.yml
sudo curl -fsSL -o .env https://raw.githubusercontent.com/larceing/sindri/main/despliegue/servidor-dev-pro/.env.ejemplo
sudo sed -i "s/^ENTORNO=.*/ENTORNO=dev/; s/^CLAVE_BASE_DATOS=.*/CLAVE_BASE_DATOS=$(openssl rand -hex 24)/" .env
sudo chmod 600 .env
sudo docker compose up -d
```

La clave se genera en el propio servidor y no sale de él. Las copias quedan en `/opt/apps/sindri-bd-dev/copias/`.

Si el repositorio es privado, las dos descargas con `curl` no funcionan. En ese caso, copia los dos ficheros a mano o haz un `git clone` en esa carpeta.

## En Ajustes

1. Si el token de GitHub de Ajustes lleva una lista de repositorios, añade `larceing/sindri`.
2. **Añadir una aplicación** → `larceing/sindri`, rama `main`. Se crean los grupos `/DEV/Sindri` y `/PRO/Sindri`, con su `/Admin`, y los clientes `sindri-dev` y `sindri-pro`.
3. Añade `DATABASE_URL` en `/opt/apps/servidor/apps/sindri/DEV/app.env`. Es lo único que Ajustes todavía no hace, y el servidor conserva esa línea en los despliegues. Esta orden lee la clave del `.env` de la base, así que no hay que copiarla:

   ```bash
   cd /opt/apps/sindri-bd-dev && . ./.env && echo "DATABASE_URL=postgres://sindri:${CLAVE_BASE_DATOS}@sindri-bd-dev:5432/sindri" | sudo tee -a /opt/apps/servidor/apps/sindri/DEV/app.env >/dev/null
   ```

4. Fila **DEV**: escribe la versión `sha-xxxxxxx` del último push (la acción «Imagen» tiene que salir en verde) y pulsa **Poner**.
5. Entra con tu usuario en `/DEV/Sindri/Admin` (o en IT) en `dev.<dominio>/sindri/` y prueba.
6. Cuando esté bien, crea la base de PRO, añade su `DATABASE_URL` a `.../sindri/PRO/app.env` (con `sindri-bd-pro`) y pulsa **Pasar a PRO**.

Si el paquete de GHCR es privado, hace falta una vez `docker login ghcr.io` en el servidor, con un token de lectura de paquetes. Si no, «Poner» dirá «no se puede descargar…».

## Variables que lee Sindri

| Variable | De dónde viene | Para qué |
|---|---|---|
| `SERVIDOR_ENTORNO` | servidor | `dev` carga los datos de demostración la primera vez. Además, Sindri se fía del proxy |
| `AUTH_MODO=sso`, `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` | servidor | Entrada con Keycloak |
| `KEYCLOAK_GRUPO_APP`, `KEYCLOAK_GRUPO_ADMIN_GLOBAL` | servidor | Quién entra y quién administra |
| `APP_VERSION` | imagen | Lo que responde `/version/` |
| `DATABASE_URL` | a mano en `app.env` | Base de datos del entorno |
| `KEYCLOAK_INTERNO` | opcional, a mano | Llamar a Keycloak por la red interna |
| `SINDRI_DEMO=0` | opcional, a mano | No cargar los datos de demostración en DEV |
| `SINDRI_CLAVE_SESION` | opcional, a mano | Clave de las cookies. Sin ella, se deriva del secreto del cliente |

## Lo que todavía no está

- **Escritorio contra el servidor.** Con Electron sobre la web haría falta un cliente público de Keycloak con PKCE y un actualizador firmado, como dice el documento de traspaso. Queda pendiente hasta decidir si hace falta trabajar sin conexión.
- **Permisos por rol dentro de Sindri.** Hoy, quien entra puede hacerlo todo. La marca de administrador ya llega en la sesión.
- **Envío a la AEAT.**
