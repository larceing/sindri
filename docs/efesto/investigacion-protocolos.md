# Efesto: protocolos industriales que el agente debe saber leer

*Investigación para Sindri (ERP open source para pymes industriales españolas). Fecha: 24-10-2026.*
*Alcance: agente de **solo lectura** en Python 3 (hoy OPC UA con asyncua) que se quiere convertir en un sistema de drivers enchufables.*

> **Cómo leer las cifras.** Las versiones y fechas marcadas con ✔ las he comprobado en PyPI, la documentación o el repositorio durante la investigación. Las estrellas de GitHub y las cuotas de mercado son **aproximadas**, salen de conocimiento previo y de fuentes de mercado genéricas, y conviene revisarlas antes de usarlas en una decisión. En España no hay datos públicos fiables de cuota de PLC por fabricante. Lo que digo de cada sector es una estimación cualitativa basada en el parque instalado típico.

---

## 1. Resumen ejecutivo

1. **Las tres primeras capas cubren la mayor parte del parque instalado: OPC UA, Siemens S7 (S7comm por PUT/GET) y Modbus TCP/RTU.** En la pyme española domina Siemens: S7-1200, S7-1500, S7-300 heredados y LOGO!. Le siguen Schneider (que a menudo se lee por Modbus), Omron, Mitsubishi y algo de Rockwell en multinacionales y alimentación.
2. **La regla de oro para un agente de solo lectura es conectarse donde ya existe un servidor:** un servidor OPC UA integrado en el PLC o el CNC, un esclavo Modbus o un endpoint REST. Así se evita tocar el programa del PLC. Cuando no hay más remedio, se pide al integrador un DB "espejo" no optimizado o que active el servidor OPC UA del S7-1500 (gratis en el 1500; en el S7-1200 desde el firmware V4.4, con licencia de runtime).
3. **Licencias.** Casi todo el ecosistema Python útil es MIT, BSD o Apache, y algunas librerías son LGPL (asyncua, BAC0, libplctag, S7CommPlusDriver). Las que imponen condiciones son **cpppo** (GPLv3 o licencia propietaria), **OpenOPC2** (GPL-2.0+ con excepción) y **FOCAS** (DLL propietaria de Fanuc). Si Sindri acaba siendo AGPL, la GPL es compatible, pero conviene aislar esos drivers como plugins opcionales (ver §5).
4. **Arquitectura recomendada:** copiar el *patrón* de Telegraf, ThingsBoard Gateway y Neuron. Un driver por protocolo con una interfaz mínima (`connect`, `read(tags)`, `browse` opcional, `subscribe` opcional y `health`). Los tags se declaran de forma uniforme (dirección, tipo, orden de bytes, escala y offset, unidades, deadband). Todo el sistema comparte un mismo bucle de reintentos con *backoff* y un buffer local en SQLite, el mismo que recomienda ThingsBoard.

---

## 2. Protocolos y sistemas, uno a uno

### 2.1 OPC UA (IEC 62541)
- **Qué es y dónde está:** el estándar abierto de referencia de la Industria 4.0. Lo integran de serie el S7-1500 (servidor gratuito), el S7-1200 desde FW 4.4 (requiere licencia SIMATIC OPC UA S7-1200 Basic), Beckhoff TwinCAT (TF6100), Omron NX/NJ, B&R, Mitsubishi iQ-R (con módulo), Rockwell (FactoryTalk Linx Gateway) y los CNC modernos (Siemens Sinumerik con licencia "Access MyMachine/OPC UA", Heidenhain TNC 640 con la opción OPC UA, Fagor 8065/8070, miembro de umati). Es también la base de Euromap 77/83, umati y PackML.
- **Relevancia:** alta y creciendo; es el **destino** de casi todas las máquinas nuevas a partir de 2020.
- **Librería Python:** `asyncua` (FreeOpcUa/opcua-asyncio). ✔ v2.1.0 del 06-10-2026, **LGPL-3.0+**, unas 1.300 estrellas (aprox.). Para un ERP AGPL no hay problema: se usa como dependencia sin modificarla.
- **Alternativas:** open62541 (C, **MPL-2.0**, muy maduro, certificable), Eclipse Milo (Java, **EPL-2.0**), node-opcua (JS, MIT), `gopcua` (Go, MIT).
- **Solo lectura:** limpia. Se crea un usuario de servidor con rol de solo lectura o se usa anónimo con permisos restringidos. El cliente usa `Read`, `Browse` y suscripciones `MonitoredItems`; nunca `Write` ni `Call`.
- **Simulador:** `asyncua` incluye servidor; también open62541 y el *Prosys OPC UA Simulation Server* (freeware, no libre). Para umati: `umati/Sample-Server` (C++, MPL-2.0) y `Sample-Server-asyncio` (Python, Apache-2.0) ✔.
- **Riesgos:** certificados y políticas de seguridad (Basic256Sha256), sesiones limitadas en el S7-1200 (pocas sesiones concurrentes), nodos con NodeId numérico que cambia al recompilar el proyecto TIA (mejor resolver por BrowsePath) y licencias de runtime OPC UA que debe comprar el cliente final.

### 2.2 OPC DA / OPC Classic (COM/DCOM, solo Windows)
- **Qué es:** el OPC antiguo (DA, HDA, A&E). Sigue vivo en SCADAs heredados como WinCC 7, RSLinx, Kepware, Wonderware/AVEVA, Citect y los servidores OPC de fabricantes (Omron CX-Server, MX OPC de Mitsubishi).
- **Relevancia:** media en plantas con SCADA de 2005-2015; en declive.
- **Librería Python:** `OpenOPC2` ✔ v0.1.19 del 19-05-2026, **GPL-2.0-or-later con excepción de enlace**. Funciona en local (Python de 32 bits y `gbda_aut.dll` registrada) o en **modo gateway**: un servicio Windows con Pyro5 al que se conecta un cliente Linux o Docker sin DCOM ✔.
- **Alternativa recomendada:** no leer DA directamente, sino poner un **puente DA→UA** en el PC Windows: el *UA Wrapper* de la OPC Foundation (.NET, licencia de la Fundación, gratis para miembros), Kepware o Matrikon UA Tunneller (de pago), o el servicio gateway de OpenOPC2 como plugin aparte.
- **Solo lectura:** sí (`read`, `list`).
- **Simulador:** Matrikon OPC Simulation Server (freeware, propietario).
- **Riesgos:** DCOM es una pesadilla de configuración, y Microsoft endureció DCOM (KB5004442) entre 2022 y 2023, lo que rompió muchos accesos remotos. Requiere Windows, y el código GPL obliga a aislarlo.

