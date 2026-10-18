# Instrucciones de Sindri: ERP con CRM, escritorio y conexión con planta

**Para la IA de este proyecto.** Este documento viene de otro proyecto (el del servidor y las
apps de Tareas) y es todo lo que necesitas: no tienes acceso a sus ficheros ni hace falta.
Léelo entero antes de escribir código, y guárdalo en el repo como `docs/INSTRUCCIONES.md`.

## Qué hay que hacer

Construir **Sindri**, un **ERP con el CRM dentro**, que se despliega en el servidor DEV/PRO de Luis, más
una **versión de escritorio** y un **agente de planta** que lee de SCADA. Por orden:

1. Leer en `larceing/servidor` (solo lectura) [`docs/README.md`](https://github.com/larceing/servidor/blob/main/docs/README.md),
   [`docs/NUEVA_APP.md`](https://github.com/larceing/servidor/blob/main/docs/NUEVA_APP.md) y [`AGENTS.md`](https://github.com/larceing/servidor/blob/main/AGENTS.md).
2. En el repo `larceing/sindri` (lo crea Luis), copiar la parte E: `servidor.json`,
   `.github/workflows/imagen.yml`, `AGENTS.md`.
3. Hacer la app web mínima: login con Keycloak, `GET /sindri/version/`, vive bajo `/sindri/`,
   Postgres, pruebas. Desarrollo en local con `docker-compose` (app + Postgres + simulador
   OPC UA).
4. Diseñar la API con versión (`/sindri/api/v1/` y `/sindri/api/planta/v1/`) pensando en el
   escritorio (parte B) y el agente de planta (parte C).
5. Ponerla en DEV desde Ajustes **cuando el servidor sepa dar Postgres a una app** (parte D,
   punto 1; lo está haciendo el otro proyecto). Hasta entonces, todo en local.
6. Nada a PRO hasta que Luis lo diga.

Reglas de trabajo: UI y documentación en español; ningún dominio, IP, persona ni secreto en
el código ni en el chat; el repo del servidor no se toca desde aquí (si hace falta algo del
servidor, se apunta y Luis lo lleva al otro proyecto).

---

# Parte A. La app web y el servidor

## Sindri (ERP con CRM): todo lo necesario para empezar

Para quien vaya a construir el CRM y el ERP (persona o IA). Se lee entero antes de escribir
código. Son tres piezas:

| Pieza | Dónde corre | Quién la despliega | Documento |
|---|---|---|---|
| **La app web** (CRM + ERP) | en el servidor, `/sindri/` | el servidor, DEV primero | este |
| **El escritorio** | en cada PC | GitHub Releases, no el servidor | la parte B de este documento |
| **El agente de planta** (SCADA, PLC, máquinas) | en un PC de la fábrica | se instala allí, no el servidor | la parte C |

El escritorio y el agente de planta hablan con la app web por su API, así que los dos se
leen **antes** de diseñar esa API.

### 1. Dónde están las instrucciones del servidor

La fuente buena está en el repositorio **`larceing/servidor`** (rama `main`). Si este proyecto no tiene ese repo añadido, añádelo para leerlo (solo lectura: no se cambia desde aquí).

| Qué | Dónde | Para qué |
|---|---|---|
| Cómo está montado y las reglas | [`docs/README.md`](https://github.com/larceing/servidor/blob/main/docs/README.md)  | Primero. El dibujo, nombres de rutas y grupos, los dos tipos de despliegue |
| Paso a paso de una app nueva | [`docs/NUEVA_APP.md`](https://github.com/larceing/servidor/blob/main/docs/NUEVA_APP.md)  | Lo que tiene que cumplir la app y cómo darla de alta |
| Producto con varias apps | [`docs/NUEVO_PRODUCTO.md`](https://github.com/larceing/servidor/blob/main/docs/NUEVO_PRODUCTO.md) | Solo si la app va dentro de un producto (no es el caso por defecto) |
| Reglas para una IA | [`AGENTS.md`](https://github.com/larceing/servidor/blob/main/AGENTS.md)  | Lo que no se hace nunca |
| El manifiesto `servidor.json` campo a campo | [`README.md`](https://github.com/larceing/servidor/blob/main/README.md) del repo | Referencia |
| Un ejemplo real de alta en DEV | notas del proyecto de origen (no hacen falta aquí) | Es de tipo `workflow`; esta app no lo necesita, pero enseña el recorrido |
| Copias nocturnas y avisos | `/opt/copias/copias.sh` en el servidor | Qué se copia cada noche (ver el punto 6) |
| Ejemplo de app que vive bajo una ruta | `app_fastapi/ruta_base.py` en `larceing/APP_TAREAS_BASE` | Cómo no perder `/sindri/` en enlaces y redirecciones |
| Ejemplo de login Keycloak (sso) y grupos | `app_fastapi/auth.py` en `larceing/APP_TAREAS_BASE` (`acceso_por_grupos`) | Cómo leer los grupos del token |
| Ejemplo de agente que sale de una red local hacia el servidor | el agente de APP_DATA_SPSIL (túnel WebSocket hacia fuera) | El mismo patrón que el agente de planta |
| Ejemplo del job que construye la imagen | job `imagen` de `.github/workflows/despliegue.yml` en `larceing/aris` | Ya copiado en la parte E |

Direcciones: Ajustes está en PRO (`https://pro.<dominio>/ajustes/`, solo grupo IT). DEV es
`https://dev.<dominio>/`. El dominio no se escribe en el código: llega por variables.

### 2. Las decisiones ya tomadas

| | Valor | Por qué |
|---|---|---|
| Una sola app, Sindri: el CRM dentro del ERP | el CRM es un módulo más (clientes, oportunidades), junto a ventas, compras, stock y producción | Comparten clientes, productos y pedidos. Dos apps con dos bases obligarían a sincronizarlas siempre |
| Repositorio | **`larceing/sindri`** (lo tienes que crear tú en GitHub; desde aquí no se puede). Dentro: la app, `escritorio/` y `planta/` | Nada mezclado con otras apps; las tres piezas cambian juntas |
| Ruta | `/sindri/` (suelta, no dentro de SPSIL) | Si un día va dentro de un producto, basta `"dentro"` en el manifiesto |
| Grupos de Keycloak | `Sindri` → entra `/DEV/Sindri` (y subgrupos), administra `/DEV/Sindri/Admin` e `/IT`. Por módulo, subgrupos que se crean en Keycloak junto con meter a las personas: `/DEV/Sindri/CRM`, `/DEV/Sindri/Produccion`… | `/DEV/Sindri` y `/Admin` se crean solos al darlo de alta; los de módulo los lee la app del token |
| Despliegue | **tipo `servidor`** (receta A de NUEVA_APP) | Sin script en el servidor, sin claves SSH, sin pasos a mano |
| Imagen | `ghcr.io/larceing/sindri`, etiquetas `sha-xxxxxxx` (push a `main`) y `vX.Y.Z` (release) | Es lo que el servidor sabe desplegar |
| Base de datos | **PostgreSQL** propia de la app | Un ERP necesita transacciones de verdad y varios usuarios escribiendo. La receta A hoy no la da: pedido al servidor (punto 7) |
| Entornos | **solo DEV** hasta que digas lo contrario | Regla del servidor: DEV antes que PRO |

Mientras el servidor no sepa dar una base de datos a una app de tipo `servidor`, el
desarrollo sigue en tu PC (Postgres en Docker, ver el punto 5) y DEV espera. Si eso tarda
mucho, la otra salida es la receta B copiando `larceing/APP_TAREAS_SPSIL` (un paso a mano
en el servidor y tres secretos de SSH). Mejor no hacerlo sin hablarlo antes.

### 3. Lo que la app tiene que cumplir para enchufarse

1. **Un contenedor** que escuche en el 8000, sin publicar puertos.
2. **`GET /sindri/version/`** → 200 con `{"version": "sha-1a2b3c4"}` (la etiqueta que corre;
   llega como `APP_VERSION` en el build, ver la plantilla).
3. **Vivir bajo `/sindri/`**: con `"prefijo": "quitar"` la app recibe `/...` y la cabecera
   `X-Forwarded-Prefix: /sindri`. Todo enlace, redirección y cookie se construye con ese prefijo
   (o `APP_RUTA_BASE`) y el `Host` de la petición. Nada fijo.
4. **Login con Keycloak** (Authorization Code). El servidor le pasa, en `app.env`:
   `SERVIDOR_ENTORNO`, `APP_URL_PUBLICA`, `APP_RUTA_BASE`, `KEYCLOAK_ISSUER`,
   `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `AUTH_MODO=sso`, `KEYCLOAK_GRUPO_APP`
   (`DEV/Sindri`) y `KEYCLOAK_GRUPO_ADMIN_GLOBAL` (IT). El token trae `groups` con el camino
   entero (`/DEV/Sindri/Admin`). Entra quien esté en `KEYCLOAK_GRUPO_APP` o debajo, o en IT;
   administra `…/Admin` e IT.
5. **Datos en su Postgres**; ficheros subidos (facturas, adjuntos) en `/datos`. Lo que se
   escriba en otro sitio se pierde en cada versión. Las migraciones de la base van en la
   app y se aplican solas al arrancar, hacia delante y sin romper la versión anterior
   (si «Poner» vuelve atrás, la versión vieja tiene que seguir funcionando con la base).
6. **Pruebas en GitHub** antes de construir la imagen.

### 4. Cómo se pone en DEV (el recorrido entero)

0. Antes: que el servidor dé base de datos a las apps de tipo `servidor` (punto 7).
1. Crea el repo `larceing/sindri` en GitHub y copia dentro lo de la parte E
   (`servidor.json` en la raíz, el workflow en `.github/workflows/`, `AGENTS.md`).
2. Haz el primer push a `main` con la app mínima (que responda `/sindri/version/`). GitHub
   construye `ghcr.io/larceing/sindri:sha-xxxxxxx`.
3. Si el paquete de GHCR queda **privado**, el servidor tiene que poder descargarlo: o lo
   pones público (GitHub → Packages → sindri → Package settings), o hace falta una vez
   `docker login ghcr.io` en el servidor (si ya se hizo para otra app de `larceing`, vale).
4. Si el token de GitHub de Ajustes lleva lista de repositorios, añade `larceing/sindri`
   (Actions, Contents y Deployments: lectura y escritura).
5. Ajustes → **Añadir una aplicación** → `larceing/sindri`, rama `main` → **Añadir**. Se crean
   la ruta, los grupos `/DEV/Sindri`, `/PRO/Sindri` (con `/Admin`) y el cliente `sindri-dev`.
6. En la tarjeta, fila **DEV**: la versión `sha-xxxxxxx` → **Poner**. Si no responde su
   `version/`, vuelve sola a la anterior.
7. Prueba en `https://dev.<dominio>/sindri/`. IT entra sin más; a los demás, mételos en
   `/DEV/Sindri` en Keycloak.
8. **No** pulses «Pasar a PRO» hasta que lo digas.

Cada versión nueva: push a `main` → imagen nueva → «Poner» en DEV con esa versión.

### 5. Desarrollar en tu PC

Un `docker-compose.yml` en el repo con la app y un Postgres, y variables en un `.env`
local (nunca subido). Login: un Keycloak de pruebas en el mismo compose, o el cliente
`sindri-dev` con `http://localhost:8000/*` añadido en sus direcciones de vuelta. Para probar
la ruta, arranca con `APP_RUTA_BASE=/sindri`. Para la planta, un simulador (ver la parte C).

### 6. Cuidado con los datos

- Las copias nocturnas (`copias-y-avisos`) copian solas los contenedores Postgres/MariaDB
  y Keycloak. Si el servidor le da a la app su Postgres como contenedor, entra en la copia
  sin hacer nada. **El volumen `/datos` no se copia hoy** (pedido en el punto 7).
- Nada de datos de clientes de verdad en DEV, ni conectar DEV a la planta de verdad.
- Un ERP lleva facturas: antes de PRO, decide con tu gestoría qué exige la ley de tu país
  (en España, Verifactu/TicketBAI). Mejor diseñarlo desde el principio que añadirlo luego.

### 7. Lo que le falta al servidor (pedido aparte)

Apuntado en la parte D y enviado al hilo que lleva el
servidor. Esta app no toca el repo `larceing/servidor`.

### 8. Las reglas que no se rompen

- Nada de la app en el repo del servidor, ni del servidor en la app. Solo `servidor.json`.
- Ni dominios, ni IPs, ni personas, ni nombres de otras apps en el código.
- Ningún secreto en el repo ni en un chat: van en `app.env` (los pone el servidor), en
  secretos de GitHub o en el llavero del sistema (escritorio y agente de planta).
- DEV antes que PRO, siempre.


---

# Parte B. Escritorio

## ERP de escritorio: lo que hay que tener en cuenta

El servidor **no despliega** la versión de escritorio: se instala en cada PC. Pero habla con
la misma app web (DEV o PRO) y con el mismo Keycloak. Casi todo lo que puede salir mal sale
de olvidar eso. Esto se decide **antes** de escribir la API.

### 1. La regla de oro

El escritorio es **un cliente más** dla app web. No tiene base de datos propia con los datos
de verdad, no se conecta nunca a la base del servidor y no lleva dentro ningún secreto.
Todo pasa por HTTPS a `https://<entorno>/sindri/`. Así el servidor sigue siendo el único sitio
con datos, copias y permisos, y DEV/PRO siguen separados.

### 2. Dos formas de hacerlo (elige una antes de empezar)

| | **A. Ventana sobre la web** (recomendada para la v1) | **B. App nativa que usa la API** |
|---|---|---|
| Qué es | Una app (Tauri o Electron) que abre `https://<entorno>/sindri/` en su ventana y añade lo propio del PC (icono en la bandeja, avisos, abrir ficheros, atajos) | Una interfaz propia que llama a `/sindri/api/v1/...` |
| Código de pantallas | el mismo que la web | dos interfaces que mantener |
| Login | el mismo de la web (cliente `sindri-dev`, cookie de sesión). Nada nuevo en Keycloak | cliente público con PKCE: **lo tiene que crear el servidor** (ver la parte D) |
| Sin conexión | no funciona | posible, pero con sincronización y conflictos |
| Cuándo | casi siempre | solo si hace falta trabajar sin red o algo que la web no puede |

Si no hay un motivo claro para B, **A**. Se puede pasar de A a B más adelante si la API ya
existe y está bien versionada.

### 3. Login (las dos formas)

- **Nunca** meter `KEYCLOAK_CLIENT_SECRET` en el instalador: cualquiera lo saca. El
  escritorio no usa el cliente confidencial `sindri-dev`.
- Con **A**: el login es la página de Keycloak dentro de la ventana, como en el navegador.
  La ventana solo debe navegar por el dominio de la app y el de Keycloak; cualquier otro
  enlace se abre en el navegador del sistema.
- Con **B**: Authorization Code + PKCE (RFC 8252) con un cliente **público**
  `sindri-escritorio-dev` / `sindri-escritorio-pro`, abriendo el navegador del sistema y volviendo
  a `http://127.0.0.1:<puerto>/callback` (o un esquema propio `sindri://`). Nada de pedir
  usuario y contraseña en la app (Direct Access Grant: desactivado). El refresh token se
  guarda en el llavero del sistema (Windows: Credential Manager; con la librería
  `keyring` o el plugin de Tauri), nunca en un fichero de texto.
- La app web, con B, además de su cookie acepta `Authorization: Bearer <token>` en
  `/sindri/api/`: comprueba firma (JWKS del `KEYCLOAK_ISSUER`), `iss`, `exp`, `azp`/`aud`
  del cliente de escritorio de **su** entorno y los mismos grupos que la web
  (`/DEV/Sindri…` o IT). Un token de DEV no vale en PRO, y al revés.

### 4. DEV y PRO en el escritorio

- La dirección del servidor **no va escrita en el código**. Se mete al construir (variable
  del workflow, `vars.URL_DEV` / `vars.URL_PRO` en GitHub) o se elige en el primer arranque.
- Dos instaladores distintos: **«Sindri DEV»** (otro nombre, otro icono o una franja visible
  que diga DEV, otro identificador de app y otra carpeta de datos) y «Sindri». Así se pueden
  tener los dos instalados sin que uno pise al otro, y nadie trabaja en DEV creyendo que
  es PRO.
- Mientras la app esté solo en DEV, solo existe el instalador DEV.

### 5. Versiones: el escritorio siempre va por detrás

La web se actualiza al momento; los PC, cuando la gente acepta la actualización. Por eso:

- La API va con versión (`/sindri/api/v1/`). Un cambio que rompa va a `v2` y `v1` sigue
  viva un tiempo. Nunca quitar ni renombrar un campo de golpe.
- La app web publica `GET /sindri/version/` (ya lo pide el servidor) y, además,
  `"escritorio_minima": "1.2.0"` en esa misma respuesta o en `/sindri/api/v1/compat`. El
  escritorio lo mira al arrancar y, si es más viejo, pide actualizar en vez de fallar.
- Orden al publicar algo que necesitan los dos: primero el servidor (DEV), luego el
  escritorio.

### 6. Cómo se construye y se reparte

- Mismo repositorio `larceing/sindri`, carpeta `escritorio/`, con su propio workflow
  (`escritorio.yml`) que se lanza con etiquetas `escritorio-vX.Y.Z`, para no mezclarlo con
  las `vX.Y.Z` de la web (esas las usa el servidor para PRO).
- El instalador va a **GitHub Releases**. Actualizaciones automáticas desde ahí (updater
  de Tauri o `electron-updater`), con la firma de las actualizaciones activada (la clave
  privada, en secretos de GitHub).
- Firma de código de Windows: sin ella, SmartScreen avisa. Para pruebas internas en DEV
  se puede vivir sin ella; para repartirlo a más gente, hace falta un certificado.
- Pruebas en GitHub también para el escritorio (al menos que construya en Windows).

### 7. Lo que no se hace

- Conectar el escritorio a la base de datos o a cualquier cosa del servidor que no sea
  `https://<entorno>/sindri/` y Keycloak.
- Guardar datos de clientes en el PC (salvo una caché cifrada si se elige B con modo sin
  conexión, y borrándola al cerrar sesión).
- Llevar secretos dentro del instalador.
- Un mismo instalador que valga para DEV y PRO sin que se note cuál es.


---

# Parte C. Conexión con planta (SCADA)

## Conexión con producción (SCADA, PLC, máquinas)

El ERP quiere datos de la fábrica (piezas hechas, paradas, estados, alarmas, OEE) y, a veces,
mandarle cosas (la orden de fabricación que toca). Es la parte con más riesgo: un error aquí
puede parar una línea o abrir la red de las máquinas a Internet. Se lee **antes** de diseñar
la API.

### 1. Las reglas que no se rompen

1. **La red de planta nunca se abre hacia fuera.** Nada de puertos del SCADA o de los PLC
   en Internet, nada de VPN del servidor hacia la fábrica, nada de reenvío de puertos en el
   router. El servidor **no entra** en la planta.
2. **La conexión la abre la planta, hacia fuera**: un **agente de planta** que corre dentro
   de la fábrica, lee del SCADA y manda los datos por HTTPS al ERP. Es el mismo patrón que
   ya usa el agente de APP_DATA_SPSIL .
3. **Solo lectura por defecto.** El agente lee. Escribir en un PLC o en el SCADA está
   prohibido salvo un diseño aparte, aprobado y con lista cerrada (punto 5).
4. **DEV nunca toca la planta de verdad.** DEV trabaja contra un simulador. Solo el agente
   de PRO habla con el SCADA real.
5. **Si el ERP se cae, la fábrica sigue.** Nada en la planta puede depender de que el ERP
   responda.

### 2. El dibujo

```
 RED DE PLANTA (OT)                          │  INTERNET            SERVIDOR
                                             │
 PLC ─┐                                      │
 PLC ─┼─► SCADA / histórico ─► agente de ────┼── HTTPS (sale) ──► entrada ─► /sindri/api/planta/v1/
 HMI ─┘   (OPC UA, Modbus,      planta       │   token propio        (el ERP guarda y resume)
          MQTT, su base SQL)    (PC aparte,  │
                                 en la zona  │
                                 entre OT/IT)│
```

- El agente va en un PC o caja industrial **aparte**, en la zona entre la red de máquinas y
  la red de oficina (si la fábrica la tiene). Nunca dentro del PC del SCADA.
- Lee del SCADA por lo que el SCADA ofrezca, por este orden de preferencia:
  **OPC UA** (con usuario de solo lectura y cifrado), **MQTT** (si la planta ya tiene un
  broker, p. ej. Sparkplug B), la **base de datos del histórico** con un usuario de solo
  lectura, y **Modbus TCP** solo si no hay otra cosa (no tiene seguridad: solo dentro de la
  red de planta).
- Manda al ERP por HTTPS a `https://<entorno>/sindri/api/planta/v1/...`. Los WebSocket también
  pasan por la entrada del servidor si hacen falta, pero para empezar basta HTTPS con envíos
  cada pocos segundos.

### 3. El agente de planta

- Vive en el mismo repo, carpeta `planta/`, con su propia imagen
  (`ghcr.io/larceing/sindri-planta`) o instalador. **No lo despliega el servidor**: se instala en
  la fábrica (Docker o servicio de Windows) y se actualiza solo desde GitHub Releases, igual
  que el escritorio.
- **Su identidad**: un token por agente y por entorno, creado en la administración del ERP
  (solo `…/Admin` o IT), que se puede revocar. En el agente se guarda en el llavero del
  sistema o en un fichero solo legible por su usuario. Nunca en el repo ni en un chat. El
  token solo sirve para `/sindri/api/planta/`, nada más del ERP.
- **Guarda y reenvía**: si no hay red, guarda en local (SQLite) y manda lo pendiente cuando
  vuelva. Cada lectura con su id para que el ERP no la cuente dos veces.
- **Resume en origen**: no mandar cada tag cada segundo. Mandar cambios de estado, contadores
  y un resumen por minuto. El detalle fino se queda en el histórico del SCADA.
- **Hora**: todo en UTC, con la hora del origen, y el PC con NTP.
- **Configuración** (qué tags leer, cada cuánto, a qué máquina corresponde cada uno): la
  descarga del ERP (`GET /sindri/api/planta/v1/config`), no se edita a mano en la fábrica.
- **Salud**: el agente manda un latido; el ERP avisa (campana o correo) si un agente lleva
  X minutos callado.

### 4. En el ERP

- API aparte y con versión: `/sindri/api/planta/v1/`. Los agentes se actualizan tarde, como
  el escritorio: nunca romper `v1` de golpe.
- Tablas de series de tiempo con limpieza (p. ej. el detalle 90 días, los resúmenes
  siempre). Si crece mucho, TimescaleDB sobre el mismo Postgres, pero no para empezar.
- Pantalla de agentes: cuáles hay, de qué entorno, último latido, versión, revocar.

### 5. Escribir en la planta (solo si de verdad hace falta)

Ejemplo: mandar al SCADA la orden de fabricación siguiente. Si se hace:

- El ERP **no escribe** en el PLC. Deja la orden en una cola; el agente la recoge; el
  **SCADA** (y una persona en el HMI) decide si la acepta.
- Lista cerrada de qué se puede escribir, en la configuración del agente, no en el ERP.
- Registro de cada escritura (quién, cuándo, qué valor).
- Desactivado por defecto, y apagable en el agente sin tocar el ERP.
- Hablarlo antes con quien lleve la automatización de la fábrica.

### 6. Probarlo en DEV

- Un **simulador** en el `docker-compose` de desarrollo y en un PC de pruebas: un servidor
  OPC UA de demo (p. ej. el de la librería `asyncua`, con unos tags que suben y bajan) y,
  si hace falta, un simulador Modbus.
- El agente DEV apunta al simulador y a `https://dev.<dominio>/sindri/`, con su token de DEV.
- El agente de PRO, con su token de PRO, es el único que se instala en la fábrica. Y solo
  cuando digas.


---

# Parte D. Lo pendiente en el servidor

Ya pedido al proyecto del servidor; aquí solo para saber qué esperar.

## Lo que el ERP (con CRM) necesitaría del servidor

Para el hilo que lleva `larceing/servidor`. Esta app no toca ese repo. Por orden de
importancia: el 1 hace falta **para poder ponerla en DEV**; el 2 y el 3, antes de PRO.

1. **Base de datos propia para una app de tipo `servidor`.** Hoy `_compose_app` escribe un
   solo servicio (`app`) con un volumen `datos`. Un ERP necesita PostgreSQL. Propuesta: en
   el manifiesto, `"despliegue": {"tipo": "servidor", "base": "postgres:17"}` → el compose
   añade un servicio `bd` (solo en la red interna del proyecto, sin estar en la red del
   proxy), su volumen, una contraseña generada en `secretos/` y `DATABASE_URL` en `app.env`.
   Uno por entorno (DEV y PRO nunca comparten base). Como es un contenedor Postgres, las
   copias nocturnas (`/opt/copias/copias.sh`) ya lo copian solas.
2. **Copia del volumen `/datos` de las apps de tipo `servidor`** (adjuntos, facturas en
   PDF). Hoy no entra en las copias nocturnas.
3. **Secretos propios de una app en Ajustes** (correo SMTP, claves de API). Hoy van a mano
   en `app.env`. Propuesta: variables extra por entorno en la tarjeta de la app, que el
   agente mezcla en `app.env`.
4. **Cliente público de Keycloak para escritorio**, solo si se elige la forma B de
   la parte B. Hoy `asegurar_cliente` crea solo clientes confidenciales. Propuesta:
   `"keycloak": {"escritorio": {"cliente": "{ruta}-escritorio-{entorno}", "vueltas":
   ["http://127.0.0.1:53682/callback"]}}` → `publicClient: true`, PKCE S256 obligatorio,
   sin Direct Access Grant, el mismo mapper de grupos, y `KEYCLOAK_CLIENT_ID_ESCRITORIO`
   en `app.env` para que la API acepte esos tokens.
5. **(Opcional) Poner en DEV solo** cada imagen nueva de `main` para las apps de tipo
   `servidor`. Hoy hay que pulsar «Poner» con cada versión.

El agente de planta no necesita nada del servidor: entra por la ruta normal `/sindri/` (la
entrada ya pasa WebSocket).


---

# Parte E. Ficheros para copiar al repo

## `servidor.json` (raíz del repo)

```json
{
  "nombre": "Sindri",
  "ruta": "sindri",
  "grupo": "Sindri",
  "puerto": 8000,
  "prefijo": "quitar",
  "version": "version/",
  "despliegue": {
    "tipo": "servidor",
    "imagen": "ghcr.io/larceing/sindri",
    "memoria_mb": 1024
  }
}
```

## `.github/workflows/imagen.yml`

```yaml
# Pruebas e imagen de la app web. El servidor la despliega (tipo "servidor"):
#   push a main         -> pruebas -> ghcr.io/<repo>:sha-xxxxxxx  (luego «Poner» en DEV, en Ajustes)
#   release vX.Y.Z      -> pruebas -> ghcr.io/<repo>:vX.Y.Z
#   pull request        -> solo pruebas
# El escritorio y el agente de planta van en sus propios workflows (etiquetas
# escritorio-vX.Y.Z y planta-vX.Y.Z), para no mezclarse con las vX.Y.Z de la web.
name: Imagen

on:
  push:
    branches: [main]
  pull_request:
  release:
    types: [published]

permissions:
  contents: read

jobs:
  pruebas:
    runs-on: ubuntu-latest
    services:
      bd:
        image: postgres:17
        env:
          POSTGRES_PASSWORD: pruebas
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s --health-retries 20
    env:
      DATABASE_URL: postgresql://postgres:pruebas@127.0.0.1:5432/postgres
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      # Cambia estas dos líneas por las de tu app si no es Python.
      - run: pip install -r requirements.txt
      - run: python -m unittest discover -s tests -v

  imagen:
    needs: pruebas
    if: github.event_name == 'push' || github.event_name == 'release'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - id: v
        run: |
          if [ "$GITHUB_EVENT_NAME" = release ]; then
            echo "version=$GITHUB_REF_NAME" >> "$GITHUB_OUTPUT"
            echo "extra=latest" >> "$GITHUB_OUTPUT"
          else
            echo "version=sha-${GITHUB_SHA::7}" >> "$GITHUB_OUTPUT"
            echo "extra=main" >> "$GITHUB_OUTPUT"
          fi
          echo "imagen=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_OUTPUT"
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          # El Dockerfile la recibe con ARG APP_VERSION y la deja en ENV APP_VERSION:
          # es lo que responde GET <ruta>/version/.
          build-args: APP_VERSION=${{ steps.v.outputs.version }}
          tags: |
            ${{ steps.v.outputs.imagen }}:${{ steps.v.outputs.version }}
            ${{ steps.v.outputs.imagen }}:${{ steps.v.outputs.extra }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

## `AGENTS.md` (raíz del repo)

```markdown
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
```
