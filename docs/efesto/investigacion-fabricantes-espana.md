# Efesto: investigación ampliada de protocolos y fabricantes (foco España)

*Ampliación del informe `investigacion-protocolos.md` (24-10-2026). No repite lo que ese informe ya cubre (OPC UA genérico, S7, Modbus, EtherNet/IP Logix, FINS, MC 3E, ADS, MQTT/Sparkplug, MTConnect genérico, FOCAS, LSV2, Euromap 63/77/83 en general, umati, PackML, BACnet, IO-Link, SQL de Ignition/WinCC, CSV, REST genérico, básculas serie genéricas y lectores de códigos). Aquí se añaden fabricantes concretos, mapas de registros, perfiles semánticos y estándares nuevos.*

> **Leyenda.** ✔ = comprobado durante esta sesión en la web del fabricante, PyPI, el repositorio o la documentación oficial. ~ = aproximado: conocimiento previo, fuente secundaria o deducción. **Prioridad:** 1 = MVP, 2 = segunda ola (o 1 dentro de su sector), 3 = bajo demanda.
>
> **Aviso sobre fuentes.** Varias búsquedas devuelven artículos de `industrialmonitordirect.com`. Parecen generados automáticamente, no citan fuentes y a veces se contradicen con la documentación oficial. Lo que solo sale de ahí lo marco como ~ y conviene verificarlo antes de usarlo.

---

## 0. Lo que más cambia las prioridades (resumen)

1. **El OPC UA "de serie" ha llegado a más marcas de las que suponía el informe anterior.** Fagor CNCelite (8058/8060/8065elite) trae servidor umati integrado ✔. KUKA KR C5 lleva preinstalado KUKA.DeviceConnector (OPC UA + Machinery + Robotics) ✔. Keyence KV-8000A trae OPC UA "de serie" ✔. Omron NX701, NX102 y NJ501-1x00 tienen servidor OPC UA ✔. Schneider M241, M251 y M262 lo ejecutan en el propio PLC ✔. **Consecuencia:** el perfil umati/Machinery sobre asyncua sube a **prioridad 1**, y los drivers nativos de nicho (Keyence Host Link, MEWTOCOL, PCOM) bajan a 3.
2. **Fagor es el CNC español y sus controles modernos se leen gratis con asyncua.** Para el 8055, muy extendido en talleres antiguos, no hay vía abierta documentada. Ahí la solución es leer señales de su PLC por E/S, un IO-Link master o la entrada manual.
3. **Las licencias de opciones OPC UA en CNC son caras o se cobran por aplicación cliente.** En Heidenhain, las opciones 56-61 dan **una licencia por cada aplicación OPC UA**, con 90 días de prueba ✔. En Sinumerik hace falta la licencia OPC UA, y las suscripciones *notify* son "muy inestables y pueden tumbar el servidor" ✔, así que hay que **leer por polling**. pyLSV2 (gratis, MIT) sigue siendo la vía de Heidenhain en la pyme.
4. **Energía:** Circutor (español) es la marca dominante y sus mapas Modbus son públicos. Su software **PowerStudio** expone una API XML por HTTP (`/services/user/values.xml?var=...`) ✔, de modo que **un solo driver cubre todos los analizadores** de una planta que ya tenga PowerStudio. Schneider publica sus mapas en .xlsx (PM5xxx) ✔. Se propone un **driver "energía" con biblioteca de mapas** como prioridad 1.
5. **Trampas de licencia nuevas:** `dlms-cosem` pasó de MIT a **Business Source License 1.1** en la v24.1.0 ✔. `wmbusmeters` es **GPL-3.0** ✔, `aphyt` (Omron NX/NJ) es **GPL-2.0** ✔ y `winccua-mcp-server` es GPL-3.0 ✔. Todos estos deben ir aislados como proceso externo o plugin.
6. **Hay contadores de etiquetas muy baratos de leer:** Zebra `~HQOD` (odómetro), `~HQES` (errores) y `~HS` por TCP 9100 ✔. Es valioso en alimentación española, donde cada línea etiqueta. Prioridad 2.
7. **Las básculas españolas (Dibal, Epelsa, Baxtran) no tienen protocolo público.** Se integran a través de su software (Dibal DFS y similares) o por la salida continua del indicador. Bizerba sí ofrece REST, SOAP y **volcado a SQL** con `_connect2DB` ✔. MT-SICS está totalmente documentado ✔.
8. **Robots:** hay vías abiertas nuevas. Para Fanuc, `fanuc_ucl` (Apache-2.0, v2.0.2 del 14-10-2026) lee E/S y variables de sistema por SNPX (puerto 60008) ✔. Para ABB, `abb_robot_client` (Apache-2.0) solo cubre RobotWare 6, no OmniCore/RW7 ✔. Universal Robots tiene puertos **de solo lectura** (30011-30013) ✔.
9. **Plástico:** en Euromap 77 el *namespace* cambia entre releases (`http://www.euromap.org/euromap77/` frente a `http://opcfoundation.org/UA/PlasticsRubber/IMM2MES/`) y los contadores UInt64 llegan como texto ✔. Engel cobra la licencia E77, pero su servidor E63 es gratuito ✔.
10. **Estándares que preparar:** Sparkplug 3.0 ya es **ISO/IEC 20237** ✔. AAS va por el metamodelo 3.2 (IDTA, 07-2026) ✔, con el SDK Python BaSyx 2.2.0 en MIT ✔. `umatiGateway` (Apache-2.0) publica OPC UA→MQTT JSON ✔. Weihenstephan (OPC 40600) es el estándar de alimentación y bebidas ✔.

---

## 1. Fabricantes y controles muy presentes en España

### 1.1 Fagor Automation (Arrasate, Gipuzkoa): CNC 8055, 8060, 8065, 8070 y CNCelite
- **Controles modernos (CNCelite 8058/8060/8065):** integran **"el servidor umati basado en OPC UA"** en los tres modelos de la gama, presentado como una característica, no como una opción ✔ (entrevista de Fagor en umati.org). Fagor es miembro de umati desde 2019 ✔, y un técnico de Fagor presentó en IMH un "servidor OPC-UA industrializado compatible con umati" para MES y ERP ✔.
- **8070:** no he encontrado confirmación pública de OPC UA ~. Es un control abierto sobre PC con Windows, y en la práctica suele leerse con la API de Fagor o con software de terceros ~.
- **8065 (no elite):** existe una **API** de Fagor (ITRI la usó para un adaptador propio) y hubo desarrollos tempranos sobre MTConnect ✔ (Fagor Magazine n.º 3). Las versiones recientes del software ~ incorporan OPC UA.
- **8055/8040/8050 (parque antiguo, muy común):** usan un **protocolo propio Fagor (DNC)**, con *drivers* comerciales como FactoryWiz ("Fagor CNC protocol" para 8040, 8050 y 8055) ✔. No hay librería abierta ni documentación pública ~. La tarjeta Ethernet 8C400013 es opcional ✔ (cncpd).
- **Recomendación:** CNCelite → `asyncua` + **perfil umati (OPC 40501/40001)**. 8055 → no conviene invertir; mejor leer el estado por E/S (marcha, alarma o contador de piezas a un IO-Link master o una entrada Modbus) o con la **entrada manual**.
- **Simulador:** Fagor distribuye simuladores de PC de sus CNC ~ (desconozco si incluyen el servidor OPC UA). Para CI basta con `umati/Sample-Server-asyncio` (Apache-2.0).
- **Riesgo:** implementación umati parcial; hay que mapear por BrowseName. **Prioridad 1** (metal ES).