### 2.3 Modbus TCP y Modbus RTU (RS-485/RS-232) + pasarelas
- **Qué es:** el protocolo más universal y sencillo. Está en analizadores de red (Circutor, una empresa española muy extendida, Schneider PM, Carlo Gavazzi), variadores (Danfoss, ABB, Schneider), controladores de temperatura (termorreguladores de inyectoras y hornos), equipos de frío industrial, compresores (Atlas Copco, Kaeser), Schneider M221/M241/M340, Unitronics, Delta, Wago y pasarelas serie→TCP (Moxa MGate, USR, Anybus).
- **Relevancia:** muy alta en todos los sectores. Es el "mínimo común denominador".
- **Librería Python:** `pymodbus` ✔ v3.16.1 del 11-10-2026, **BSD-3-Clause**, unas 2.500 estrellas (aprox.), unos 1,6 millones de descargas al mes ✔. Es asíncrona, soporta TCP, UDP, RTU, ASCII y RTU sobre TCP, e incluye simulador y servidor. Alternativa ligera: `minimalmodbus` (Apache-2.0, solo RTU/ASCII). En Go: `goburrow/modbus` (BSD). En C: `libmodbus` (LGPL-2.1).
- **Solo lectura:** muy limpia; basta con usar solo las funciones 1, 2, 3 y 4. El driver nunca debe exponer 5, 6, 15 ni 16.
- **Simulador:** el servidor y simulador de `pymodbus`, `diagslave` (freeware) y ModbusPal (Java).
- **Riesgos:** no hay un modelo de datos común, así que el *mapa de registros* sale del manual de cada equipo y hay que codificar orden de bytes y de palabras, escala y offset. Equipos que solo aceptan 1 o 2 conexiones TCP simultáneas (con frecuencia el SCADA ya ocupa una). En RTU solo puede haber **un maestro por bus**: si ya hay un HMI o SCADA maestro no se puede colgar otro, y hay que leer del maestro o usar una pasarela con multimaestro (Moxa MGate). Hay ambigüedad en el direccionamiento (40001 frente a 0) y no existe seguridad (Modbus/TCP Security apenas se usa).

### 2.4 Siemens S7: S7comm (clásico) y S7comm-plus
- **Qué es y dónde está:** **el PLC dominante en la pyme industrial española** (S7-1200, S7-1500, S7-300/400 heredados, ET200SP y LOGO! en máquinas pequeñas). Aparece en todos los sectores: metal, plástico (periféricos), alimentación, embalaje y madera (seccionadoras y CNC de madera con PLC Siemens).
- **Relevancia:** máxima.
- **S7comm clásico, librería `python-snap7`** (gijzelaerr). ✔ v3.x (docs v3.3.0): ahora es **Python puro** (ya no usa la DLL C de Snap7), incluye cliente síncrono y asíncrono (`AsyncClient`) y servidor de pruebas ✔. Licencia **MIT** (histórica del proyecto; la página de documentación no la muestra, así que conviene confirmarla en el repositorio). Unas 750 estrellas (aprox.). Soporta S7-300/400 al completo, LOGO! 8, y S7-1200/1500 solo por PUT/GET ✔.
- **Restricciones del S7-1200/1500** ✔ (de la matriz de soporte de python-snap7):
  - Hay que **activar "Permitir acceso PUT/GET"** en TIA Portal, lo que obliga a volver a descargar la configuración. PUT/GET **no tiene autenticación**.
  - Solo se leen **DB no optimizados** (direccionamiento absoluto `DB10.DBD4`) y las áreas I/Q/M/T/C. Los **DB con "acceso optimizado"**, el valor por defecto en TIA, **no se pueden leer por dirección absoluta**.
  - Probado en un S7-1200 1212C con FW V4.7 y en un S7-1500 1511F con FW V2.9 ✔.
  - **Solución práctica:** pedir al integrador un **DB_Efesto no optimizado** que copie las variables de interés (estado, contadores, alarmas y orden) en cada ciclo, o usar el **servidor OPC UA** del PLC.
- **S7comm-plus** (el protocolo nativo del 1200/1500, con TLS a partir de TIA V17 y acceso simbólico a DB optimizados):
  - Python: proyecto independiente `gijzelaerr/s7commplus` (a partir de python-snap7 3.x) ✔ existe, pero es joven y su licencia y madurez están por verificar.
  - .NET: `S7CommPlusDriver` (Thomas Wiens / dotnetprojects) ✔ **LGPL-3.0+**, v5.0.0 de octubre de 2026, con acceso simbólico `GetTagBySymbolAsync("MyDb.MyValue")`.
  - Node-RED: `node-red-contrib-s7-plus` ✔ (LGPL-3.0+, "en desarrollo, no apto para producción", requiere TLS en el PLC y TIA ≥ V17).
  - PLC4X: el driver S7+ **aún no** es libre; es comercial de ToddySoft y está pendiente de financiación ✔.
  - **Conclusión:** de momento S7comm-plus es *experimental*. Hay que ofrecerlo como driver opcional y no basar en él el producto.
- **Alternativas:** Go `robinson/gos7` (BSD-3), Node `nodes7` (MIT), PLC4X (Java/Go, Apache-2.0).
- **Solo lectura:** el cliente solo llama a `db_read` y `read_area`. PUT/GET permite escribir, así que la garantía de solo lectura depende de **nuestro código** (y de la red). En el S7-1500 se puede restringir con niveles de protección y, sobre todo, usar OPC UA con un usuario de solo lectura.
- **Simulador:** el servidor de python-snap7 ✔. PLCSIM Advanced (propietario, de pago) permite probar S7comm y OPC UA reales.
- **Riesgos:** activar PUT/GET supone un cambio en el PLC y, a menudo, que el integrador se niegue o pida dinero. La seguridad (OT abierta) también pesa. El **S7-1200 G2** (2025) y los firmware nuevos tienden a desaconsejar PUT/GET; hay que verificar el soporte modelo a modelo. Las direcciones cambian si alguien recompila el DB.

### 2.5 Allen-Bradley / Rockwell: EtherNet/IP + CIP
- **Dónde está:** menos habitual en la pyme española. Aparece en multinacionales estadounidenses, en alimentación y bebidas, en embalaje (líneas importadas) y en automoción tier-1. Familias ControlLogix, CompactLogix, Micro800, y SLC/MicroLogix/PLC-5 heredados.
- **Relevancia:** media-baja (más alta en alimentación de gran tamaño).
- **Librerías Python:**
  - `pycomm3` ✔ v1.2.16, **MIT**, unas 450 estrellas (aprox.). Lectura de tags simbólicos Logix, lista de tags (*browse*), SLC/PLC-5 por PCCC y CIP genérico. Último release de 2024, con poco movimiento pero estable.
  - `pylogix` (Apache-2.0, unas 650 estrellas): sencillo, solo Logix y Micro800.
  - `libplctag` (C) ✔ **MPL-2.0 o LGPL-2+** (doble licencia), unas 900 estrellas. Soporta ControlLogix, Micro800, PLC-5/SLC/MicroLogix, Omron NX/NJ y Modbus. Tiene wrapper Python mínimo y wrappers .NET, Go y Java.
  - `cpppo` ✔ v5.2.5 (02-2025), **GPLv3+ o propietaria (doble licencia)**. Útil sobre todo por su **simulador de controlador EtherNet/IP**. **Ojo a la licencia:** mejor usarlo solo en tests.
- **Solo lectura:** limpia (lectura por nombre de tag).
- **Simulador:** el servidor ENIP de `cpppo` ✔, el simulador ab_server de `libplctag` (incluido en el repo) y Studio 5000 Logix Emulate (propietario).
- **Riesgos:** los tags locales a programa (`Program:Main.X`) y los UDT complejos. Micro800 no admite el *browse* completo. Hay que vigilar el número de conexiones CIP.

