"""Beckhoff TwinCAT (ADS): PLC y PC industriales Beckhoff. Se lee por nombre de símbolo."""
from __future__ import annotations

from .base import Driver, Tag

SIMBOLO_MARCA = "Sindri.Simulador"


class Ads(Driver):
    id = "ads"
    nombre = "Beckhoff ADS"
    libreria = "pyads (MIT), con su adslib (MIT)"
    sintaxis = "MAIN.nPiezas · GVL.fTemperatura"
    marca = f"símbolo {SIMBOLO_MARCA} = 1"

    async def abrir(self) -> None:
        import pyads

        # En Linux pyads lleva su propio router; en el PLC hay que dar de alta una ruta hacia el agente.
        self.plc = pyads.Connection(self.ajuste("ams_net_id", obligatorio=True), int(self.ajuste("ams_puerto", 851)), self.ajuste("host", obligatorio=True))
        await self.en_hilo(self.plc.open)
        await self.en_hilo(self.plc.read_device_info)

    async def es_simulador(self) -> bool:
        try:
            return int(await self.en_hilo(self.plc.read_by_name, SIMBOLO_MARCA)) == 1
        except Exception:  # noqa: BLE001
            return False

    async def preparar(self, tags: list[Tag]) -> None:
        self.tags, self.errores = tags, {}
        self.nombres = {t.id: t.origen.strip() for t in tags}

    async def leer(self) -> dict:
        salida = {}
        for c, nombre in self.nombres.items():
            try:
                salida[c] = await self.en_hilo(self.plc.read_by_name, nombre)
            except Exception as e:  # noqa: BLE001
                self.errores[c] = f"{nombre}: {e}"
        return salida

    async def cerrar(self) -> None:
        await self.en_hilo(self.plc.close)