### 1.2 Ingeteam (Zamudio, Bizkaia)
- Electrónica de potencia (variadores, inversores fotovoltaicos, convertidores eólicos y de tracción) y pasarelas **INGESYS® Gateway** (Modbus y Modbus TCP, orientadas al sector eléctrico) ✔ (modbus.org). Los inversores tienen tarjeta Ethernet **Modbus TCP** (AAX7054) ✔.
- **Vía:** `pymodbus` con el mapa del manual. Es relevante para el **autoconsumo fotovoltaico** de las naves, una petición frecuente de las pymes. **Prioridad 2** (energía).

### 1.3 Schneider Electric: Modicon M221, M241, M251, M262, M340, M580
- **M241/M251/M262:** **servidor OPC UA en el propio PLC** ✔ (FAQ de SE). **M221:** solo Modbus TCP/RTU ~ (sin OPC UA).
- **M580:** OPC UA mediante el **módulo BMENUA0100** ✔ (firmware SV2.04.02 publicado ✔) o con OPC Factory Server. Desde OFS 3.62 lo sustituye EcoStruxure OPC UA Server Expert (de pago) ✔. M340: Modbus TCP o OFS ✔.
- **Vía:** OPC UA si el PLC lo trae y está activado en Machine Expert. Si no, Modbus (el `%MW` está mapeado directamente a los holding registers ~).
- **Simulador:** el servidor de asyncua y el de pymodbus. **Prioridad 1** (vía OPC UA/Modbus existentes).

### 1.4 Omron: CJ, CP, NX/NJ
- **NX701, NX102 y NJ501-1□00:** servidor OPC UA integrado ✔ (Omron). El manual W588 lo documenta ✔. Para NX1P2 no lo he confirmado.
- **EtherNet/IP simbólico:** `aphyt` v0.1.30 (09-09-2026, **GPL-2.0** ✔), con `read_variable` por nombre ✔. Alternativa: `libplctag` (MPL/LGPL). **Mejor OPC UA** para no meter GPL.
- **CJ/CP:** FINS (ya en curso). **Prioridad 2.**

### 1.5 Keyence KV (KV-5500, KV-7500, KV-8000, KV Nano)
- **KV-8000A:** **servidor OPC UA "de serie"** con autenticación por certificados ✔. Es la vía preferente.
- **KV Host Link (protocolo superior):** ASCII terminado en CRLF por TCP/UDP **8501** ✔ (pykeyence, Proxus). Hay soporte de **protocolo MC** en las unidades Ethernet ✔ (Proxus anuncia "Keyence MC" y "MC ASCII"), lo que permitiría reutilizar `pymcprotocol` ~.
- **Librería:** `pykeyence` (v0.1.11, **sin licencia declarada** ✔, 0 estrellas: no usar sin aclararla). Existen emuladores (`keyence-hostlink-emu`) ✔. Host Link es fácil de implementar en unas 200 líneas.
- **Prioridad 3** (en España, Keyence está más presente en sensores y visión que en PLC ~).

### 1.6 Panasonic FP (FP0R, FP0H, FP7, FP-X): MEWTOCOL
- **MEWTOCOL-COM**: protocolo ASCII sencillo y documentado por Panasonic ~. FP0H y FP7 tienen Ethernet con MEWTOCOL y Modbus TCP ~ (manual FP0H Ethernet ✔ existe).
- **Librerías:** `pypanasonic` (MIT, v0.0.8, 2024, solo serie ✔) y `a2y-mew` (**"Free For Educational Use"**: no apta ✔). .NET: Mewtocol.NET.
- **Recomendación:** **Modbus TCP** si el modelo lo trae. Si no, un driver MEWTOCOL propio (protocolo trivial). **Prioridad 3.**

### 1.7 Delta (DVP, AS)
- Hablan Modbus de forma nativa (RTU en todos y TCP en los -E/AS300) ~. Mapa típico: D0 = 0x1000 (4096) y M0 = 0x0800 ~, que hay que verificar por familia en el manual.
- **Vía:** `pymodbus` + **perfil de mapa "Delta DVP/AS"** precargado. **Prioridad 2** (frecuente en maquinaria asiática y nacional barata ~).

### 1.8 Unitronics (Vision, Samba, UniStream)
- **PCOM** documentado públicamente por Unitronics ✔ (PDF). Hay un modo ASCII y otro binario, y por TCP cada orden lleva una cabecera de 6 bytes (101 = ASCII, 102 = binario) ✔. Se leen MB, MI, ML, MF y SI ✔. M90, M91 y V120 no admiten TCP ✔. El puerto es configurable (20256 por defecto ~).
- **Librería:** `pcom` (MIT, v0.11, 01-04-2022, solo Ethernet ✔). **UniStream:** Modbus TCP y OPC UA ~.
- **Prioridad 3.**

### 1.9 WAGO (PFC100, PFC200, CC100)
- CODESYS 3.5. **Modbus TCP esclavo** configurado en el proyecto (I/O Mapping, offsets desde 0, REAL en dos registros con orden de palabras variable) ✔ (Cybus). **OPC UA** con el servidor CODESYS (los símbolos se publican en la *Symbol Configuration*) ~. También ofrece MQTT con WAGO Cloud Connectivity ✔.
- **Prioridad 2** (vía Modbus/OPC UA existentes; hace falta una guía para el integrador).

### 1.10 Phoenix Contact PLCnext (AXC F 1152/2152/3152)
- **REST Data Interface:** `GET https://<plc>/_pxc_api/api/variables?paths=...` ✔. **Requisito:** las variables globales deben tener el **atributo HMI** ✔. Autenticación por token (`userAuthenticationRequired`) ✔.
- **OPC UA:** servidor integrado ~ (las variables necesitan el atributo OPC).
- **Vía:** el driver **HTTP JSON** que ya existe, más un **perfil PLCnext** (login, sesión y `paths`). **Prioridad 2.**

### 1.11 B&R (X20, ACOPOS, APC)
- **OPC UA:** servidor integrado en Automation Runtime, que se activa en Automation Studio ~. Es la vía estándar.
- **PVI:** propietario. Requiere licencia de runtime fuera de los PC de B&R (llave USB o una licencia corporativa de unos 30.000 € ✔, según Promotic). El X20BC0087 es acoplador Modbus TCP ✔. **Descartar PVI.** **Prioridad 2** (vía OPC UA).

### 1.12 Bosch Rexroth ctrlX CORE
- **REST del Data Layer (incluido):** `POST /identity-manager/api/v1/auth/token` → *bearer*. Después `GET /automation/api/v1/<ruta-del-nodo>` (`?type=browse` y `?type=metadata`), con lectura masiva en `/automation/api/v2/bulk` ✔.
- **OPC UA Server:** es una **app de pago** en tres niveles: Basic (5 sesiones y 2.000 ítems), Standard (50 y 5.000) y Advanced (500 y 50.000), además de una suscripción anual ✔.
- **Recomendación:** **REST**, porque es gratis. El simulador ctrlX WORKS (virtual) es gratuito para pruebas ✔. **Prioridad 2.**

### 1.13 Robots: ABB, KUKA, Fanuc (y Universal Robots)