### 2.6 Omron FINS
- **Dónde está:** CP1, CJ y CS (heredados), y NX/NJ (que prefieren EtherNet/IP y OPC UA). Muy presente en embalaje, alimentación y máquina auxiliar de origen asiático o nacional.
- **Relevancia:** media.
- **Librería Python:** `fins-driver` ✔ v0.3.1 (12-2024), **MIT**. Alternativas: `fins` en PyPI (sin mantener), `omron-fins` en Rust (docs.rs), `libplctag` para NX/NJ por CIP y PLC4X (no tiene FINS).
- **Solo lectura:** sí (comando *Memory Area Read*, 0101).
- **Simulador:** no hay uno libre sólido; se puede usar CX-Programmer/Sysmac Studio (propietario) o escribir un servidor FINS UDP de pruebas, que es trivial.
- **Riesgos:** FINS/UDP necesita configurar nodos de red (el último octeto de la IP como número de nodo) y algunos CPU solo aceptan TCP. En NX/NJ hay que publicar variables en la red y usar CIP u OPC UA.

### 2.7 Mitsubishi MC protocol / SLMP
- **Dónde está:** serie Q, L, iQ-R e iQ-F (FX5U). Muy común en maquinaria japonesa y china (inyectoras, robots cartesianos, máquinas de embalaje) y en algunos fabricantes nacionales de máquina.
- **Relevancia:** media.
- **Librería Python:** `pymcprotocol` ✔ v0.3.0 (04-2021), **MIT**. Soporta Q, L, QnA, iQ-L e iQ-R con trama 3E (la 4E no está probada); **no** admite FX ni A ✔. Está sin mantenimiento desde 2021, pero el protocolo es estable. Alternativas: fork `upymcprotocol`, el wrapper `strnh/pymcprotocol-wrapper`, `aslmp` en PyPI, el driver de Neuron (comercial), el `go-mcprotocol` de Go y HslCommunication (.NET, propietario, descartado).
- **FX5U (iQ-F):** SLMP 3E binario ✔ con la conexión SLMP habilitada en GX Works3; si no, por Modbus TCP, que el FX5U trae integrado.
- **Solo lectura:** sí (*batch read*, 0401).
- **Simulador:** GX Simulator3 (propietario, sin acceso de red). No hay ninguno libre; conviene un mini-servidor de test propio.
- **Riesgos:** hay que abrir un puerto MC en los parámetros del PLC (un cambio de configuración). Variantes ASCII y binaria. FX3U necesita el módulo FX3U-ENET y trama 1E.

### 2.8 Beckhoff ADS (TwinCAT)
- **Dónde está:** maquinaria especial, embalaje, madera (CNC y seccionadoras) y fabricantes de máquina que usan PC industrial.
- **Relevancia:** media-baja en la pyme usuaria, alta en algunos OEM.
- **Librería Python:** `pyads` (stlehmann) **MIT**, unas 280 estrellas (aprox.), v3.4.x. Usa `adslib` (MIT, de Beckhoff) en Linux. Ofrece lectura por nombre simbólico (`read_by_name`), notificaciones y creación de rutas en Linux ✔. Alternativas: `aioads` (asíncrona), `ads-client` (Node, MIT), PLC4X ADS (Java/Go).
- **Solo lectura:** sí. Además se puede usar OPC UA (TF6100, licencia de pago) en lugar de ADS.
- **Simulador:** TwinCAT 3 XAR en modo trial (propietario, gratis con licencia de 7 días renovable). No existe un servidor ADS libre completo.
- **Riesgos:** hay que **crear una ruta ADS** en el PLC (AMS NetId), lo que obliga a tener credenciales de Windows/TwinCAT del PLC o a pedírselo al OEM.

### 2.9 MQTT y Sparkplug B
- **Qué es:** transporte publish/subscribe. Muchos equipos modernos, pasarelas IoT (Siemens IOT2050, Moxa, Teltonika), IO-Link masters, Node-RED y Neuron publican en MQTT. Sparkplug B (Eclipse, protobuf, estados `NBIRTH`/`DBIRTH`/`DDATA`) es el estándar del "Unified Namespace" y lo usan Ignition, HighByte y Cirrus Link.
- **Relevancia:** media y creciendo. Es el **mejor canal de entrada para todo lo que ya está "IoT-izado"**.
- **Librerías Python:** `paho-mqtt` (**EPL-2.0 / EDL-1.0**, Eclipse, el estándar de facto), `aiomqtt` (BSD-3), `gmqtt` (MIT). Para Sparkplug B: `pysparkplug` ✔ v0.6.1 (05-2025, **Apache-2.0**), `mqtt-spb-wrapper` ✔ v2.1.2 (07-2025, **EPL-2.0**) y Eclipse Tahu (referencia multilenguaje, EPL-2.0).
- **Solo lectura:** natural, el agente solo se *suscribe*. Hay que usar credenciales con ACL de solo suscripción en el broker.
- **Simulador:** brokers libres Mosquitto (EPL/EDL), EMQX (BSL/Apache según versión) y NanoMQ (MIT); publicadores de prueba propios.
- **Riesgos:** sin modelo semántico salvo con Sparkplug, cada equipo publica su propio JSON. EPL-2.0 es compatible con GPL solo mediante la cláusula de licencia secundaria; como dependencia sin modificar no hay problema práctico. Hay que vigilar QoS y la pérdida de mensajes si el agente cae (sesiones persistentes).

### 2.10 MTConnect (CNC)
- **Qué es:** estándar abierto (AMT, EE. UU.) en el que un *agente* HTTP expone XML/JSON (`/probe`, `/current`, `/sample`) con estado, ejecución, programa, contadores y alarmas del CNC. Lo traen de serie o como opción Mazak, Okuma, Haas (NGC), DMG Mori (algunas), Doosan y Hurco. Para Fanuc, Siemens y Heidenhain hacen falta *adaptadores*.
- **Relevancia en España:** **baja-media**. En Europa se impone umati/OPC UA, pero sí aparece en Mazak y Haas, que son muy comunes en talleres de mecanizado.
- **Librería Python:** basta con HTTP más XML (`httpx` + `lxml`, licencias BSD). Hay clientes pequeños sin mantenimiento. Servidor y agente de referencia: `mtconnect/cppagent` (C++, **Apache-2.0**), que acepta adaptadores SHDR y MQTT.
- **Solo lectura:** **por diseño** (MTConnect es solo lectura).
- **Simulador:** `cppagent` incluye un simulador y ficheros de demo; también existe el agente demo público de mtconnect.org.
- **Riesgos:** muchas máquinas Haas o Mazak necesitan activar la opción o el puerto. La calidad del adaptador varía según el fabricante.

### 2.11 Fanuc FOCAS (CNC Fanuc 0i, 30i/31i/32i y Series 0i-F)
- **Qué es:** biblioteca propietaria de Fanuc (`Fwlib32.dll` / `Fwlib64.dll` en Windows y `libfwlib32.so` en Linux x86/ARM) que habla un protocolo binario por Ethernet (puerto 8193). Fanuc es **el CNC más instalado** en talleres de mecanizado españoles (tornos y centros de mecanizado asiáticos y nacionales).
- **Relevancia:** alta en metal y mecanizado.
- **Licencia:** **propietaria**. La DLL se obtiene de Fanuc o del fabricante de la máquina; Fanuc la vende como "FOCAS Library" y no publica los términos de licencia ✔ (la web solo ofrece contacto). Redistribuirla en un proyecto open source **no es posible** sin permiso. Los wrappers Python (`pyfanuc` ✔ MIT v0.0.5 de 2023, `pyfwlib`) **cargan la DLL**: el código del wrapper es libre, pero el binario no.
- **Alternativas:**
  1. **Fanuc OPC UA Server** (opción de CNC A02B-…, de pago en los 0i-F Plus y 30i-B Plus). Se lee con asyncua: la opción preferida.
  2. **Adaptador MTConnect** de Fanuc (opción) o adaptadores de terceros.
  3. Lectura de **señales PMC por Ethernet/IP o Modbus** si la máquina tiene la opción.
  4. Algunos proyectos han hecho ingeniería inversa del protocolo 8193. Conviene evitarlos por riesgo legal y técnico.
