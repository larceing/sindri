"""Drivers de Efesto: uno por protocolo o sistema de producción.

Los de serie están aquí. Un módulo de personalización puede traer el suyo como paquete de
Python que declare el grupo de entry points «sindri.efesto.drivers» (ver docs/EFESTO.md):

    [project.entry-points."sindri.efesto.drivers"]
    mi_maquina = "mi_paquete.driver:MiDriver"

Se importan solo al usarse: una fábrica que no tiene Modbus no necesita pymodbus.
"""
from __future__ import annotations

import importlib
from importlib.metadata import entry_points

from .base import Driver

DE_SERIE = {
    "opcua": "drivers.opcua:OpcUa",
    "modbus": "drivers.modbus:Modbus",
    "s7": "drivers.s7:S7",
    "enip": "drivers.enip:EtherNetIP",
    "ads": "drivers.ads:Ads",
    "mc": "drivers.mc:Melsec",
    "mqtt": "drivers.mqtt:Mqtt",
    "mtconnect": "drivers.mtconnect:MTConnect",
    "http": "drivers.http_json:HttpJson",
    "ficheros": "drivers.ficheros:Ficheros",
    "sql": "drivers.sql:Sql",
    "serie": "drivers.serie:Serie",
    "fins": "drivers.fins:Fins",
    "keyence": "drivers.keyence:Keyence",
    "bacnet": "drivers.bacnet:Bacnet",
    "sparkplug": "drivers.sparkplug:Sparkplug",
}


def _externos() -> dict[str, object]:
    try:
        return {e.name: e for e in entry_points(group="sindri.efesto.drivers")}
    except Exception:  # noqa: BLE001
        return {}


def disponibles() -> list[str]:
    return sorted(set(DE_SERIE) | set(_externos()))


def cargar(id_driver: str) -> type[Driver]:
    externos = _externos()
    if id_driver in externos:
        clase = externos[id_driver].load()
    elif id_driver in DE_SERIE:
        modulo, nombre = DE_SERIE[id_driver].split(":")
        try:
            clase = getattr(importlib.import_module(modulo), nombre)
        except ImportError as e:
            raise SystemExit(f"El driver «{id_driver}» necesita una librería que no está instalada: {e.name}. Ver requirements.txt.") from e
    else:
        raise SystemExit(f"No hay driver «{id_driver}». Hay: {', '.join(disponibles())}.")
    if not (isinstance(clase, type) and issubclass(clase, Driver)):
        raise SystemExit(f"«{id_driver}» no es un driver de Efesto (tiene que heredar de drivers.base.Driver).")
    return clase
