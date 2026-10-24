"""Pruebas de los drivers de Efesto contra el simulador multiprotocolo.

  python -m unittest -v test_drivers

Arranca dos simuladores: uno con la marca de Sindri (puertos +1000) y otro sin ella (+2000).
Cada driver tiene que leer todos sus tags del primero y negarse a tomar el segundo por el simulador,
que es lo que impide que un agente de DEV lea una planta de verdad. Sin las librerías de
requirements-pruebas.txt, las pruebas con simulador se saltan."""
from __future__ import annotations

import ast
import asyncio
import importlib.util
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import unittest

import drivers
from agente import normalizar, tags_por_fuente
from drivers import sparkplug_b
from drivers.base import transformar
from drivers.modbus import decodificar, direccion
from drivers.sql import consulta_segura

AQUI = os.path.dirname(os.path.abspath(__file__))
SIMULADOR = os.path.join(AQUI, "..", "simulador")
NECESARIAS = ["asyncua", "pymodbus", "snap7", "pylogix", "pyads", "pymcprotocol", "paho", "amqtt", "bacpypes3", "serial", "cpppo"]
HAY_TODO = all(importlib.util.find_spec(m) for m in NECESARIAS)
PUSH = {"pasarela": 12, "broker": 2, "bascula": 2, "vision": 2.5}  # drivers que esperan a que llegue algo


def desplazar(ajustes: dict, d: int) -> dict:
    """Cambia los puertos de una fuente de ejemplo para el simulador desplazado."""
    salida = {}
    for k, v in ajustes.items():
        if k == "puerto":
            v = int(v) + d
        elif isinstance(v, str):
            v = re.sub(r":(\d{4,5})(?=/|$)", lambda m: f":{int(m.group(1)) + d}", v)
        salida[k] = v
    return salida


def cargar_ejemplos(carpeta: str, d: int):
    with open(os.path.join(AQUI, "ejemplos", "fuentes.simulador.json"), encoding="utf-8") as f:
        fuentes = json.loads(f.read().replace("${CARPETA}", carpeta))
    with open(os.path.join(AQUI, "ejemplos", "maquinas.simulador.json"), encoding="utf-8") as f:
        maquinas = json.load(f)
    fuentes = {n: (a if a["driver"] == "ads" else desplazar(a, d)) for n, a in fuentes.items()}
    reparto, avisos = tags_por_fuente({"maquinas": maquinas}, fuentes)
    assert not avisos, avisos
    return fuentes, reparto


def esperar_puerto(puerto: int, segundos: float = 20) -> None:
    fin = time.time() + segundos
    while time.time() < fin:
        try:
            with socket.create_connection(("127.0.0.1", puerto), timeout=0.5):
                return
        except OSError:
            time.sleep(0.3)
    raise RuntimeError(f"el simulador no abre el puerto {puerto}")


async def leer_una_vez(nombre: str, ajustes: dict, tags) -> tuple[bool, dict, dict]:
    d = drivers.cargar(ajustes["driver"])(nombre, ajustes)
    await asyncio.wait_for(d.abrir(), 20)
    try:
        es_sim = await d.es_simulador()
        await d.preparar(tags)
        await asyncio.sleep(PUSH.get(nombre, 0))
        crudos = await asyncio.wait_for(d.leer(), 20)
        porid = {t.id: t for t in tags}
        return es_sim, {k: normalizar(porid[k], v) for k, v in crudos.items()}, dict(d.errores)
    finally:
        await d.cerrar()


async def solo_marca(nombre: str, ajustes: dict) -> bool:
    d = drivers.cargar(ajustes["driver"])(nombre, ajustes)
    await asyncio.wait_for(d.abrir(), 20)
    try:
        return await d.es_simulador()
    finally:
        await d.cerrar()


