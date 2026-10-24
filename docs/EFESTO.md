# Efesto: leer cualquier sistema de producción

Efesto es la parte de Sindri que trae los datos de la fábrica: estado de cada máquina, piezas
buenas y malas, medidas, alarmas y orden en curso. Es el agente de planta de `planta/agente/`,
que ahora lee de muchos sistemas distintos, cada uno con su **driver**.

Este documento recoge la investigación, lo que se ha construido y probado con simuladores, y lo
que falta. La investigación completa, con fuentes, está en [efesto/](efesto/):

- [investigacion-protocolos.md](efesto/investigacion-protocolos.md): 25 sistemas y 10 proyectos open source.
- [investigacion-fabricantes-espana.md](efesto/investigacion-fabricantes-espana.md): los fabricantes que más se ven en España.

## En corto

- **Hecho y probado:** 16 drivers y un simulador con 22 máquinas, una por protocolo o sistema.
  Sindri y Efesto juntos, de punta a punta: llegan los **106 de 106 tags** de las 23 máquinas
  (las 22 del simulador nuevo y la línea del simulador OPC UA de siempre).
- **Un sistema nuevo es un driver nuevo**, y un driver puede venir en un módulo aparte (un paquete
  de Python) sin tocar Efesto. El equipo de personalizaciones puede escribir el de una máquina rara.
- **Lo que no cambia:** solo lectura, DEV nunca toca la planta real, guarda y reenvía, y ni
  direcciones ni claves de la fábrica salen de ella.
- **Lo que no se puede cubrir con código abierto:** Fanuc FOCAS (DLL propietaria), S7comm-plus
  (S7-1200/1500 con bloques optimizados, todavía experimental) y OPC DA sin pasarela. Para cada uno
  hay una salida (abajo, «Huecos»).

## Qué cubre

| Driver | Sistemas | Librería y licencia | Máquina simulada |
|---|---|---|---|
| `opcua` | SCADA modernos, S7-1500/1200, Euromap 77/83, PackML, umati, Fagor 8060/8065, Omron NX, Keyence KV-8000A, Schneider M241+, KEPServerEX e Ignition como pasarela | asyncua (LGPL-3.0) | LINEA1, INYECTORA1 (Euromap 77), ENVASADORA1 (PackML) |
| `modbus` | Variadores, controladores de temperatura, PLC sencillos, analizadores de red (Circutor, Schneider PM), pasarelas serie-Ethernet. TCP, RTU por serie y RTU dentro de TCP | pymodbus (BSD-3) | PRENSA1, CONTADOR1 (RTU dentro de TCP) |
| `s7` | Siemens S7-300/400, S7-1200/1500 con PUT/GET y DB no optimizado, LOGO! y clones | python-snap7 3.x, Python puro (MIT) | HORNO1 |
| `enip` | Rockwell ControlLogix, CompactLogix, Micro800 | pylogix (Apache-2.0) | LINEA2 |
| `ads` | Beckhoff TwinCAT | pyads (MIT) | ROBOT1 |
| `mc` | Mitsubishi MELSEC Q, L, iQ-R, iQ-F (MC/SLMP 3E) | pymcprotocol (MIT) | TORNO1 |
| `fins` | Omron CJ, CP, CS, NX/NJ | escrito aquí, sin librería | PRENSA2 |
| `keyence` | Keyence KV (KV Host Link) | escrito aquí, sin librería | ENSAMBLADORA1 |
| `mqtt` | Máquinas modernas, pasarelas IIoT, IO-Link masters, Node-RED. JSON o valor | paho-mqtt (BSD-3) | EMPAQUETADORA1 (estados PackML) |
| `sparkplug` | Ignition Edge, Cirrus Link, HiveMQ Edge, Kepware (MQTT Sparkplug B, ISO/IEC 20237) | paho-mqtt; el protobuf se decodifica aquí | LINEA3 |
| `mtconnect` | CNC: Mazak, Okuma, Haas, DMG MORI; Fanuc, Siemens y Heidenhain con adaptador | ninguna (HTTP y XML) | CNC1 |
| `http` | API REST con JSON: IO-Link masters (ifm), ctrlX, PLCnext, básculas y MES con API | ninguna | ETIQUETADORA1, SENSOR1 (IO-Link) |
| `bacnet` | Compresores, climatización, enfriadoras, contadores de edificio | bacpypes3 (MIT) | COMPRESOR1 |
| `sql` | Históricos de SCADA (Ignition, AVEVA Historian, alarmas de WinCC), tablas de un MES, Bizerba | sqlite3; psycopg y pymssql (LGPL) si hacen falta | MEZCLADORA1, HORNO2 (tablas de Ignition) |
| `ficheros` | Máquinas que dejan CSV en una carpeta o por FTP/SMB, informes Euromap 63 | ninguna | SECADERO1, INYECTORA2 (Euromap 63) |
| `serie` | Básculas (MT-SICS, tramas continuas), lectores, cámaras de visión que mandan texto por TCP | pyserial (BSD-3) | BASCULA1, VISION1 |

