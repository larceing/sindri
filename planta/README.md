# Planta: Efesto (agente) y simuladores

> **Efesto** lee cualquier sistema de producción con un driver por protocolo (OPC UA, Modbus, S7,
> EtherNet/IP, ADS, MELSEC, FINS, Keyence, MQTT, Sparkplug B, MTConnect, HTTP, BACnet, SQL,
> ficheros y puerto serie). Cómo funciona, cómo se añade un driver como módulo y qué falta:
> [docs/EFESTO.md](../docs/EFESTO.md).

Lo que conecta Sindri con la fábrica. Las reglas completas están en [docs/INSTRUCCIONES.md](../docs/INSTRUCCIONES.md), parte C. En corto:

- La conexión la abre el agente desde la fábrica, hacia fuera, por HTTPS. Sindri nunca entra en la red de planta.
- El agente solo lee. No hay ninguna llamada de escritura en el código.
- Si Sindri se cae, la fábrica sigue: el agente guarda lo pendiente en SQLite y lo manda cuando vuelve.
- DEV nunca toca la planta de verdad. Si Sindri no es PRO, el agente solo arranca contra el simulador (lo comprueba por el espacio de nombres `urn:sindri:simulador`) y, si no, se para.

## `agente/`

Lee del SCADA por OPC UA y manda a `<sindri>/api/planta/v1/`:

| Ruta | Qué hace |
|---|---|
| `GET /config` | Máquinas y tags que tiene que leer, y cada cuánto. Se edita en Sindri, no en la fábrica |
| `POST /lecturas` | Hasta 1000 lecturas. Cada una lleva su id: si llega dos veces, cuenta una |
| `POST /latido` | Versión, pendientes y si llega al SCADA. Sindri marca «Callado» a los 5 minutos sin latido |

Qué se manda: los estados y los textos (orden, alarma) cuando cambian; los contadores y las medidas, un resumen por minuto (último, mínimo, máximo, media). Todo en UTC. Sindri guarda el detalle 90 días y los resúmenes siempre.

### Token

Cada agente tiene su token, que crea un administrador en Sindri → Planta y se enseña una sola vez. Solo sirve para `/api/planta/`; con él no se ve nada más de Sindri. Se puede revocar.

En el agente va en un fichero legible solo por su usuario (`SINDRI_PLANTA_TOKEN_FICHERO`). Nunca en el repositorio ni en un chat.

### Variables

| Variable | Ejemplo |
|---|---|
| `SINDRI_URL` | `https://dev.<dominio>/sindri` |
| `SINDRI_PLANTA_TOKEN_FICHERO` | `/run/secrets/planta_token` |
| `EFESTO_FUENTES` | `fuentes.json` con cómo llegar a cada sistema (ver `ejemplos/`) |
| `OPCUA_URL` | `opc.tcp://<scada>:4840/` (sin `fuentes.json`, como en la 0.1) |
| `OPCUA_USUARIO`, `OPCUA_CLAVE_FICHERO` | Usuario de solo lectura del SCADA |
| `OPCUA_SEGURIDAD` | `Basic256Sha256,SignAndEncrypt,cert.der,clave.pem` |
| `DATOS` | Carpeta de la cola local |

### Pruebas e imagen

```bash
cd planta/agente && python -m unittest -v
```

Una release `planta-vX.Y.Z` publica `ghcr.io/larceing/sindri-planta:X.Y.Z` (workflow `planta.yml`). La versión del agente está en `VERSION`, dentro de `agente.py`.

## `simulador/`

`multiprotocolo.py`: 22 máquinas de mentira, una por protocolo, para desarrollar y probar drivers
(ver docs/EFESTO.md). `simulador.py`: el servidor OPC UA de una línea de envasado con estado, piezas buenas y malas, velocidad, temperatura del horno, orden en curso y alarmas. Es lo único contra lo que trabajan el entorno local y DEV.

## Probarlo en local

Ver «Desarrollo en local» en el [README](../README.md).
