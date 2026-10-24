"""BACnet/IP: climatización, compresores, enfriadoras, calderas y contadores de edificio.
Se lee la propiedad present-value (u otra) de cada objeto."""
from __future__ import annotations

import re

from .base import MARCA, Driver, Tag

# analog-value,1 · analog-input,3 · binary-value,2 · multi-state-value,1 · analog-input,3/status-flags
PATRON = re.compile(r"^([a-z-]+),(\d+)(?:/([a-z-]+))?$")


class Bacnet(Driver):
    id = "bacnet"
    nombre = "BACnet/IP"
    libreria = "bacpypes3 (MIT)"
    sintaxis = "analog-input,1 · binary-value,2 · multi-state-value,1 · analog-value,3/units"
    marca = f"el dispositivo se llama «{MARCA}» (object-name del device)"

    async def abrir(self) -> None:
        from bacpypes3.app import Application
        from bacpypes3.local.device import DeviceObject
        from bacpypes3.local.networkport import NetworkPortObject
        from bacpypes3.pdu import Address

        # El agente se presenta como un dispositivo BACnet más, que solo pregunta.
        local = self.ajuste("local", "0.0.0.0/24:47808")
        self.app = Application.from_object_list([
            DeviceObject(objectIdentifier=("device", int(self.ajuste("id_local", 4194302))), objectName="efesto", vendorIdentifier=999),
            NetworkPortObject(local, objectIdentifier=("network-port", 1), objectName="NetworkPort-1"),
        ])
        self.destino = Address(self.ajuste("host", obligatorio=True))
        self.dispositivo = int(self.ajuste("dispositivo", obligatorio=True))
        await self._leer(f"device,{self.dispositivo}", "object-name")

    async def _leer(self, objeto: str, propiedad: str):
        from bacpypes3.primitivedata import ObjectIdentifier

        return await self.app.read_property(self.destino, ObjectIdentifier(objeto), propiedad)

    async def es_simulador(self) -> bool:
        try:
            return str(await self._leer(f"device,{self.dispositivo}", "object-name")) == MARCA
        except Exception:  # noqa: BLE001
            return False

    async def preparar(self, tags: list[Tag]) -> None:
        self.tags, self.dirs, self.errores = tags, {}, {}
        for t in tags:
            m = PATRON.match(t.origen.strip())
            if not m:
                self.errores[t.id] = f"«{t.origen}» no es un objeto BACnet (p. ej. analog-input,1)"
                continue
            self.dirs[t.id] = (f"{m.group(1)},{m.group(2)}", m.group(3) or "present-value")

    async def leer(self) -> dict:
        salida = {}
        for c, (objeto, propiedad) in self.dirs.items():
            try:
                v = await self._leer(objeto, propiedad)
                salida[c] = v if isinstance(v, (int, float, str)) else (int(v) if hasattr(v, "__int__") else str(v))
            except Exception as e:  # noqa: BLE001
                self.errores[c] = f"{objeto}: {e}"
        return salida

    async def cerrar(self) -> None:
        self.app.close()
