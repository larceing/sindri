"""EtherNet/IP (CIP): Allen-Bradley/Rockwell ControlLogix, CompactLogix y Micro800, y equipos
Omron NX/NJ. Se lee por nombre de tag."""
from __future__ import annotations

from .base import Driver, Tag

TAG_MARCA = "SindriSimulador"  # el simulador lo tiene a 1


class EtherNetIP(Driver):
    id = "enip"
    nombre = "EtherNet/IP (Rockwell Logix)"
    libreria = "pylogix (Apache-2.0)"
    sintaxis = "Piezas · Program:Main.Piezas · Linea1.Velocidad · Datos[3]"
    marca = f"tag {TAG_MARCA} = 1"

    async def abrir(self) -> None:
        from pylogix import PLC

        self.plc = PLC()
        self.plc.IPAddress = self.ajuste("host", obligatorio=True)
        self.plc.Port = int(self.ajuste("puerto", 44818))
        self.plc.ProcessorSlot = int(self.ajuste("slot", 0))
        self.plc.Micro800 = bool(self.ajuste("micro800", False))
        self.plc.SocketTimeout = 5
        r = await self.en_hilo(self.plc.Read, TAG_MARCA)  # abre la sesión CIP
        if any(p in str(r.Status).lower() for p in ("connect", "socket", "timed out", "refused")):
            raise ConnectionError(r.Status)

    async def es_simulador(self) -> bool:
        r = await self.en_hilo(self.plc.Read, TAG_MARCA)
        return r.Status == "Success" and r.Value == 1

    async def preparar(self, tags: list[Tag]) -> None:
        self.tags, self.errores = tags, {}
        self.nombres = {t.id: t.origen.strip() for t in tags if t.origen.strip()}

    async def leer(self) -> dict:
        if not self.nombres:
            return {}
        claves = list(self.nombres)
        respuestas = await self.en_hilo(self.plc.Read, [self.nombres[c] for c in claves])
        salida = {}
        for c, r in zip(claves, respuestas):
            if r.Status == "Success":
                salida[c] = r.Value
            else:
                self.errores[c] = f"{self.nombres[c]}: {r.Status}"
        return salida

    async def cerrar(self) -> None:
        await self.en_hilo(self.plc.Close)

    async def descubrir(self) -> list[dict]:
        r = await self.en_hilo(self.plc.GetTagList)
        if r.Status != "Success":
            return []
        return [{"origen": t.TagName, "tipo_dato": t.DataType} for t in r.Value]