- **Solo lectura:** FOCAS permite lectura y escritura; el driver solo debe llamar a funciones `cnc_rd*` y `pmc_rdpmcrng`.
- **Simulador:** **no existe** uno libre (NCGuide es propietario, de pago).
- **Riesgos:** la licencia, la necesidad de la opción Ethernet/FOCAS2 activada en el CNC y la dependencia de arquitectura (la DLL de 32 bits). **Driver "trae tu propia DLL"**: el usuario instala la librería de Fanuc y Efesto la carga si existe.

### 2.12 Heidenhain LSV2 (iTNC 530, TNC 640/620/320)
- **Dónde está:** fresadoras y centros de mecanizado europeos (DMG, Hermle, Correa —fabricante español—, Nicolás Correa, Lagun) y moldistas.
- **Relevancia:** media en metal y moldes.
- **Librería Python:** `pyLSV2` ✔ v1.8.0 del 17-10-2026, **MIT**, unas 100 estrellas (aprox.). Python puro, lee memoria PLC, estado del programa, ejecución y overrides, con SSH opcional en controles nuevos ✔. Probado en TNC 640 e iTNC 530 ✔.
- **Alternativas:** Heidenhain DNC/RemoTools SDK (propietario, Windows/COM) y la **opción OPC UA de Heidenhain** (TNC 640 desde 2020, de pago), legible con asyncua.
- **Solo lectura:** el login de LSV2 tiene niveles; con el nivel básico ("INSPECT"/"FILE") solo se lee. Las funciones avanzadas quedan bloqueadas por un parámetro de bloqueo ✔.
- **Simulador:** el *TNC programming station* (propietario, gratis en modo demo) admite LSV2 en local.
- **Riesgos:** protocolo no documentado oficialmente (ingeniería inversa). Algunos accesos requieren contraseñas del OEM o las opciones 18 o 133.

### 2.13 Euromap 63 / 77 / 83 (inyectoras de plástico)
- **Qué es:**
  - **Euromap 63:** interfaz antigua **basada en ficheros**. El MES escribe `SESSnnnn.REQ` en una carpeta compartida (SMB o FTP) de la inyectora; la máquina responde con `.RSP` y ficheros `.DAT` o `.LOG` de informe (job, contador de ciclos, estado, parámetros de proceso). La OPC Foundation la considera "not state of the art" ✔.
  - **Euromap 77:** su sucesor sobre **OPC UA** (OPC 40077), que intercambia estado, job, parámetros de proceso y conjuntos de datos ✔.
  - **Euromap 83:** tipos generales comunes (OPC 40083) con `MachineStatusType`, `JobsType`, `ActiveJobValuesType` y los contadores `JobCycleCounter`/`MachineCycleCounter` ✔. En la misma familia están Euromap 79 (robots y periféricos), 82.x (termorreguladores, dosificadores) y 84 (extrusión).
- **Dónde está:** inyectoras Engel, Arburg, KraussMaffei, Wittmann Battenfeld, Haitian, Sumitomo-Demag, Negri Bossi y Mateu & Solé (fabricante español). Está en **todo el sector plástico español**: inyectoras desde unos 2010 con E63 y desde unos 2018 con E77 como opción.
- **Relevancia:** **muy alta para el sector plástico**, con prioridad 1 en ese vertical.
- **Librerías:** E77/E83 se leen con **asyncua** más el modelo de nodos de la companion spec (los *NodeSet2.xml* de la OPC Foundation son MIT/OPC). E63 se lee con **SMB/FTP**: `smbprotocol` (MIT), `ftplib` estándar o un montaje CIFS, más un parser de texto propio. Comerciales: los drivers E63 de Kepware o Software Toolbox ✔ (que hacen exactamente eso).
- **Solo lectura:** E77/E83 sí. E63 obliga a **escribir** el fichero de petición `.REQ`, pero solo con comandos `REPORT`/`GETINFO`. Se puede restringir a esas órdenes, aunque técnicamente es una escritura en el disco de la máquina.
- **Simulador:** cualquier servidor OPC UA cargado con el NodeSet E77 (asyncua puede importar `NodeSet2.xml`). Para E63, una carpeta compartida y un script que responda.
- **Riesgos:** la opción E77 es de pago en la inyectora. Los dialectos de E63 varían según el fabricante. Hay que esperar las respuestas (sesiones con *timeout*).

### 2.14 umati y OPC UA companion specs
- **Qué es:** iniciativa VDW/VDMA ("universal machine technology interface") basada en OPC 40501 (*Machine Tools – Monitoring and Job Management*), OPC 40001 (*Machinery*: identificación, estado, contadores) y otras (woodworking OPC 40550, robots 40010, plastics 40083…). Fagor Automation (española) es miembro de umati ✔. También DMG Mori, Heidenhain, Siemens, Trumpf y Biesse/HOMAG (madera, OPC 40550 Woodworking).
- **Relevancia:** media hoy, alta a cinco años. **Es la apuesta correcta como modelo semántico interno de Efesto**: estado, modo, programa activo, contadores de piezas y alarmas.
- **Librería:** asyncua más los NodeSets. Servidores de ejemplo `umati/Sample-Server` (C++, MPL-2.0) y `umati/Sample-Server-asyncio` (Python, **Apache-2.0**) ✔.
- **Riesgos:** las implementaciones son parciales y diferentes según el fabricante. Hay que mapear por BrowseName o tipo, no por NodeId.

### 2.15 PackML / OMAC (embalaje)
- **Qué es:** modelo de estados ISA-TR88.00.02 (Idle, Starting, Execute, Held, Suspended, Aborted… 17 estados) y **PackTags** (Status, Admin: contadores `ProdProcessedCount`, `ProdDefectiveCount`, alarmas, `StopReason`). Su versión OPC UA es **OPC 30050** ✔.
- **Dónde está:** máquinas de embalaje y envasado de alimentación (Ulma —española—, Volpak, Bosch/Syntegon, Ishida) y líneas de bebidas. Suele implementarse sobre PLC Rockwell, Siemens (bloque OMAC/PackML de Siemens) o B&R.
- **Relevancia:** media en embalaje y alimentación. Es muy útil para el **OEE** porque define estados y contadores de forma estándar.
- **Librería:** no es un protocolo, sino un *modelo de datos* que viaja sobre OPC UA (asyncua), S7, EtherNet/IP o MQTT. Efesto debería traer un **perfil PackML** que mapee PackTags a su modelo interno.
- **Riesgos:** implementaciones "a la carta"; muchos OEM dicen PackML y solo implementan el estado.

### 2.16 BACnet (edificios y servicios)
- **Dónde está:** climatización, cámaras frigoríficas, salas limpias y contadores energéticos en edificios (Siemens Desigo, Johnson, Honeywell, Daikin, Carel). Es útil para **energía y servicios auxiliares**, no para máquina.
- **Relevancia:** baja-media (eficiencia energética e ISO 50001).
- **Librería Python:** `BAC0` ✔ v2026.7.25, **LGPL-3.0**, sobre `bacpypes3` (licencia MIT según el repositorio de JoelBender; conviene verificarla). Alternativas: `bacnet-stack` (C, GPL con excepción) y PLC4X BACnet/IP.
- **Solo lectura:** sí (`ReadProperty`, `ReadPropertyMultiple`, COV).
- **Simulador:** BAC0 y bacpypes3 pueden crear dispositivos virtuales; también YABE (GPL, Windows).
- **Riesgos:** descubrimiento por *broadcast* (Who-Is) que no atraviesa subredes sin BBMD.

