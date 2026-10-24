"""MQTT Sparkplug B: pasarelas IIoT (Ignition Edge, Cirrus Link, HiveMQ Edge, Kepware, Node-RED,
Opto 22, Siemens IOT2050…). Se escucha NBIRTH/DBIRTH y NDATA/DDATA de un grupo. Nunca se manda
NCMD/DCMD: ni siquiera para pedir un «rebirth» (ver docs/EFESTO.md)."""
from __future__ import annotations

import struct
import time

from .base import Tag
from .mqtt import Mqtt

TIPOS = ("NBIRTH", "DBIRTH", "NDATA", "DDATA", "NDEATH", "DDEATH")


class Sparkplug(Mqtt):
    id = "sparkplug"
    nombre = "MQTT Sparkplug B"
    libreria = "paho-mqtt (BSD-3-Clause); el Payload protobuf se decodifica aquí (sparkplug_b.py)"
    sintaxis = "nodo/dispositivo/Métrica · nodo//Métrica (métrica del nodo) · nodo/dispositivo/Carpeta/Métrica"

    def _topics(self) -> set[str]:
        return {f"spBv1.0/{self.ajuste('grupo', obligatorio=True)}/{t}/#" for t in TIPOS}

    async def abrir(self) -> None:
        self.metricas: dict[str, tuple[float, object]] = {}
        self.alias: dict[tuple[str, str, int], str] = {}
        await super().abrir()
        original = self.cliente.on_message

        def al_recibir(cliente, datos, mensaje):
            if mensaje.topic.startswith("spBv1.0/"):
                self._sparkplug(mensaje.topic, mensaje.payload)
            else:
                original(cliente, datos, mensaje)

        self.cliente.on_message = al_recibir

    def _sparkplug(self, topic: str, payload: bytes) -> None:
        from .sparkplug_b import decodificar

        partes = topic.split("/")
        if len(partes) < 4:
            return
        tipo, nodo = partes[2], partes[3]
        dispositivo = partes[4] if len(partes) > 4 else ""
        if tipo in ("NDEATH", "DDEATH"):
            # El nodo o el dispositivo se ha ido: sus valores dejan de valer.
            prefijo = f"{nodo}/{dispositivo}/" if dispositivo else f"{nodo}/"
            with self.cerrojo:
                for k in [k for k in self.metricas if k.startswith(prefijo)]:
                    del self.metricas[k]
            return
        if tipo not in ("NBIRTH", "DBIRTH", "NDATA", "DDATA"):
            return
        try:
            _, metricas = decodificar(payload)
        except (ValueError, IndexError, UnicodeDecodeError, struct.error):
            return
        ahora = time.time()
        with self.cerrojo:
            for m in metricas:
                nombre = m.nombre
                if tipo.endswith("BIRTH") and m.alias is not None and nombre:
                    self.alias[(nodo, dispositivo, m.alias)] = nombre
                if not nombre and m.alias is not None:
                    nombre = self.alias.get((nodo, dispositivo, m.alias))
                if nombre and not m.nulo:
                    self.metricas[f"{nodo}/{dispositivo}/{nombre}"] = (ahora, m.valor)

    async def preparar(self, tags: list[Tag]) -> None:
        self.tags, self.errores = tags, {}

    async def leer(self) -> dict:
        caducidad = float(self.ajuste("caducidad_s", 300))
        with self.cerrojo:
            metricas = dict(self.metricas)
        salida = {}
        for t in self.tags:
            m = metricas.get(t.origen.strip())
            if m and time.time() - m[0] <= caducidad:
                salida[t.id] = m[1]
        return salida

    async def descubrir(self) -> list[dict]:
        import asyncio

        await asyncio.sleep(5)
        with self.cerrojo:
            return [{"origen": k, "ejemplo": str(v)[:60]} for k, (_, v) in sorted(self.metricas.items())]


