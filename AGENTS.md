# AGENTS.md (larceing/sindri)

ERP con CRM dentro, más su escritorio (`escritorio/`) y su agente de planta (`planta/`).
UI y documentación en español.

Antes de tocar nada, lee `docs/INSTRUCCIONES.md` (este mismo documento, guardado en el repo), y en `larceing/servidor` los `docs/README.md` y `docs/NUEVA_APP.md`.

- Se enchufa al servidor solo con `servidor.json` (tipo `servidor`). Nada del servidor aquí,
  nada de esta app en `larceing/servidor`.
- Ni dominios, ni IPs, ni personas, ni nombres de otras apps en el código: todo llega por
  variables (`APP_URL_PUBLICA`, `APP_RUTA_BASE`, `KEYCLOAK_*`, `DATABASE_URL`).
- Direcciones siempre desde `X-Forwarded-Prefix`/`APP_RUTA_BASE` y el `Host`; nunca `/sindri`
  escrito a mano.
- `GET <ruta>/version/` responde `{"version": "<APP_VERSION>"}`.
- Migraciones hacia delante y compatibles con la versión anterior.
- API con versión (`/api/v1/`, `/api/planta/v1/`): el escritorio y los agentes van por detrás.
- Escritorio: sin secretos dentro, nunca habla con la base, DEV y PRO en instaladores distintos.
- Planta: la conexión sale de la fábrica, solo lectura por defecto, DEV solo contra simulador.
- Ningún secreto en el repo ni en un chat. DEV antes que PRO; a PRO solo cuando lo diga el
  responsable.
