# Sindri de escritorio

Una ventana sobre la web de Sindri, como dice la parte B de [docs/INSTRUCCIONES.md](../docs/INSTRUCCIONES.md) (forma A).

- **Es un cliente más.** No tiene base de datos ni lleva secretos. Solo habla con `https://<entorno>/sindri/` y con su Keycloak. Los datos, las copias y los permisos están en el servidor.
- **Login:** la página de Keycloak dentro de la ventana, igual que en el navegador. No hace falta nada nuevo en Keycloak.
- **Solo navega por Sindri y Keycloak.** Keycloak lo saca de a dónde manda `/login`. Cualquier otro enlace se abre en el navegador del sistema.
- **Versiones:** al arrancar lee `escritorio_minima` en `/version/`. Si esta versión es más vieja, pide actualizar y abre las descargas.
- **Sin red no funciona.** Enseña un aviso y reintenta cada 15 segundos.

## DEV y PRO

La dirección no está en el código. Va en `entorno.json`, que se genera al construir:

| | Instalador | Carpeta de datos | Se distingue por |
|---|---|---|---|
| DEV | «Sindri DEV», `es.sindrierp.escritorio.dev` | `Sindri DEV` | Franja roja «DEV» arriba y título «Sindri DEV» |
| PRO | «Sindri», `es.sindrierp.escritorio` | `Sindri` | |

Mientras Sindri solo esté en DEV, solo se publica el instalador DEV.

## Desarrollar

Con el entorno local en marcha (`docker compose up`):

```bash
SINDRI_URL=http://localhost:8000/sindri/ SINDRI_ENTORNO=dev pnpm escritorio
```

Fuera de este PC solo se acepta HTTPS.

## Instalador

En GitHub, el workflow `escritorio.yml` construye en Windows cada cambio. Con una release `escritorio-vX.Y.Z` (la misma versión que `package.json`), adjunta el instalador «Sindri DEV». La dirección sale de la variable `URL_DEV` del repositorio (Settings → Secrets and variables → Actions → Variables). Es una dirección, no un secreto.

A mano: `SINDRI_ENTORNO=dev SINDRI_URL=https://dev.<dominio>/sindri/ pnpm --filter @sindri/escritorio dist`.

## Pendiente

- Actualización automática desde Releases, con las actualizaciones firmadas.
- Firma de código de Windows: sin ella, SmartScreen avisa. Para pruebas internas en DEV se puede vivir sin ella.
- Icono propio, y otro distinto para DEV.