| Robot | Vía recomendada | Librería / licencia | Notas |
|---|---|---|---|
| **KUKA KR C5** | **OPC UA** (KUKA.DeviceConnector preinstalado) ✔ | asyncua | Certificado en 03-2026: Machinery 1.01, **Robotics 1.00**, PLCopen y DI. También PubSub sobre MQTT ✔. KR C4 con KSS/VSS ≥ 8.3 ✔ |
| KUKA KR C4 antiguo | KUKAVARPROXY (TCP 7000) | `py-openshowvar` MIT ✔ (v1.1.7); proxy VB6 **sin licencia declarada** ✔ | **Sin autenticación** y permite escribir: solo con aprobación expresa. Prioridad 3 |
| **ABB IRC5 (RW6)** | Robot Web Services (REST) | `abb_robot_client` **Apache-2.0** v0.4.0 (07-2024) ✔: `get_rapid_variable`, `get_digital_io`, `get_execution_state` ✔ | **No admite RobotWare 7/OmniCore** ✔ |
| ABB OmniCore (RW7) | RWS 2.0 (REST, HTTPS) o OPC UA (opción ~) | HTTP JSON propio | RWS2 cambia rutas y autenticación ~ |
| **Fanuc R-30iB/R-50iA** | OPC UA Server (opción) ✔ o SNPX | `fanuc_ucl` **Apache-2.0** v2.0.2 (14-10-2026) ✔: lee DO, GI y variables de sistema por SNPX (TCP 60008) ✔ | SNPX requiere la opción "HMI Device (SNPX)" ~ (R553). El OPC UA de Fanuc admite hasta 10 clientes ✔ |
| Universal Robots | Puertos **de solo lectura** 30011/30012/30013 ✔; RTDE 30004 | `ur_rtde` (MIT ~) | El Dashboard (29999) **puede arrancar y parar** programas ✔: no usarlo |

- **Simuladores:** URSim (gratis, propietario ~), RobotStudio (propietario), KUKA.Sim (de pago) y ROBOGUIDE (de pago). Para CI: un servidor asyncua con el NodeSet Robotics (OPC 40010).
- **Prioridad:** KUKA OPC UA y UR **2**. ABB RWS **2**. Fanuc **2-3** (robot) y KUKAVARPROXY **3**.

### 1.14 CNC Fanuc: alternativas a FOCAS
- **OPC UA en el CNC:** opción con llave de software en las series 30i/31i/32i (y 0i-F Plus ~), por el puerto 4840. Expone PMC, variables macro y alarmas ~ (fuente secundaria; no he encontrado el código de opción oficial).
- **MT-LINKi** (software de Fanuc para PC): recoge el programa en ejecución, el historial de alarmas, señales y macros de CNC y robots, además de estado y productividad ✔. Admite equipos de otras marcas por OPC UA o MTConnect ✔. La salida hacia MES/ERP no está documentada públicamente ~ (en la práctica, una BD MongoDB/SQL interna ~). **Si el cliente ya tiene MT-LINKi, leer de él.**
- **Softing edgeConnector FANUC CNC** (Docker, FANUC→OPC UA/MQTT) está **deprecated** ✔; su sucesor es `sdex-suite` (comercial).
- **Conclusión:** FOCAS con "trae tu propia DLL" (ya en el informe anterior), más OPC UA cuando exista la opción. **Prioridad 2.**

### 1.15 Heidenhain TNC 640/620/TNC7: OPC UA NC Server
- **Opciones 56 a 61: cada una habilita una aplicación OPC UA** (hasta seis) ✔. Versiones mínimas: TNC 640 34059x-10, TNC 620 81760x-08 y TNC7 81762x-16 ✔. **Prueba única de 90 días** ✔.
- **Consecuencia:** si el cliente ya tiene un MES por OPC UA, Efesto **necesita otra opción** de pago. Por eso **pyLSV2 (MIT)** sigue siendo la vía principal en la pyme. **Prioridad 2.**

### 1.16 Siemens Sinumerik 828D / 840D sl / ONE
- **OPC UA:** licencia "SINUMERIK Access MyMachine /OPC UA" (6FC5800-0AP67-0YB0 ~). Da acceso al estado, el programa, el cabezal, el avance, las herramientas, los almacenes y los ficheros ✔. En la práctica se usa el puerto **4840** (854 en algunos ejemplos ✔).
- **Advertencia:** las suscripciones *notify* son "highly unstable and can crash the OPC UA server" ✔ (Cybus). **El driver debe forzar polling** en Sinumerik. Los métodos requieren derechos de acceso específicos ✔.
- **Run MyHMI /3GL, /SmartOperate y similares:** SDK de HMI de pago, para OEM. **Descartar.** **Prioridad 2.**

### 1.17 Haas (NGC): MTConnect y Q-commands
- **Q-commands** por **TCP 5051**, que se activan con el **Setting 143** ✔ (MachineMetrics). Las órdenes son **Q100** (número de serie), **Q104** (modo), **Q500** (programa, estado y piezas) y **Q600 nnnn** (lee la variable macro nnnn) ✔/~. Son **de solo lectura por diseño** ~. MTConnect en NGC ✔ (TrakHound tiene un agente y un adaptador para Haas ✔).
- **Vía:** driver TCP ASCII trivial o MTConnect (ya existe). **Prioridad 2** (Haas es muy común en talleres ES ~).

### 1.18 Okuma (OSP-P200/P300/P500)
- **MTConnect gratis:** "Free! Okuma MTConnect Agent & Adapter" para cualquier OSP-P ✔ (okuma.com). Hay una API THINC/OSP Suite para apps en el PC del control ~. OPC UA en P500/P700 ~.
- **Vía:** MTConnect, que ya existe. **Prioridad 3.**

### 1.19 Mazak (Mazatrol Matrix, SmoothX/Ai)
- MTConnect (agente o adaptador de Mazak; SmartBox para equipos antiguos) ✔/~. Algunos Smooth admiten MC por debajo ~ (no documentado públicamente). **Vía:** MTConnect. **Prioridad 3.**

---

## 2. Básculas y etiquetado en alimentación española

| Equipo | Protocolo | ¿Documentado? | Vía recomendada | Prioridad |
|---|---|---|---|---|
| **Mettler Toledo (MT-SICS)** | ASCII por RS-232/TCP. Niveles 0-3; `S` (estable), `SI` (inmediato), `SIR` (repetido), `I2` (tipo), `I4` (n.º de serie) ✔ | **Sí**, manual público ✔ | Driver MT-SICS (respuesta `S S     100.00 g`, estado S/D, errores `ES`, `ET`, `EL`, `S I`, `S +`, `S -`) ✔ | **1** (alim.) |
| MT IND570/IND780 | Además, Modbus TCP, EtherNet/IP (AOP de Rockwell ✔) y servidor de datos compartidos ~ | Sí ~ | Modbus TCP si está configurado | 2 |
| **Dibal** (Derio) | Propietario (DibalCom ~) | **No es público** | Mediante **Dibal DFS** (gestión de la gama 500: artículos, trazabilidad, ventas) ✔ → exportación de ficheros o BD ~ | 2 |
| **Epelsa** (Barcelona) | Propietario ~ | No encontrado | Su software de gestión o la salida continua del indicador ~ | 3 |
| **Baxtran** (Gipuzkoa) | Indicadores con salida continua RS-232/485 y Modbus RTU opcional ~ | Manuales de indicador ~ | Driver de "trama continua" configurable por regex | 2 |
| **Gram** (Barcelona) | ZFOC: `SOH STX STA SIGN PESO UNIDAD BCC ETX EOT`; STA 53h (estable), 55h (inestable), 46h (anómalo); BCC = XOR; petición ENQ/ACK/DC1 ✔ | **Sí** ✔ | Parser por plantilla | 2 |
| **Bizerba** | `_connect.BRAIN` V5: **REST/SOAP**, `_connect2DB` (**SQL Server/Access**, exportación CSV), `_connect2File` (XML BX-NET) y `_connect2SAP` ✔ | Sí, por módulos de pago ✔ | Leer la **BD de `_connect2DB`** con el driver SQL | 2 |
| **Marel** (ahora **JBT Marel**) | Innova: "standard data interface with ERP" (maestros, órdenes y datos de producción) ✔; detalle técnico no público | Bajo contrato | Lo que el cliente tenga de Innova (BD/servicios) ~ | 3 |
| **Ishida** | DACS-GN: USB cifrado, IDCS y **Sentinel 5.0** (local o nube) ✔; sin protocolo abierto | No ✔ | Exportaciones de IDCS/Sentinel ~ | 3 |