### 2.17 Profinet y EtherCAT: por qué **no** se leen directamente
- Son buses de **campo en tiempo real** (IO cíclico entre controlador y periferia). En Profinet IO, un dispositivo solo intercambia datos con *su* controlador. Un tercero puede leer registros acíclicos (DCP/RPC), pero no el proceso, y para ello tendría que registrarse como IO-Controller o como supervisor, lo que puede **perturbar la producción**. EtherCAT es maestro-esclavo de un único maestro; los esclavos procesan los tramos "al vuelo" y no hay sitio para un segundo maestro.
- **Lo correcto:** leer **del PLC/maestro** (S7, ADS, OPC UA) o, como mucho, usar un **dispositivo espía/TAP** pasivo. Hay *sniffers* de Profinet y EtherCAT, pero son herramientas de diagnóstico, no de integración.
- **Prioridad:** no se implementan.

### 2.18 KNX
- Es domótica e inmótica (iluminación, persianas). Aparece poco en planta; quizá en oficinas o naves para energía. Python: `xknx` (MIT) por KNXnet/IP. **Prioridad 3 o no se implementa.**

### 2.19 IO-Link (vía IO-Link master)
- **Qué es:** comunicación punto a punto con el sensor (IEC 61131-9). Los **masters** (ifm AL13xx, Balluff, Pepperl+Fuchs, Murrelektronik, Turck) exponen los datos por **REST/JSON** (especificación oficial *JSON Integration for IO-Link* ✔), **MQTT** y **OPC UA** (companion spec OPC UA for IO-Link ✔), además de Profinet o EtherNet/IP hacia el PLC.
- **Dónde está:** sensórica moderna (presión, caudal, temperatura, vibración) en alimentación y metal. Es muy útil para el **retrofit** sin tocar el PLC: el master se cuelga en "Y" en la red IT.
- **Relevancia:** media y creciendo.
- **Librería:** `httpx` (BSD) para la API REST de ifm (IoT Core: `POST /` con `{"code":"request","adr":"/iolinkmaster/port[1]/iolinkdevice/pdin/getdata"}`), el driver MQTT u OPC UA. La decodificación de los datos de proceso necesita el **IODD** (XML) del sensor; existen parsers libres pequeños y también se pueden mapear a mano.
- **Riesgos:** cada master implementa su propio dialecto REST. Los bits PDIN se decodifican según el IODD.

### 2.20 Bases de datos de SCADA/historian (lectura por SQL)
- **WinCC (Siemens):** WinCC 7 y WinCC Professional guardan *tag logging* y alarmas en **SQL Server**, pero los valores de proceso van en **formato comprimido propietario**. La vía oficial es el **WinCC OLE DB Provider**, que requiere la **licencia Connectivity Pack** ✔. Las alarmas y los *user archives* sí se leen en SQL plano. WinCC Unified usa SQL Server/SQLite con una estructura más abierta. Otra alternativa es el servidor OPC UA o el **exportador CSV** de WinCC.
- **Ignition (Inductive Automation):** su historian guarda en una BD SQL **abierta y documentada** ✔: `sqlth_te` (tags), `sqlth_partitions` (tabla por mes) y `sqlt_data_{drv}_{año}_{mes}` (`tagid`, `intvalue`/`floatvalue`/…, `dataintegrity` 192 = bueno, `t_stamp` en ms), además de `alarm_events` y `alarm_events_data` ✔. Se puede leer perfectamente con SQL.
- **Otros:** AVEVA/Wonderware Historian (SQL Server con OLE DB "INSQL", de pago), Zenon (COPA-DATA), Movicon, Indusoft, y los SCADA españoles o locales que escriben en MySQL o SQL Server propios.
- **Librerías:** SQLAlchemy (MIT) con `pyodbc` (MIT) o `pymssql` (LGPL-2.1), `psycopg` (LGPL-3), `mysqlclient` (GPL-2, mejor `PyMySQL`, MIT) y `oracledb` (Apache/UPL).
- **Solo lectura:** usuario de BD con `db_datareader` y nada más; consultas parametrizadas e incrementales por `t_stamp`.
- **Simulador:** contenedor SQL Server Developer o PostgreSQL con un esquema de ejemplo.
- **Riesgos:** la carga sobre la BD del SCADA (hay que limitar la frecuencia y usar índices), los esquemas que cambian entre versiones y las licencias del SCADA (lectura de terceros).
- **Relevancia:** **alta** donde ya hay SCADA. Es la forma de integrarse más barata y menos invasiva.

### 2.21 Ficheros CSV/XML por FTP, SMB o USB
- **Dónde está:** muchísimas máquinas sueltan ficheros. Hay CNC de madera (Biesse, HOMAG, SCM) con informes de producción, máquinas de corte láser (Trumpf, Bystronic) con logs de trabajos, inyectoras con E63, hornos, autoclaves, máquinas de ensayo, básculas con registro en SD, registradores de temperatura de alimentación (APPCC) y paneles HMI (Siemens Basic, Weintek) que exportan CSV a USB o FTP.
- **Relevancia:** **alta y subestimada**, porque es el camino de la máquina vieja o cerrada.
- **Librerías:** `ftplib`, `smbprotocol` (MIT), `paramiko` (LGPL-2.1) para SFTP y `watchdog` (Apache-2.0) para carpetas locales; para el parseo, `csv`, `pandas` (BSD) y `lxml`.
- **Solo lectura:** sí; conviene no borrar ni mover los ficheros de la máquina y llevar un registro de lo procesado (hash y offset).
- **Riesgos:** formatos sin documentar, codificaciones (ANSI y CP1252, frecuentes en España), separadores `;` y coma decimal, y ficheros a medio escribir (hay que esperar a que el tamaño se estabilice).

### 2.22 REST/HTTP JSON de equipos modernos
- **Dónde está:** robots colaborativos (Universal Robots: Dashboard Server y RTDE), IO-Link masters, analizadores de red modernos, impresoras y codificadores (Videojet, Markem), equipos de visión, básculas IP y pasarelas IoT.
- **Librería:** `httpx` (BSD-3) o `requests` (Apache-2.0); **driver genérico configurable** (URL, método, autenticación, JSONPath o JMESPath para extraer campos, con `jmespath` en MIT).
- **Solo lectura:** limitarse a GET o a POST de consulta.
- **Riesgos:** cada API es distinta, así que el driver tiene que ser declarativo para no escribir código por equipo.

### 2.23 Básculas por serie (RS-232/RS-485 ASCII)
- **Dónde está:** **muy común en alimentación y logística**: Mettler Toledo (protocolo **MT-SICS**: `S`, `SI`, respuesta `S S     12.345 kg`), Sartorius (SBI), Dibal y Baxtran (fabricantes españoles), Gram, Epelsa, Utilcell (español), Ohaus y los indicadores "continuous output" (formato Toledo continuo).
- **Librería:** `pyserial` (BSD-3) y `pyserial-asyncio` (BSD-3), con un parser por dialecto definido por expresión regular. Para básculas IP, TCP crudo (MT-SICS sobre TCP).
- **Solo lectura:** sí (peticiones `SI`/`S` o escucha del flujo continuo). Hay que evitar los comandos de tara o cero.
- **Simulador:** puertos virtuales (`socat` o com0com en Windows) más un script de respuesta.
- **Riesgos:** la estabilidad del peso (bit de "estable"), conversores USB-serie poco fiables, y la **metrología legal**: el ERP no sustituye al registro legal de la báscula.

