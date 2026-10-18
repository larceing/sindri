# Sistema de prueba en vuestro servidor

Con esto se monta Ergane en un servidor Linux con Docker. Se levantan dos contenedores:

- **ergane:** la aplicación web y su API.
- **base:** la base de datos PostgreSQL 17, con los datos guardados en un volumen de Docker.

La primera vez que arranca, Ergane carga datos de demostración: una conservera inventada con clientes, productos con lotes, stock, pedidos en todos los estados y dos facturas emitidas.

## Requisitos

- Un servidor Linux con Docker y el plugin `docker compose`, con unos 2 GB de RAM libres.
- Copia del proyecto en el servidor (con `git clone` o subiendo la carpeta).

## Instalar

```bash
cd ergane/despliegue
cp .env.ejemplo .env
nano .env                    # cambia las tres claves
docker compose up -d --build
```

Abre `http://IP-DEL-SERVIDOR:3210`. El navegador pedirá el usuario y la clave que pusiste en `.env`.

## Uso diario

| Para | Comando (dentro de `despliegue/`) |
|---|---|
| Ver si está en marcha | `docker compose ps` |
| Ver el registro | `docker compose logs -f ergane` |
| Parar | `docker compose stop` |
| Actualizar a una versión nueva | `git pull && docker compose up -d --build` |
| Copia de seguridad de la base | `docker compose exec base pg_dump -U ergane ergane > copia-$(date +%F).sql` |
| Empezar de cero (borra todos los datos) | `docker compose down -v` y luego `docker compose up -d` |

Los datos sobreviven a reinicios y actualizaciones. Solo se borran con `down -v`.

## Antes de abrirlo a internet

- **Pon HTTPS por delante.** El usuario y la clave viajan en cada petición y, sin cifrar, se pueden leer por el camino. Lo más sencillo es un proxy inverso (Caddy, Nginx o el que ya uséis) con certificado, apuntando al puerto 3210. Mientras tanto, déjalo solo en la red interna o detrás de una VPN.
- **El acceso es provisional.** Hay un solo usuario y una sola clave para todos. Los usuarios con permisos por puesto están en la hoja de ruta.
- **VERI\*FACTU no envía nada.** Las facturas generan su huella y su QR, pero el envío a la AEAT todavía no está hecho: los registros se quedan en la bandeja de salida.

## Si el servidor sale a internet por un proxy que intercepta HTTPS

La construcción descarga paquetes de npm. Si falla con `self-signed certificate`, pasa el certificado del proxy:

```bash
docker build --secret id=ca,src=/ruta/al/certificado.crt -t ergane-prueba-ergane ..
docker compose up -d --no-build
```