**Impresoras de etiquetas**
- **Zebra (ZPL/SGD, TCP 9100):** `~HQOD` devuelve el odómetro (no reseteable más dos contadores reseteables, en pulgadas o cm según `^MA`); `~HQPH` da la vida del cabezal, `~HQES` los errores y avisos en nibbles hexadecimales (p. ej., cabezal abierto o sin papel), `~HQHA` la MAC; todo entre STX y ETX ✔. `~HS` devuelve tres cadenas de estado (papel, pausa, cabezal y formatos en búfer) ✔. SGD: `device.host_status` ✔. También SNMP con la MIB de Zebra ~.
- **SATO:** API por **WebSocket** (`ws://localhost:8055/SATOPrinterAPI`) con `Printer.GetPrinterStatus()` (online, error, búfer y trabajo) ✔. **No documenta odómetro** ✔. El estado STATUS4/ENQ por TCP 1024/9100 ~ y la MIB estándar de impresoras (RFC 3805) ~.
- **Librería:** socket TCP crudo para ZPL y `pysnmp` (BSD-2 ~) o `easysnmp` para SNMP.
- **Riesgo:** el puerto 9100 también **imprime**: el driver solo debe enviar comandos `~HQ`/`~HS`, en lista blanca. **Prioridad 2** (contador de etiquetas como *proxy* de producción en envasado).

---

## 3. Energía y servicios

### 3.1 Circutor (Viladecavalls, Barcelona)
- **Modbus:** CVM-B100/B150 → **Modbus RTU y BACnet** por RS-485 ✔. El Modbus TCP se añade con el módulo de expansión M-CVM-AB-Modbus-TCP (switch, M56E0A) ✔. CVM-C10, CVM-MINI, CVM-NRG96 y CVM144 tienen mapas publicados en sus manuales y en terceros (p. ej., CVM-C10: V1 en 0x0000, I1 en 0x0002, kW1 en 0x0004, frecuencia en 0x003C, todos en dword de 32 bits) ✔ (AGG Software). El tipo y el orden de palabras dependen del modelo (entero con decimales implícitos en la mayoría ~).
- **PowerStudio / PowerStudio Scada:** **API XML por HTTP** (`/services/user/devices.xml`, `varInfo.xml?var=`, `values.xml?var=equipo.variable`, `records.xml?begin=&end=&var=&period=900`, `events.xml`) ✔. Ofrece además exportación a SQL (manual aparte ✔).
- **Recomendación:** (a) si existe PowerStudio, driver **"circutor_powerstudio"** (HTTP XML); (b) si no, `pymodbus` + **biblioteca de mapas Circutor** (YAML por modelo). **Prioridad 1** (energía, ISO 50001 y auditorías del RD 56/2016 ~).

### 3.2 Schneider PowerLogic / iEM / PM
- **Listas de registros públicas en Excel:** `PM556x_PublicModbusRegisterList` (PM5500/5600/5700) y `PM51xx_PM53xx_PMC Register List` ✔ (FAQ FA234017). iEM3xxx: listas públicas en el manual ~. Son FLOAT32 big-endian, con direcciones en base 1 en la documentación (restar 1) ~.
- **Vía:** `pymodbus` + **importador de los .xlsx de Schneider** (el formato es estable) ~. **Prioridad 1.**
- Otros mapas públicos habituales: Carlo Gavazzi EM/ET ~, Socomec Diris ~, Janitza UMG ~ (también con OPC UA y REST en modelos altos ~), ABB M4M ~ y Eastron SDM (muy común y barato) ~.

### 3.3 Contadores de agua, gas, calor y compañía eléctrica
- **M-Bus cableado (EN 13757):** `pyMeterBus` (BSD-3, decodifica y consulta por serie/RFC 2217; no codifica todas las tramas) ✔. **wM-Bus (OMS):** `wmbusmeters` (**GPL-3.0**, unos 66 drivers, salida JSON/MQTT, unas 1.400 estrellas) ✔ → **ejecutar como proceso externo** y consumir su MQTT/JSON (no se enlaza, así que no contamina el núcleo).
- **Contador fiscal eléctrico (DLMS/COSEM; en España, los de las distribuidoras: ZIV, Sagemcom, Landis ~):** `dlms-cosem` → **BSL 1.1 desde la v24.1.0** (antes MIT) ✔; `gurux-dlms` → **GPL-2.0** ✔. **Riesgo de licencia.** Alternativa: leer el **analizador propio** del cliente, no el contador de la distribuidora. **Prioridad 3.**
- **Gas y agua de red:** normalmente salida de **pulsos** → entrada digital de un IO-Link master, un módulo Modbus (p. ej., un contador de pulsos Modbus) o la entrada del propio analizador Circutor ~. **Prioridad 2** (vía Modbus).

### 3.4 Compresores
- **Atlas Copco Elektronikon (MkIV, MK5):** Modbus RTU con ComBox-S o pasarela; SMARTLINK es **telemetría a la nube de Atlas Copco**, no local ~. El mapa de registros se entrega bajo petición (no es público) ~ (fuente secundaria). Optimizer 4.0 (controlador central) ~ con Modbus TCP/Profinet.
- **Kaeser SIGMA CONTROL 2:** **servidor web** integrado y Ethernet de serie, con adaptadores opcionales Modbus, Profibus, DeviceNet y Profinet ✔. Las versiones recientes traen Modbus TCP y OPC UA ~.
- **Recomendación:** `pymodbus` con el mapa del fabricante, más el perfil "compresor" (horas totales y en carga, presión, estado y alarma). **Prioridad 2.**

### 3.5 Climatización
- BACnet (ya en curso). En España es frecuente que el **frío industrial** use Carel (pCO, con Modbus y BACnet) ~ y Eliwell/Dixell (Modbus RTU) ~ → perfiles Modbus. **Prioridad 2-3.**

---

## 4. Plástico y metal

### 4.1 Inyectoras

| Fabricante | E63 | E77 / OPC UA | Notas |
|---|---|---|---|
| **Engel** (CC100/CC200/CC300) | Sí; **servidor E63 de Engel gratuito** ✔ | CC300: **licencia de pago** de Engel ✔ | CC100/CC90: monitorización serie con licencia "Engel Monitoring System" ✔. Incidencias reales con `BadSecurityChecksFailed` (certificados) ✔ |
| **Arburg** (Selogica, Gestica) | Sí ~ | E77 ~ (opción); MES propio **ALS** ✔ | Si el cliente tiene ALS, leer de su BD ~ |
| **KraussMaffei** (MC6) | Sí ~ | E77 ~ | — |
| **Haitian / Zhafir** (Techmation, KEBA) | Habitual en el parque español ~ | E77 en las nuevas ~ | Muy presente por precio ~ |
| **Mateu & Solé** (Barcelona) | ~ | ~ | Sin documentación pública encontrada; preguntar al fabricante |
| Sumitomo-Demag, Wittmann Battenfeld, Negri Bossi | Sí ~ | E77 ~ | Sigmatek ofrece una librería de servidor E77 a los OEM ✔ |