@unittest.skipUnless(HAY_TODO, "faltan librerías: pip install -r requirements-pruebas.txt")
class PruebaContraSimulador(unittest.TestCase):
    procesos: list[subprocess.Popen] = []

    @classmethod
    def setUpClass(cls) -> None:
        cls.carpeta_con = tempfile.mkdtemp()
        cls.carpeta_sin = tempfile.mkdtemp()
        py = sys.executable
        entorno = dict(os.environ)
        cls.procesos = [
            subprocess.Popen([py, "multiprotocolo.py"], cwd=SIMULADOR, env=entorno | {"PUERTOS_DESPLAZAMIENTO": "1000", "CARPETA": cls.carpeta_con},
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
            subprocess.Popen([py, "multiprotocolo.py", "--sin-marca", "--solo", "modbus,s7,enip,mc,http,serie,ficheros,modbus_rtu,fins,keyence,euromap63,iolink,ignition,vision,mqtt,opcua_estandar,bacnet"],
                             cwd=SIMULADOR, env=entorno | {"PUERTOS_DESPLAZAMIENTO": "2000", "CARPETA": cls.carpeta_sin}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
            subprocess.Popen([py, "simulador.py"], cwd=SIMULADOR, env=entorno | {"PUERTO": "5840"}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
        ]
        for p in (6020, 2102, 45818, 6007, 2883, 6050, 6060, 6070, 6021, 10600, 9501, 6061, 6071, 5841, 5840, 7020, 3102, 46818, 3883, 6841):
            esperar_puerto(p)
        time.sleep(3)  # que las máquinas den unos pasos y los ficheros existan
        cls.con = cargar_ejemplos(cls.carpeta_con, 1000)
        cls.sin = cargar_ejemplos(cls.carpeta_sin, 2000)

    @classmethod
    def tearDownClass(cls) -> None:
        for p in cls.procesos:
            p.terminate()
        for p in cls.procesos:
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()

    def test_cada_driver_lee_todos_sus_tags(self):
        fuentes, reparto = self.con

        async def todas():
            return await asyncio.gather(*[leer_una_vez(n, a, reparto[n]) for n, a in fuentes.items()], return_exceptions=True)

        for (nombre, ajustes), r in zip(fuentes.items(), asyncio.run(todas())):
            with self.subTest(fuente=nombre, driver=ajustes["driver"]):
                self.assertNotIsInstance(r, Exception, r)
                es_sim, valores, errores = r
                self.assertTrue(es_sim, "no reconoce al simulador")
                self.assertEqual(errores, {})
                self.assertEqual(set(valores), {t.id for t in reparto[nombre]})

    def test_sin_marca_ningun_driver_lo_toma_por_el_simulador(self):
        fuentes, _ = self.sin
        # ADS no se puede duplicar (puerto fijo) y el OPC UA de Linea1 no tiene versión sin marca.
        probar = {n: a for n, a in fuentes.items() if a["driver"] != "ads" and n != "scada-opcua"}

        async def todas():
            return await asyncio.gather(*[solo_marca(n, a) for n, a in probar.items()], return_exceptions=True)

        for (nombre, ajustes), r in zip(probar.items(), asyncio.run(todas())):
            with self.subTest(fuente=nombre, driver=ajustes["driver"]):
                self.assertIs(r, False, f"{nombre}: {r!r}")


class PruebaSoloLectura(unittest.TestCase):
    """Ningún driver llama a nada que escriba, pare, arranque o descargue programa."""

    PROHIBIDO = re.compile(r"write|publish|set_value|setvalue|force|download|upload|remote_|stop|run$|reset|delete|insert|update|call_method|batchwrite|randomwrite", re.I)
    PERMITIDO = {"set_user", "set_password", "set_security_string", "username_pw_set", "tls_set", "loop_stop", "loop_start", "read_tags"}

    def llamadas(self, ruta: str):
        with open(ruta, encoding="utf-8") as f:
            arbol = ast.parse(f.read())
        for n in ast.walk(arbol):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute):
                yield n.func.attr, ast.unparse(n.func.value), n.lineno

    def test_ninguna_llamada_de_escritura(self):
        carpeta = os.path.join(AQUI, "drivers")
        for fichero in sorted(os.listdir(carpeta)):
            if not fichero.endswith(".py") or fichero == "sparkplug_b.py":
                continue
            for nombre, objeto, linea in self.llamadas(os.path.join(carpeta, fichero)):
                if nombre in self.PERMITIDO or not self.PROHIBIDO.search(nombre):
                    continue
                # FINS y Keyence mandan su petición de lectura por el socket: comprobado abajo.
                if fichero in ("fins.py", "keyence.py") and objeto == "self.w" and nombre == "write":
                    continue
                self.fail(f"{fichero}:{linea}: {objeto}.{nombre}()")

    def test_fins_solo_manda_leer(self):
        with open(os.path.join(AQUI, "drivers", "fins.py"), encoding="utf-8") as f:
            texto = f.read()
        self.assertEqual(texto.count("self.w.write("), 2)  # el saludo y la orden 0101
        self.assertIn("self.sid, 0x01, 0x01, area", texto)

    def test_keyence_rechaza_lo_que_no_es_leer(self):
        from drivers.keyence import Keyence

        k = Keyence("k", {})
        with self.assertRaises(ValueError):
            asyncio.run(k._orden("WR DM100 1"))


class PruebaPiezas(unittest.TestCase):
    def test_transformar(self):
        self.assertEqual(transformar(215, {"escala": 0.1}), 21.5)
        self.assertEqual(transformar("ACTIVE", {"mapa": {"ACTIVE": 1}, "defecto_mapa": 0}), 1)
        self.assertEqual(transformar("READY", {"mapa": {"ACTIVE": 1}, "defecto_mapa": 0}), 0)
        self.assertEqual(transformar(6, {"mapa": {"6": 1}}), 1)
        self.assertEqual(transformar(0b1000, {"bit": 3}), 1)
        self.assertEqual(transformar("FF9C00C8", {"hex": {"inicio": 0, "bytes": 2, "signo": True}}), -100)
        self.assertEqual(transformar("FF9C00C8", {"hex": {"inicio": 2, "bytes": 2}, "escala": 0.1}), 20.0)
        self.assertIsNone(transformar("zz", {"hex": {}}))

    def test_normalizar_pide_mapa_para_textos(self):
        from drivers.base import Tag

        with self.assertRaises(ValueError):
            normalizar(Tag("M", "Estado", "x", "state"), "ACTIVE")
        self.assertEqual(normalizar(Tag("M", "Peso", "x", "value"), "12,5"), 12.5)
        self.assertEqual(normalizar(Tag("M", "Orden", "x", "text"), 123), "123")

    def test_modbus_ordenes_de_bytes(self):
        import struct

        w = [int.from_bytes(struct.pack(">f", 12.5)[i:i + 2], "big") for i in (0, 2)]
        self.assertEqual(decodificar(w, direccion("hr:0:float32", 1)), 12.5)
        self.assertEqual(decodificar(w[::-1], direccion("hr:0:float32:cdab", 1)), 12.5)
        swap = [((x & 0xFF) << 8) | (x >> 8) for x in w]
        self.assertEqual(decodificar(swap, direccion("hr:0:float32:badc", 1)), 12.5)
        self.assertEqual(direccion("3/ir:7:int32", 1).unidad, 3)
        with self.assertRaises(ValueError):
            direccion("hr:abc", 1)

    def test_sql_solo_select(self):
        self.assertTrue(consulta_segura("select valor from t where tag = 'x' limit 1").startswith("select"))
        for mala in ("delete from t", "select 1; drop table t", "update t set a=1", "with x as (select 1) insert into t select * from x", "select * into nueva from t"):
            with self.subTest(consulta=mala), self.assertRaises(ValueError):
                consulta_segura(mala)

    def test_sparkplug_ida_y_vuelta(self):
        m = [sparkplug_b.Metrica("Estado", 1, sparkplug_b.INT32, -2), sparkplug_b.Metrica("V", 2, sparkplug_b.DOUBLE, 3.25),
             sparkplug_b.Metrica("Orden", 3, sparkplug_b.STRING, "OF-1"), sparkplug_b.Metrica(None, 4, sparkplug_b.BOOLEAN, True)]
        seq, salida = sparkplug_b.decodificar(sparkplug_b.codificar(1_700_000_000_000, 7, m))
        self.assertEqual(seq, 7)
        self.assertEqual([(x.nombre, x.alias, x.valor) for x in salida], [("Estado", 1, -2), ("V", 2, 3.25), ("Orden", 3, "OF-1"), (None, 4, True)])

    def test_todos_los_drivers_se_cargan_y_se_describen(self):
        for i in drivers.disponibles():
            with self.subTest(driver=i):
                try:
                    c = drivers.cargar(i)
                except SystemExit as e:  # falta una librería opcional
                    self.skipTest(str(e))
                self.assertTrue(c.nombre and c.libreria and c.sintaxis and c.marca)


if __name__ == "__main__":
    unittest.main()