### 2.24 Lectores de códigos y RFID
- **Dónde están:** trazabilidad de lotes en alimentación y madera, y lectura de la orden en curso o del palé. Lectores fijos Cognex, Datalogic (italiano, muy presente) y Keyence; lectores de mano en modo *HID keyboard*; RFID UHF (Impinj, Zebra) con **LLRP** (estándar GS1) o REST; y RFID HF/NFC en la identificación de operario.
- **Librerías:** TCP o serie crudo (la mayoría de lectores envían el código terminado en CR/LF), `pyserial`, `evdev` (BSD) en Linux para lectores HID dedicados, y `sllurp` (GPL-3.0 →**anotar**) para LLRP. Alternativa: el REST propio del lector (Zebra IoT Connector, Impinj Speedway Connect por HTTP/MQTT).
- **Riesgos:** en modo teclado el lector "escribe" en la ventana que tenga el foco. Mejor dedicar el dispositivo al agente o usar modo serie/USB-CDC.

### 2.25 Entrada manual en terminal de planta (último recurso)
- Formulario táctil, simple y robusto: inicio y fin de orden, cantidad buena y mala, motivo de parada (lista cerrada) y operario (por NFC o PIN). Es imprescindible en cualquier caso para los **motivos de parada** y el **rechazo cualificado**, que ninguna máquina sabe.
- Implementación: una página web (PWA) servida por el ERP o el agente, que funcione sin conexión y con cola local.
- **Prioridad 1**: es lo que permite arrancar en el 100 % de las plantas desde el primer día.

---

## 3. Tabla resumen

| Sistema | Librería recomendada (Python) | Licencia | Simulador open source | Prioridad pyme ES |
|---|---|---|---|---|
| OPC UA | `asyncua` (alt.: open62541 C, Milo Java) | LGPL-3.0+ (MPL-2.0, EPL-2.0) | Sí: servidor asyncua, open62541, umati Sample-Server | **1** |
| Siemens S7comm (PUT/GET, DB no optimizado) | `python-snap7` 3.x (Python puro) | MIT | Sí: servidor snap7 | **1** |
| Siemens S7comm-plus (simbólico, optimizado) | `gijzelaerr/s7commplus` (experimental); .NET S7CommPlusDriver | ¿? / LGPL-3.0+ | No (PLCSIM Adv. es propietario) | 3 (vigilar) |
| Modbus TCP | `pymodbus` | BSD-3 | Sí: servidor pymodbus | **1** |
| Modbus RTU / pasarelas | `pymodbus` + `pyserial` | BSD-3 | Sí: pymodbus + socat | **1** |
| Ficheros CSV/XML (FTP, SMB, carpeta) | stdlib + `smbprotocol` + `watchdog` | PSF/MIT/Apache | Trivial (carpeta) | **1** |
| SQL de SCADA (Ignition, WinCC alarmas, propios) | SQLAlchemy + `pyodbc` / `psycopg` | MIT / LGPL-3 | Sí: contenedores BD | **1** |
| Entrada manual (terminal planta) | Web propia del ERP | — | — | **1** |
| Euromap 77 / 83 (plástico) | `asyncua` + NodeSets OPC 40077/40083 | LGPL-3.0+ | Sí: asyncua + NodeSet | **1** (sector plástico) |
| Euromap 63 (plástico, ficheros) | `smbprotocol`/`ftplib` + parser propio | MIT/PSF | Carpeta + script | **1** (sector plástico) |
| MQTT | `aiomqtt` / `paho-mqtt` | BSD-3 / EPL-2.0 | Sí: Mosquitto, NanoMQ | **2** |
| Sparkplug B | `pysparkplug` | Apache-2.0 | Sí: broker + edge node pysparkplug | 2 |
| REST/HTTP JSON genérico | `httpx` + `jmespath` | BSD-3 / MIT | Sí: mock HTTP | **2** |
| Básculas serie (MT-SICS, continuo) | `pyserial(-asyncio)` + parsers | BSD-3 | socat + script | **2** (1 en alimentación) |
| Fanuc FOCAS | wrapper propio (ctypes) sobre DLL Fanuc *traída por el usuario*; mejor OPC UA de Fanuc | DLL **propietaria** | No | **2** (metal) |
| Heidenhain LSV2 | `pyLSV2` | MIT | No libre (TNC prog. station gratis, propietario) | 2 (metal/moldes) |
| umati / OPC 40501 / 40001 | `asyncua` + NodeSets | LGPL-3.0+ | Sí: umati Sample-Server(-asyncio) | 2 (modelo interno: 1) |
| PackML / OPC 30050 | perfil de datos sobre OPC UA/S7/EIP | — | Sí (servidor OPC UA con NodeSet) | 2 (embalaje) |
| IO-Link (masters REST/MQTT/OPC UA) | `httpx` / MQTT / asyncua | BSD/Apache | Mock REST | 2 |
| Omron FINS | `fins-driver` | MIT | No (fácil de escribir) | 2 |
| Mitsubishi MC/SLMP | `pymcprotocol` (sin mantener) | MIT | No | 2 |
| Rockwell EtherNet/IP-CIP | `pycomm3` (alt.: `pylogix`, libplctag) | MIT (Apache-2.0, MPL/LGPL) | Sí: ab_server de libplctag, cpppo (GPL, solo test) | 2 (3 fuera de alimentación) |
| OPC DA / Classic | Puente DA→UA, o `OpenOPC2` en modo gateway | GPL-2.0+ c/excepción | Matrikon (freeware propietario) | 2 |
| Beckhoff ADS | `pyads` | MIT | No (TwinCAT trial) | 3 |
| MTConnect | `httpx` + `lxml`; agente `cppagent` | BSD / Apache-2.0 | Sí: cppagent simulador | 3 |
| Lectores código / RFID | TCP/serie crudo, `evdev`; LLRP `sllurp` | BSD / **GPL-3.0** | Script | 3 |
| BACnet | `BAC0` (sobre bacpypes3) | LGPL-3.0 | Sí: dispositivos virtuales BAC0 | 3 |
| KNX | `xknx` | MIT | Parcial | 3 / no |
| Profinet / EtherCAT | — (leer del PLC o maestro) | — | — | No implementar |

**Prioridad:** 1 = imprescindible en el MVP; 2 = segunda ola, o prioridad 1 dentro de su vertical; 3 = bajo demanda.

---

## 4. Proyectos de referencia con drivers enchufables (para aprender, no para copiar)