- **Detalles prácticos de E77** ✔ (Cybus): el namespace varía entre la release 1.00 (`http://www.euromap.org/euromap77/`) y las nuevas (`http://opcfoundation.org/UA/PlasticsRubber/IMM2MES/`). Hay que leer `NamespaceArray` (ns=0;i=2255) y **resolver por BrowsePath**. Nodos útiles: `MachineStatus.MachineMode` (0 OTHER, 1 AUTOMATIC, 2 SEMI_AUTOMATIC, 3 MANUAL, 4 SETUP, 5 SLEEP); `Jobs.ActiveJob` (JobName, ProductName, MouldId, NumCavities, ExpectedCycleTime); `Jobs.ActiveJobValues` (JobStatus, JobPartsCounter, JobGoodPartsCounter, JobBadPartsCounter, MachineCycleCounter, LastCycleTime, AverageCycleTime). **Los contadores UInt64 llegan como texto** y los tiempos son `Duration` en ms. `Jobs` es opcional. Los parámetros por ciclo llegan en el evento `CycleParametersEventType`.
- **Acción para Efesto:** el perfil E77 debe (1) detectar el namespace, (2) tratar los UInt64 como texto o entero grande y (3) suscribirse a los eventos de ciclo, que son opcionales.
- **Simulador:** no existe uno libre conocido ✔ (no encontrado). Hay que crear uno propio con asyncua más el NodeSet OPC 40077 (MIT, del repositorio UA-Nodeset de la OPC Foundation ~). **Prioridad 1** (plástico).

### 4.2 Prensas
- Las prensas españolas (Fagor Arrasate, Goiti, Loire Gestamp ~) suelen llevar PLC Siemens o Rockwell. Se leen **del PLC** (S7/OPC UA) o del control de prensa. No he encontrado ningún estándar específico ~; hay una companion spec VDMA para prensas en desarrollo ~. **Prioridad:** vía S7/OPC UA ya existente. Lo que sí hace falta es un **perfil "prensa"** (golpes, golpes por minuto, modo, carga del molde/troquel).

### 4.3 Láser y corte (Trumpf, Bystronic)
- **Trumpf:** la **interfaz OPC UA es una opción de máquina** que se pide con la máquina nueva o se activa después de forma remota ✔. Las máquinas antiguas con "Remote Control Interface" se modernizan con el **OPC UA Retrofit Extension Cube** (un IPC) ✔. Datos disponibles: qué pieza y con qué material se fabrica, carga y descarga, nivel de los contenedores de piezas, avance del trabajo y fin de pedido ✔. La seguridad (certificados) viene activa de fábrica ✔. **Prioridad 2.**
- **Bystronic:** ByCockpit (app de monitorización) ✔; OPC UA ~ (sin detalle público). Los logs de trabajo por fichero ~ ya entran en el driver CSV. **Prioridad 3.**

### 4.4 Plegadoras
- Controles **Delem** (DA-53T, 58T, 66T, 69T), **Cybelec** (CybTouch, ModEva) y **ESA**. Los fabricantes anuncian "integración Industria 4.0" con OPC UA de forma genérica ✔ (Durmapress), sin especificación pública ~. Los controles Delem exportan por red los programas y las estadísticas de producción ~.
- **Recomendación:** OPC UA si existe; si no, **contador de golpes** por E/S → IO-Link/Modbus, o entrada manual. **Prioridad 3.**

---

## 5. Alimentación y embalaje

### 5.1 Envasadoras
- **ULMA Packaging (Oñati):** las máquinas UPC 4.0 traen de serie OEE por orden, turno y línea; alarmas; consumos de electricidad, aire, gas y film; e **integración con MES/ERP/SCADA** (órdenes, recetas, parámetros, alarmas y eficiencia) ✔. Los **logs de eventos se descargan por FTP con usuario y contraseña** ✔. El portal myULMA ✔ y la conexión remota RSM ✔. La web no menciona **OPC UA ni PackML** ✔ (habrá que pedírselo a ULMA por proyecto). Muchas máquinas usan PLC Rockwell ✔ ("Rockwell or Xdevice machines").
  **Vía:** FTP (driver de ficheros, ya existe) más EtherNet/IP o S7 del PLC con un perfil "ULMA" acordado. **Prioridad 1** en el sector cárnico y hortofrutícola español ~.
- **Multivac:** MULTIVAC Line Control (gestión de lotes, artículos y trazabilidad) ✔; la interfaz técnica no es pública ✔. Usa PLC propios o B&R ~ y OPC UA ~. **Prioridad 2.**
- **Ishida:** véase §2. **Prioridad 3.**
- **Weihenstephan Standards (OPC 40600, v1.00 de 2021-08-04)** ✔: máquina de estados WS (Base, Execute, Held, Suspended), modo de operación y programa ✔. Están extendidos en **bebidas, lácteos y panadería** (WS Pack, WS Food, WS Brew, WS Bake ~). Conviene un **perfil WS** junto a PackML. **Prioridad 2.**

### 5.2 Sistemas de visión
- **Cognex In-Sight:** **Native Mode** por Telnet/TCP (puerto 23 ~), con login de usuario ~. Comandos de lectura: `GV` (obtiene el valor de una celda o tag), `GI`, `GO` (online), `GF`/`GJ` (job activo), `RB`/`RI` (imagen) ✔. Ofrece además EtherNet/IP, PROFINET y Modbus TCP ~ y FTP de imágenes ~. **Riesgo:** Native Mode también permite **escribir** (SV, SO, LF…), así que hay que usar una lista blanca de comandos `G*`/`R*`. **Prioridad 2.**
- **Keyence CV-X / IV / XG:** comandos "no procedimentales" por TCP (puerto 8500 ~) para leer resultados y contadores ~. Alternativa: EtherNet/IP o PLC-Link ~. **Prioridad 3.**
- **Patrón común:** casi todos **envían el resultado por TCP al terminar la inspección** (un "result string" configurable). Un **driver "TCP listener"** con parser regex cubre Cognex, Keyence, Datalogic, Omron y SICK. **Prioridad 2.**

---

## 6. SCADA y MES: cómo sacar datos sin licencias extra

| Sistema | Vía sin coste adicional (o mínimo) | ¿Histórico en SQL legible? | Notas |
|---|---|---|---|
| **AVEVA/Wonderware Historian** | SQL Server: BD **Runtime**, tablas **History** y **Live** (recomendadas), AnalogSummaryHistory, StateSummaryHistory, tablas *wide* ✔ | **Sí, por OLE DB**: las "extension tables" son virtuales y viven en el *linked server* `INSQL` (`INSQL.Runtime.dbo.History`) ✔ | Requiere CAL o licencia de cliente según el contrato ~. Es la vía más limpia en plantas con InTouch |
| **AVEVA InTouch (sin Historian)** | Alarmas en SQL (Alarm DB Logger) ~; OPC UA con AVEVA OI Gateway ~ | Parcial ~ | — |
| **WinCC V7/V8** | OPC UA server (DA) ~; alarmas y *user archives* en SQL plano | Proceso comprimido (Connectivity Pack, de pago) | Ya en el informe anterior |
| **WinCC Unified** | **GraphQL** integrado (`/graphql`): tags, valores *logged* y alarmas activas o históricas, con login por sesión ✔ (`winccua-mcp-server`, GPL-3.0, como referencia) | Vía API ✔ | Implementar nuestro propio cliente GraphQL (no copiar código GPL) |
| **Ignition** | OPC UA server ✔ y SQL del historian ✔ (ya cubierto) | Sí ✔ | — |
| **InduSoft / AVEVA Edge** | Historian a SQL; tablas con columnas por tag y calidad `_Q` ~ (esquema de la misma familia que Tatsoft FactoryStudio: `UTCTimeStamp_Ticks`, `TagName`, `_TagName_Q`) ✔/~ | **Sí** ~ | Ticks .NET (100 ns desde el año 1) ✔ |
| **Movicon (Emerson/Progea)** | Historian en SQL Server, MySQL o Access, con tablas abiertas ~ | **Sí** ~ | — |
| **COPA-DATA zenon** | Archivos **binarios propietarios**; módulo **Historian SQL Server Interface** (escribe por bloques con *buffer*), exportación a CSV, XML y SQL; alarmas y eventos a SQL "legibles por terceros" ✔ | Solo si está activo el exportador SQL ✔ | OPC UA server de zenon ~ (licencia) |
| **CIMPLICITY (GE Vernova)** | Database Logger a SQL Server en tablas abiertas ~; Proficy Historian con OLE DB y tablas virtuales (`ihRawData`) ~ | Sí ~ | — |
| **FactoryTalk View SE/ME** | Data Log a ODBC (FloatTable, StringTable, TagTable) ~; FactoryTalk Linx Gateway (OPC UA, de pago) ✔ | **Sí** ~ | FactoryTalk Optix: OPC UA y BD propios ~ |