`python agente.py drivers` lista los que hay, con su sintaxis de dirección y cómo reconocen al simulador.

## Cómo funciona

```
 fábrica                                                   Sindri
┌────────────────────────────────────────────┐            ┌──────────────────────┐
│ PLC, CNC, SCADA, básculas, MQTT…           │            │ Planta → máquinas    │
│        ▲ solo lectura                       │  HTTPS     │ y tags (qué leer)    │
│ Efesto ─ un driver por fuente ─ cola SQLite ├──────────▶ │ /api/planta/v1       │
│        fuentes.json (cómo llegar a cada una)│  saliente  │ lecturas y latido    │
└────────────────────────────────────────────┘            └──────────────────────┘
```

- **En Sindri** se dan de alta las máquinas y sus tags: qué se lee (`origen`, en la sintaxis del
  driver), de qué tipo es (estado, contador, medida o texto) y, si hace falta, sus **ajustes**:
  `escala`, `desplazamiento`, `bit`, `mapa` (de un valor de la máquina a un estado de Sindri, como
  `ACTIVE → 1` o `EXECUTE → 1`) y `hex` (datos de proceso IO-Link). Cada máquina dice de qué
  **fuente** sale (`prensa`, `scada`…).
- **En la fábrica**, `fuentes.json` dice cómo llegar a cada fuente: driver, host, puerto, rack,
  unidad… Las claves van en un fichero aparte (`clave_fichero`); si `fuentes.json` lleva una clave,
  Efesto no arranca. Así ni direcciones ni claves de la planta están en Sindri. Ejemplo:
  [fuentes.simulador.json](../planta/agente/ejemplos/fuentes.simulador.json).
- **Una tarea por fuente.** Si una máquina se cae, las demás siguen. Reintenta con espera creciente
  (de 5 s a 2 min). Cada lectura pasa por el mismo resumen y la misma cola que en la versión 0.1.
- **El latido** dice cómo va cada fuente. En Sindri → Planta sale «22/22 fuentes», y al pasar el
  ratón, cuál falla y por qué.
- **Compatibilidad:** sin `fuentes.json`, Efesto 0.2 sigue leyendo OPC UA con las variables de la 0.1.
  Un agente 0.1 ignora los campos nuevos de la configuración.

## Añadir un sistema nuevo como módulo

Un driver es una clase que hereda de `drivers.base.Driver` y rellena cinco métodos: `abrir`,
`es_simulador`, `preparar`, `leer` y `cerrar` (y, si puede, `descubrir`). El de Keyence son unas 60
líneas y el de FINS unas 85.

1. Escribirlo en su propio paquete de Python y declararlo:
   ```toml
   [project.entry-points."sindri.efesto.drivers"]
   mi_maquina = "mi_paquete.driver:MiDriver"
   ```
2. Añadir su máquina al simulador (o su propio simulador) con la marca `SINDRI-SIMULADOR`.
3. Pasar `test_drivers.py`: tiene que leer todos los tags del simulador, no tomar por simulador
   algo sin marca y no llamar a nada que escriba.
4. Instalar el paquete junto al agente (`pip install`). `agente.py drivers` ya lo enseña.

