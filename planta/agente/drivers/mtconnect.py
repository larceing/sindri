"""MTConnect: CNC y máquina herramienta (Mazak, Okuma, DMG MORI, Haas, Hurco; Fanuc, Siemens y
Heidenhain con adaptador). Estándar abierto por HTTP y XML: se lee /current del agente MTConnect."""
from __future__ import annotations

import urllib.request
import xml.etree.ElementTree as ET

from .base import Driver


def _sin_espacio(etiqueta: str) -> str:
    return etiqueta.rsplit("}", 1)[-1]


class MTConnect(Driver):
    id = "mtconnect"
    nombre = "MTConnect (CNC)"
    libreria = "ninguna (HTTP y XML de la librería estándar)"
    sintaxis = "execution · PartCount · Spindle1Speed (dataItemId o name) · cond:system (estado de una condición)"
    marca = "cabecera del documento con sender=«sindri-simulador»"

    async def abrir(self) -> None:
        self.url = self.ajuste("url", obligatorio=True).rstrip("/")
        self.dispositivo = self.ajuste("dispositivo")
        self.cabecera = (await self._documento("probe")).find(".//{*}Header")

    def _get(self, ruta: str) -> bytes:
        destino = f"{self.url}/{self.dispositivo}/{ruta}" if self.dispositivo else f"{self.url}/{ruta}"
        with urllib.request.urlopen(destino, timeout=10) as r:
            return r.read()

    async def _documento(self, ruta: str) -> ET.Element:
        return ET.fromstring(await self.en_hilo(self._get, ruta))

    async def es_simulador(self) -> bool:
        return self.cabecera is not None and self.cabecera.get("sender") == "sindri-simulador"

    async def leer(self) -> dict:
        doc = await self._documento("current")
        valores: dict[str, str] = {}
        condiciones: dict[str, str] = {}
        destinos = {"Samples": valores, "Events": valores, "Condition": condiciones}
        for contenedor in doc.iter():
            grupo = _sin_espacio(contenedor.tag)
            if grupo not in destinos:
                continue
            destino = destinos[grupo]
            for e in contenedor:
                v = _sin_espacio(e.tag).upper() if grupo == "Condition" else (e.text or "").strip()
                for k in (e.get("dataItemId"), e.get("name")):
                    if k:
                        destino[k] = v
        salida = {}
        for t in self.tags:
            o = t.origen.strip()
            v = condiciones.get(o[5:]) if o.startswith("cond:") else valores.get(o)
            if v is None or v == "UNAVAILABLE":
                continue
            try:
                salida[t.id] = float(v) if t.tipo in ("counter", "value") else v
            except ValueError:
                self.errores[t.id] = f"{o}: «{v}» no es un número"
        return salida

    async def descubrir(self) -> list[dict]:
        doc = await self._documento("probe")
        return [{"origen": e.get("id"), "nombre": e.get("name"), "categoria": e.get("category"), "tipo_dato": e.get("type")}
                for e in doc.iter() if _sin_espacio(e.tag) == "DataItem"]