**Conclusión:** el **driver SQL** genérico, con *plantillas* por SCADA (consultas incrementales por marca de tiempo y conversión de *ticks*), ofrece más rendimiento que cualquier driver nuevo de PLC en plantas con SCADA. Se propone añadir plantillas para AVEVA Historian (`INSQL`), InduSoft/Edge, Movicon, CIMPLICITY y FactoryTalk Datalog. **Prioridad 1** (plantillas), con verificación en campo.

---

## 7. Estándares emergentes

| Estándar | Estado (10-2026) | Librería / licencia | Simulador | Riesgo | Prioridad |
|---|---|---|---|---|---|
| **Asset Administration Shell (AAS)** | IDTA Part 1 Metamodel **v3.2** (07-2026) ✔ y Part 2 API v3.1.1 (08-2025) ✔. Submodelos: Digital Nameplate 3.0.1 (10-2025) ✔, moldes de plástico (IDTA 02038, 07-2025) ✔ y pasaporte de baterías (DBP, 02-2026) ✔ | **`basyx-python-sdk` 2.2.0 (02-10-2026), MIT** ✔: modelo, JSON/XML y AASX. Servidor Java **BaSyx AAS Environment, MIT** ✔ (Docker `eclipsebasyx/aas-environment`) | El propio BaSyx en Docker | Adopción baja en pymes; útil para el **Pasaporte Digital de Producto (ESPR)** | **3** hoy (2 en dos años): *exportar* datos de Sindri como AAS, no leer máquinas |
| **OPC UA PubSub** | Estándar (Part 14). KUKA KR C5 ya publica OPC UA sobre MQTT ✔ | open62541 (MPL-2.0) ✔ implementa PubSub. En Python, **sin soporte maduro** en asyncua ~ → con codificación JSON sobre MQTT basta el driver MQTT y un parser | open62541 | La codificación binaria UADP sobre UDP es compleja | **3** (JSON/MQTT: 2) |
| **Sparkplug B 3.0** | **ISO/IEC 20237** (anuncio del 07-11-2023) ✔ | `pysparkplug` (Apache-2.0, ya en curso) | Ya cubierto | Topic `STATE` del primary host distinto en v3 ~ | 2 (ya en curso) |
| **umati sobre MQTT** | **`umatiGateway`** (C#, **Apache-2.0** ✔): se suscribe a servidores OPC UA umati y publica JSON en MQTT (web en :8080), en desarrollo activo (commit de 10-2026) ✔ | Nada nuevo: driver MQTT + parser umati JSON | El propio gateway con Sample-Server | Estructura de *topics* por verificar ~ | 2 |
| **UNS / Industrial DataOps** | Patrón (no estándar): broker MQTT + jerarquía ISA-95 + Sparkplug o JSON. Herramientas: **HiveMQ Edge** (todos los adaptadores gratis; de pago solo *buffer offline*, Data Hub y soporte ✔; licencia del núcleo Apache-2.0 ~), United Manufacturing Hub ~ y Node-RED | — | Mosquitto | Si el cliente ya tiene UNS, **Efesto debe ser un consumidor más** | **2**: un modo "suscriptor UNS" con mapeo por *topic* |
| **Weihenstephan (OPC 40600)** | v1.00 de 2021 ✔ | asyncua + NodeSet | NodeSet sobre asyncua | — | 2 (alimentación) |
| **OPC UA Robotics (40010)** | KUKA certificado ✔ | asyncua | NodeSet | — | 2 |

---

## 8. Tabla resumen de la ampliación

| Sistema / equipo | Protocolo recomendado | Librería Python | Licencia | Madurez | Simulador libre | Prioridad |
|---|---|---|---|---|---|---|
| Fagor CNCelite 8058/8060/8065 | OPC UA umati | asyncua | LGPL-3.0+ | Alta | umati Sample-Server-asyncio (Apache-2.0) ✔ | **1** |
| Fagor 8055/8040 | Protocolo propio Fagor | — (comercial) | — | — | No | 3 (E/S o manual) |
| Schneider M241/M251/M262 | OPC UA | asyncua | LGPL-3.0+ | Alta | asyncua | 1 |
| Schneider M221 / M340 | Modbus TCP | pymodbus | BSD-3 | Alta | pymodbus | 1 |
| Omron NX/NJ | OPC UA (EIP con `aphyt`) | asyncua / aphyt | LGPL / **GPL-2.0** ✔ | Media | asyncua | 2 |
| Keyence KV-8000A | OPC UA | asyncua | LGPL | Alta | asyncua | 2 |
| Keyence KV (otros) | Host Link 8501 / MC | propia / pymcprotocol | — / MIT | Baja | emulador hostlink ✔ | 3 |
| Panasonic FP | Modbus TCP o MEWTOCOL | pymodbus / pypanasonic | BSD / MIT ✔ | Baja | No | 3 |
| Delta DVP/AS | Modbus | pymodbus + perfil | BSD-3 | Alta | pymodbus | 2 |
| Unitronics | PCOM / Modbus | pcom | MIT ✔ | Baja (2022) | No | 3 |
| WAGO | Modbus TCP / OPC UA | pymodbus / asyncua | BSD / LGPL | Alta | Sí | 2 |
| PLCnext | REST (atributo HMI) | httpx | BSD-3 | Media | Mock | 2 |
| B&R | OPC UA | asyncua | LGPL | Alta | asyncua | 2 |
| ctrlX CORE | REST Data Layer (gratis) | httpx | BSD-3 | Media | ctrlX WORKS virtual (propietario, gratis) ✔ | 2 |
| KUKA KR C5 | OPC UA (Robotics) | asyncua | LGPL | Alta | NodeSet 40010 | 2 |
| ABB IRC5 | RWS | abb_robot_client | Apache-2.0 ✔ | Media (no RW7) | RobotStudio (prop.) | 2 |
| Fanuc robot | OPC UA (opción) / SNPX | fanuc_ucl | Apache-2.0 ✔ | Media-alta (2026) | ROBOGUIDE (prop.) | 2-3 |
| Universal Robots | Puertos de solo lectura 3001x / RTDE | ur_rtde | MIT ~ | Alta | URSim (gratis, prop.) | 2 |
| Fanuc CNC | OPC UA (opción) / FOCAS | asyncua / ctypes | LGPL / DLL prop. | — | No | 2 |
| Heidenhain | LSV2 (OPC UA: opciones 56-61) | pyLSV2 | MIT | Alta | Prog. station (prop.) | 2 |
| Sinumerik | OPC UA **solo polling** | asyncua | LGPL | Media | No | 2 |
| Haas NGC | Q-commands TCP 5051 / MTConnect | propia (≈100 líneas) | — | Alta (protocolo) | Mock TCP | 2 |
| Okuma / Mazak | MTConnect | httpx + lxml | BSD | Alta | cppagent ✔ | 3 |
| MT-SICS | ASCII serie/TCP | pyserial | BSD-3 | Alta | socat + script | **1** (alim.) |
| Gram / Baxtran / indicadores | Trama continua (regex) | pyserial | BSD-3 | Alta | socat | 2 |
| Bizerba | SQL de `_connect2DB` / REST | SQLAlchemy / httpx | MIT / BSD | Media | BD de prueba | 2 |
| Dibal / Epelsa | A través de su software | — | — | — | — | 2-3 |
| Zebra | `~HQOD`/`~HQES`/`~HS` TCP 9100 + SNMP | socket / pysnmp | — / BSD ~ | Alta | Mock TCP | 2 |
| SATO | WebSocket API / SNMP | websockets | BSD-3 ~ | Media | Mock | 3 |
| Circutor | Modbus + mapas / PowerStudio XML | pymodbus / httpx | BSD | Alta | pymodbus + mapa | **1** |
| Schneider PM/iEM | Modbus + .xlsx público | pymodbus + openpyxl | BSD / MIT | Alta | pymodbus | **1** |
| M-Bus cableado | EN 13757 | pyMeterBus | BSD-3 ✔ | Media | — | 3 |
| wM-Bus | wmbusmeters (proceso externo) → MQTT/JSON | — | **GPL-3.0** ✔ | Alta | rtl_433 + SDR | 3 |
| DLMS/COSEM | — | dlms-cosem / gurux | **BSL 1.1** ✔ / **GPL-2.0** ✔ | Media | — | 3 (riesgo) |
| Compresores (Atlas Copco, Kaeser) | Modbus (mapa del fabricante) | pymodbus | BSD | Alta | pymodbus | 2 |
| Euromap 77 (detección de release) | OPC UA | asyncua | LGPL | Media | Propio con NodeSet 40077 | **1** (plástico) |
| Trumpf | OPC UA (opción) | asyncua | LGPL | Media | No | 2 |
| ULMA Packaging | FTP de logs + PLC (EIP/S7) | ftplib / pylogix / snap7 | PSF / Apache / MIT | Media | Carpeta FTP | **1** (cárnico) |
| Weihenstephan | OPC UA 40600 | asyncua | LGPL | Media | NodeSet | 2 |
| Cognex | Native Mode (lista blanca G*/R*) | socket | — | Alta | Mock | 2 |
| Visión genérica | TCP listener + regex | asyncio | PSF | Alta | Mock | 2 |
| AVEVA Historian | SQL (`INSQL`) | pyodbc | MIT | Alta | SQL Server Dev | **1** (si existe) |
| WinCC Unified | GraphQL | httpx / gql | BSD / MIT ~ | Media | No | 2 |
| zenon | Exportación SQL | SQLAlchemy | MIT | Media | — | 2 |
| AAS | Exportación AAS de Sindri | basyx-python-sdk | MIT ✔ | Media | BaSyx Docker (MIT) ✔ | 3 |
| UNS / umati MQTT | Suscriptor MQTT con mapeo | aiomqtt | BSD-3 | Alta | Mosquitto + umatiGateway | 2 |

---

## 9. Recomendaciones de arquitectura que salen de esta ampliación

1. **Perfiles antes que drivers.** La mayoría de los equipos nuevos cabe en *protocolos existentes* más un **perfil** (mapa de tags a roles semánticos): umati/Machinery, Robotics 40010, Euromap 77 con detección de release, PackML, Weihenstephan, Circutor, Schneider PM, Delta, compresor y prensa. Conviene un repositorio de perfiles en YAML, versionado y contribuible por integradores.
2. **Flags de comportamiento por fabricante** en el driver OPC UA: `force_polling` (Sinumerik), `uint64_as_string` (E77), `resolve_namespace_by_uri` (E77/umati) y `max_sessions` (S7-1200, ctrlX Basic con 5).
3. **Listas blancas de comandos** en los drivers "de texto" que también escriben: ZPL (`~HQ`, `~HS`), Cognex Native Mode (`G*`, `R*`), Haas (`Q100`, `Q104`, `Q500`, `Q600`), MT-SICS (`S`, `SI`, `I*`, nunca `T`, `Z` ni `TA`) y KUKAVARPROXY (solo lectura).
4. **Plugins de proceso externo** para todo lo GPL o BSL (wmbusmeters, aphyt, gurux-dlms), comunicados por MQTT o JSON por *stdout*. Así el núcleo de Sindri no se ve afectado por la licencia.
5. **Driver "TCP listener"** (el equipo empuja la trama: visión, básculas en modo continuo, lectores) y **driver "TCP request/response"** (Haas, MT-SICS, ZPL, Host Link) declarativos, configurados con regex y plantillas. Cubren más de diez familias sin código nuevo.
6. **Preventa:** una tabla de "licencias que debe comprar el cliente". Incluye Heidenhain 56-61 por aplicación, Sinumerik OPC UA, Fanuc OPC UA, Engel E77, ctrlX OPC UA, Trumpf OPC UA, WinCC Connectivity Pack y Bizerba `_connect2DB`. Junto a ella, la vía gratuita alternativa (LSV2, REST de ctrlX, E63 de Engel, PowerStudio o SQL).

---

## 10. Fuentes

**CNC**
- Fagor, entrevista en umati (CNCelite con servidor umati): https://umati.org/fagor-automation-gmbh-interview/
- Fagor en IMH (servidor OPC-UA compatible con umati): https://www.imh.eus/en/about-imh/communication/events/manulearn-learning-factory-standard-communication-protocols-opc-ua-and-umati
- Fagor Magazine n.º 3 (API del 8065, MTConnect): https://www.fagorautomation.com/downloads/boletines/es/magazine_3.pdf
- FactoryWiz, protocolo Fagor 8040/8050/8055: https://mfgnewsdigital.mydigitalpublication.com/article/Fagor+Native+Protocol+Added+To+Factorywiz+Monitoring/2890449/440590/article.html
- Heidenhain OPC UA NC Server (opciones 56-61): https://www.heidenhain.us/wp-content/uploads/2023/02/BR_OPC_UA_NC_Server_ID1355797_en.pdf
- Sinumerik OPC UA (Cybus): https://docs.cybus.io/1-7-2/documentation/industry-protocol-details/sinumerik
- Haas, conectividad (Q-commands, 5051, Setting 143): https://docs.machinemetrics.com/docs/machine-connectivity/haas-connectivity-guide
- TrakHound, agente MTConnect para Haas: https://de.github.com/TrakHound/MTConnect-Agent-For-Haas
- Okuma MTConnect gratuito: https://www.okuma.com/mtconnect
- FANUC MT-LINKi: https://www.fanuc.eu/hu/en/cnc/connectivity/mt-linki
- Softing edgeConnector FANUC CNC (deprecated): https://opcfoundation.org/?p=19216

**PLC**
- Schneider, OPC UA en Modicon (FAQ): https://www.se.com/kz/ru/faqs/FA176318
- Schneider, cliente OPC UA M580 / BMENUA0100: https://www.se.com/us/en/faqs/FAQ000247881/
- Omron, productos con OPC UA: https://www.ia.omron.com/product/special/sysmac/nx1/opcua-products.html
- Omron, manual W588 OPC UA: https://files.omron.eu/downloads/latest/manual/en/w588_nj_nx-series_opc_ua_cpu_units_users_manual_en.pdf?v=1
- aphyt (PyPI): https://pypi.org/project/aphyt/
- Keyence KV-8000A con OPC UA: https://www.keyence.com/landing/controls/pr_opc-ua_01089999.jsp
- pykeyence: https://github.com/CREFLEINC/pykeyence
- Proxus, protocolos Keyence: https://proxus.io/docs/connecting-data/protocols/keyence/
- pypanasonic: https://pypi.org/project/pypanasonic/0.0.6
- a2y-mew: https://pypi.org/project/a2y-mew
- Unitronics, protocolo PCOM: https://www.unitronicsplc.com/Download/SoftwareUtilities/Unitronics%20PCOM%20Protocol.pdf
- pcom (PyPI): https://pypi.org/project/pcom
- WAGO PFC200 por Modbus (Cybus): https://docs.cybus.io/guides/machine-connectivity/plcs-industrial-controllers/connecting-a-wago-pfc200-controller
- PLCnext REST, variables: https://plcnext.help/te/Communication_interfaces/REST_data_interface/REST_data_interface_Variables.htm
- ctrlX REST API: https://community.boschrexroth.com/ctrlx-automation-how-tos-qmglrz33/post/using-rest-api-of-ctrlx-core-HCE2Q8WW3uhUYOh
- ctrlX OPC UA Server (licencias): https://community.boschrexroth.com/ctrlx-os-store-apps-oc2pqqwn/post/ctrlx-os---opc-ua-server-2J3tFReDuoM8Svz
- B&R, comunicación (Promotic): https://www.promotic.eu/en/pmdoc/Subsystems/Comm/PLC/BerneckerReiner.htm
- Ingeteam en modbus.org: https://modbus.org/viewcompany.php?id=354

**Robots**
- KUKA KR C5, certificación OPC UA: https://opcfoundation.org/?p=14701
- KUKAVARPROXY: https://github.com/tobesch/KUKAVARPROXY
- py-openshowvar: https://pypi.org/project/py-openshowvar/1.1.4/
- abb_robot_client: https://pypi.org/project/abb-robot-client y https://abb-robot-client.readthedocs.io/en/stable/abb_robot_client/api/rws.html
- rwsuis: https://pypi.org/project/rwsuis/
- fanuc_ucl: https://pypi.org/project/fanuc-ucl/
- FANUC robot OPC UA Server: https://www.fanucamerica.com/products/software/hmi-device-snpx
- Universal Robots, interfaces de cliente: https://www.universal-robots.com/articles/ur/interface-communication/overview-of-client-interfaces/

**Básculas y etiquetado**
- MT-SICS, manual de referencia: https://mt.com/content/dam/non-indexed/po/labtec/12_Miscellaneous/RM-MT-SICS-LA-en.pdf
- Gram, protocolo ZFOC: https://gram-group.com/wp-content/uploads/2018/11/MU_ZFOC_Protocol_RS_001.pdf
- Dibal DFS: https://tamtrongroup.com/wp-content/uploads/2023/01/Dibal-DFS-datablad-2.pdf
- Bizerba _connect.BRAIN V5: https://www.bizerba.com/gb/en/products/_connect_brain-v5
- JBT Marel Innova Integration: https://jbtmarel.com/en/products/innova-integration-services/
- Ishida DACS-GN: https://www.ishidaeurope.com/media/5xwhgoa1/dacs-gn_checkw_brochure_v5-0425.pdf
- Zebra `~HQ`: https://docs.zebra.com/us/en/printers/software/zpl-pg/c-zpl-zpl-commands/r-zpl-hq.html
- Zebra host status: https://docs.zebra.com/us/en/printers/software/zpl-pg/sgd-command-reference/device-host_status.html
- SATO Printer API: https://www.satoeurope.com/pdf/products/software/sato-printer-api-reference-document.pdf

**Energía**
- Circutor CVM-B: https://circutor.com/en/products/measurement-and-control/fixed-power-analyzers/fixed-power-analyzer/serie/cvm-b/
- Circutor, mapas Modbus (AGG Software): https://www.aggsoft.com/modbus-data-logging/circutor.htm
- PowerStudio, servicios XML: https://www.manualsdir.com/manuals/750263/circutor-powerstudio-series.html
- Schneider PM5000, listas de registros: https://www.se.com/ww/en/faqs/FA234017
- wmbusmeters: https://github.com/wmbusmeters/wmbusmeters/
- pyMeterBus: https://github.com/prein2/pyMeterBus
- dlms-cosem (BSL): https://pypi.org/project/dlms-cosem
- gurux-dlms: https://pypi.org/project/gurux-dlms/1.0.22
- Kaeser SIGMA CONTROL 2: https://www.wateronline.com/doc/sigma-control-0001
- Atlas Copco por Modbus (fuente secundaria, ~): https://industrialmonitordirect.com/blogs/knowledgebase/reading-atlas-copco-elektronikon-mkiv-data-via-modbus

**Plástico, metal, embalaje y visión**
- Euromap 77 (Cybus, detalles prácticos): https://docs.cybus.io/guides/system-connectivity/industry-standards-interoperability/euromap-77-integration
- Engel en el foro de Ignition: https://forum.inductiveautomation.com/t/engel-molding-machines/56233
- Sigmatek, servidor EM77: https://www.sigmatek-automation.com/fileadmin/user_upload/downloads/EM77_Server_infosheet_en.pdf
- OPC Foundation, Plastics & Rubber: https://opcfoundation.org/markets-collaboration/plastics-and-rubber-machinery/
- Trumpf Connectivity: https://www.trumpf.com/en_INT/products/services/services-machines-systems-and-lasers/monitoring-analysis/connectivity/
- Trumpf, OPC UA en producción: https://trumpf.com/en_IN/newsroom/stories/5-ways-to-use-opc-ua-in-your-production-environment/download-pdf.html
- Plegadoras y controles (Durmapress): https://www.durmapress.com/es/industria-4-0-2
- ULMA Smart machines: https://ulmapackaging.com/en/digital-solutions/smart-machines
- MULTIVAC Line Control: https://multivac.com/bg/en/our-solutions/portfolio/digital-solutions/multivac-line-control
- OPC 40600 Weihenstephan: https://reference.opcfoundation.org/Weihenstephan
- Cognex Native Mode: https://docs.cognex.com/is_640/web/EN/ise/Content/Communications_Reference/NativeMode_Commands.htm

**SCADA**
- AVEVA Historian, tablas de historia: https://docs.aveva.com/bundle/sp-historian/page/65335.html
- zenon, registro de datos: https://www.copadata.com/en/zenon-capabilities/data-acquisition/data-recording/
- Esquema del historian de FactoryStudio (familia InduSoft): https://tatsoft.com/help/fs-2014/reverb/FactoryStudio/HistorianAndDataLogging.07.6.html
- WinCC Unified GraphQL (MCP de referencia, GPL-3.0): https://github.com/vogler75/winccua-mcp-server

**Estándares emergentes**
- basyx-python-sdk: https://www.pypi.org/project/basyx-python-sdk
- BaSyx AAS Environment: https://hub.docker.com/r/eclipsebasyx/aas-environment
- IDTA AAS Part 1 v3.2: https://industrialdigitaltwin.org/wp-content/uploads/2026/07/IDTA-01001-3-2_AAS-Specification_Part1_Metamodel.pdf
- IDTA Digital Nameplate 3.0.1: https://industrialdigitaltwin.org/en/wp-content/uploads/sites/2/2025/10/IDTA-02006-3-0-1_Submodel_Digital-Nameplate.pdf
- Sparkplug como ISO/IEC 20237: https://newsroom.eclipse.org/node/39754
- umatiGateway: https://zff.dev/umati/umatiGateway
- open62541 PubSub: https://open62541.org/doc/master/pubsub.html
- HiveMQ Edge, adaptadores: https://community.hivemq.com/t/hivemq-edge-open-source-protocol-adapters/3341

*Queda por verificar: licencia del núcleo de HiveMQ Edge; código de opción OPC UA de Fanuc CNC; soporte de OPC UA en Fagor 8070 y en Omron NX1P2; puerto exacto de Cognex Native Mode y de Keyence CV-X; mapas de Dibal, Epelsa y Mateu & Solé (pedirlos al fabricante); licencia de `pykeyence` y de `ur_rtde`.*