Así un driver con una licencia que no queramos dentro de Efesto (GPL, una DLL propietaria) vive
aparte y solo lo instala el cliente que lo necesita.

### Dar de alta una máquina real

`python agente.py descubrir <fuente>` lista lo que hay para leer: variables OPC UA, tags de un
Logix, topics MQTT, métricas Sparkplug, columnas de un CSV o elementos MTConnect. Contra una
máquina real solo funciona con `EFESTO_DESCUBRIR_REAL=1`, que se pone en la fábrica. El
descubrimiento también es de solo lectura.

## Lo que protege la planta

- **Solo lectura, comprobado en cada cambio.** `test_drivers.py` lee el código de cada driver y
  falla si llama a algo que escriba, pare, arranque o descargue programa (`write`, `publish`,
  `remote_stop`, `batchwrite`…). Las librerías sí tienen esas funciones (pymcprotocol trae
  `remote_stop` y `remote_reset`); los drivers no las usan. FINS y Keyence se escriben aquí para
  mandar solo la orden de leer, y Keyence rechaza cualquier otra.
- **Las consultas SQL** solo pueden ser un `SELECT` sin `;`, y además se abren en modo solo lectura
  (SQLite `mode=ro`, transacción `READ ONLY` en PostgreSQL, `rollback` tras cada lectura).
- **DEV nunca toca la planta de verdad.** Fuera de PRO, Efesto solo lee de una fuente si al otro
  lado está el simulador, y lo comprueba **leyendo** una marca en cada protocolo:

  | Protocolo | Marca del simulador |
  |---|---|
  | OPC UA | espacio de nombres `urn:sindri:simulador` |
  | Modbus | identificación del dispositivo (función 43) con fabricante `SINDRI-SIMULADOR` |
  | S7 | DB9999 empieza por `SINDRI-SIMULADOR` |
  | EtherNet/IP, ADS | tag `SindriSimulador` o símbolo `Sindri.Simulador` a 1 |
  | MC, FINS, Keyence | D/DM9900 a 9907 contienen `SINDRI-SIMULADOR` |
  | MQTT, Sparkplug | mensaje retenido en `sindri/simulador` |
  | BACnet | el dispositivo se llama `SINDRI-SIMULADOR` |
  | HTTP | cabecera `X-Sindri-Simulador`; MTConnect, `sender="sindri-simulador"` |
  | Ficheros, SQL | fichero `.sindri-simulador` o tabla `sindri_simulador` |
  | Serie | la primera línea es `SINDRI-SIMULADOR` |

  La prueba arranca un segundo simulador **sin marca** y comprueba que ningún driver lo toma por el
  simulador. La marca evita equivocaciones; no es una barrera contra alguien que quiera saltársela.

## Simulador multiprotocolo

[planta/simulador/multiprotocolo.py](../planta/simulador/multiprotocolo.py) monta una fábrica de
mentira: 22 máquinas, cada una con su protocolo, que pasan por marcha, parada y avería, cuentan
piezas, cambian de orden y lanzan alarmas. Escucha solo en `127.0.0.1` salvo que se diga otra cosa.
Los servidores Modbus, Modbus RTU, MC, FINS y Keyence están escritos ahí mismo, sin la librería del
cliente, para que la prueba no sea una librería hablando consigo misma. Ninguno atiende órdenes de
escritura.

```bash
cd planta/simulador && python multiprotocolo.py            # todo
python multiprotocolo.py --sin-marca --solo modbus,s7     # para ver que DEV se niega
cd ../agente && python probar.py                           # lee una vez cada máquina
python -m unittest -v                                      # pruebas, en GitHub también
```

### Resultado

Con Sindri en local (DEV, base integrada), un agente y las 23 máquinas dadas de alta con
`ejemplos/dar_de_alta.py`:

- **22 de 22 fuentes** conectadas y **106 de 106 tags** con datos en Sindri, sin un solo aviso en
  el registro del agente.
- `test_drivers.py`: los 22 leen todos sus tags del simulador y ninguno toma por simulador al que
  no tiene marca (ADS se salta en esta segunda parte porque su puerto es fijo). Pasa cinco veces
  seguidas.