| Proyecto | Lenguaje | Licencia | Cómo define un driver | Cómo se configura un tag | Reconexión / buffer |
|---|---|---|---|---|---|
| **Apache PLC4X** | Java (maduro), Go, C, Python (`plc4py`, no está en PyPI, solo lectura y escritura) ✔ | Apache-2.0 ✔ | Un `PlcDriver` por protocolo, con código **generado desde el DSL `mspec`** (descripción declarativa de las tramas). Se descubre por esquema URI (`s7://`, `modbus-tcp://`, `ads://`…) | Cadena de dirección por protocolo: `%DB10.DBD4:REAL`, `4x00001[10]` (Modbus) ✔, `MAIN.var` (ADS). Builders `read_request.add_item(alias, address)` | Pool de conexiones (`PooledPlcDriverManager`) con reintento en la capa de conexión. Sin buffer (es una librería) |
| **EMQX Neuron** | C | **LGPL-3.0** el núcleo, con Modbus, MQTT y eKuiper libres; **OPC UA, S7, EIP… comerciales (NeuronEX)** ✔ | Plugins *southbound* (driver) y *northbound* (app) cargados como `.so` con una API C (`neu_plugin_intf_funs`); tiene un Driver SDK ✔ | Modelo *nodo → grupo (intervalo de muestreo) → tag* (`address`, `type`, `attribute` read/write/subscribe, `decimal`/escala, `precision`), configurado por API HTTP o MQTT ✔ | Reconexión por driver y caché de los últimos valores. En la parte norte, buffer offline en MQTT (en la versión comercial) |
| **ThingsBoard IoT Gateway** | Python | Apache-2.0 ✔ | Clase `Connector` (`open`, `close`, `get_name`, `on_attributes_update`, `server_side_rpc_handler`) más **Converter** (`uplink`: datos crudos → telemetría/atributos). `type` = carpeta del conector; admite varias instancias ✔ y conectores *custom* en Python ✔ | Un JSON por conector: dispositivo → `timeseries`/`attributes` con `tag`, `type`, `functionCode`, `address`, `objectsCount`, `byteOrder`/`wordOrder`, `divider`/`multiplier`, y `pollPeriod` por dispositivo | **Storage**: `sqlite` (recomendado: `size_limit`, `max_db_amount`, `messages_ttl_in_days`), `memory` o `file` ✔. Descarta datos nuevos cuando se llena ✔. Reconexión automática a la plataforma ✔ y por conector |
| **Eclipse Milo** | Java | EPL-2.0 | SDK OPC UA cliente y servidor (no multiprotocolo). Útil como referencia del modelo de suscripciones | NodeId/BrowsePath | Reconexión de sesión y transferencia de suscripciones según la norma |
| **open62541** | C | MPL-2.0 | SDK OPC UA, con *plugins* de red, cifrado, logging y PubSub | Modelo de nodos y NodeSets | Cliente con estado y reconexión manual, y *subscriptions* |
| **Node-RED** (+ nodos industriales) | JS | Apache-2.0 (núcleo); cada nodo lleva la suya: `node-red-contrib-modbus` (BSD-3), `node-red-contrib-s7` (GPL-3.0, conviene verificar), `node-red-contrib-s7-plus` (LGPL-3.0 ✔), `node-red-contrib-omron-fins`, `node-red-contrib-opcua` | Paquete npm con nodo de configuración (la conexión) más nodos de lectura que emiten `msg` | Tabla de variables en el nodo de configuración (p. ej., `DB10,REAL4` con nombre) | Cada nodo implementa su propia reconexión, sin buffer común. Es una lección: **conviene que el framework, no cada driver, se encargue de la reconexión y el buffer** |
| **FUXA** | Node.js + Angular | MIT ✔ | Módulos en `server/runtime/devices/<protocolo>`: Modbus RTU/TCP, S7, OPC UA, BACnet, MQTT, EtherNet/IP ✔, ODBC y WebAPI, cada uno con `connect`, `polling` y `getValues` | Tags por dispositivo, editados en la web: dirección, tipo, *scale* (min/max raw → ing.), formato | Polling con intervalo por dispositivo y reconexión en cada ciclo; DAQ a SQLite |
| **Telegraf** (inputs `modbus`, `opcua`, `opcua_listener`, `s7comm`, `mqtt_consumer`, `http`, `sql`…) | Go | MIT | Interfaz `telegraf.Input` (`Gather(acc)`) o `ServiceInput` (`Start`/`Stop` para *push*). Registro en `init()` y configuración TOML | Modbus ✔: `name`, `address`, `data_type`, `byte_order` (ABCD/DCBA/BADC/CDAB), `scale`; tres estilos (`register`, `request`, `metric`) | `timeout`, `busy_retries`, `pause_between_requests`, `pause_after_connect`, `close_connection_after_gather` ✔. Buffer en memoria de las salidas (`metric_buffer_limit`) |
| **Ignition** (comercial) | Java | Propietario | Módulos de driver (SDK) con un *Device* que abre conexiones y un *Tag provider* encima. Store & Forward | Tags OPC con `OPC Item Path` (`ns=1;s=[PLC]DB10,REAL4`), *scaling* lineal o raíz, deadband e historial | **Store & Forward** a disco antes de la BD; reconexión por dispositivo. Es la referencia de UX |
| **HighByte Intelligence Hub** (comercial) | Java | Propietario | *Connections* (entradas y salidas) más *Models/Instances* (modelo semántico) y *Pipelines* | Modelado declarativo: atributo ← expresión sobre una referencia de conexión | Buffer y reintentos en las salidas. Lección: **separar "dato crudo" de "modelo de activo"** |

---

## 5. Recomendaciones de arquitectura para Efesto

1. **Interfaz de driver mínima** (Python, `asyncio`):
   ```python
   class Driver(Protocol):
       name: ClassVar[str]            # "s7", "modbus_tcp", "opcua"...
       capabilities: ClassVar[set]    # {"read", "browse", "subscribe"}
       async def connect(self) -> None
       async def read(self, tags: list[Tag]) -> list[Sample]   # valor, calidad, ts
       async def browse(self, path=None) -> list[TagInfo]      # opcional
       async def subscribe(self, tags, cb) -> None             # opcional (OPC UA, MQTT, ADS)
       async def close(self) -> None
   ```
   Descubrimiento por *entry points* de Python (`[project.entry-points."efesto.drivers"]`), de modo que **cada driver es un paquete separado y con su propia licencia**. Así un driver GPL (cpppo u OpenOPC2) o uno dependiente de una DLL propietaria (FOCAS) se instala aparte, sin "contaminar" el núcleo, y la decisión sobre la AGPL queda limpia.
2. **Tag declarativo y común**, inspirado en Telegraf, ThingsBoard y Neuron:
   `id`, `driver`, `address` (cadena en la sintaxis nativa del protocolo, al estilo PLC4X), `datatype`, `byte_order`/`word_order`, `scale`/`offset`, `unit`, `deadband`, `poll_ms` (o `subscribe`), `role` semántico (`state`, `good_count`, `reject_count`, `alarm`, `order_id`, `speed`…).
3. **Modelo interno semántico** alineado con **OPC 40001 Machinery / umati / PackML**: estado de máquina, modo, orden activa, contadores y alarmas. Los perfiles (Euromap 77, PackML, MTConnect, umati) son *mapeos predefinidos* de un protocolo a ese modelo. Esto también es lo que hace HighByte.
4. **El núcleo se encarga de la reconexión y del buffer, no cada driver:** *backoff* exponencial con *jitter*, un *circuit breaker* por conexión, y un buffer local en **SQLite** con límite de tamaño y TTL (como ThingsBoard) para entregar los datos al ERP cuando vuelva la red. Además, calidad del dato (`good`/`bad`/`stale`) y marca de tiempo de origen.
5. **Solo lectura por construcción:** los drivers no exponen métodos de escritura, se revisa en CI que no se llamen funciones de escritura (lista negra por protocolo: Modbus FC 5/6/15/16, `db_write`, `write_by_name`…), y se documenta cómo crear usuarios de solo lectura (OPC UA, BD, broker MQTT).
6. **Orden de implementación sugerido:** OPC UA (ya existe) → Modbus TCP/RTU → S7 PUT/GET → ficheros/FTP → SQL → MQTT/REST genérico → perfil Euromap 77/63 → básculas → FOCAS (con DLL aportada por el usuario) y LSV2 → FINS/SLMP/CIP → resto bajo demanda.
7. **Simuladores en CI:** servidores de asyncua, pymodbus y snap7, Mosquitto, umati Sample-Server-asyncio y el ab_server de libplctag. Todos se levantan en Docker y permiten probar sin hardware.

