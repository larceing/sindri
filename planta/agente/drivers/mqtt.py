"""MQTT: máquinas y sensores modernos, pasarelas IIoT (Siemens IOT2050, Node-RED, Kepware,
Ignition, HMS…) e IO-Link masters. JSON o valor suelto. Sparkplug B: ver docs/EFESTO.md."""
from __future__ import annotations

import asyncio
import json
import threading
import time

from .base import MARCA, Driver, Tag, ruta_json, secreto

TOPIC_MARCA = "sindri/simulador"


class Mqtt(Driver):
    id = "mqtt"
    nombre = "MQTT (JSON o valor)"
    libreria = "paho-mqtt (EPL-2.0 o BSD-3-Clause, a elegir: BSD)"
    sintaxis = "fabrica/linea1/estado · fabrica/linea1|maquina.piezas (topic|ruta dentro del JSON)"
    marca = f"mensaje retenido en {TOPIC_MARCA} = «{MARCA}»"

    async def abrir(self) -> None:
        import paho.mqtt.client as mqtt

        self.ultimos: dict[str, tuple[float, bytes]] = {}
        self.cerrojo = threading.Lock()
        self.conectado = asyncio.Event()
        bucle = asyncio.get_running_loop()
        self.cliente = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=self.ajuste("cliente_id", f"efesto-{self.fuente}"))
        if self.ajuste("usuario"):
            self.cliente.username_pw_set(self.ajuste("usuario"), secreto(self.ajustes, "clave"))
        if self.ajuste("tls"):
            self.cliente.tls_set(ca_certs=self.ajuste("ca"))

        def al_conectar(cliente, _u, _f, codigo, _p):
            if codigo == 0:
                cliente.subscribe([(t, 0) for t in self._topics() | {TOPIC_MARCA}])
                bucle.call_soon_threadsafe(self.conectado.set)

        def al_recibir(_c, _u, mensaje):
            with self.cerrojo:
                self.ultimos[mensaje.topic] = (time.time(), mensaje.payload)

        self.cliente.on_connect = al_conectar
        self.cliente.on_message = al_recibir
        self.cliente.connect(self.ajuste("host", obligatorio=True), int(self.ajuste("puerto", 1883)), keepalive=30)
        self.cliente.loop_start()
        await asyncio.wait_for(self.conectado.wait(), 10)

    def _topics(self) -> set[str]:
        return {t.origen.split("|", 1)[0].strip() for t in self.tags}

    async def es_simulador(self) -> bool:
        for _ in range(30):  # el retenido llega justo después de suscribirse
            with self.cerrojo:
                m = self.ultimos.get(TOPIC_MARCA)
            if m:
                return m[1].decode("utf-8", "replace") == MARCA
            await asyncio.sleep(0.1)
        return False

    async def preparar(self, tags: list[Tag]) -> None:
        nuevos = {t.origen.split("|", 1)[0].strip() for t in tags} - self._topics()
        self.tags, self.errores = tags, {}
        if nuevos:
            self.cliente.subscribe([(t, 0) for t in nuevos])

    async def leer(self) -> dict:
        # MQTT empuja: se devuelve lo último que llegó de cada topic.
        caducidad = float(self.ajuste("caducidad_s", 300))
        salida = {}
        with self.cerrojo:
            ultimos = dict(self.ultimos)
        for t in self.tags:
            topic, _, ruta = t.origen.partition("|")
            m = ultimos.get(topic.strip())
            if not m or time.time() - m[0] > caducidad:
                continue
            texto = m[1].decode("utf-8", "replace")
            try:
                dato = json.loads(texto)
            except ValueError:
                dato = texto
            v = ruta_json(dato, ruta.strip()) if ruta.strip() else dato
            if v is not None:
                salida[t.id] = v
        return salida

    async def cerrar(self) -> None:
        self.cliente.loop_stop()
        self.cliente.disconnect()

    async def descubrir(self) -> list[dict]:
        """Escucha # durante 5 segundos y enseña los topics que llegan."""
        self.cliente.subscribe("#")
        await asyncio.sleep(5)
        self.cliente.unsubscribe("#")
        with self.cerrojo:
            return [{"origen": t, "ejemplo": p[:80].decode("utf-8", "replace")} for t, (_, p) in sorted(self.ultimos.items())]