- Las pruebas encontraron un fallo de verdad: el driver de EtherNet/IP no pasaba el puerto a la
  librería y, con dos PLC en la misma máquina, leía del que no era.

## Huecos y cómo se cubren

| Hueco | Por qué | Salida propuesta |
|---|---|---|
| **Fanuc FOCAS** | DLL propietaria de Fanuc, no se puede llevar | Opción OPC UA o MTConnect de Fanuc; robots por SNPX con `fanuc_ucl` (Apache-2.0); o un driver aparte donde el cliente pone su DLL |
| **S7-1200/1500 con DB optimizados** | S7comm-plus sin implementación abierta madura | Servidor OPC UA del PLC, o pedir al integrador un DB «espejo» no optimizado |
| **OPC DA (Windows, DCOM)** | Tecnología de 1996, solo Windows | Pasarela DA→UA (muchas gratuitas) y leer por OPC UA |
| **Heidenhain** | El OPC UA del TNC es una opción de pago | pyLSV2 (MIT) por LSV2: driver por hacer |
| **Euromap 63 con peticiones** | Hay que dejar un fichero `.REQ` en la carpeta de la máquina | Hoy se leen los informes que la máquina ya deja. Escribir el `.REQ` no toca el control, pero es escribir: lo decides tú |
| **Sparkplug sin nacimiento** | Si las métricas llegan solo con alias, hace falta el NBIRTH/DBIRTH, y pedir uno nuevo es mandar un NCMD | Efesto espera al siguiente nacimiento y no manda nada. Pedir que la pasarela publique con nombre o nazca cada cierto tiempo |
| **Impresoras Zebra (puerto 9100)** | Los contadores se leen por el mismo puerto que imprime | Driver con lista blanca de órdenes (`~HQOD`, `~HS`), por hacer |
| **Dibal, Epelsa, Baxtran** | No publican protocolo | Trama continua del indicador (driver `serie`) o su software |
| **Profinet, EtherCAT** | Buses de tiempo real de un solo controlador | Se lee del PLC, nunca del bus |
| **Licencias GPL o BSL** (cpppo, gurux-dlms, wmbusmeters, dlms-cosem) | No entran en el agente | Solo en pruebas (cpppo hace de PLC en el simulador) o como proceso aparte |

## Lo que sigue

Ordenado por lo que más máquinas españolas abre por esfuerzo:

1. **Perfiles**: plantillas de tags por estándar o modelo (Euromap 77, PackML, Weihenstephan,
   umati/Machinery, MTConnect, analizadores Circutor, histórico de Ignition) para dar de alta una
   máquina eligiendo el perfil en Sindri. Los ejemplos de `maquinas.simulador.json` son el borrador.
2. **Pantalla para dar de alta máquinas y tags en Sindri**, con el resultado de `descubrir`. Hoy
   se hace por la API. La pantalla de Planta también necesita agrupar cuando hay muchas máquinas.
3. **Drivers que faltan**: pyLSV2 (Heidenhain), Haas Q-commands, Zebra, MT-SICS con petición
   (Mettler), API XML de Circutor PowerStudio, OPC UA por suscripción (con lectura periódica forzada
   para Sinumerik) y un modo «suscriptor UNS» para quien ya tiene un MQTT central.
4. **asyncua 1.1.6 → 2.x** (salió la 2.1.0) y pymodbus 4 cuando salga.
5. **Instalador de Efesto como servicio de Windows**, que ya estaba pendiente.

## Decisiones

Tomadas por Luis el 24-10-2026:

1. Los drivers con licencia GPL o con DLL de terceros van **siempre como módulo aparte**, nunca
   dentro de Efesto.
2. Efesto **no escribe** el fichero de petición de Euromap 63. Sigue siendo solo lectura; si un
   cliente lo pide, se estudia más adelante como opción por fuente, desactivada por defecto.

Pendiente de Luis:

3. ¿Qué tres sistemas primero en clientes reales? Recomendado: OPC UA con perfiles (cada vez más
   marcas lo traen de serie), Siemens S7 y Modbus con los mapas de los analizadores de red.
