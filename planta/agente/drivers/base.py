"""Contrato de un driver de Efesto: cómo se lee un sistema de producción.

Un driver sabe hablar un protocolo (OPC UA, Modbus, S7…) y nada más. El agente le da la
conexión (una «fuente» de fuentes.json, que vive en la fábrica) y la lista de tags que el ERP
quiere, y le pide valores cada segundo. El resumen, la cola y el envío son del agente.

Reglas que cumple todo driver:
- Solo lee. Ninguna llamada de escritura, de arranque/paro ni de descarga de programa
  (lo comprueba test_drivers.py leyendo el código de cada driver).
- Sabe decir si al otro lado está el simulador de Sindri (es_simulador). Fuera de PRO el
  agente no lee nada que no lo sea. La marca se lee, nunca se escribe.
- Si un tag no se puede leer, no lo inventa: no lo devuelve y apunta el error.
"""
from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass, field
from typing import Any, ClassVar

# Lo que enseña el simulador de Sindri en cada protocolo para que el agente lo reconozca.
MARCA = "SINDRI-SIMULADOR"


@dataclass
class Tag:
    maquina: str
    clave: str
    origen: str  # la dirección, en la sintaxis de cada driver
    tipo: str  # state, counter, value, text
    ajustes: dict = field(default_factory=dict)  # hex, bit, mapa, defecto_mapa, escala, desplazamiento
    espacio: str | None = None  # contexto de la máquina (espacio OPC UA, dispositivo MTConnect…)

    @property
    def id(self) -> tuple[str, str]:
        return (self.maquina, self.clave)


class DireccionNoValida(ValueError):
    pass


def transformar(valor: Any, ajustes: dict) -> Any:
    """Lo que se puede ajustar desde el ERP sin tocar el driver: hex, bit, mapa, escala y desplazamiento."""
    if valor is None or not ajustes:
        return valor
    if "hex" in ajustes:
        # Datos de proceso en hexadecimal (IO-Link): {"hex": {"inicio": 0, "bytes": 2, "signo": true}}
        h = ajustes["hex"]
        try:
            crudo = bytes.fromhex(str(valor))[int(h.get("inicio", 0)): int(h.get("inicio", 0)) + int(h.get("bytes", 2))]
            valor = int.from_bytes(crudo, "big", signed=bool(h.get("signo", False)))
            if "desplazar" in h:
                valor >>= int(h["desplazar"])
        except (TypeError, ValueError):
            return None
    if "bit" in ajustes:
        try:
            valor = (int(valor) >> int(ajustes["bit"])) & 1
        except (TypeError, ValueError):
            return None
    if "mapa" in ajustes:
        mapa = ajustes["mapa"]
        clave = valor if isinstance(valor, str) else str(int(valor)) if isinstance(valor, (int, float, bool)) and float(valor).is_integer() else str(valor)
        if clave in mapa:
            valor = mapa[clave]
        elif "defecto_mapa" in ajustes:
            valor = ajustes["defecto_mapa"]
    if isinstance(valor, bool):
        valor = int(valor)
    if isinstance(valor, (int, float)) and ("escala" in ajustes or "desplazamiento" in ajustes):
        valor = valor * float(ajustes.get("escala", 1)) + float(ajustes.get("desplazamiento", 0))
        if isinstance(valor, float) and not math.isfinite(valor):
            return None
    return valor


def secreto(ajustes: dict, clave: str) -> str | None:
    """Los secretos de una fuente van en un fichero (clave_fichero), nunca en fuentes.json."""
    ruta = ajustes.get(f"{clave}_fichero")
    if ruta:
        with open(ruta, encoding="utf-8") as f:
            return f.read().strip()
    return None


class Driver:
    """Clase base. Un driver nuevo hereda de aquí y rellena los métodos marcados."""

    # Datos del driver, que salen en `agente.py drivers` y en la documentación.
    id: ClassVar[str] = ""
    nombre: ClassVar[str] = ""
    libreria: ClassVar[str] = ""  # librería de terceros que usa y su licencia
    sintaxis: ClassVar[str] = ""  # ejemplo de dirección de un tag
    marca: ClassVar[str] = ""  # cómo reconoce al simulador

    def __init__(self, nombre: str, ajustes: dict):
        self.fuente = nombre
        self.ajustes = ajustes
        self.tags: list[Tag] = []
        self.errores: dict[tuple[str, str], str] = {}

    # Lo que rellena cada driver -------------------------------------------------------

    async def abrir(self) -> None:
        """Conecta. Puede lanzar cualquier excepción: el agente reintenta."""

    async def es_simulador(self) -> bool:
        """True solo si al otro lado está el simulador de Sindri. Solo lectura."""
        raise NotImplementedError

    async def preparar(self, tags: list[Tag]) -> None:
        """Comprueba y traduce las direcciones. Las que no valen van a self.errores."""
        self.tags = tags

    async def leer(self) -> dict[tuple[str, str], Any]:
        """Valores en crudo de los tags preparados. Lo que no se pudo leer, no aparece."""
        raise NotImplementedError

    async def cerrar(self) -> None:
        pass

    async def descubrir(self) -> list[dict]:
        """Opcional: qué hay para leer, para ayudar a dar de alta una máquina."""
        return []

    # Ayudas ---------------------------------------------------------------------------

    @staticmethod
    async def en_hilo(funcion, *args, **kwargs):
        """Para librerías que no son asíncronas (snap7, pylogix, pyads…)."""
        return await asyncio.to_thread(funcion, *args, **kwargs)

    def ajuste(self, clave: str, defecto: Any = None, obligatorio: bool = False) -> Any:
        v = self.ajustes.get(clave, defecto)
        if obligatorio and v in (None, ""):
            raise SystemExit(f"Falta «{clave}» en la fuente «{self.fuente}» de fuentes.json.")
        return v


def ruta_json(dato: Any, ruta: str) -> Any:
    """a.b.c · a.lista.0.valor · vacío = el dato entero. None si no está."""
    for paso in [p for p in ruta.replace("[", ".").replace("]", "").split(".") if p and p != "$"]:
        if isinstance(dato, dict):
            dato = dato.get(paso)
        elif isinstance(dato, list) and paso.lstrip("-").isdigit() and -len(dato) <= int(paso) < len(dato):
            dato = dato[int(paso)]
        else:
            return None
    return dato