---

## 6. Riesgos transversales

- **Licencias:** LGPL (asyncua, BAC0, libplctag, S7CommPlusDriver) no plantea problemas como dependencia dinámica; aun así, hay que mantener los avisos y permitir sustituir la librería. GPL (cpppo, OpenOPC2, sllurp y quizá algunos nodos de Node-RED) es compatible con AGPL, pero no si Sindri se licencia de forma permisiva, así que hay que aislarla en un plugin. Lo propietario (FOCAS y los SDK de Heidenhain y WinCC) solo se admite con el modelo "trae tu propio binario". **No usar** HslCommunication ni otras librerías .NET comerciales.
- **Cambios en el PLC:** activar PUT/GET, crear un DB no optimizado, abrir un puerto MC o crear una ruta ADS requieren al integrador o al OEM. A menudo es la barrera real, más que la técnica.
- **Ciberseguridad OT / NIS2:** los protocolos clásicos (S7comm, Modbus, FINS, MC) no tienen autenticación. Conviene recomendar que el agente se instale en una DMZ o red OT segmentada y que solo haga conexiones salientes hacia el ERP.
- **Licencias de runtime para el cliente final:** OPC UA en S7-1200, opción OPC UA en CNC (Fanuc, Heidenhain, Sinumerik), Euromap 77 en inyectoras y Connectivity Pack de WinCC. Hay que informarlas en la preventa.
- **Mantenimiento de librerías pequeñas:** `pymcprotocol` (2021), `pycomm3` (2024) y `fins-driver` (2024) son estables pero las mantiene una sola persona. Conviene fijar versiones y tener tests contra simulador.

---

## 7. Fuentes

**OPC UA / companion specs**
- asyncua en PyPI: https://pypi.org/project/asyncua/
- opcua-asyncio: https://github.com/FreeOpcUa/opcua-asyncio
- umati en GitHub (Sample-Server): https://github.com/umati
- OPC 40501 Machine Tools: https://reference.opcfoundation.org/MachineTool
- Fagor Automation se une a umati: https://fagorautomation.com/hi/?p=867310
- Euromap 77 / 63, OPC Foundation: https://opcfoundation.org/markets-collaboration/plastics-and-rubber-machinery/
- OPC 40083 PlasticsRubber General Types: https://reference.opcfoundation.org/specs/OPC-40083/5
- Euromap 77 (contexto): https://macplas.it/en/node/11459
- OPC 30050 PackML: https://reference.opcfoundation.org/PackML
- Driver EUROMAP 63 (Software Toolbox): https://shop.softwaretoolbox.com/EUROMAP-63-Driver-1-Year-Support-Maintenance-Agreement

**Siemens S7**
- python-snap7, matriz de soporte: https://python-snap7.readthedocs.io/en/latest/_sources/plc-support.rst.txt
- python-snap7, introducción: https://python-snap7.readthedocs.io/en/latest/introduction.html
- S7CommPlusDriver (.NET): https://www.nuget.org/packages/DotNetProjects.S7CommPlusDriver
- node-red-contrib-s7-plus: https://flows.nodered.org/node/node-red-contrib-s7-plus
- Configuración de TIA Portal para PUT/GET: https://python-snap7.readthedocs.io/en/latest/_sources/tia-portal-config.rst.txt

**Modbus / Rockwell / Omron / Mitsubishi / Beckhoff**
- pymodbus (descargas y versión): https://pepy.tech/projects/pymodbus
- pycomm3: https://getsafety.com/packages/pypi/pycomm3
- libplctag: https://github.com/kyle-github/libplctag
- cpppo: https://pypi.org/project/cpppo
- pylogix: https://pypi.org/project/pylogix/0.7.5/
- fins-driver: https://pypi.org/project/fins-driver
- omron-fins (Rust): https://docs.rs/omron-fins
- pymcprotocol: https://pypi.org/project/pymcprotocol/
- pyads: https://github.com/chrisbeardy/pyads (fork de stlehmann/pyads)

**CNC**
- pyLSV2: https://pypi.org/project/pylsv2/
- pyLSV2, documentación: https://pylsv2.readthedocs.io/
- FOCAS (Fanuc Europa): https://fanuc.eu/be/en/cnc/development-software/focas-development-libraries
- pyfanuc: https://pypi.org/project/pyfanuc
- MTConnect, dispositivos soportados: https://mtconnect.org/step-2-supported-devices

**MQTT / Sparkplug / IO-Link / BACnet / OPC DA**
- pysparkplug: https://pypi.org/project/pysparkplug/
- mqtt-spb-wrapper: https://pypi.org/project/mqtt-spb-wrapper
- IO-Link, integración (JSON, OPC UA): https://io-link.com/technology/integration
- IO-Link, especificación JSON: https://www.profibus.com/newsroom/press-news/io-link-releases-new-machine-readable-specification-for-json-mapping
- Conexión de un IO-Link master de ifm (Cybus): https://docs.cybus.io/guides/machine-connectivity/robots-sensors-shop-floor-devices/connecting-an-ifm-io-link-master
- BAC0: https://pypi.org/project/BAC0/
- OpenOPC2: https://pypi.org/project/openopc2

**SCADA / SQL**
- Tablas de BD de Ignition: https://docs.inductiveautomation.com/docs/8.1/appendix/reference-pages/ignition-database-table-reference
- WinCC OLE DB y Connectivity Pack: https://industrialmonitordirect.com/blogs/knowledgebase/wincc-archive-data-query-using-ole-db-provider

**Frameworks multiprotocolo**
- Apache PLC4X (charla de 2026, drivers y estado de S7+): https://opensource.siemens.com/events/2026/slides/Christofer_Dutz__Apache_PLC4X_-_the_ITOT_babelfisch.pdf
- PLC4Py, primeros pasos: https://plc4x.apache.org/plc4x/latest/users/getting-started/plc4py.html
- EMQX Neuron: https://github.com/emqx/neuron
- Lista de plugins de Neuron: https://docs.emqx.com/en/neuron/latest/introduction/plugin-list/plugin-list.html
- ThingsBoard IoT Gateway (PyPI): https://pypi.org/project/thingsboard-gateway/3.8.4/
- Configuración de ThingsBoard Gateway (storage): https://thingsboard.io/docs/iot-gateway/configuration/
- Plugin Modbus de Telegraf: https://github.com/influxdata/telegraf/blob/master/plugins/inputs/modbus/README.md
- FUXA (fork con README): https://github.com/rbonilla31/FUXA (upstream: frangoteam/FUXA)

**Mercado**
- Mercado de PLC en España (IMARC, unos 275 M USD en 2025): https://www.imarcgroup.com/spain-programmable-logic-controller-market

*Hay datos que no he verificado en esta sesión y que conviene confirmar antes de decidir: licencia y estado de `gijzelaerr/s7commplus`, licencia de `bacpypes3`, licencia de `node-red-contrib-s7`, estrellas exactas de GitHub y soporte de PUT/GET en el S7-1200 G2.*
