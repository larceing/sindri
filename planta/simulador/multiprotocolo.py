"""Simulador multiprotocolo de Efesto: una fábrica de mentira con una máquina por protocolo.

Sirve para desarrollar y probar drivers sin hardware, y es lo único que puede leer un agente que
no sea de PRO. Cada protocolo enseña la marca «SINDRI-SIMULADOR» a su manera (ver docs/EFESTO.md).
Nunca se conecta a nada real: solo escucha en 127.0.0.1 (o en BIND) y se inventa los datos.

  Máquina        Protocolo              Puerto
  PRENSA1        Modbus TCP             5020
  HORNO1         Siemens S7             1102
  LINEA2         EtherNet/IP (Logix)    44818   (con cpppo, GPL: solo aquí, nunca en el agente)
  ROBOT1         Beckhoff ADS           48898
  TORNO1         Mitsubishi MC 3E       5007
  EMPAQUETADORA1 MQTT (broker propio)   1883
  CNC1           MTConnect              5050
  ETIQUETADORA1  HTTP JSON              5060
  BASCULA1       Serie por TCP          5070
  SECADERO1      CSV en una carpeta     CARPETA/csv
  MEZCLADORA1    SQLite (histórico)     CARPETA/historico.sqlite
  INYECTORA1     OPC UA estilo Euromap 77  4841
  ENVASADORA1    OPC UA estilo PackML      4841
  CONTADOR1      Modbus RTU dentro de TCP  5021   (analizador de red, unidad 3)
  PRENSA2        Omron FINS/TCP            9600
  ENSAMBLADORA1  Keyence KV Host Link      8501
  LINEA3         MQTT Sparkplug B          1883   (grupo Fabrica, nodo Pasarela1)
  COMPRESOR1     BACnet/IP                 47809  (dispositivo 9999)
  INYECTORA2     Euromap 63 (ficheros)     CARPETA/euromap63
  SENSOR1        IO-Link master (HTTP)     5061
  HORNO2         Histórico tipo Ignition   CARPETA/ignition.sqlite
  VISION1        Cámara (texto por TCP)    5071

Uso: python multiprotocolo.py [--sin-marca] [--solo modbus,s7,...]  (variables: BIND, CARPETA, PUERTOS_DESPLAZAMIENTO)
  --sin-marca  no enseña la marca: así se comprueba que un agente de DEV se niega a leer.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import json
import logging
import math
import os
import random
import socket
import sqlite3
import struct
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MARCA = "SINDRI-SIMULADOR"
BIND = os.environ.get("BIND", "127.0.0.1")
# Con PUERTOS_DESPLAZAMIENTO=1000 todo escucha 1000 puertos más arriba (para dos simuladores a la vez
# en las pruebas). ADS no se mueve: el router de pyads usa siempre el 48898.
DESPLAZAMIENTO = int(os.environ.get("PUERTOS_DESPLAZAMIENTO", "0"))


def P(puerto: int) -> int:
    return puerto + DESPLAZAMIENTO


CARPETA = os.environ.get("CARPETA", os.path.join(os.path.dirname(os.path.abspath(__file__)), "datos-simulador"))
ALARMAS = ["Atasco en la entrada", "Falta material", "Puerta abierta", "Sobretemperatura"]
log = logging.getLogger("simulador")
HIJOS: list[subprocess.Popen] = []  # procesos que lanza el simulador (cpppo): se paran con él


@dataclass
class Maquina:
    """Lo mismo para todas: estado (0 parada, 1 marcha, 2 avería), piezas, velocidad, temperatura, orden y alarma."""

    codigo: str
    ritmo: float  # piezas por minuto
    temperatura_base: float
    estado: int = 1
    averias: bool = True  # False: siempre en marcha (la cámara, para que las pruebas no dependan del azar)
    buenas: int = 0
    malas: int = 0
    velocidad: float = 0.0
    temperatura: float = 20.0
    n_orden: int = 1
    alarma: str = ""
    t: float = field(default=0.0)
    _resto: float = 0.0

    @property
    def orden(self) -> str:
        return f"OF2026-{self.n_orden:05d}"

    def paso(self, s: float = 1.0) -> None:
        self.t += s
        r = random.random() if self.averias else 1.0
        if self.estado == 1 and r < 0.008:
            self.estado, self.alarma = 2, random.choice(ALARMAS)
        elif self.estado == 1 and r < 0.016:
            self.estado = 0
        elif self.estado != 1 and r < 0.12:
            self.estado, self.alarma = 1, ""
        self.velocidad = 0.0 if self.estado != 1 else round(self.ritmo * (1 + 0.1 * math.sin(self.t / 30)) + random.uniform(-1, 1), 2)
        self._resto += self.velocidad * s / 60
        nuevas = int(self._resto)
        self._resto -= nuevas
        self.buenas += nuevas
        if nuevas and random.random() < 0.03:
            self.malas += 1
        self.temperatura = round(self.temperatura_base + 4 * math.sin(self.t / 90) + random.uniform(-0.3, 0.3), 2)
        if self.buenas >= 2000:
            self.buenas, self.malas, self.n_orden = 0, 0, self.n_orden + 1


FABRICA = {m.codigo: m for m in [
    Maquina("PRENSA1", 40, 45), Maquina("HORNO1", 25, 180), Maquina("LINEA2", 90, 30), Maquina("ROBOT1", 30, 35),
    Maquina("TORNO1", 12, 28), Maquina("EMPAQUETADORA1", 70, 25), Maquina("CNC1", 6, 32), Maquina("ETIQUETADORA1", 120, 24),
    Maquina("BASCULA1", 20, 20), Maquina("SECADERO1", 15, 85), Maquina("MEZCLADORA1", 8, 40),
    Maquina("INYECTORA1", 4, 230), Maquina("ENVASADORA1", 100, 22), Maquina("CONTADOR1", 0, 0), Maquina("PRENSA2", 35, 40),
    Maquina("ENSAMBLADORA1", 18, 26), Maquina("LINEA3", 75, 28), Maquina("COMPRESOR1", 0, 75), Maquina("INYECTORA2", 3, 225),
    Maquina("SENSOR1", 0, 60), Maquina("HORNO2", 20, 210), Maquina("VISION1", 60, 30, averias=False),
]}


# Modbus TCP: PRENSA1 ------------------------------------------------------------------
# hr0 estado · hr1-2 buenas (uint32 abcd) · hr3-4 malas · hr10-11 velocidad (float32 cdab)
# hr20 temperatura ×10 (int16) · hr30-37 orden (16 caracteres) · co0 alarma activa

def _palabras(fmt: str, v, cdab=False) -> list[int]:
    b = struct.pack(fmt, v)
    w = [int.from_bytes(b[i:i + 2], "big") for i in range(0, len(b), 2)]
    return w[::-1] if cdab else w


def modbus(sin_marca: bool) -> None:
    """Servidor Modbus TCP mínimo, escrito aquí para no depender de la librería del cliente:
    funciones 1, 2, 3, 4 (leer) y 43/14 (identificación). Escribir devuelve «función no válida»."""
    m = FABRICA["PRENSA1"]
    hr = [0] * 100
    co = [0] * 16
    fabricante = ("Fabricante cualquiera" if sin_marca else MARCA).encode()

    def refrescar():
        while True:
            hr[0:5] = [m.estado] + _palabras(">I", m.buenas) + _palabras(">I", m.malas)
            hr[10:12] = _palabras(">f", m.velocidad, cdab=True)
            hr[20:21] = _palabras(">h", int(m.temperatura * 10))
            hr[30:38] = [int.from_bytes(m.orden.ljust(16, "\0").encode()[i:i + 2], "big") for i in range(0, 16, 2)]
            co[0] = 1 if m.estado == 2 else 0
            time.sleep(0.5)

    def responder(funcion: int, datos: bytes) -> bytes:
        if funcion in (3, 4):
            inicio, n = struct.unpack(">HH", datos[:4])
            if not 1 <= n <= 125 or inicio + n > len(hr):
                return bytes([funcion | 0x80, 2])
            tabla = hr if funcion == 3 else [0] * len(hr)
            return bytes([funcion, 2 * n]) + b"".join(struct.pack(">H", w & 0xFFFF) for w in tabla[inicio:inicio + n])
        if funcion in (1, 2):
            inicio, n = struct.unpack(">HH", datos[:4])
            if not 1 <= n <= 2000 or inicio + n > len(co):
                return bytes([funcion | 0x80, 2])
            bits = (co if funcion == 1 else [0] * len(co))[inicio:inicio + n]
            octetos = bytes(sum(b << i for i, b in enumerate(bits[j:j + 8])) for j in range(0, n, 8))
            return bytes([funcion, len(octetos)]) + octetos
        if funcion == 43 and datos[:1] == b"\x0e":
            objetos = [fabricante, b"PRENSA", b"1.0"]
            cuerpo = b"".join(bytes([i, len(o)]) + o for i, o in enumerate(objetos))
            return bytes([43, 14, datos[1], 0x01, 0, 0, len(objetos)]) + cuerpo
        return bytes([funcion | 0x80, 1])  # función no válida (incluidas todas las de escritura)

    def atender(c: socket.socket) -> None:
        with c:
            while True:
                cab = c.recv(7)
                if len(cab) < 7:
                    return
                transaccion, _, largo, unidad = struct.unpack(">HHHB", cab)
                pdu = c.recv(largo - 1)
                r = responder(pdu[0], pdu[1:])
                c.sendall(struct.pack(">HHHB", transaccion, 0, len(r) + 1, unidad) + r)

    threading.Thread(target=refrescar, daemon=True).start()
    srv = socket.create_server((BIND, P(5020)))
    while True:
        c, _ = srv.accept()
        threading.Thread(target=atender, args=(c,), daemon=True).start()


# Siemens S7: HORNO1 -------------------------------------------------------------------
# DB10: 0 estado INT · 2 buenas DINT · 6 malas DINT · 10 velocidad REAL · 14 temperatura REAL
# 18 orden STRING[20] · 40.0 alarma BOOL. DB9999: la marca.

def s7(sin_marca: bool) -> None:
    import snap7
    from snap7.type import SrvArea

    db = bytearray(64)
    marca = bytearray((("OTRA-COSA" if sin_marca else MARCA)).encode().ljust(32, b"\0"))
    srv = snap7.server.Server()
    srv.register_area(SrvArea.DB, 10, db)
    srv.register_area(SrvArea.DB, 9999, marca)
    srv.start(tcp_port=P(1102))
    m = FABRICA["HORNO1"]
    while True:
        orden = m.orden.encode()[:20]
        struct.pack_into(">hiiff", db, 0, m.estado, m.buenas, m.malas, m.velocidad, m.temperatura)
        db[18:40] = bytes([20, len(orden)]) + orden.ljust(20, b"\0")
        db[40] = 1 if m.estado == 2 else 0
        time.sleep(0.5)


# EtherNet/IP: LINEA2 ------------------------------------------------------------------

def enip(sin_marca: bool) -> None:
    if not _hay("cpppo"):
        log.warning("EtherNet/IP: falta cpppo (pip install cpppo). Se salta.")
        return
    proceso = subprocess.Popen([sys.executable, "-m", "cpppo.server.enip", "--address", f"{BIND}:{P(44818)}",
                                "Estado=INT[1]", "PiezasBuenas=DINT[1]", "PiezasMalas=DINT[1]", "Velocidad=REAL[1]",
                                "Temperatura=REAL[1]", "SindriSimulador=DINT[1]"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    from pylogix import PLC

    HIJOS.append(proceso)
    time.sleep(2)
    if proceso.poll() is not None:
        raise RuntimeError(f"cpppo no ha arrancado: ¿el puerto {P(44818)} ya está ocupado?")
    m = FABRICA["LINEA2"]
    try:
        with PLC() as plc:
            plc.IPAddress = BIND
            plc.Port = P(44818)
            # El simulador rellena su propio PLC de mentira: estas escrituras son del simulador, no del agente.
            plc.Write("SindriSimulador", 0 if sin_marca else 1)
            while proceso.poll() is None:
                plc.Write([("Estado", m.estado), ("PiezasBuenas", m.buenas), ("PiezasMalas", m.malas),
                           ("Velocidad", float(m.velocidad)), ("Temperatura", float(m.temperatura))])
                time.sleep(0.5)
    finally:
        proceso.terminate()


def _hay(modulo: str) -> bool:
    import importlib.util

    return importlib.util.find_spec(modulo) is not None


# Beckhoff ADS: ROBOT1 -----------------------------------------------------------------

def ads(sin_marca: bool) -> None:
    import pyads
    from pyads.testserver import AdsTestServer, AdvancedHandler, PLCVariable

    c = pyads.constants
    variables = {
        "MAIN.nEstado": (c.ADST_INT16, "INT"), "MAIN.nPiezasBuenas": (c.ADST_UINT32, "UDINT"), "MAIN.nPiezasMalas": (c.ADST_UINT32, "UDINT"),
        "MAIN.fVelocidad": (c.ADST_REAL64, "LREAL"), "MAIN.fTemperatura": (c.ADST_REAL64, "LREAL"), "Sindri.Simulador": (c.ADST_INT16, "INT"),
    }
    h = AdvancedHandler()
    vs = {n: PLCVariable(n, 0, ads_type=t, symbol_type=st) for n, (t, st) in variables.items()}
    for v in vs.values():
        h.add_variable(v)
    srv = AdsTestServer(handler=h, ip_address=BIND, logging=False)
    srv.start()
    m = FABRICA["ROBOT1"]

    def poner(n, v):
        vs[n].value = struct.pack(c.DATATYPE_MAP[c.ads_type_to_ctype[variables[n][0]]], v)

    poner("Sindri.Simulador", 0 if sin_marca else 1)
    while True:
        poner("MAIN.nEstado", m.estado)
        poner("MAIN.nPiezasBuenas", m.buenas)
        poner("MAIN.nPiezasMalas", m.malas)
        poner("MAIN.fVelocidad", m.velocidad)
        poner("MAIN.fTemperatura", m.temperatura)
        time.sleep(0.5)


# Mitsubishi MC 3E binario: TORNO1 -----------------------------------------------------
# D100 estado · D101-102 buenas (int32) · D103-104 malas · D110-111 temperatura (float32)
# D120-121 velocidad (float32) · D200-207 orden · M0 alarma · D9900-9907 marca.
# Solo atiende la lectura por lotes (0401); cualquier otra orden recibe un error.

def mc(sin_marca: bool) -> None:
    memoria_d = [0] * 10000
    memoria_m = [0] * 1000
    m = FABRICA["TORNO1"]

    def palabras_texto(texto: str, n: int) -> list[int]:
        b = texto.encode()[: n * 2].ljust(n * 2, b"\0")
        return [int.from_bytes(b[i:i + 2], "little") for i in range(0, n * 2, 2)]

    memoria_d[9900:9908] = palabras_texto("NADA" if sin_marca else MARCA, 8)

    def refrescar():
        while True:
            memoria_d[100] = m.estado
            memoria_d[101:103] = struct.unpack("<HH", struct.pack("<i", m.buenas))
            memoria_d[103:105] = struct.unpack("<HH", struct.pack("<i", m.malas))
            memoria_d[110:112] = struct.unpack("<HH", struct.pack("<f", m.temperatura))
            memoria_d[120:122] = struct.unpack("<HH", struct.pack("<f", m.velocidad))
            memoria_d[200:208] = palabras_texto(m.orden, 8)
            memoria_m[0] = 1 if m.estado == 2 else 0
            time.sleep(0.5)

    threading.Thread(target=refrescar, daemon=True).start()

    def atender(conexion: socket.socket) -> None:
        with conexion:
            while True:
                cab = conexion.recv(9)
                if len(cab) < 9:
                    return
                largo = struct.unpack("<H", cab[7:9])[0]
                cuerpo = b""
                while len(cuerpo) < largo:
                    trozo = conexion.recv(largo - len(cuerpo))
                    if not trozo:
                        return
                    cuerpo += trozo
                orden, sub = struct.unpack("<HH", cuerpo[2:6])
                respuesta = b""
                fin = 0xC059  # orden no soportada
                if orden == 0x0401:
                    inicio = int.from_bytes(cuerpo[6:9], "little")
                    codigo = cuerpo[9]
                    n = struct.unpack("<H", cuerpo[10:12])[0]
                    if codigo == 0xA8 and sub == 0:  # D, por palabras
                        respuesta, fin = b"".join(struct.pack("<H", w & 0xFFFF) for w in memoria_d[inicio:inicio + n]), 0
                    elif codigo == 0x90 and sub == 1:  # M, por bits: 4 bits por byte, dos puntos por byte
                        bits = memoria_m[inicio:inicio + n] + [0]
                        respuesta, fin = bytes((bits[i] << 4) | bits[i + 1] for i in range(0, n, 2)), 0
                datos = struct.pack("<H", fin) + respuesta
                conexion.sendall(b"\xd0\x00" + cab[2:7] + struct.pack("<H", len(datos)) + datos)

    srv = socket.create_server((BIND, P(5007)), reuse_port=False)
    while True:
        c, _ = srv.accept()
        threading.Thread(target=atender, args=(c,), daemon=True).start()


# MQTT: EMPAQUETADORA1 (estados PackML) -------------------------------------------------

PACKML = {0: "STOPPED", 1: "EXECUTE", 2: "ABORTED"}


async def mqtt(sin_marca: bool) -> None:
    from amqtt.broker import Broker
    import paho.mqtt.client as paho

    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "agente"))
    from drivers import sparkplug_b as sp

    broker = Broker({"listeners": {"default": {"type": "tcp", "bind": f"{BIND}:{P(1883)}"}}, "plugins": {"amqtt.plugins.authentication.AnonymousAuthPlugin": {"allow_anonymous": True}}})
    await broker.start()
    cliente = paho.Client(paho.CallbackAPIVersion.VERSION2, client_id="simulador")
    cliente.connect(BIND, P(1883))
    cliente.loop_start()
    cliente.publish("sindri/simulador", "OTRA-COSA" if sin_marca else MARCA, retain=True)
    m = FABRICA["EMPAQUETADORA1"]
    l3 = FABRICA["LINEA3"]
    seq = 0
    vuelta = 0
    while True:
        # LINEA3 por Sparkplug B: nacimiento cada 10 s (con alias) y datos cada segundo (solo alias).
        ahora = int(time.time() * 1000)
        metricas = [("Estado", sp.INT32, l3.estado), ("Contadores/Buenas", sp.UINT32, l3.buenas),
                    ("Contadores/Malas", sp.UINT32, l3.malas), ("Velocidad", sp.DOUBLE, float(l3.velocidad)), ("Orden", sp.STRING, l3.orden)]
        if vuelta % 10 == 0:
            seq = 0
            cliente.publish("spBv1.0/Fabrica/NBIRTH/Pasarela1", sp.codificar(ahora, seq, [sp.Metrica("bdSeq", None, sp.UINT64, 0)]))
            seq += 1
            cliente.publish("spBv1.0/Fabrica/DBIRTH/Pasarela1/LINEA3", sp.codificar(ahora, seq, [sp.Metrica(n, k + 1, t, v) for k, (n, t, v) in enumerate(metricas)]))
        else:
            cliente.publish("spBv1.0/Fabrica/DDATA/Pasarela1/LINEA3", sp.codificar(ahora, seq, [sp.Metrica(None, k + 1, t, v) for k, (n, t, v) in enumerate(metricas)]))
        seq = (seq + 1) % 256
        vuelta += 1
        cliente.publish("fabrica/empaquetadora1/estado", json.dumps({
            "packml": {"estado": PACKML[m.estado]}, "contadores": {"buenas": m.buenas, "malas": m.malas},
            "velocidad": m.velocidad, "temperatura": m.temperatura, "orden": m.orden,
        }), retain=True)
        cliente.publish("fabrica/empaquetadora1/alarma", m.alarma, retain=True)
        await asyncio.sleep(1)


# HTTP: MTConnect (CNC1) y JSON (ETIQUETADORA1) ----------------------------------------

EJECUCION = {0: "STOPPED", 1: "ACTIVE", 2: "INTERRUPTED"}


def _mtconnect(doc: str, sin_marca: bool) -> bytes:
    m = FABRICA["CNC1"]
    ahora = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    cabecera = f'<Header creationTime="{ahora}" sender="{"otra-cosa" if sin_marca else "sindri-simulador"}" instanceId="1" version="2.0" bufferSize="1"/>'
    ns = 'xmlns="urn:mtconnect.org:MTConnectStreams:2.0"' if doc == "current" else 'xmlns="urn:mtconnect.org:MTConnectDevices:2.0"'
    if doc == "probe":
        items = "".join(f'<DataItem id="{i}" name="{n}" category="{c}" type="{t}"/>' for i, n, c, t in [
            ("exec", "execution", "EVENT", "EXECUTION"), ("pc", "PartCount", "EVENT", "PART_COUNT"),
            ("prog", "program", "EVENT", "PROGRAM"), ("sp", "Sspeed", "SAMPLE", "ROTARY_VELOCITY"),
            ("temp", "Stemp", "SAMPLE", "TEMPERATURE"), ("sys", "system", "CONDITION", "SYSTEM")])
        return f'<?xml version="1.0"?><MTConnectDevices {ns}>{cabecera}<Devices><Device id="cnc1" name="CNC1"><DataItems>{items}</DataItems></Device></Devices></MTConnectDevices>'.encode()
    cond = f'<Fault dataItemId="sys" name="system" timestamp="{ahora}">{m.alarma}</Fault>' if m.estado == 2 else f'<Normal dataItemId="sys" name="system" timestamp="{ahora}"/>'
    return (f'<?xml version="1.0"?><MTConnectStreams {ns}>{cabecera}<Streams><DeviceStream name="CNC1" uuid="cnc1"><ComponentStream component="Controller" name="controller">'
            f'<Events><Execution dataItemId="exec" name="execution" timestamp="{ahora}">{EJECUCION[m.estado]}</Execution>'
            f'<PartCount dataItemId="pc" name="PartCount" timestamp="{ahora}">{m.buenas}</PartCount>'
            f'<Program dataItemId="prog" name="program" timestamp="{ahora}">{m.orden}</Program></Events>'
            f'<Samples><RotaryVelocity dataItemId="sp" name="Sspeed" timestamp="{ahora}">{m.velocidad * 100:.0f}</RotaryVelocity>'
            f'<Temperature dataItemId="temp" name="Stemp" timestamp="{ahora}">{m.temperatura}</Temperature></Samples>'
            f'<Condition>{cond}</Condition></ComponentStream></DeviceStream></Streams></MTConnectStreams>').encode()


def http(sin_marca: bool) -> None:
    class Mtc(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            doc = self.path.strip("/").split("/")[-1] or "probe"
            if doc not in ("probe", "current"):
                return self.send_error(404)
            cuerpo = _mtconnect(doc, sin_marca)
            self.send_response(200)
            self.send_header("content-type", "application/xml")
            self.end_headers()
            self.wfile.write(cuerpo)

        def log_message(self, *a):
            pass

    class Json(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            m = FABRICA["ETIQUETADORA1"]
            datos = {"api/estado": {"maquina": {"estado": ["parada", "marcha", "averia"][m.estado], "alarma": m.alarma or None},
                                    "contadores": {"buenas": m.buenas, "malas": m.malas}, "orden": m.orden},
                     "api/proceso": {"velocidad_ppm": m.velocidad, "temperatura_c": m.temperatura}}
            ruta = self.path.strip("/")
            if ruta and ruta not in datos:
                return self.send_error(404)
            cuerpo = json.dumps(datos.get(ruta, {"nombre": "ETIQUETADORA1"})).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            if not sin_marca:
                self.send_header("X-Sindri-Simulador", "1")
            self.end_headers()
            self.wfile.write(cuerpo)

        def log_message(self, *a):
            pass

    threading.Thread(target=ThreadingHTTPServer((BIND, P(5050)), Mtc).serve_forever, daemon=True).start()
    ThreadingHTTPServer((BIND, P(5060)), Json).serve_forever()


# Serie por TCP: BASCULA1 --------------------------------------------------------------
# Tramas al estilo de muchas básculas: «ST,GS,+0012.345 kg» (estable) o «US,GS,…» (moviéndose).

def serie(sin_marca: bool) -> None:
    m = FABRICA["BASCULA1"]

    def atender(c: socket.socket) -> None:
        with c:
            try:
                c.sendall(((("HOLA" if sin_marca else MARCA)) + "\r\n").encode())
                while True:
                    peso = 0.0 if m.estado != 1 else 12 + 0.5 * math.sin(m.t / 10) + random.uniform(-0.02, 0.02)
                    c.sendall(f"{'ST' if random.random() > 0.2 else 'US'},GS,{peso:+010.3f} kg\r\n".encode())
                    time.sleep(0.5)
            except OSError:
                return

    srv = socket.create_server((BIND, P(5070)))
    while True:
        c, _ = srv.accept()
        threading.Thread(target=atender, args=(c,), daemon=True).start()


# Ficheros y base de datos: SECADERO1 y MEZCLADORA1 ------------------------------------

def ficheros_y_sql(sin_marca: bool) -> None:
    carpeta_csv = os.path.join(CARPETA, "csv")
    os.makedirs(carpeta_csv, exist_ok=True)
    marca = os.path.join(carpeta_csv, ".sindri-simulador")
    if sin_marca:
        if os.path.exists(marca):
            os.remove(marca)
    else:
        open(marca, "w").close()
    db = sqlite3.connect(os.path.join(CARPETA, "historico.sqlite"))
    db.executescript("""
        create table if not exists historico (tag text, valor real, texto text, fecha text);
        create index if not exists historico_tag on historico (tag, fecha);
        drop table if exists sindri_simulador;
    """)
    if not sin_marca:
        db.execute("create table sindri_simulador (marca text)")
        db.execute("insert into sindri_simulador values (?)", (MARCA,))
    db.commit()
    s, mz = FABRICA["SECADERO1"], FABRICA["MEZCLADORA1"]
    while True:
        dia = time.strftime("%Y%m%d")
        ruta = os.path.join(carpeta_csv, f"secadero1_{dia}.csv")
        nuevo = not os.path.exists(ruta)
        with open(ruta, "a", newline="", encoding="utf-8") as f:
            w = csv.writer(f, delimiter=";")
            if nuevo:
                w.writerow(["Fecha", "Estado", "Piezas", "Rechazos", "Velocidad", "Temperatura", "Orden", "Alarma"])
            w.writerow([time.strftime("%d/%m/%Y %H:%M:%S"), s.estado, s.buenas, s.malas, f"{s.velocidad:.2f}".replace(".", ","),
                        f"{s.temperatura:.2f}".replace(".", ","), s.orden, s.alarma])
        fecha = time.strftime("%Y-%m-%dT%H:%M:%S")
        db.executemany("insert into historico values (?, ?, ?, ?)", [
            ("Mezcladora.Estado", mz.estado, None, fecha), ("Mezcladora.Piezas", mz.buenas, None, fecha),
            ("Mezcladora.Temperatura", mz.temperatura, None, fecha), ("Mezcladora.Orden", None, mz.orden, fecha)])
        db.execute("delete from historico where fecha < ?", (time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(time.time() - 3600)),))
        db.commit()
        time.sleep(2)


# OPC UA con modelos estándar: INYECTORA1 (Euromap 77) y ENVASADORA1 (PackML) -------------
# Estructura simplificada inspirada en OPC 40077 y OPC 30050: sirve para probar el driver y los
# perfiles; con una máquina real se valida contra el NodeSet oficial.

E77 = "http://opcfoundation.org/UA/PlasticsRubber/IMM2MES/"
PACKML_NS = "http://opcfoundation.org/UA/PackML/"
PACKML_ESTADO = {0: 2, 1: 6, 2: 9}  # parada → Stopped, marcha → Execute, avería → Aborted


async def opcua_estandar(sin_marca: bool) -> None:
    from asyncua import Server, ua

    srv = Server()
    await srv.init()
    srv.set_endpoint(f"opc.tcp://{BIND}:{P(4841)}/")
    srv.set_server_name("Sindri - simulador de modelos estándar")
    srv.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    if not sin_marca:
        await srv.register_namespace("urn:sindri:simulador")
    e77 = await srv.register_namespace(E77)
    pml = await srv.register_namespace(PACKML_NS)
    obj = srv.nodes.objects
    iny = await obj.add_object(e77, "IMM_INYECTORA1")
    estado_m = await iny.add_object(e77, "MachineStatus")
    modo = await estado_m.add_variable(e77, "MachineMode", 1, ua.VariantType.Int32)
    ciclo = await estado_m.add_variable(e77, "IsCycleRunning", True, ua.VariantType.Boolean)
    alarma = await estado_m.add_variable(e77, "ActiveAlarmText", "", ua.VariantType.String)
    trabajos = await (await iny.add_object(e77, "Jobs")).add_object(e77, "ActiveJobValues")
    ciclos = await trabajos.add_variable(e77, "JobCycleCounter", 0, ua.VariantType.UInt32)
    buenas = await trabajos.add_variable(e77, "JobGoodPartsCounter", 0, ua.VariantType.UInt32)
    malas = await trabajos.add_variable(e77, "JobBadPartsCounter", 0, ua.VariantType.UInt32)
    trabajo = await trabajos.add_variable(e77, "JobName", "", ua.VariantType.String)
    t_cil = await (await iny.add_object(e77, "InjectionUnit")).add_variable(e77, "ActCylinderTemperature", 0.0, ua.VariantType.Double)

    env = await obj.add_object(pml, "ENVASADORA1")
    st = await env.add_object(pml, "Status")
    ad = await env.add_object(pml, "Admin")
    p_estado = await st.add_variable(pml, "StateCurrent", 6, ua.VariantType.Int32)
    p_modo = await st.add_variable(pml, "UnitModeCurrent", 1, ua.VariantType.Int32)
    p_vel = await st.add_variable(pml, "CurMachSpeed", 0.0, ua.VariantType.Float)
    p_buenas = await ad.add_variable(pml, "ProdProcessedCount", 0, ua.VariantType.Int32)
    p_malas = await ad.add_variable(pml, "ProdDefectiveCount", 0, ua.VariantType.Int32)
    p_paro = await ad.add_variable(pml, "StopReason", 0, ua.VariantType.Int32)
    i, e = FABRICA["INYECTORA1"], FABRICA["ENVASADORA1"]
    async with srv:
        while True:
            await modo.write_value({0: 3, 1: 1, 2: 0}[i.estado], ua.VariantType.Int32)  # manual, automático, otro
            await ciclo.write_value(i.estado == 1)
            await alarma.write_value(i.alarma)
            await ciclos.write_value(i.buenas + i.malas, ua.VariantType.UInt32)
            await buenas.write_value(i.buenas, ua.VariantType.UInt32)
            await malas.write_value(i.malas, ua.VariantType.UInt32)
            await trabajo.write_value(i.orden)
            await t_cil.write_value(i.temperatura)
            await p_estado.write_value(PACKML_ESTADO[e.estado], ua.VariantType.Int32)
            await p_modo.write_value(1, ua.VariantType.Int32)
            await p_vel.write_value(float(e.velocidad), ua.VariantType.Float)
            await p_buenas.write_value(e.buenas, ua.VariantType.Int32)
            await p_malas.write_value(e.malas, ua.VariantType.Int32)
            await p_paro.write_value(0 if e.estado != 2 else 17, ua.VariantType.Int32)
            await asyncio.sleep(1)


# Modbus RTU dentro de TCP: CONTADOR1, un analizador de red (unidad 3) ---------------------
# hr0-1 tensión ×10 (uint32) · hr2-3 corriente en mA · hr4-5 potencia en W (int32)
# hr6 cos φ ×1000 · hr60-61 energía activa en Wh (uint32). Mapa propio, parecido al de muchos
# analizadores; cada modelo real trae el suyo en el manual.

def _crc(b: bytes) -> bytes:
    crc = 0xFFFF
    for x in b:
        crc ^= x
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return struct.pack("<H", crc)


def modbus_rtu(sin_marca: bool) -> None:
    hr = [0] * 100
    energia = [0.0]
    fabricante = ("Otro" if sin_marca else MARCA).encode()

    def refrescar():
        while True:
            carga = sum(m.velocidad > 0 for m in FABRICA.values()) / len(FABRICA)
            potencia = 8000 + 30000 * carga + random.uniform(-300, 300)
            energia[0] += potencia * 0.5 / 3600
            tension = 230 + random.uniform(-2, 2)
            hr[0:2] = _palabras(">I", int(tension * 10))
            hr[2:4] = _palabras(">I", int(potencia / tension / 3 * 1000))
            hr[4:6] = _palabras(">i", int(potencia))
            hr[6] = int(930 + random.uniform(-10, 10))
            hr[60:62] = _palabras(">I", int(energia[0]))
            time.sleep(0.5)

    def responder(pdu: bytes) -> bytes:
        f = pdu[0]
        if f in (3, 4):
            inicio, n = struct.unpack(">HH", pdu[1:5])
            if inicio + n > len(hr) or not 1 <= n <= 125:
                return bytes([f | 0x80, 2])
            return bytes([f, 2 * n]) + b"".join(struct.pack(">H", w) for w in hr[inicio:inicio + n])
        if f == 43 and pdu[1] == 14:
            objetos = [fabricante, b"ANALIZADOR", b"2.1"]
            return bytes([43, 14, pdu[2], 1, 0, 0, len(objetos)]) + b"".join(bytes([k, len(o)]) + o for k, o in enumerate(objetos))
        return bytes([f | 0x80, 1])

    def atender(c: socket.socket) -> None:
        with c:
            while True:
                trama = c.recv(256)
                if len(trama) < 4:
                    return
                if _crc(trama[:-2]) != trama[-2:] or trama[0] != 3:
                    continue  # otra unidad o trama rota: en RTU no se contesta
                r = bytes([3]) + responder(trama[1:-2])
                c.sendall(r + _crc(r))

    threading.Thread(target=refrescar, daemon=True).start()
    srv = socket.create_server((BIND, P(5021)))
    while True:
        c, _ = srv.accept()
        threading.Thread(target=atender, args=(c,), daemon=True).start()


# Omron FINS/TCP: PRENSA2 --------------------------------------------------------------
# DM100 estado · DM101-102 buenas (int32, palabra baja primero) · DM103-104 malas
# DM110-111 temperatura (float32) · DM200-207 orden · CIO0.03 avería · DM9900-9907 marca

def fins(sin_marca: bool) -> None:
    dm = [0] * 10000
    cio = [0] * 100
    m = FABRICA["PRENSA2"]

    def cdab(fmt, v):
        w = _palabras(fmt, v)
        return [w[1], w[0]]

    def texto(t: str, n: int) -> list[int]:
        b = t.encode()[: 2 * n].ljust(2 * n, b"\0")
        return [int.from_bytes(b[i:i + 2], "big") for i in range(0, 2 * n, 2)]

    dm[9900:9908] = texto("NADA" if sin_marca else MARCA, 8)

    def refrescar():
        while True:
            dm[100] = m.estado
            dm[101:103] = cdab(">i", m.buenas)
            dm[103:105] = cdab(">i", m.malas)
            dm[110:112] = cdab(">f", m.temperatura)
            dm[200:208] = texto(m.orden, 8)
            cio[0] = (1 << 3) if m.estado == 2 else 0
            time.sleep(0.5)

    def atender(c: socket.socket) -> None:
        nodo_cliente, nodo_srv = 10, 1
        with c:
            while True:
                cab = c.recv(16)
                if len(cab) < 16 or cab[:4] != b"FINS":
                    return
                largo, orden = struct.unpack(">II", cab[4:12])
                resto = c.recv(largo - 8)
                if orden == 0:
                    c.sendall(b"FINS" + struct.pack(">IIIII", 16, 1, 0, nodo_cliente, nodo_srv))
                    continue
                f = resto  # la trama FINS: 10 bytes de cabecera, orden y datos
                mrc, src = f[10], f[11]
                fin, datos = 0x0401, b""  # orden no soportada (también todas las de escribir)
                if (mrc, src) == (1, 1):
                    area, dirn, bit, n = f[12], *struct.unpack(">HBH", f[13:18])
                    if area == 0x82:
                        fin, datos = 0, b"".join(struct.pack(">H", w) for w in dm[dirn:dirn + n])
                    elif area == 0xB0:
                        fin, datos = 0, b"".join(struct.pack(">H", w) for w in cio[dirn:dirn + n])
                    elif area == 0x30:
                        fin, datos = 0, bytes(((cio[dirn] >> bit) & 1,))
                    elif area == 0x02:
                        fin, datos = 0, bytes(((dm[dirn] >> bit) & 1,))
                    else:
                        fin = 0x1101
                respuesta = bytes([0xC0, 0, 2, f[6], f[7], f[8], f[3], f[4], f[5], f[9], mrc, src]) + struct.pack(">H", fin) + datos
                c.sendall(b"FINS" + struct.pack(">III", 8 + len(respuesta), 2, 0) + respuesta)

    threading.Thread(target=refrescar, daemon=True).start()
    srv = socket.create_server((BIND, P(9600)))
    while True:
        c, _ = srv.accept()
        threading.Thread(target=atender, args=(c,), daemon=True).start()


# Keyence KV Host Link: ENSAMBLADORA1 --------------------------------------------------
# DM100 estado · DM101.D buenas · DM103.D malas · DM110 temperatura ×10 · R100 avería

def keyence(sin_marca: bool) -> None:
    m = FABRICA["ENSAMBLADORA1"]
    marca = ("NADA" if sin_marca else MARCA).encode().ljust(16, b"\0")

    def leer(d: str) -> str:
        base, _, formato = d.partition(".")
        area = "".join(ch for ch in base if ch.isalpha())
        num = int(base[len(area):])
        if area == "DM" and 9900 <= num < 9908:
            return marca[(num - 9900) * 2:(num - 9900) * 2 + 2].hex().upper() if formato == "H" else str(int.from_bytes(marca[(num - 9900) * 2:(num - 9900) * 2 + 2], "big")).zfill(5)
        valores = {("DM", 100): m.estado, ("DM", 101): m.buenas, ("DM", 103): m.malas, ("DM", 110): int(m.temperatura * 10), ("R", 100): int(m.estado == 2)}
        if (area, num) not in valores:
            return "00000"
        v = valores[(area, num)]
        if formato == "H":
            return f"{v & 0xFFFF:04X}"
        return str(v).zfill(10 if formato in ("D", "L") else 5) if area != "R" else str(v)

    def atender(c: socket.socket) -> None:
        with c:
            while True:
                trozo = b""
                while not trozo.endswith(b"\r"):
                    b = c.recv(1)
                    if not b:
                        return
                    trozo += b
                partes = trozo.decode("ascii").strip().split()
                if partes and partes[0] == "RD" and len(partes) == 2:
                    r = leer(partes[1])
                elif partes and partes[0] == "RDS" and len(partes) == 3:
                    base, _, fmt = partes[1].partition(".")
                    area = "".join(ch for ch in base if ch.isalpha())
                    r = " ".join(leer(f"{area}{int(base[len(area):]) + k}" + (f".{fmt}" if fmt else "")) for k in range(int(partes[2])))
                else:
                    r = "E1"  # orden no válida (WR, WRS, M0/M1 de paro y marcha… no se atienden)
                c.sendall(r.encode() + b"\r\n")

    srv = socket.create_server((BIND, P(8501)))
    while True:
        c, _ = srv.accept()
        threading.Thread(target=atender, args=(c,), daemon=True).start()


# BACnet/IP: COMPRESOR1 ----------------------------------------------------------------
# analog-input,1 presión (bar) · analog-input,2 temperatura · binary-value,1 en marcha
# multi-state-value,1 estado (1 parado, 2 en carga, 3 en vacío, 4 alarma) · analog-value,1 horas

async def bacnet(sin_marca: bool) -> None:
    from bacpypes3.app import Application
    from bacpypes3.local.analog import AnalogInputObject, AnalogValueObject
    from bacpypes3.local.binary import BinaryValueObject
    from bacpypes3.local.device import DeviceObject
    from bacpypes3.local.multistate import MultiStateValueObject
    from bacpypes3.local.networkport import NetworkPortObject

    sf = [0, 0, 0, 0]
    presion = AnalogInputObject(objectIdentifier=("analog-input", 1), objectName="Presion", presentValue=7.0, statusFlags=sf, units="bars")
    temp = AnalogInputObject(objectIdentifier=("analog-input", 2), objectName="Temperatura", presentValue=70.0, statusFlags=sf, units="degreesCelsius")
    marcha = BinaryValueObject(objectIdentifier=("binary-value", 1), objectName="EnMarcha", presentValue="active", statusFlags=sf)
    estado = MultiStateValueObject(objectIdentifier=("multi-state-value", 1), objectName="Estado", presentValue=2, numberOfStates=4, statusFlags=sf)
    horas = AnalogValueObject(objectIdentifier=("analog-value", 1), objectName="Horas", presentValue=12345.0, statusFlags=sf)
    app = Application.from_object_list([
        DeviceObject(objectIdentifier=("device", 9999), objectName="COMPRESOR1" if sin_marca else MARCA, vendorIdentifier=999, vendorName="Simulador"),
        NetworkPortObject(f"{BIND}/8:{P(47809)}", objectIdentifier=("network-port", 1), objectName="NetworkPort-1"),
        presion, temp, marcha, estado, horas,
    ])
    m = FABRICA["COMPRESOR1"]
    try:
        while True:
            en_carga = m.estado == 1 and (m.t // 20) % 3 != 0
            presion.presentValue = round((7.5 if en_carga else 6.8) + random.uniform(-0.05, 0.05), 2)
            temp.presentValue = m.temperatura
            marcha.presentValue = "active" if m.estado == 1 else "inactive"
            estado.presentValue = 4 if m.estado == 2 else 1 if m.estado == 0 else 2 if en_carga else 3
            horas.presentValue = round(12345 + m.t / 3600, 3)
            await asyncio.sleep(1)
    finally:
        app.close()


# Euromap 63 (ficheros), IO-Link (HTTP), histórico tipo Ignition y cámara de visión ----------

def euromap63(sin_marca: bool) -> None:
    """INYECTORA2: cada 5 s deja un informe .DAT (cabecera y una fila, separado por comas)."""
    carpeta = os.path.join(CARPETA, "euromap63")
    os.makedirs(carpeta, exist_ok=True)
    marca = os.path.join(carpeta, ".sindri-simulador")
    if sin_marca and os.path.exists(marca):
        os.remove(marca)
    elif not sin_marca:
        open(marca, "w").close()
    m = FABRICA["INYECTORA2"]
    while True:
        with open(os.path.join(carpeta, "REPORT1.DAT.tmp"), "w", encoding="latin-1") as f:
            f.write("Date,Time,ActStsMach,ActCntCyc,ActCntPrt,ActCntPrtRej,ActTimCyc,ActTmpCyl1,ATActJob\n")
            f.write(time.strftime("%Y%m%d,%H:%M:%S,") + f"{['0M000', '0A000', '0E000'][m.estado]},{m.buenas + m.malas},{m.buenas},{m.malas},"
                    f"{60 / m.ritmo:.2f},{m.temperatura:.1f},{m.orden}\n")
        os.replace(os.path.join(carpeta, "REPORT1.DAT.tmp"), os.path.join(carpeta, "REPORT1.DAT"))
        time.sleep(5)


def iolink(sin_marca: bool) -> None:
    """SENSOR1: un IO-Link master con API JSON (al estilo ifm IoT Core). Puerto 1: presión y
    temperatura en 4 bytes (presión ×100 con signo, temperatura ×10). Puerto 2: caudal en l/min ×10."""
    m = FABRICA["SENSOR1"]

    class Iol(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if "port[1]" in self.path:
                pdin = struct.pack(">hh", int((6.5 + 0.3 * math.sin(m.t / 20)) * 100), int(m.temperatura * 10)).hex().upper()
            elif "port[2]" in self.path:
                pdin = struct.pack(">H", int((42 + random.uniform(-1, 1)) * 10)).hex().upper()
            elif self.path.strip("/") == "":
                pdin = None
            else:
                return self.send_error(404)
            cuerpo = json.dumps({"cid": -1, "data": {"value": pdin}, "code": 200} if pdin else {"producto": "IO-Link master simulado", "puertos": 2}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            if not sin_marca:
                self.send_header("X-Sindri-Simulador", "1")
            self.end_headers()
            self.wfile.write(cuerpo)

        def log_message(self, *a):
            pass

    ThreadingHTTPServer((BIND, P(5061)), Iol).serve_forever()


def ignition(sin_marca: bool) -> None:
    """HORNO2: tablas del histórico de Ignition (sqlth_te y sqlt_data_1_AAAA_MM)."""
    db = sqlite3.connect(os.path.join(CARPETA, "ignition.sqlite"))
    tabla = time.strftime("sqlt_data_1_%Y_%m")
    db.executescript(f"""
        create table if not exists sqlth_te (id integer primary key, tagpath text, datatype integer);
        create table if not exists {tabla} (tagid integer, intvalue integer, floatvalue real, stringvalue text, dataintegrity integer, t_stamp integer);
        create index if not exists {tabla}_i on {tabla} (tagid, t_stamp);
        drop table if exists sindri_simulador;
    """)
    db.executemany("insert or replace into sqlth_te values (?, ?, ?)", [(1, "horno2/estado", 0), (2, "horno2/piezas", 0), (3, "horno2/temperatura", 1), (4, "horno2/orden", 2)])
    if not sin_marca:
        db.execute("create table sindri_simulador (marca text)")
        db.execute("insert into sindri_simulador values (?)", (MARCA,))
    db.commit()
    m = FABRICA["HORNO2"]
    while True:
        t = int(time.time() * 1000)
        db.executemany(f"insert into {tabla} values (?, ?, ?, ?, 192, ?)", [
            (1, m.estado, None, None, t), (2, m.buenas, None, None, t), (3, None, m.temperatura, None, t), (4, None, None, m.orden, t)])
        db.execute(f"delete from {tabla} where t_stamp < ?", (t - 3_600_000,))
        db.commit()
        time.sleep(2)


def vision(sin_marca: bool) -> None:
    """VISION1: una cámara que manda una línea por pieza inspeccionada: «RES;OK;0.982;12345»."""
    m = FABRICA["VISION1"]

    def atender(c: socket.socket) -> None:
        with c:
            try:
                c.sendall((("HOLA" if sin_marca else MARCA) + "\r\n").encode())
                n = 0
                while True:
                    if m.estado == 1:
                        n += 1
                        ok = random.random() > 0.04
                        c.sendall(f"RES;{'OK' if ok else 'NG'};{random.uniform(0.9, 1) if ok else random.uniform(0.3, 0.7):.3f};{n}\r\n".encode())
                    time.sleep(1)
            except OSError:
                return

    srv = socket.create_server((BIND, P(5071)))
    while True:
        c, _ = srv.accept()
        threading.Thread(target=atender, args=(c,), daemon=True).start()


# Arranque -----------------------------------------------------------------------------

HILOS = {"modbus": modbus, "s7": s7, "enip": enip, "ads": ads, "mc": mc, "http": http, "serie": serie, "ficheros": ficheros_y_sql,
         "modbus_rtu": modbus_rtu, "fins": fins, "keyence": keyence, "euromap63": euromap63, "iolink": iolink, "ignition": ignition, "vision": vision}
ASINCRONOS = {"mqtt": mqtt, "opcua_estandar": opcua_estandar, "bacnet": bacnet}


async def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--sin-marca", action="store_true")
    p.add_argument("--solo", default=",".join([*HILOS, *ASINCRONOS]))
    a = p.parse_args()
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    elegidos = [x.strip() for x in a.solo.split(",") if x.strip()]

    def con_registro(nombre, f):
        def envoltura():
            try:
                f(a.sin_marca)
            except Exception:  # noqa: BLE001
                log.exception("El simulador %s se ha parado", nombre)
        return envoltura

    for n in elegidos:
        if n in HILOS:
            threading.Thread(target=con_registro(n, HILOS[n]), daemon=True, name=n).start()

    async def fabrica():
        while True:
            for m in FABRICA.values():
                m.paso()
            await asyncio.sleep(1)

    async def con_registro_async(nombre, f):
        try:
            await f(a.sin_marca)
        except Exception:  # noqa: BLE001 - un protocolo que falla no tumba a los demás
            log.exception("El simulador %s se ha parado", nombre)

    tareas = [asyncio.create_task(fabrica())] + [asyncio.create_task(con_registro_async(n, ASINCRONOS[n])) for n in elegidos if n in ASINCRONOS]
    print(f"Simulador multiprotocolo en {BIND}: {', '.join(elegidos)}{' (sin marca)' if a.sin_marca else ''}", flush=True)
    await asyncio.gather(*tareas)


if __name__ == "__main__":
    import signal

    def salir(*_):
        for h in HIJOS:
            h.terminate()
        os._exit(0)

    signal.signal(signal.SIGTERM, salir)
    signal.signal(signal.SIGINT, salir)
    asyncio.run(main())
